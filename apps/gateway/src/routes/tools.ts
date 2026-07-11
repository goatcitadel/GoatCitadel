import type { FastifyPluginAsync } from "fastify";
import type { DeploymentProfile, LocalOperatorOverrideRecord, PermissionProfileRecord } from "@goatcitadel/contracts";
import { z } from "zod";
import { evaluateComputerUseSafety, evaluateDeploymentProfileToolAccess } from "../browser-runtime-guardrails.js";
import { markMutationCommitted } from "../plugins/idempotency.js";

const RATE_LIMIT_GENERAL_MAX = 500;
const RATE_LIMIT_MUTATION_MAX = 180;

const accessEvaluateSchema = z.object({
  toolName: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  args: z.record(z.unknown()).optional(),
  trustLevel: z.enum(["trusted_operator", "trusted_workspace", "mixed_untrusted", "untrusted_external"]).optional(),
  sourceAttribution: z
    .array(
      z.object({
        sourceType: z.enum(["file", "url", "text", "memory", "mcp"]),
        sourceRef: z.string().min(1),
        title: z.string().optional(),
        backend: z.enum(["native", "firecrawl"]).optional(),
        fetchedAt: z.string().optional(),
        trustLevel: z
          .enum(["trusted_operator", "trusted_workspace", "mixed_untrusted", "untrusted_external"])
          .optional(),
      }),
    )
    .optional(),
  permissionProfileId: z.string().min(1).optional(),
  localOperatorOverrideId: z.string().min(1).optional(),
  surface: z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]).optional(),
});

const grantScopeSchema = z.enum(["global", "session", "workspace", "agent", "task"]);
const permissionSurfaceSchema = z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]);
const permissionScopeSchema = z.enum(["operator", "workspace"]);
const overrideScopeSchema = z.enum(["operator", "workspace", "session", "run"]);

const grantsQuerySchema = z.object({
  scope: grantScopeSchema.optional(),
  scopeRef: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const createGrantSchema = z
  .object({
    toolPattern: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
    scope: grantScopeSchema,
    scopeRef: z.string().optional(),
    grantType: z.enum(["one_time", "ttl", "persistent"]).optional(),
    constraints: z
      .object({
        allowedHosts: z.array(z.string().min(1)).optional(),
        allowedPaths: z.array(z.string().min(1)).optional(),
        referenceRoots: z
          .array(
            z.object({
              label: z.string().min(1),
              rootPath: z.string().min(1),
              access: z.literal("read_only"),
            }),
          )
          .optional(),
        maxWritesPerHour: z.number().int().positive().optional(),
        maxCallsPerHour: z.number().int().positive().optional(),
        mutationAllowed: z.boolean().optional(),
      })
      .optional(),
    expiresAt: z.string().datetime().optional(),
    usesRemaining: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    const grantType = value.grantType ?? "persistent";
    if (value.decision === "deny" && grantType === "one_time") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grantType"],
        message: "one_time grants can only be allow grants.",
      });
      return;
    }
    if (grantType === "ttl") {
      if (!value.expiresAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expiresAt"],
          message: "ttl grants require expiresAt.",
        });
      }
      if (value.usesRemaining !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["usesRemaining"],
          message: "ttl grants cannot set usesRemaining.",
        });
      }
      return;
    }
    if (grantType === "one_time") {
      if (value.expiresAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expiresAt"],
          message: "one_time grants cannot set expiresAt.",
        });
      }
      if (value.usesRemaining !== undefined && value.usesRemaining !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["usesRemaining"],
          message: "one_time grants must use exactly one remaining use.",
        });
      }
      return;
    }
    if (value.expiresAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "persistent grants cannot set expiresAt.",
      });
    }
    if (value.usesRemaining !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["usesRemaining"],
        message: "persistent grants cannot set usesRemaining.",
      });
    }
  });

const revokeParamsSchema = z.object({
  grantId: z.string().uuid(),
});

const profileParamsSchema = z.object({
  profileId: z.string().min(1),
});

