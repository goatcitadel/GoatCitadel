import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";
import { sessionParamsSchema } from "./chat.shared.js";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted } from "../plugins/idempotency.js";

const prepareSchema = z
  .object({
    sourceTurnId: z.string().trim().min(1).max(256),
    guidance: z.string().trim().max(2000).optional(),
    targetCandidateId: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/u)
      .optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
const stageSchema = z
  .object({
    draftTurnId: z.string().trim().min(1).max(256),
    reviewedContentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export function registerWorkflowSkillCaptureRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/chat/sessions/:sessionId/skill-captures/prepare",
    withRouteAccess(fastify, "operator"),
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      const body = prepareSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid skill capture request." });
      try {
        return reply.send(
          await fastify.services.chatMessages.prepareWorkflowSkillCapture(params.data.sessionId, body.data, {
            actorId: request.authActorId,
            authActorSource: request.authActorSource,
          }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
  fastify.post(
    "/api/v1/chat/sessions/:sessionId/skill-captures/stage",
    withRouteAccess(fastify, "operator"),
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      const body = stageSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid skill capture review." });
      try {
        const result = await fastify.services.chatMessages.stageWorkflowSkillCapture(params.data.sessionId, body.data, {
          actorId: request.authActorId,
          authActorSource: request.authActorSource,
        });
        await markMutationCommitted(request);
        return reply.send(result);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
}
