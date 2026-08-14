import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { sessionParamsSchema } from "./chat.shared.js";

const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
  request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

const planParamsSchema = sessionParamsSchema.extend({
  planId: z.string().trim().min(1).max(256),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const sessionModelRequestSchema = z
  .object({
    kind: z.literal("session_model"),
    providerId: z.string().trim().min(1).max(256).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]).optional(),
  })
  .strict();

const createPlanSchema = z.discriminatedUnion("kind", [
  sessionModelRequestSchema,
  z
    .object({
      kind: z.literal("installation_default_model"),
      providerId: z.string().trim().min(1).max(256),
      model: z.string().trim().min(1).max(256),
    })
    .strict(),
  z.object({ kind: z.literal("channel_connection"), channelKind: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("capability_candidate"), proposalId: z.string().trim().min(1).max(256) }).strict(),
  z
    .object({
      kind: z.literal("product_source_update"),
      sourceInstallId: z.string().trim().min(1).max(256),
      changeSummary: z.string().trim().min(1).max(2_000),
      codeModeRunId: z.string().trim().min(1).max(256),
    })
    .strict(),
]);

const revisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

/**
 * The public Chat surface can request, review, confirm, or cancel an explicit
 * plan. It never accepts a free-form settings object, credential, patch, or
 * filesystem path; the Gateway resolves the allowlisted request at execution.
 */
export function registerChatChangePlanRoutes(fastify: FastifyInstance): void {
  const chatSupport = () => fastify.services.chatSupport;

  fastify.get("/api/v1/chat/sessions/:sessionId/change-plans", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send({ items: await chatSupport().listChatChangePlans(params.data.sessionId, query.data.limit) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/change-plans", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = createPlanSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const plan = await chatSupport().createChatChangePlan(params.data.sessionId, {
        requesterActorId: resolveActorId(request),
        request: body.data,
      });
      return reply.code(201).send(plan);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/change-plans/:planId/confirm", async (request, reply) => {
    const params = planParamsSchema.safeParse(request.params);
    const body = revisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await chatSupport().confirmChatChangePlan(
          params.data.sessionId,
          params.data.planId,
          body.data.expectedRevision,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/change-plans/:planId/cancel", async (request, reply) => {
    const params = planParamsSchema.safeParse(request.params);
    const body = revisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await chatSupport().cancelChatChangePlan(params.data.sessionId, params.data.planId, body.data.expectedRevision),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
}
