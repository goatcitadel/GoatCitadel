import type { FastifyInstance } from "fastify";
import { z } from "zod";

const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES = Math.ceil((MAX_ATTACHMENT_UPLOAD_BYTES * 4) / 3) + 16 * 1024;

// SECURITY (codex finding #9): MIME types that can be safely served
// inline because they cannot execute scripts in the embedding origin.
// `image/svg+xml` is intentionally OMITTED — SVG supports `<script>`
// blocks and is a stored-XSS vector.
export const CHAT_ATTACHMENT_PASSIVE_INLINE_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

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
        const uploaded = await fastify.services.chatAttachments.uploadChatAttachment(parsed.data);
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
      return reply.send(fastify.services.chatAttachments.getChatAttachment(params.data.attachmentId));
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
      const { record, bytes } = await fastify.services.chatAttachments.readChatAttachmentContent(
        params.data.attachmentId,
      );
      // SECURITY (codex finding #9): Attachments are uploaded with an
      // uploader-supplied MIME type. Without these headers, a `text/html`
      // or `image/svg+xml` attachment opened "inline" executes scripts
      // in the Mission Control origin and becomes stored XSS. We:
      //   1. always set `X-Content-Type-Options: nosniff` so browsers
      //      cannot upgrade a benign type into an active one,
      //   2. restrict `inline` disposition to a strict passive-MIME
      //      allowlist; everything else is forced to a download with
      //      `application/octet-stream`,
      //   3. force `Content-Disposition: attachment` on the download
      //      path regardless of the upload mime hint.
      const isPassiveInline =
        query.data.disposition === "inline" &&
        CHAT_ATTACHMENT_PASSIVE_INLINE_MIME.has((record.mimeType || "").toLowerCase());
      const responseContentType = isPassiveInline ? record.mimeType : "application/octet-stream";
      const responseDisposition = isPassiveInline ? "inline" : "attachment";
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("Content-Type", responseContentType);
      reply.header("Content-Disposition", `${responseDisposition}; filename="${encodeURIComponent(record.fileName)}"`);
      return reply.send(bytes);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
}
