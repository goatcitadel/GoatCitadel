import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CHANGE_PLAN_RUNTIME_FEATURE_FLAGS, ServiceUnavailableError } from "@goatcitadel/contracts";
import type { EvolutionControlPlaneActor } from "../services/evolution-control-plane-service.js";
import { sendRouteError } from "./_error-handler.js";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const thinkingLevel = z.enum(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]);
const providerProfileSchema = z
  .object({
    label: z.string().trim().min(1).max(256).optional(),
    baseUrl: z.string().url().max(2_048).optional(),
    apiStyle: z
      .enum([
        "openai-chat-completions",
        "openai-responses",
        "openai-codex-responses",
        "anthropic-messages",
        "bedrock-messages",
      ])
      .optional(),
    authMode: z
      .enum(["api-key", "codex-oauth", "claude-code-oauth", "google-service-account", "google-adc"])
      .optional(),
    defaultModel: identifier.optional(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
      .optional(),
    googleCloud: z
      .object({
        projectId: identifier.optional(),
        projectIdEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
          .optional(),
        location: identifier.optional(),
        locationEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
          .optional(),
        endpointId: identifier.optional(),
      })
      .strict()
      .optional(),
    capabilities: z
      .object({
        vision: z.boolean().optional(),
        audio: z.boolean().optional(),
        video: z.boolean().optional(),
        toolCalling: z.boolean().optional(),
        jsonMode: z.boolean().optional(),
        webSearch: z.boolean().optional(),
        reasoning: z.boolean().optional(),
        reasoningEfforts: z
          .array(z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"]))
          .min(1)
          .max(7)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const nonEmptyStrict = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: "At least one typed setting is required." });
const safeRuntimeUrl = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => {
      const parsed = new URL(value);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    },
    { message: "Runtime URLs must be credential-free HTTP(S) origins." },
  );
const memoryConfigurationSchema = nonEmptyStrict({
  enabled: z.boolean().optional(),
  qmdEnabled: z.boolean().optional(),
  qmdApplyToChat: z.boolean().optional(),
  qmdApplyToOrchestration: z.boolean().optional(),
  qmdMaxContextTokens: z.number().int().positive().max(2_000_000).optional(),
  qmdMinPromptChars: z.number().int().nonnegative().max(2_000_000).optional(),
  qmdCacheTtlSeconds: z.number().int().positive().max(31_536_000).optional(),
  qmdDistillerProviderId: identifier.optional(),
  qmdDistillerModel: identifier.optional(),
});
const firecrawlConfigurationSchema = nonEmptyStrict({
  enabled: z.boolean().optional(),
  baseUrl: safeRuntimeUrl.optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
    .optional(),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  defaultReadBackend: z.enum(["native", "firecrawl"]).optional(),
  fallbackToNative: z.boolean().optional(),
});
const meshConfigurationSchema = nonEmptyStrict({
  enabled: z.boolean().optional(),
  mode: z.enum(["lan", "wan", "tailnet"]).optional(),
  nodeId: identifier.optional(),
  mdns: z.boolean().optional(),
  staticPeers: z.array(z.string().trim().min(1).max(2_048)).max(64).optional(),
  requireMtls: z.boolean().optional(),
  tailnetEnabled: z.boolean().optional(),
});
const npuConfigurationSchema = nonEmptyStrict({
  enabled: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  sidecarUrl: safeRuntimeUrl.optional(),
});
const nullablePositive = z.number().int().positive().max(2_000_000).nullable().optional();
const llamaCppConfigurationSchema = nonEmptyStrict({
  enabled: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  baseUrl: safeRuntimeUrl.optional(),
  alias: identifier.optional(),
  ctxSize: nullablePositive,
  threads: nullablePositive,
  gpuLayers: z.number().int().nonnegative().max(2_000_000).nullable().optional(),
  parallel: nullablePositive,
  batchSize: nullablePositive,
  ubatchSize: nullablePositive,
  flashAttention: z.boolean().nullable().optional(),
});

const requestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session_model"),
      providerId: identifier.optional(),
      model: identifier.optional(),
      thinkingLevel: thinkingLevel.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("installation_default_model"),
      providerId: identifier,
      model: identifier,
      thinkingLevel: thinkingLevel.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("provider_connection"),
      providerId: identifier,
      credentialAction: z.enum(["replace_api_key", "replace_oauth", "remove_api_key", "remove_oauth"]).optional(),
      credentialStorage: z.enum(["keychain", "env"]).optional(),
      credentialEnvVar: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
        .optional(),
      credentialDeleteScope: z.enum(["all", "keychain", "env", "inline"]).optional(),
      profile: providerProfileSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("runtime_configuration"),
      change: z.discriminatedUnion("operation", [
        z
          .object({
            operation: z.literal("tool_approval_mode"),
            mode: z.enum(["approve_all", "approve_risky", "bypass"]),
          })
          .strict(),
        z.object({ operation: z.literal("budget_mode"), mode: z.enum(["saver", "balanced", "power"]) }).strict(),
        z.object({ operation: z.literal("default_tool_profile"), profileId: identifier }).strict(),
        z
          .object({
            operation: z.literal("deployment_profile"),
            profile: z.enum(["local_dev", "trusted_local", "remote_hardened"]),
          })
          .strict(),
        z
          .object({
            operation: z.literal("read_access_policy"),
            mode: z.enum(["roots_only", "approval_required", "full_disk"]),
          })
          .strict(),
        z
          .object({
            operation: z.literal("network_allowlist"),
            entries: z.array(z.string().trim().min(1).max(512)).max(256),
          })
          .strict(),
        z.object({ operation: z.literal("utility_model"), providerId: identifier, model: identifier }).strict(),
        z
          .object({
            operation: z.literal("gateway_auth_configuration"),
            mode: z.enum(["none", "token", "basic"]),
            allowLoopbackBypass: z.boolean(),
            basicUsername: z.string().trim().min(1).max(256).optional(),
            replaceCredential: z.boolean().optional(),
          })
          .strict(),
        z.object({ operation: z.literal("memory_configuration"), config: memoryConfigurationSchema }).strict(),
        z
          .object({ operation: z.literal("web_firecrawl_configuration"), config: firecrawlConfigurationSchema })
          .strict(),
        z.object({ operation: z.literal("mesh_configuration"), config: meshConfigurationSchema }).strict(),
        z.object({ operation: z.literal("npu_configuration"), config: npuConfigurationSchema }).strict(),
        z.object({ operation: z.literal("llama_cpp_configuration"), config: llamaCppConfigurationSchema }).strict(),
        z
          .object({
            operation: z.literal("feature_flag"),
            flag: z.enum(CHANGE_PLAN_RUNTIME_FEATURE_FLAGS),
            enabled: z.boolean(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("channel_connection"), channelKind: identifier, draftId: identifier.optional() }).strict(),
  z.object({ kind: z.literal("runtime_remediation"), remediationId: identifier }).strict(),
  z
    .object({
      kind: z.literal("capability_candidate"),
      proposalId: identifier,
      action: z.enum(["activate", "revoke", "rollback"]).optional(),
      versionId: identifier.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("improvement_candidate"), candidateId: identifier }).strict(),
  z.object({ kind: z.literal("managed_source_registration") }).strict(),
  z
    .object({
      kind: z.literal("product_source_update"),
      sourceInstallId: identifier,
      changeSummary: z.string().trim().min(1).max(2_000),
      codeModeRunId: identifier,
    })
    .strict(),
]);

const originFields = {
  workspaceId: identifier.default("default"),
  sessionId: identifier.optional(),
  turnId: identifier.optional(),
} as const;

const createSchema = z
  .object({
    ...originFields,
    surface: z.enum(["chat", "settings"]).default("chat"),
    request: requestSchema,
    idempotencyKey: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const listSchema = z
  .object({
    workspaceId: identifier.default("default"),
    sessionId: identifier.optional(),
    status: z
      .enum([
        "draft",
        "awaiting_input",
        "awaiting_confirmation",
        "staging",
        "awaiting_approval",
        "applying",
        "verifying",
        "monitoring",
        "completed",
        "applied",
        "manual_required",
        "failed",
        "cancelled",
        "rolling_back",
        "rolled_back",
        "rollback_failed",
      ])
      .optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

const paramsSchema = z.object({ planId: identifier }).strict();
const actorBodySchema = z.object({ ...originFields }).strict();
const exactActionSchema = z
  .object({
    ...originFields,
    expectedRevision: z.number().int().positive(),
    actionNonce: z.string().min(16).max(512),
  })
  .strict();
const responseSchema = exactActionSchema
  .extend({
    actionId: identifier,
    values: z.record(z.string().min(1).max(128), z.union([z.string().max(4_000), z.number().finite(), z.boolean()])),
  })
  .strict();
const rollbackSchema = z
  .object({
    ...originFields,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const providerSecretSchema = exactActionSchema
  .extend({
    actionId: identifier,
    apiKey: z.string().min(1).max(16_384),
  })
  .strict();
const gatewayAuthCredentialSchema = exactActionSchema
  .extend({
    actionId: identifier,
    credential: z.string().min(1).max(16_384),
  })
  .strict();
const providerOAuthCompletionSchema = exactActionSchema.extend({ actionId: identifier }).strict();
const providerOAuthPollSchema = providerOAuthCompletionSchema.extend({ flowId: identifier }).strict();
const channelSecretsSchema = exactActionSchema
  .extend({
    actionId: identifier,
    values: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u),
        z.string().min(1).max(16_384),
      )
      .refine((values) => Object.keys(values).length > 0 && Object.keys(values).length <= 16),
  })
  .strict();
const managedSourceSelectionSchema = exactActionSchema
  .extend({
    actionId: identifier,
    rootPath: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\0\r\n]/u.test(value)),
  })
  .strict();
const secureOwnerRouteOptions = {
  bodyLimit: 20 * 1_024,
  logLevel: "silent" as const,
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
};

export function registerChangePlanRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/change-plans/:planId/managed-source-selections",
    secureOwnerRouteOptions,
    async (request, reply) => {
      markNoStore(reply);
      const params = paramsSchema.safeParse(request.params);
      const body = managedSourceSelectionSchema.safeParse(request.body);
      if (!params.success || !body.success) return badPair(reply, params, body);
      try {
        return reply.send(
          await requireManagedSourceOwner(fastify).submitSelection({
            actor: actorFor(request, { ...body.data, surface: "chat" }),
            planId: params.data.planId,
            expectedRevision: body.data.expectedRevision,
            actionId: body.data.actionId,
            actionNonce: body.data.actionNonce,
            rootPath: body.data.rootPath,
          }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post("/api/v1/change-plans/:planId/channel-secrets", secureOwnerRouteOptions, async (request, reply) => {
    markNoStore(reply);
    const params = paramsSchema.safeParse(request.params);
    const body = channelSecretsSchema.safeParse(request.body);
    if (!params.success || !body.success) return badPair(reply, params, body);
    try {
      return reply.send(
        await requireChannelConnectionOwner(fastify).submitSecrets({
          actor: actorFor(request, { ...body.data, surface: "chat" }),
          planId: params.data.planId,
          expectedRevision: body.data.expectedRevision,
          actionId: body.data.actionId,
          actionNonce: body.data.actionNonce,
          values: body.data.values,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/change-plans/:planId/provider-secret", secureOwnerRouteOptions, async (request, reply) => {
    markNoStore(reply);
    const params = paramsSchema.safeParse(request.params);
    const body = providerSecretSchema.safeParse(request.body);
    if (!params.success || !body.success) return badPair(reply, params, body);
    try {
      return reply.send(
        await requireProviderConnectionOwner(fastify).submitSecret({
          actor: actorFor(request, { ...body.data, surface: "chat" }),
          planId: params.data.planId,
          expectedRevision: body.data.expectedRevision,
          actionId: body.data.actionId,
          actionNonce: body.data.actionNonce,
          apiKey: body.data.apiKey,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post(
    "/api/v1/change-plans/:planId/gateway-auth-credential",
    secureOwnerRouteOptions,
    async (request, reply) => {
      markNoStore(reply);
      const params = paramsSchema.safeParse(request.params);
      const body = gatewayAuthCredentialSchema.safeParse(request.body);
      if (!params.success || !body.success) return badPair(reply, params, body);
      try {
        return reply.send(
          await requireRuntimeConfigurationOwner(fastify).submitGatewayAuthCredential({
            actor: actorFor(request, { ...body.data, surface: "chat" }),
            planId: params.data.planId,
            expectedRevision: body.data.expectedRevision,
            actionId: body.data.actionId,
            actionNonce: body.data.actionNonce,
            credential: body.data.credential,
          }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post(
    "/api/v1/change-plans/:planId/provider-oauth-starts",
    secureOwnerRouteOptions,
    async (request, reply) => {
      markNoStore(reply);
      const params = paramsSchema.safeParse(request.params);
      const body = providerOAuthCompletionSchema.safeParse(request.body);
      if (!params.success || !body.success) return badPair(reply, params, body);
      try {
        return reply.send(
          await requireProviderConnectionOwner(fastify).startOAuth({
            actor: actorFor(request, { ...body.data, surface: "chat" }),
            planId: params.data.planId,
            expectedRevision: body.data.expectedRevision,
            actionId: body.data.actionId,
            actionNonce: body.data.actionNonce,
          }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post("/api/v1/change-plans/:planId/provider-oauth-polls", secureOwnerRouteOptions, async (request, reply) => {
    markNoStore(reply);
    const params = paramsSchema.safeParse(request.params);
    const body = providerOAuthPollSchema.safeParse(request.body);
    if (!params.success || !body.success) return badPair(reply, params, body);
    try {
      return reply.send(
        await requireProviderConnectionOwner(fastify).pollOAuth({
          actor: actorFor(request, { ...body.data, surface: "chat" }),
          planId: params.data.planId,
          expectedRevision: body.data.expectedRevision,
          actionId: body.data.actionId,
          actionNonce: body.data.actionNonce,
          flowId: body.data.flowId,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post(
    "/api/v1/change-plans/:planId/provider-oauth-completions",
    secureOwnerRouteOptions,
    async (request, reply) => {
      markNoStore(reply);
      const params = paramsSchema.safeParse(request.params);
      const body = providerOAuthCompletionSchema.safeParse(request.body);
      if (!params.success || !body.success) return badPair(reply, params, body);
      try {
        return reply.send(
          await requireProviderConnectionOwner(fastify).completeOAuth({
            actor: actorFor(request, { ...body.data, surface: "chat" }),
            planId: params.data.planId,
            expectedRevision: body.data.expectedRevision,
            actionId: body.data.actionId,
            actionNonce: body.data.actionNonce,
          }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post("/api/v1/change-plans", async (request, reply) => {
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      const service = requireService(fastify);
      const actor = actorFor(request, body.data);
      const plan = await service.create({
        actor,
        request: body.data.request,
        idempotencyKey: body.data.idempotencyKey,
      });
      return reply.code(201).send(plan);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/change-plans", async (request, reply) => {
    const query = listSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      const actor = actorFor(request, { ...query.data, surface: "chat" });
      return reply.send({
        items: await requireService(fastify).list(actor, {
          ...(query.data.sessionId ? { sessionId: query.data.sessionId } : {}),
          ...(query.data.status ? { status: query.data.status } : {}),
          ...(query.data.limit ? { limit: query.data.limit } : {}),
        }),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/change-plans/:planId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = actorBodySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply
        .code(400)
        .send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            query: query.success ? undefined : query.error.flatten(),
          },
        });
    try {
      return reply.send(
        await requireService(fastify).get(actorFor(request, { ...query.data, surface: "chat" }), params.data.planId),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/change-plans/:planId/responses", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = responseSchema.safeParse(request.body);
    if (!params.success || !body.success) return badPair(reply, params, body);
    try {
      return reply.send(
        await requireService(fastify).respond(
          actorFor(request, { ...body.data, surface: "chat" }),
          params.data.planId,
          {
            expectedRevision: body.data.expectedRevision,
            actionId: body.data.actionId,
            actionNonce: body.data.actionNonce,
            values: body.data.values,
          },
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/change-plans/:planId/confirmations", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = exactActionSchema.safeParse(request.body);
    if (!params.success || !body.success) return badPair(reply, params, body);
    try {
      return reply.send(
        await requireService(fastify).confirm(
          actorFor(request, { ...body.data, surface: "chat" }),
          params.data.planId,
          body.data.expectedRevision,
          body.data.actionNonce,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/change-plans/:planId/cancellations", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = exactActionSchema.safeParse(request.body);
    if (!params.success || !body.success) return badPair(reply, params, body);
    try {
      return reply.send(
        await requireService(fastify).cancel(
          actorFor(request, { ...body.data, surface: "chat" }),
          params.data.planId,
          body.data.expectedRevision,
          body.data.actionNonce,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/change-plans/:planId/rollback-requests", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = rollbackSchema.safeParse(request.body);
    if (!params.success || !body.success) return badPair(reply, params, body);
    try {
      return reply.send(
        await requireService(fastify).requestRollback(
          actorFor(request, { ...body.data, surface: "chat" }),
          params.data.planId,
          body.data.expectedRevision,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
}

function requireService(fastify: FastifyInstance) {
  const service = fastify.services.evolution;
  if (!service) throw new ServiceUnavailableError("The Evolution Control Plane is not composed in this Gateway.");
  return service;
}

function requireProviderConnectionOwner(fastify: FastifyInstance) {
  const service = fastify.services.evolutionProviderConnection;
  if (!service) throw new ServiceUnavailableError("The provider connection secure owner is unavailable.");
  return service;
}

function requireChannelConnectionOwner(fastify: FastifyInstance) {
  const service = fastify.services.evolutionChannelConnection;
  if (!service) throw new ServiceUnavailableError("The channel connection secure owner is unavailable.");
  return service;
}

function requireManagedSourceOwner(fastify: FastifyInstance) {
  const service = fastify.services.evolutionManagedSource;
  if (!service) throw new ServiceUnavailableError("The managed source native owner is unavailable.");
  return service;
}

function requireRuntimeConfigurationOwner(fastify: FastifyInstance) {
  const service = fastify.services.evolutionRuntimeConfiguration;
  if (!service) throw new ServiceUnavailableError("The runtime configuration secure owner is unavailable.");
  return service;
}

function markNoStore(reply: Parameters<typeof sendRouteError>[0]): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function actorFor(
  request: FastifyRequest,
  input: { workspaceId: string; sessionId?: string; turnId?: string; surface: "chat" | "settings" },
): EvolutionControlPlaneActor {
  return {
    workspaceId: input.workspaceId,
    actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
    surface: input.surface,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
  };
}

function badPair(
  reply: Parameters<typeof sendRouteError>[0],
  params: z.SafeParseReturnType<unknown, unknown>,
  body: z.SafeParseReturnType<unknown, unknown>,
) {
  return reply.code(400).send({
    error: {
      params: params.success ? undefined : params.error.flatten(),
      body: body.success ? undefined : body.error.flatten(),
    },
  });
}
