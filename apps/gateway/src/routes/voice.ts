import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { OpenAIRealtimeVoiceError } from "../services/openai-realtime-voice-service.js";

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

const realtimeClientSecretSchema = z.object({
  surface: z.enum(["chat", "google-meet"]),
  sessionId: z.string().min(1).optional(),
  meetingSessionId: z.string().min(1).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  voice: z.string().trim().min(1).max(64).optional(),
  instructionsProfile: z.string().trim().min(1).max(128).optional(),
});

const talkParamsSchema = z.object({
  id: z.string().min(1),
});

const talkListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const meetStartSchema = z.object({
  meetingUrl: z.string().url(),
  displayName: z.string().optional(),
  accountRef: z.string().optional(),
  provider: z.enum(["openai-realtime", "local-transcription"]).optional(),
  userStartConfirmed: z.boolean().optional(),
  browserTransportReady: z.boolean().optional(),
  audioTransportReady: z.boolean().optional(),
});

const meetPrerequisitesSchema = z.object({
  meetingUrl: z.string().url().optional(),
  displayName: z.string().optional(),
  accountRef: z.string().optional(),
  provider: z.enum(["openai-realtime", "local-transcription"]).optional(),
  userStartConfirmed: z.boolean().optional(),
  browserTransportReady: z.boolean().optional(),
  audioTransportReady: z.boolean().optional(),
});

const meetParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const meetTranscriptSchema = z.object({
  text: z.string().min(1),
  speaker: z.string().optional(),
  final: z.boolean().default(false),
  provider: z.enum(["openai-realtime", "local-transcription"]),
});

const meetConsultSchema = z.object({
  target: z
    .enum(["chat", "cowork", "code"])
    .transform(() => "chat" as const)
    .optional(),
  prompt: z.string().optional(),
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

  fastify.post("/api/v1/voice/realtime/client-secret", async (request, reply) => {
    const parsed = realtimeClientSecretSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await fastify.services.voice.createRealtimeVoiceClientSecret(parsed.data));
    } catch (error) {
      const statusCode = error instanceof OpenAIRealtimeVoiceError ? error.statusCode : 502;
      return reply.code(statusCode).send({ error: (error as Error).message });
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

  fastify.get("/api/v1/voice/google-meet/sessions", async (_request, reply) => {
    return reply.send({
      items: fastify.services.voice.listGoogleMeetSessions(),
    });
  });

  fastify.post("/api/v1/voice/google-meet/prerequisites", async (request, reply) => {
    const parsed = meetPrerequisitesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.services.voice.getGoogleMeetPrerequisiteStatus(parsed.data));
  });

  fastify.post("/api/v1/voice/google-meet/sessions", async (request, reply) => {
    const parsed = meetStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.code(201).send(fastify.services.voice.startGoogleMeetSession(parsed.data));
  });

  fastify.post("/api/v1/voice/google-meet/sessions/:sessionId/transcript", async (request, reply) => {
    const params = meetParamsSchema.safeParse(request.params);
    const body = meetTranscriptSchema.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(fastify.services.voice.appendGoogleMeetTranscriptChunk(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/voice/google-meet/sessions/:sessionId/consult", async (request, reply) => {
    const params = meetParamsSchema.safeParse(request.params);
    const body = meetConsultSchema.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(fastify.services.voice.createGoogleMeetConsultHandoff(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/voice/google-meet/sessions/:sessionId/stop", async (request, reply) => {
    const params = meetParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.voice.stopGoogleMeetSession(params.data.sessionId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
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