const createPermissionProfileSchema = z.object({
  label: z.string().trim().min(1),
  description: z.string().optional(),
  scope: permissionScopeSchema.optional(),
  scopeRef: z.string().trim().min(1).optional(),
  approvalMode: z.enum(["approve_all", "approve_risky", "bypass"]),
  legacyToolProfile: z.string().trim().min(1).optional(),
  toolPatterns: z.array(z.string().trim().min(1)).optional(),
  allow: z.array(z.string().trim().min(1)).optional(),
  deny: z.array(z.string().trim().min(1)).optional(),
  readAccessMode: z.enum(["roots_only", "approval_required", "full_disk"]).optional(),
  defaultForSurfaces: z.array(permissionSurfaceSchema).optional(),
});

const updatePermissionProfileSchema = z.object({
  label: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  approvalMode: z.enum(["approve_all", "approve_risky", "bypass"]).optional(),
  legacyToolProfile: z.string().trim().min(1).optional(),
  toolPatterns: z.array(z.string().trim().min(1)).optional(),
  allow: z.array(z.string().trim().min(1)).optional(),
  deny: z.array(z.string().trim().min(1)).optional(),
  readAccessMode: z.enum(["roots_only", "approval_required", "full_disk"]).optional(),
  defaultForSurfaces: z.array(permissionSurfaceSchema).optional(),
});

const activatePermissionProfileSchema = z.object({
  profileId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  surface: permissionSurfaceSchema.optional(),
});

const effectivePermissionQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  surface: permissionSurfaceSchema.optional(),
  permissionProfileId: z.string().trim().min(1).optional(),
  localOperatorOverrideId: z.string().trim().min(1).optional(),
});

const localOperatorOverrideSchema = z.object({
  scope: overrideScopeSchema,
  scopeRef: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
  ttlSeconds: z.number().int().min(60).max(3600).default(600),
});

const overrideParamsSchema = z.object({
  overrideId: z.string().min(1),
});

