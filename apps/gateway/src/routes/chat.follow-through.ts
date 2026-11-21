import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";
import { sessionParamsSchema } from "./chat.shared.js";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted } from "../plugins/idempotency.js";
const workspace = z.string().trim().min(1).max(256);
const action = z
  .object({
    workspaceId: workspace,
    owner: z
      .object({
        kind: z.enum(["schedule", "commitment", "heartbeat", "proactive"]),
        ownerId: z.string().trim().min(1).max(256),
      })
      .strict(),
    action: z.enum(["accept", "dismiss", "pause", "resume", "run_now", "cancel_run", "set_heartbeat_interval"]),
    expectedRevision: z.number().int().positive(),
    operationId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{16,100}$/u)
      .optional(),
    expectedRunId: workspace.optional(),
    expectedExecutionGeneration: z.number().int().nonnegative().optional(),
    heartbeatIntervalSeconds: z.number().int().min(900).max(86_400).optional(),
  })
  .strict()
  .refine((input) => (input.action === "set_heartbeat_interval") === (input.heartbeatIntervalSeconds !== undefined));
export function registerChatFollowThroughRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/chat/sessions/:sessionId/follow-through",
    withRouteAccess(app, "operator"),
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params),
        query = z.object({ workspaceId: workspace.optional() }).strict().safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid follow-through scope." });
      try {
        return await app.services.chatAssistantSupport.listFollowThrough(params.data.sessionId, query.data.workspaceId);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
  app.post(
    "/api/v1/chat/sessions/:sessionId/follow-through/actions",
    withRouteAccess(app, "operator"),
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params),
        body = action.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid follow-through action." });
      try {
        const result = await app.services.chatAssistantSupport.requestFollowThroughAction(
          { ...body.data, sessionId: params.data.sessionId },
          request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
        );
        await markMutationCommitted(request);
        return reply.send(result);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
}
