import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { evaluateComputerUseSafety, evaluateDeploymentProfileToolAccess } from "../browser-runtime-guardrails.js";

const bodySchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.unknown()),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
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
  authContext: z
    .object({
      boundary: z.enum(["provider_boundary", "tool_host_boundary"]).optional(),
      secretRefs: z.array(z.string()).optional(),
    })
    .optional(),
  consentContext: z
    .object({
      operatorId: z.string().optional(),
      source: z.enum(["ui", "tui", "agent"]).optional(),
      // SECURITY (codex finding #17): No client-side sanitization of
      // `reason`. Approval reasons are treated as operator-visible
      // explanation text unless the policy engine can verify the id
      // against an approved canonical approval row and an exact pending
      // action request match.
      reason: z.string().optional(),
    })
    .optional(),
  dryRun: z.boolean().optional(),
  permissionProfileId: z.string().min(1).optional(),
  localOperatorOverrideId: z.string().min(1).optional(),
  surface: z.enum(["chat", "cowork", "code", "tools", "mcp", "all"]).optional(),
});

export const toolsInvokeRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/tools/invoke", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const requestInput = parsed.data;
    const deploymentProfile = fastify.services.toolsInvoke.getDeploymentProfile();
    const deploymentGuard = evaluateDeploymentProfileToolAccess(
      deploymentProfile,
      requestInput.toolName,
      requestInput.args,
    );
    if (deploymentGuard) {
      return reply.code(deploymentGuard.statusCode).send({
        error: deploymentGuard.reason,
        details: deploymentGuard.details,
      });
    }

    if (fastify.services.toolsInvoke.isFeatureEnabled("computerUseGuardrailsV1Enabled")) {
      const safety = evaluateComputerUseSafety(requestInput.toolName, requestInput.args);
      if (safety.requiresVerification && !safety.verified) {
        return reply.code(409).send({
          error:
            "Computer-use guardrail: this mutating browser action requires step verification (set args.verifyStep=true).",
          details: safety,
        });
      }
      if (safety.requiresConfirmation && !safety.confirmed) {
        return reply.code(409).send({
          error: "Computer-use guardrail: confirm-before-submit required (set args.confirmBeforeSubmit=true).",
          details: safety,
        });
      }
      requestInput.args = {
        ...requestInput.args,
        __gcSafety: {
          verified: safety.verified,
          confirmed: safety.confirmed,
          enforced: true,
        },
      };
    }

    let policyContext;
    try {
      policyContext = fastify.services.tools.resolveToolPolicyContext({
        operatorId: request.authActorId,
        authActorId: request.authActorId,
        authActorSource: request.authActorSource,
        workspaceId: requestInput.workspaceId,
        sessionId: requestInput.sessionId,
        taskId: requestInput.taskId,
        runId: requestInput.runId,
        surface: requestInput.surface,
        permissionProfileId: requestInput.permissionProfileId,
        localOperatorOverrideId: requestInput.localOperatorOverrideId,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const result = await fastify.services.toolsInvoke.invokeTool({
      ...requestInput,
      consentContext: {
        ...(requestInput.consentContext ?? {}),
        operatorId: request.authActorId,
        source: requestInput.consentContext?.source ?? "ui",
      },
      policyContext,
    });
    return reply.send(result);
  });
};
