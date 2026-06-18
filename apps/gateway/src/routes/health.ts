import type { FastifyPluginAsync } from "fastify";

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, reply) => {
    const database = await fastify.services.health.getDatabaseHealthSnapshot();
    const ready = database.reachable && database.issues.length === 0;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "degraded",
      readiness: ready ? "ready" : "degraded",
      service: "gateway",
      database,
    });
  });
};
