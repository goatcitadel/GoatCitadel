import type { FastifyPluginAsync } from "fastify";
import { projectProviderRuntimePublicValue } from "../services/provider-settings-public-projection.js";

export const npuRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/npu/status", async (_request, reply) => {
    return reply.send(projectProviderRuntimePublicValue(fastify.services.npu.getNpuStatus()));
  });

  fastify.get("/api/v1/npu/models", async (_request, reply) => {
    try {
      const items = await fastify.services.npu.listNpuModels();
      return reply.send(projectProviderRuntimePublicValue({ items }));
    } catch (error) {
      return reply.code(503).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/npu/start", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.npu.startNpuRuntime()));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/npu/stop", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.npu.stopNpuRuntime()));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/npu/refresh", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.npu.refreshNpuRuntime()));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
