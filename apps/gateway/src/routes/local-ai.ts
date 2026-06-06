import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { LocalAiRouteService } from "../services/local-ai-route-service.js";

const backendSchema = z.enum(["ollama", "llama_cpp", "vllm", "sglang", "openai_compatible"]);

const downloadSchema = z.object({
  modelId: z.string().trim().min(1),
  backend: backendSchema,
  approvalMode: z.enum(["request", "dry_run"]).optional(),
});

const serveSchema = z.object({
  modelId: z.string().trim().min(1),
  backend: backendSchema,
  approvalMode: z.enum(["request", "dry_run"]).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

const serveStopParamsSchema = z.object({
  jobId: z.string().trim().min(1),
});

const endpointRegistrationSchema = z.object({
  label: z.string().trim().min(1).max(120),
  backend: backendSchema,
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1),
  providerId: z.string().trim().min(1).optional(),
});

export const localAiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/local-ai/readiness", async (_request, reply) => {
    return reply.send(await getLocalAiService(fastify).getReadiness());
  });

  fastify.post("/api/v1/local-ai/downloads", async (request, reply) => {
    const parsed = downloadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await getLocalAiService(fastify).startDownload(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/local-ai/serve", async (request, reply) => {
    const parsed = serveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await getLocalAiService(fastify).startServe(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/local-ai/serve/:jobId/stop", async (request, reply) => {
    const params = serveStopParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await getLocalAiService(fastify).requestServeStop(params.data.jobId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/local-ai/endpoints/register", async (request, reply) => {
    const parsed = endpointRegistrationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.code(201).send(getLocalAiService(fastify).registerEndpoint(parsed.data));
  });
};

function getLocalAiService(fastify: FastifyInstance): LocalAiRouteService {
  const services = (fastify as FastifyInstance & { services?: { localAi?: LocalAiRouteService } }).services;
  if (!services?.localAi) {
    throw new Error("Local AI route service is not registered.");
  }
  return services.localAi;
}
