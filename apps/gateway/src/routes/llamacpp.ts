import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { projectProviderRuntimePublicValue } from "../services/provider-settings-public-projection.js";

const advisorRequestSchema = z.object({
  modelPath: z.string().optional(),
  modelId: z.string().optional(),
});

const huggingFaceDownloadSchema = z.object({
  repo: z.string().min(3),
  filename: z.string().min(1),
  alias: z.string().min(1).optional(),
  mmprojFilename: z.string().min(1).optional(),
  sha256: z.string().min(64).max(64).optional(),
  mmprojSha256: z.string().min(64).max(64).optional(),
});

const downloadJobParamsSchema = z.object({
  jobId: z.string().min(1),
});
const workspaceQuerySchema = z.object({ workspaceId: z.string().min(1).max(128).optional() });
const managedSelectionSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    modelId: z.string().min(1).max(512),
    commandPath: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const llamaCppRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/llamacpp/setup", async (request, reply) => {
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid workspace id." });
    return reply.send(
      projectProviderRuntimePublicValue(
        await fastify.services.llamaCpp.getLlamaCppSetup(query.data.workspaceId ?? "default"),
      ),
    );
  });

  fastify.post("/api/v1/llamacpp/setup/managed-selection", async (request, reply) => {
    const parsed = managedSelectionSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid selection." });
    try {
      return reply.send(await fastify.services.llamaCpp.stageLlamaCppManagedSelection(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/setup/chat-test", async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid workspace id." });
    try {
      return reply.send(await fastify.services.llamaCpp.testLlamaCppChat(parsed.data.workspaceId ?? "default"));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llamacpp/status", async (_request, reply) => {
    return reply.send(projectProviderRuntimePublicValue(await fastify.services.llamaCpp.refreshLlamaCppRuntime()));
  });

  fastify.get("/api/v1/llamacpp/install", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llamaCpp.detectLlamaCppInstall()));
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llamacpp/models", async (_request, reply) => {
    try {
      const items = await fastify.services.llamaCpp.listLlamaCppModels();
      return reply.send(projectProviderRuntimePublicValue({ items }));
    } catch (error) {
      const message = (error as Error).message;
      fastify.log.debug({ err: error }, "llama.cpp model discovery degraded");
      return reply.send(
        projectProviderRuntimePublicValue({
          items: [],
          degraded: true,
          warning: message || "llama.cpp model discovery is unavailable.",
        }),
      );
    }
  });

  fastify.post("/api/v1/llamacpp/start", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llamaCpp.startLlamaCppRuntime()));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/stop", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llamaCpp.stopLlamaCppRuntime()));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/refresh", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llamaCpp.refreshLlamaCppRuntime()));
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
      return reply.send(
        projectProviderRuntimePublicValue(await fastify.services.llamaCpp.adviseLlamaCppRuntime(parsed.data)),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/huggingface/download", async (request, reply) => {
    const parsed = huggingFaceDownloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid Hugging Face request" });
    }
    try {
      return reply
        .code(202)
        .send(
          projectProviderRuntimePublicValue(
            await fastify.services.llamaCpp.startLlamaCppHuggingFaceDownload(parsed.data),
          ),
        );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llamacpp/huggingface/downloads/:jobId", async (request, reply) => {
    const params = downloadJobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.issues[0]?.message ?? "Invalid download job id" });
    }
    try {
      return reply.send(
        projectProviderRuntimePublicValue(fastify.services.llamaCpp.getLlamaCppHuggingFaceDownload(params.data.jobId)),
      );
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llamacpp/huggingface/downloads/:jobId/cancel", async (request, reply) => {
    const params = downloadJobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.issues[0]?.message ?? "Invalid download job id" });
    }
    try {
      return reply.send(
        projectProviderRuntimePublicValue(
          fastify.services.llamaCpp.cancelLlamaCppHuggingFaceDownload(params.data.jobId),
        ),
      );
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
};
