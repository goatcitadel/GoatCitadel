import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const advisorRequestSchema = z.object({
  modelPath: z.string().optional(),
  modelId: z.string().optional(),
});

export const llamaCppRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/llamacpp/status", async (_request, reply) => {
    return reply.send(fastify.gateway.getLlamaCppStatus());
  });

  fastify.get("/api/v1/llamacpp/models", async (_request, reply) => {
    try {
      const items = await fastify.gateway.listLlamaCppModels();
      return reply.send({ items });
    } catch (error) {
      return reply.code(503).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/start", async (_request, reply) => {
    try {
      return reply.send(await fastify.gateway.startLlamaCppRuntime());
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/stop", async (_request, reply) => {
    try {
      return reply.send(await fastify.gateway.stopLlamaCppRuntime());
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/refresh", async (_request, reply) => {
    try {
      return reply.send(await fastify.gateway.refreshLlamaCppRuntime());
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/advisor", async (request, reply) => {
    const parsed = advisorRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid advisor request" });
    }
    try {
      return reply.send(await fastify.gateway.adviseLlamaCppRuntime(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