export const toolsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/tools/catalog", async (_request, reply) => {
    return reply.send({ items: fastify.services.tools.listToolCatalog() });
  });

  fastify.post("/api/v1/tools/access/evaluate", async (request, reply) => {
    const parsed = accessEvaluateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    let policyContext;
    try {
      policyContext = fastify.services.tools.resolveToolPolicyContext({
        operatorId: request.authActorId,
        authActorId: request.authActorId,
        authActorSource: request.authActorSource,
        workspaceId: parsed.data.workspaceId,
        sessionId: parsed.data.sessionId,
        taskId: parsed.data.taskId,
        runId: parsed.data.runId,
        surface: parsed.data.surface,
        permissionProfileId: parsed.data.permissionProfileId,
        localOperatorOverrideId: parsed.data.localOperatorOverrideId,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const evaluation = fastify.services.tools.evaluateToolAccess({
      ...parsed.data,
      policyContext,
    });
    const toolsInvoke = (
      fastify.services as {
        toolsInvoke?: {
          getDeploymentProfile?: () => DeploymentProfile;
          isFeatureEnabled?: (flag: string) => boolean;
        };
      }
    ).toolsInvoke;
    const deploymentProfile = toolsInvoke?.getDeploymentProfile?.();
    const deploymentGuard = deploymentProfile
      ? evaluateDeploymentProfileToolAccess(deploymentProfile, parsed.data.toolName, parsed.data.args ?? {})
      : undefined;
    if (deploymentGuard) {
      return reply.send({
        ...evaluation,
        allowed: false,
        requiresApproval: false,
        reasonCodes: [...evaluation.reasonCodes, "deployment_profile_block"],
        policyReason: deploymentGuard.reason,
      });
    }

    if (toolsInvoke?.isFeatureEnabled?.("computerUseGuardrailsV1Enabled")) {
      const safety = evaluateComputerUseSafety(parsed.data.toolName, parsed.data.args ?? {});
      const computerUseReason =
        safety.requiresVerification && !safety.verified
          ? "Computer-use guardrail: this mutating browser action requires step verification (set args.verifyStep=true)."
          : safety.requiresConfirmation && !safety.confirmed
            ? "Computer-use guardrail: confirm-before-submit required (set args.confirmBeforeSubmit=true)."
            : undefined;
      if (computerUseReason) {
        return reply.send({
          ...evaluation,
          allowed: false,
          requiresApproval: false,
          reasonCodes: [...evaluation.reasonCodes, "computer_use_guardrail_block"],
          policyReason: computerUseReason,
        });
      }
    }

    return reply.send(evaluation);
  });

  fastify.get("/api/v1/tools/permission-profiles", async (request, reply) => {
    const includeArchived =
      request.query && typeof request.query === "object"
        ? (request.query as Record<string, unknown>).includeArchived === "true"
        : false;
    const workspaceId =
      request.query && typeof request.query === "object"
        ? readQueryString((request.query as Record<string, unknown>).workspaceId)
        : undefined;
    const items = fastify.services.tools
      .listPermissionProfiles(includeArchived)
      .filter((profile: PermissionProfileRecord) =>
        isPermissionProfileVisibleToActor(profile, {
          actorId: request.authActorId,
          workspaceId,
        }),
      );
    return reply.send({ items });
  });

  fastify.get("/api/v1/tools/permission-profiles/effective", async (request, reply) => {
    const parsed = effectivePermissionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(
        fastify.services.tools.resolveToolPolicyContext({
          operatorId: request.authActorId,
          authActorId: request.authActorId,
          authActorSource: request.authActorSource,
          workspaceId: parsed.data.workspaceId,
          sessionId: parsed.data.sessionId,
          taskId: parsed.data.taskId,
          runId: parsed.data.runId,
          surface: parsed.data.surface,
          permissionProfileId: parsed.data.permissionProfileId,
          localOperatorOverrideId: parsed.data.localOperatorOverrideId,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get(
    "/api/v1/tools/local-operator-overrides",
    { config: { rateLimit: { max: RATE_LIMIT_GENERAL_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      return reply.send({
        items: fastify.services.tools.listActiveLocalOperatorOverrides(request.authActorId),
      });
    },
  );

  fastify.post(
    "/api/v1/tools/permission-profiles",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const parsed = createPermissionProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        const scope = parsed.data.scope ?? "operator";
        if (scope === "workspace" && !parsed.data.scopeRef) {
          return reply.code(400).send({ error: "Workspace-scoped permission profiles require scopeRef." });
        }
        return reply.code(201).send(
          fastify.services.tools.createPermissionProfile({
            ...parsed.data,
            scope,
            scopeRef: scope === "operator" ? request.authActorId : parsed.data.scopeRef,
            createdBy: request.authActorId,
          }),
        );
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.patch(
    "/api/v1/tools/permission-profiles/:profileId",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const params = profileParamsSchema.safeParse(request.params);
      const body = updatePermissionProfileSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
      }
      try {
        const existingProfile = fastify.services.tools
          .listPermissionProfiles(true)
          .find((profile: PermissionProfileRecord) => profile.profileId === params.data.profileId);
        if (!existingProfile) {
          return reply.code(404).send({ error: `Permission profile ${params.data.profileId} not found` });
        }
        if (!canMutatePermissionProfile(existingProfile, request.authActorId)) {
          return reply
            .code(403)
            .send({ error: `Permission profile ${params.data.profileId} is not editable by this operator.` });
        }
        return reply.send(
          fastify.services.tools.updatePermissionProfile(params.data.profileId, {
            ...body.data,
            updatedBy: request.authActorId,
          }),
        );
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/tools/permission-profiles/:profileId/archive",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const params = profileParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      try {
        const existingProfile = fastify.services.tools
          .listPermissionProfiles(true)
          .find((profile: PermissionProfileRecord) => profile.profileId === params.data.profileId);
        if (!existingProfile) {
          return reply.code(404).send({ error: `Permission profile ${params.data.profileId} not found` });
        }
        if (!canMutatePermissionProfile(existingProfile, request.authActorId)) {
          return reply
            .code(403)
            .send({ error: `Permission profile ${params.data.profileId} is not editable by this operator.` });
        }
        const archived = fastify.services.tools.archivePermissionProfile(params.data.profileId, request.authActorId);
        return archived
          ? reply.send({ archived: true, profileId: params.data.profileId })
          : reply
              .code(404)
              .send({ error: `Permission profile ${params.data.profileId} not found or already archived` });
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/tools/permission-profiles/activate",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const parsed = activatePermissionProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        const profile = fastify.services.tools
          .listPermissionProfiles(true)
          .find((item: PermissionProfileRecord) => item.profileId === parsed.data.profileId);
        if (!profile) {
          return reply.code(404).send({ error: `Permission profile ${parsed.data.profileId} not found` });
        }
        return reply.send(
          fastify.services.tools.activatePermissionProfile({
            ...parsed.data,
            operatorId: profile?.scope === "workspace" ? undefined : request.authActorId,
            createdBy: request.authActorId,
          }),
        );
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/tools/local-operator-overrides",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const parsed = localOperatorOverrideSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      if (parsed.data.scope !== "operator" && !parsed.data.scopeRef) {
        return reply.code(400).send({ error: "Scoped Local Operator Override requires scopeRef." });
      }
      try {
        return reply.code(201).send(
          fastify.services.tools.createLocalOperatorOverride({
            ...parsed.data,
            operatorId: request.authActorId,
            createdBy: request.authActorId,
          }),
        );
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/tools/local-operator-overrides/:overrideId/revoke",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const params = overrideParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      const activeForOperator = fastify.services.tools.listActiveLocalOperatorOverrides(request.authActorId);
      if (
        !activeForOperator.some(
          (override: LocalOperatorOverrideRecord) => override.overrideId === params.data.overrideId,
        )
      ) {
        return reply
          .code(404)
          .send({ error: `Local operator override ${params.data.overrideId} not found or inactive` });
      }
      const override = fastify.services.tools.revokeLocalOperatorOverride(params.data.overrideId, request.authActorId);
      return override
        ? reply.send({
            revoked: true,
            overrideId: params.data.overrideId,
            status: override.status,
            revokedAt: override.revokedAt,
            revokedBy: override.revokedBy ?? request.authActorId,
            override,
          })
        : reply.code(404).send({ error: `Local operator override ${params.data.overrideId} not found or inactive` });
    },
  );

  fastify.get("/api/v1/tools/grants", async (request, reply) => {
    const parsed = grantsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    return reply.send({
      items: fastify.services.tools.listToolGrants(parsed.data.scope, parsed.data.scopeRef, parsed.data.limit),
    });
  });

  fastify.post(
    "/api/v1/tools/grants",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const parsed = createGrantSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        const created = fastify.services.tools.createToolGrant({
          ...parsed.data,
          createdBy: request.authActorId,
        });
        markMutationCommitted(request);
        return reply.code(201).send(created);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/tools/grants/:grantId/revoke",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      await fastify.requireOperatorAuth(request, reply);
      if (reply.sent) return reply;
      const params = revokeParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      const revoked = fastify.services.tools.revokeToolGrant(params.data.grantId, request.authActorId);
      if (!revoked) {
        return reply.code(404).send({ error: `Tool grant ${params.data.grantId} not found or already revoked` });
      }

      markMutationCommitted(request);
      return reply.send({ revoked: true, grantId: params.data.grantId, revokedBy: request.authActorId });
    },
  );
};

function canMutatePermissionProfile(profile: PermissionProfileRecord, actorId: string): boolean {
  if (profile.builtin) {
    return false;
  }
  if (profile.scope === "operator") {
    return profile.scopeRef === actorId && profile.createdBy === actorId;
  }
  if (profile.scope === "workspace") {
    return profile.createdBy === actorId;
  }
  return false;
}

function isPermissionProfileVisibleToActor(
  profile: PermissionProfileRecord,
  context: { actorId: string; workspaceId?: string },
): boolean {
  if (profile.scope === "global") {
    return true;
  }
  if (profile.scope === "operator") {
    return profile.scopeRef === context.actorId;
  }
  if (profile.scope === "workspace") {
    return Boolean(context.workspaceId && profile.scopeRef === context.workspaceId);
  }
  return false;
}

function readQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
