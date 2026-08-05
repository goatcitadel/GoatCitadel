import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const scopeSchema = z.enum(["read", "interact", "state", "admin"]);

const listQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  status: z.enum(["active", "closed", "all"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const sessionParamsSchema = z.object({
  sessionId: z.string().trim().min(1),
});

const grantParamsSchema = sessionParamsSchema.extend({
  grantId: z.string().trim().min(1),
});

const createSessionSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
});

const grantSchema = z.object({
  actorId: z.string().trim().min(1),
  scopes: z.array(scopeSchema).min(1),
  allowedHosts: z.array(z.string().trim().min(1)).optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

const eventQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const grantQuerySchema = z.object({
  status: z.enum(["active", "revoked", "all"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const browserSessionsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  fastify.get("/api/v1/browser-sessions", operatorOnly, async (request, reply) => {
    try {
      const query = listQuerySchema.parse(request.query);
      return reply.send(await fastify.gatewayRuntime.browserSessionRuntimeService.listSessions(query));
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/browser-sessions", operatorOnly, async (request, reply) => {
    try {
      const body = createSessionSchema.parse(request.body);
      const session = await fastify.gatewayRuntime.browserSessionRuntimeService.createSession({
        ...body,
        actorId: resolveActorId(request),
      });
      return reply.code(201).send(session);
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/browser-sessions/:sessionId", operatorOnly, async (request, reply) => {
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      return reply.send(await fastify.gatewayRuntime.browserSessionRuntimeService.getSession(sessionId));
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/browser-sessions/:sessionId/state", operatorOnly, async (request, reply) => {
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      return reply.send(await fastify.gatewayRuntime.browserSessionRuntimeService.getStateProjection(sessionId));
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/browser-sessions/:sessionId", operatorOnly, async (request, reply) => {
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      return reply.send(
        await fastify.gatewayRuntime.browserSessionRuntimeService.closeSession(sessionId, resolveActorId(request)),
      );
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/browser-sessions/:sessionId/grants", operatorOnly, async (request, reply) => {
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const body = grantSchema.parse(request.body);
      return reply
        .code(201)
        .send(
          await fastify.gatewayRuntime.browserSessionRuntimeService.createGrant(
            sessionId,
            body,
            resolveActorId(request),
          ),
        );
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/browser-sessions/:sessionId/grants", operatorOnly, async (request, reply) => {
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = grantQuerySchema.parse(request.query);
      return reply.send(await fastify.gatewayRuntime.browserSessionRuntimeService.listGrants(sessionId, query));
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/browser-sessions/:sessionId/grants/:grantId", operatorOnly, async (request, reply) => {
    try {
      const { sessionId, grantId } = grantParamsSchema.parse(request.params);
      return reply.send(
        await fastify.gatewayRuntime.browserSessionRuntimeService.revokeGrant(
          sessionId,
          grantId,
          resolveActorId(request),
        ),
      );
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/browser-sessions/:sessionId/grants/:grantId/rotate", operatorOnly, async (request, reply) => {
    try {
      const { sessionId, grantId } = grantParamsSchema.parse(request.params);
      return reply.send(
        await fastify.gatewayRuntime.browserSessionRuntimeService.rotateGrant(
          sessionId,
          grantId,
          resolveActorId(request),
        ),
      );
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/browser-sessions/:sessionId/events", operatorOnly, async (request, reply) => {
    try {
      const { sessionId } = sessionParamsSchema.parse(request.params);
      const query = eventQuerySchema.parse(request.query);
      return reply.send(await fastify.gatewayRuntime.browserSessionRuntimeService.listEvents(sessionId, query.limit));
    } catch (error) {
      return sendBrowserSessionRouteError(reply, error, request.log);
    }
  });
};

function sendBrowserSessionRouteError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyBaseLogger,
): ReturnType<FastifyReply["send"]> {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: error.flatten() });
  }
  return sendRouteError(reply, error, log);
}
