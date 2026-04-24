import type { FastifyPluginAsync } from "fastify";

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async () => ({
    status: "ok",
    service: "gateway",
    database: await fastify.services.health.getDatabaseHealthSnapshot(),
  }));
};
