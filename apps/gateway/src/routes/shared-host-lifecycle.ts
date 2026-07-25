import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import {
  MAX_SHARED_HOST_DRAIN_TIMEOUT_MS,
  MIN_SHARED_HOST_DRAIN_TIMEOUT_MS,
  SharedHostDrainDisabledError,
  resolveSharedHostDrainTimeoutMs,
} from "../services/shared-host-lifecycle-service.js";
import { withRouteAccess } from "./route-access.js";

const drainBodySchema = z
  .object({
    mode: z.enum(["pause", "force"]).default("pause"),
    timeoutMs: z.number().int().min(MIN_SHARED_HOST_DRAIN_TIMEOUT_MS).max(MAX_SHARED_HOST_DRAIN_TIMEOUT_MS).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const sharedHostLifecycleRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.get("/api/v1/ops/shared-host", operatorOnly, async (_request, reply) => {
    return reply.send({ lifecycle: fastify.sharedHostLifecycle.snapshot() });
  });

  fastify.post("/api/v1/ops/shared-host/drain", operatorOnly, async (request, reply) => {
    const parsed = drainBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const result = await fastify.sharedHostLifecycle.drain({
        mode: parsed.data.mode,
        timeoutMs: parsed.data.timeoutMs ?? resolveSharedHostDrainTimeoutMs(),
        reason: parsed.data.reason,
        actorId: request.authActorId || "operator",
      });
      const statusCode = result.outcome === "timed_out" ? 202 : 200;
      return reply.code(statusCode).send({
        ...result,
        requiresProcessTermination: result.snapshot.state === "closing",
      });
    } catch (error) {
      if (error instanceof SharedHostDrainDisabledError) {
        return reply.code(409).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });
};
