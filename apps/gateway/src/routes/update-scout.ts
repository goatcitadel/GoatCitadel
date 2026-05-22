import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const scoutSourceSchema = z.object({
  sourceRef: z.string().trim().min(1),
  sourceType: z.enum(["skill", "package", "repo", "url"]).optional(),
  currentVersion: z.string().trim().min(1).optional(),
});

const scoutRequestSchema = z.object({
  sources: z.array(scoutSourceSchema).min(1).max(50),
  workspaceId: z.string().trim().min(1).max(80).optional(),
  createImprovementCandidate: z.boolean().optional(),
});

export const updateScoutRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.post("/api/v1/update-scout/reports", operatorOnly, async (request, reply) => {
    const parsed = scoutRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.updateScout.scout(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
