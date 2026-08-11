import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChatCompactionBreakerActionService } from "../services/chat-compaction-breaker-action-service.js";
import { withRouteAccess } from "./route-access.js";

const sessionParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(256),
});

const actionParamsSchema = sessionParamsSchema.extend({
  actionId: z.string().uuid(),
});

const createActionSchema = z
  .object({
    dimensionHash: z.string().trim().min(1).max(128),
    actionKind: z.enum(["force", "repair"]),
    expectedBreakerRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(512),
    expiresInSeconds: z.number().int().min(30).max(300).optional(),
    approvalId: z.string().trim().min(1).max(256),
  })
  .strict();

const createApprovalRequestSchema = z
  .object({
    dimensionHash: z.string().trim().min(1).max(128),
    actionKind: z.enum(["force", "repair"]),
    expectedBreakerRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(512),
    expiresInSeconds: z.number().int().min(30).max(300).optional(),
  })
  .strict();

/**
 * Registers the governed breaker endpoints without decorating shared Gateway
 * services. The root composition owner supplies the concrete service and its
 * deny-wins policy, approval, audit, and canonical Chat execution ports.
 */
export async function registerChatCompactionBreakerActionRoutes(
  fastify: FastifyInstance,
  service: ChatCompactionBreakerActionService = fastify.services.chatCompactionBreakerActions,
): Promise<void> {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.post(
    "/api/v1/chat/sessions/:sessionId/compaction-breaker/approval-requests",
    operatorOnly,
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      const body = createApprovalRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
      }
      const actorId = resolveSpecificOperator(request, reply);
      if (!actorId) {
        return reply;
      }
      try {
        return reply.code(201).send(
          await service.requestApproval({
            sessionId: params.data.sessionId,
            actorId,
            request: body.data,
          }),
        );
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  fastify.post("/api/v1/chat/sessions/:sessionId/compaction-breaker/actions", operatorOnly, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = createActionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    const actorId = resolveSpecificOperator(request, reply);
    if (!actorId) {
      return reply;
    }
    try {
      const action = await service.createAction({
        sessionId: params.data.sessionId,
        actorId,
        request: body.data,
      });
      return reply.code(201).send({ action });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  fastify.get(
    "/api/v1/chat/sessions/:sessionId/compaction-breaker/actions/:actionId",
    operatorOnly,
    async (request, reply) => {
      const params = actionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      const actorId = resolveSpecificOperator(request, reply);
      if (!actorId) {
        return reply;
      }
      try {
        return reply.send({ action: await service.inspectAction({ ...params.data, actorId }) });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  fastify.post(
    "/api/v1/chat/sessions/:sessionId/compaction-breaker/actions/:actionId/repair",
    operatorOnly,
    async (request, reply) => {
      const params = actionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      const actorId = resolveSpecificOperator(request, reply);
      if (!actorId) {
        return reply;
      }
      try {
        return reply.send(await service.repair({ ...params.data, actorId }));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );
}

function resolveSpecificOperator(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (
    request.authActorSource !== "token" &&
    request.authActorSource !== "basic" &&
    request.authActorSource !== "loopback"
  ) {
    void reply.code(403).send({ error: "An authenticated operator route is required" });
    return undefined;
  }
  const actorId = request.authActorId?.trim();
  if (!actorId || actorId === "auth:none") {
    void reply.code(401).send({ error: "A specific authenticated operator identity is required" });
    return undefined;
  }
  return actorId;
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (isGoatError(error)) {
    return reply.code(error.httpStatus).send(error.toJSON());
  }
  if (error instanceof RangeError) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

function isGoatError(error: unknown): error is {
  httpStatus: number;
  toJSON(): Record<string, unknown>;
} {
  return Boolean(
    error &&
    typeof error === "object" &&
    typeof (error as { httpStatus?: unknown }).httpStatus === "number" &&
    typeof (error as { toJSON?: unknown }).toJSON === "function",
  );
}
