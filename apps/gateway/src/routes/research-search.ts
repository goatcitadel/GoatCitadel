import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(512),
  mode: z.enum(["quick", "research"]).optional(),
  providers: z
    .array(z.enum(["brave", "parallel"]))
    .max(2)
    .optional(),
  engines: z.array(z.string().trim().min(1)).optional(),
  maxResults: z.number().int().positive().max(50).optional(),
  freshness: z.enum(["any", "day", "week", "month"]).optional(),
  workspaceId: z.string().trim().min(1).max(80).optional(),
});

export const researchSearchRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.post("/api/v1/research/search", operatorOnly, async (request, reply) => {
    const parsed = searchRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(
        await fastify.services.researchSearch.search({
          ...parsed.data,
          engines: parsed.data.engines as never,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
