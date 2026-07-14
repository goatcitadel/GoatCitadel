import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const findingSchema = z.object({
  source: z.string().trim().min(1),
  component: z.string().trim().min(1),
  title: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).min(1),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  summary: z.string().trim().min(1).optional(),
  evidenceRef: z.string().trim().min(1).optional(),
});

const importFindingsSchema = z.object({
  findings: z.array(findingSchema).min(1).max(200),
});

export const reviewReadinessRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  fastify.get("/api/v1/review/readiness", operatorOnly, async (request, reply) => {
    try {
      return reply.send(fastify.gatewayRuntime.reviewReadinessService.getReadiness());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/review/identity", operatorOnly, async (request, reply) => {
    try {
      return reply.send(fastify.gatewayRuntime.reviewReadinessService.getRuntimeIdentity());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/readiness/runtime-release/refresh", operatorOnly, async (request, reply) => {
    try {
      return reply.send(await fastify.gatewayRuntime.reviewReadinessService.refreshRuntimeReleaseTrust());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/findings/import", operatorOnly, async (request, reply) => {
    try {
      const body = importFindingsSchema.parse(request.body);
      return reply.send(
        fastify.gatewayRuntime.reviewReadinessService.importFindings({
          findings: body.findings,
          actorId: resolveActorId(request),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
