import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const transcribeSchema = z.object({
  bytesBase64: z.string().min(1),
  mimeType: z.string().optional(),
  language: z.string().optional(),
});

const runtimeInstallSchema = z.object({
  modelId: z.string().min(1).optional(),
  activate: z.boolean().optional(),
  repair: z.boolean().optional(),
});

const talkCreateSchema = z.object({
  mode: z.enum(["push_to_talk", "wake"]).optional(),
  sessionId: z.string().optional(),
});

const talkParamsSchema = z.object({
  id: z.string().min(1),
});

const talkListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const modelParamsSchema = z.object({
  modelId: z.string().min(1),
});

export const voiceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/voice/transcribe", async (request, reply) => {
    const parsed = transcribeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.voice.transcribeVoice(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/voice/talk/sessions", async (request, reply) => {
    const parsed = talkCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await fastify.services.voice.startTalkSession(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/voice/talk/sessions", async (request, reply) => {
    const parsed = talkListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.voice.listVoiceTalkSessions(parsed.data.limit),
    });
  });

  fastify.post("/api/v1/voice/talk/sessions/:id/stop", async (request, reply) => {
    const params = talkParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.voice.stopTalkSession(params.data.id));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/voice/wake/start", async (_request, reply) => {
    try {
      return reply.send(await fastify.services.voice.startVoiceWake());
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/voice/wake/stop", async (_request, reply) => {
    return reply.send(fastify.services.voice.stopVoiceWake());
  });

  fastify.get("/api/v1/voice/status", async (_request, reply) => {
    return reply.send(await fastify.services.voice.getVoiceStatus());
  });

  fastify.get("/api/v1/voice/runtime", async (_request, reply) => {
    return reply.send(await fastify.services.voice.getVoiceRuntimeStatus());
  });

  fastify.post("/api/v1/voice/runtime/install", async (request, reply) => {
    const parsed = runtimeInstallSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.voice.installVoiceRuntime(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/voice/runtime/models/:modelId/select", async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.voice.selectVoiceRuntimeModel(params.data.modelId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/voice/runtime/models/:modelId", async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.voice.removeVoiceRuntimeModel(params.data.modelId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
