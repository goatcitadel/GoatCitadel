import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const createMediaJobSchema = z.object({
  type: z.enum(["ocr", "vision", "audio_transcribe", "video_transcribe", "analyze"]),
  sessionId: z.string().optional(),
  attachmentId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});

const mediaJobParamsSchema = z.object({
  jobId: z.string().min(1),
});

const mediaListQuerySchema = z.object({
  sessionId: z.string().optional(),
});

const attachmentParamsSchema = z.object({
  attachmentId: z.string().min(1),
});

export const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/media/jobs", async (request, reply) => {
    const parsed = createMediaJobSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await fastify.services.media.createMediaJob(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/media/jobs/:jobId", async (request, reply) => {
    const params = mediaJobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.media.getMediaJob(params.data.jobId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/media/jobs", async (request, reply) => {
    const query = mediaListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return reply.send({
      items: await fastify.services.media.listMediaJobs(query.data.sessionId),
    });
  });

  fastify.get("/api/v1/chat/attachments/:attachmentId/preview", async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.media.getChatAttachmentPreview(params.data.attachmentId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
};
