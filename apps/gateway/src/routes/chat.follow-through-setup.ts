import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";
import { sessionParamsSchema } from "./chat.shared.js";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted } from "../plugins/idempotency.js";
const id = z.string().trim().min(1).max(256),
  zone = z.string().trim().min(1).max(128);
const trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recurring"), schedule: z.string().trim().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("once"), at: z.string().datetime({ offset: true }), timezone: zone }).strict(),
  z
    .object({ kind: z.literal("event"), hookId: id, notBefore: z.string().datetime({ offset: true }), timezone: zone })
    .strict(),
]);
const create = z
  .object({
    workspaceId: id,
    expectedSetupHash: z.string().regex(/^[a-f0-9]{64}$/u),
    operationId: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/u),
    purpose: z.string().trim().min(1).max(2000),
    permissionProfileId: id,
    trigger,
    delivery: z.object({ kind: z.literal("conversation") }).strict(),
  })
  .strict();
export function registerChatFollowThroughSetupRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/chat/sessions/:sessionId/follow-through/setup",
    withRouteAccess(app, "operator"),
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const params = sessionParamsSchema.safeParse(request.params),
        query = z.object({ workspaceId: id }).strict().safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid schedule setup scope." });
      try {
        return await app.services.chatSupport.inspectFollowThroughSetup({
          ...query.data,
          sessionId: params.data.sessionId,
          actorId: request.authActorId,
        });
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
  app.post(
    "/api/v1/chat/sessions/:sessionId/follow-through/setup",
    withRouteAccess(app, "operator"),
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params),
        body = create.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .code(400)
          .send({
            error:
              "Review the exact purpose, trigger, delivery, permissions and current limits before scheduling work.",
          });
      try {
        const result = await app.services.chatSupport.createFollowThroughSetup({
          ...body.data,
          sessionId: params.data.sessionId,
          actorId: request.authActorId,
        });
        markMutationCommitted(request);
        return reply.code(201).send(result);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
}
