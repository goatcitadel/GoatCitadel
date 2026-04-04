import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const llmApiStyleSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

const updateConfigSchema = z.object({
  activeProviderId: z.string().optional(),
  activeModel: z.string().optional(),
  upsertProvider: z.object({
    providerId: z.string().min(1),
    label: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    apiStyle: llmApiStyleSchema.optional(),
    defaultModel: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    headers: z.record(z.string()).optional(),
  }).optional(),
});

const modelQuerySchema = z.object({
  providerId: z.string().min(1).optional(),
});

const modelPreviewSchema = z.object({
  providerId: z.string().min(1),
  baseUrl: z.string().url(),
  apiStyle: llmApiStyleSchema.optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  headers: z.record(z.string()).optional(),
});

const chatCompletionSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  messages: z.array(z.object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(z.record(z.unknown()))]),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
  })).min(1),
  memory: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(["qmd", "off"]).optional(),
    sessionId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    maxContextTokens: z.number().int().positive().optional(),
    forceRefresh: z.boolean().optional(),
  }).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  reasoning: z.object({
    effort: z.enum(["none", "low", "medium", "high", "xhigh"]),
  }).optional(),
  verbosity: z.enum(["low", "medium", "high"]).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.record(z.unknown())).optional(),
  tool_choice: z.union([z.string(), z.record(z.unknown())]).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  response_format: z.record(z.unknown()).optional(),
  service_tier: z.string().min(1).optional(),
  prompt_cache_retention: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const llmRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/llm/providers", async (_request, reply) => {
    return reply.send({ items: fastify.gateway.listLlmProviders() });
  });

  fastify.get("/api/v1/llm/config", async (_request, reply) => {
    return reply.send(fastify.gateway.getLlmConfig());
  });

  fastify.patch("/api/v1/llm/config", async (request, reply) => {
    const parsed = updateConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.updateLlmConfig(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llm/models", async (request, reply) => {
    const parsed = modelQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send({ items: await fastify.gateway.listLlmModels(parsed.data.providerId) });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llm/models/preview", async (request, reply) => {
    const parsed = modelPreviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(await fastify.gateway.previewLlmModels(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llm/chat-completions", async (request, reply) => {
    const parsed = chatCompletionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const result = await fastify.gateway.createChatCompletion(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
