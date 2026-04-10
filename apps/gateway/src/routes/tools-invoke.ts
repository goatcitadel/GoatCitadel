import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  evaluateComputerUseSafety,
  evaluateDeploymentProfileToolAccess,
} from "../tool-runtime-guardrails.js";

const bodySchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.unknown()),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  taskId: z.string().optional(),
  trustLevel: z.enum(["trusted_operator", "trusted_workspace", "mixed_untrusted", "untrusted_external"]).optional(),
  sourceAttribution: z.array(z.object({
    sourceType: z.enum(["file", "url", "text", "memory", "mcp"]),
    sourceRef: z.string().min(1),
    title: z.string().optional(),
    backend: z.enum(["native", "firecrawl"]).optional(),
    fetchedAt: z.string().optional(),
    trustLevel: z.enum(["trusted_operator", "trusted_workspace", "mixed_untrusted", "untrusted_external"]).optional(),
  })).optional(),
  authContext: z.object({
    boundary: z.enum(["provider_boundary", "tool_host_boundary"]).optional(),
    secretRefs: z.array(z.string()).optional(),
  }).optional(),
  consentContext: z.object({
    operatorId: z.string().optional(),
    source: z.enum(["ui", "tui", "agent"]).optional(),
    reason: z.string().optional().transform((value) =>
      // SEC: Strip "approval:" prefix from client-supplied reason to prevent
      // bypass of the risky-shell approval gate. Only the engine itself may
      // set this prefix after verifying a real approval record.
      value && value.startsWith("approval:") ? value.slice("approval:".length) : value
    ),
  }).optional(),
  dryRun: z.boolean().optional(),
});

export const toolsInvokeRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/tools/invoke", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const requestInput = parsed.data;
    const deploymentProfile = fastify.gateway.getDeploymentProfile();
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

    if (fastify.gateway.isFeatureEnabled("computerUseGuardrailsV1Enabled")) {
      const safety = evaluateComputerUseSafety(requestInput.toolName, requestInput.args);
      if (safety.requiresVerification && !safety.verified) {
        return reply.code(409).send({
          error: "Computer-use guardrail: this mutating browser action requires step verification (set args.verifyStep=true).",
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

    const result = await fastify.gateway.invokeTool(requestInput);
    return reply.send(result);
  });
};
