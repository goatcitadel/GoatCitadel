import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const summaryQuery = z.object({
  scope: z.enum(["session", "day", "agent", "task"]).default("day"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const costsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/costs/summary", async (request, reply) => {
    const parsed = summaryQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const now = new Date();
    const to = parsed.data.to ?? now.toISOString();
    const from = parsed.data.from ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const items = fastify.services.costs.costSummary(parsed.data.scope, from, to);
    const dailySeries = fastify.services.costs.costDailySeries(from, to);
    const usageAvailability = fastify.services.costs.costUsageAvailability(from, to);
    return reply.send({
      items,
      dailySeries,
      scope: parsed.data.scope,
      from,
      to,
      usageAvailability,
    });
  });

  fastify.post("/api/v1/costs/run-cheaper", async (_request, reply) => {
    return reply.send(fastify.services.costs.runCheaper());
  });
};
