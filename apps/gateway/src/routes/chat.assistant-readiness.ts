import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";
import { sessionParamsSchema } from "./chat.shared.js";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted } from "../plugins/idempotency.js";
export function registerChatAssistantReadinessRoutes(fastify: FastifyInstance): void {
  fastify.get(
    "/api/v1/chat/sessions/:sessionId/assistant-readiness",
    withRouteAccess(fastify, "operator"),
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params),
        query = z
          .object({ workspaceId: z.string().trim().min(1).max(256).optional() })
          .strict()
          .safeParse(request.query);
      if (!params.success || !query.success)
        return reply.code(400).send({ error: "Invalid assistant readiness scope." });
      try {
        return reply.send(
          await fastify.services.chatSupport.getAssistantReadiness(params.data.sessionId, query.data.workspaceId),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
  fastify.post(
    "/api/v1/chat/sessions/:sessionId/assistant-readiness/setup",
    withRouteAccess(fastify, "operator"),
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params),
        body = z
          .object({
            workspaceId: z.string().trim().min(1).max(256),
            itemId: z.enum(["memory", "skills", "follow_up", "scheduled_work", "indexed_recall", "skill_use"]),
            expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
            operationId: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/u),
          })
          .strict()
          .safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid assistant setup review." });
      const actor = request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
      try {
        const result = await fastify.services.chatSupport.prepareAssistantSetup(
          { ...body.data, sessionId: params.data.sessionId },
          actor,
        );
        markMutationCommitted(request);
        return reply.code(201).send(result);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
}
