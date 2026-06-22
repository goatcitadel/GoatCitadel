import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";

const listQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const evidenceRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.get("/api/v1/evidence/envelopes", operatorOnly, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.evidence.listEnvelopes(parsed.data),
    });
  });
};
