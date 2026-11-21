import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";
import { sessionParamsSchema } from "./chat.shared.js";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted } from "../plugins/idempotency.js";
const id = z.string().trim().min(1).max(256);
const scope = z
  .object({
    workspaceId: id,
    approvalId: id,
    sourceTurnId: id.optional(),
    reason: z.enum(["setup_complete", "approval_expired"]),
  })
  .strict();
export function registerChatContinuationRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/chat/sessions/:sessionId/continuations",
    withRouteAccess(app, "operator"),
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const params = sessionParamsSchema.safeParse(request.params),
        query = scope.safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Chat recovery scope." });
      try {
        return await app.services.chatAssistantSupport.inspectChatContinuation({
          ...query.data,
          sessionId: params.data.sessionId,
          actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
        });
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
  app.post(
    "/api/v1/chat/sessions/:sessionId/continuations",
    withRouteAccess(app, "operator"),
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const params = sessionParamsSchema.safeParse(request.params),
        body = scope
          .extend({ expectedSourceHash: z.string().regex(/^[a-f0-9]{64}$/u) })
          .strict()
          .safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ error: "Refresh and review the exact Chat recovery before continuing." });
      try {
        const result = await app.services.chatAssistantSupport.prepareChatContinuation({
          ...body.data,
          sessionId: params.data.sessionId,
          actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
        });
        await markMutationCommitted(request);
        return reply.send(result);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
}
