import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConflictError, redactStructuredSecrets } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";
// Read markers follow the Inbox's read-state identity rule: only token/basic operator auth is an identity.
import { inboxActor } from "./inbox.js";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";

const RATE_LIMIT_GENERAL_MAX = 500;
const RATE_LIMIT_MUTATION_MAX = 180;

const messagingQuerySchema = z.object({
  workspaceId: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9._-]+$/)
    .optional(),
});

const sessionParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(256),
});

const readRequestSchema = z.object({
  readThrough: z.string().datetime({ offset: true }),
});

/** Messaging: channel conversations grouped by their connection, plus per-operator read markers. */
export function registerChatMessagingRoutes(fastify: FastifyInstance): void {
  fastify.get(
    "/api/v1/chat/messaging",
    { config: { rateLimit: { max: RATE_LIMIT_GENERAL_MAX } } },
    async (request, reply) => {
      const query = messagingQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: { query: query.error.flatten() } });
      }
      try {
        const overview = await fastify.services.chatSessions.listChatMessaging({
          workspaceId: query.data.workspaceId,
          actor: inboxActor(request),
        });
        // Titles come from outside providers: project them like every other public chat text.
        reply.header("Cache-Control", "private, no-store");
        return reply.send(redactStructuredSecrets(overview).value);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post(
    "/api/v1/chat/sessions/:sessionId/read",
    { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      const body = readRequestSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
      }
      const actor = inboxActor(request);
      if (!actor) {
        return sendRouteError(
          reply,
          new ConflictError({
            code: "STATE_CONFLICT",
            message: "Read state is kept per operator, and this request does not identify one.",
          }),
          request.log,
        );
      }
      try {
        const result = await fastify.services.chatSessions.markChatSessionRead({
          sessionId: params.data.sessionId,
          actor,
          readThrough: body.data.readThrough,
        });
        await markMutationCommitted(request);
        reply.header("Cache-Control", "private, no-store");
        return reply.send(result);
      } catch (error) {
        await markMutationCommittedFromError(request, error);
        return sendRouteError(reply, error, request.log);
      }
    },
  );
}
