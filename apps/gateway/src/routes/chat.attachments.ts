import type { FastifyInstance } from "fastify";
import { z } from "zod";

const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES = Math.ceil((MAX_ATTACHMENT_UPLOAD_BYTES * 4) / 3) + 16 * 1024;

const attachmentUploadSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().optional(),
  fileName: z.string().min(1),
  mimeType: z.string().default("application/octet-stream"),
  bytesBase64: z.string().min(1),
});

const attachmentParamsSchema = z.object({
  attachmentId: z.string().min(1),
});

const attachmentContentQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).default("attachment"),
});

export function registerChatAttachmentRoutes(fastify: FastifyInstance): void {
  fastify.post(
    "/api/v1/chat/attachments",
    {
      bodyLimit: MAX_ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES,
    },
    async (request, reply) => {
      const parsed = attachmentUploadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        const uploaded = await fastify.gateway.uploadChatAttachment(parsed.data);
        return reply.code(201).send(uploaded);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.get("/api/v1/chat/attachments/:attachmentId", async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getChatAttachment(params.data.attachmentId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/attachments/:attachmentId/content", async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    const query = attachmentContentQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const { record, bytes } = await fastify.gateway.readChatAttachmentContent(params.data.attachmentId);
      reply.header("Content-Type", record.mimeType || "application/octet-stream");
      reply.header(
        "Content-Disposition",
        `${query.data.disposition}; filename="${encodeURIComponent(record.fileName)}"`,
      );
      return reply.send(bytes);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
}
