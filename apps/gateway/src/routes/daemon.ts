import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const logsQuerySchema = z.object({
  tail: z.coerce.number().int().positive().max(2000).default(200),
});

export const daemonRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/daemon/status", async (_request, reply) => {
    return reply.send(await fastify.services.daemon.getDaemonStatus());
  });

  fastify.post("/api/v1/daemon/start", async (_request, reply) => {
    return reply.send(await fastify.services.daemon.daemonStart());
  });

  fastify.post("/api/v1/daemon/stop", async (_request, reply) => {
    return reply.send(await fastify.services.daemon.daemonStop());
  });

  fastify.post("/api/v1/daemon/restart", async (_request, reply) => {
    return reply.send(await fastify.services.daemon.daemonRestart());
  });

  fastify.get("/api/v1/daemon/logs", async (request, reply) => {
    const parsed = logsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: await fastify.services.daemon.listDaemonLogs(parsed.data.tail),
    });
  });
};
