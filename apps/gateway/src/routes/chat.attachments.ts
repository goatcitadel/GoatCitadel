import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GoatError } from "@goatcitadel/contracts";
import { isStreamedRequestBody } from "../services/streamed-upload.js";
import { sendRouteError } from "./_error-handler.js";

/** Base64 JSON stays for small files; anything larger streams as `application/octet-stream`. */
const MAX_JSON_ATTACHMENT_BODY_BYTES = 1024 * 1024;

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

const streamedAttachmentQuerySchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  fileName: z.string().min(1).max(1024),
  mimeType: z.string().max(255).default("application/octet-stream"),
});

const streamedAttachmentHeadersSchema = z.object({
  "content-length": z.string().regex(/^\d{1,15}$/u),
  "x-content-sha256": z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/u)
    .transform((value) => value.toLowerCase())
    .optional(),
});

const attachmentParamsSchema = z.object({
  attachmentId: z.string().min(1),
});

const attachmentContentQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).default("attachment"),
});

export function registerChatAttachmentRoutes(fastify: FastifyInstance): void {
  // Its own scope, so the raw-stream parser applies to the upload route alone.
  void fastify.register(async (scope) => {
    // Hand the body over unread; the service streams it to disk, counting bytes itself
    // (Fastify's bodyLimit only applies to parsers that buffer).
    scope.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));

    scope.post(
      "/api/v1/chat/attachments",
      {
        bodyLimit: MAX_JSON_ATTACHMENT_BODY_BYTES,
      },
      async (request, reply) => {
        if (isStreamedRequestBody(request.body)) {
          const query = streamedAttachmentQuerySchema.safeParse(request.query);
          const headers = streamedAttachmentHeadersSchema.safeParse(request.headers);
          if (!headers.success && !request.headers["content-length"]) {
            return reply.code(411).send({ error: "Content-Length is required for a streamed upload." });
          }
          if (!query.success || !headers.success) {
            return reply.code(400).send({
              error: {
                query: query.success ? undefined : query.error.flatten(),
                headers: headers.success ? undefined : headers.error.flatten(),
              },
            });
          }
          try {
            const uploaded = await fastify.services.chatAttachments.uploadChatAttachment({
              ...query.data,
              stream: {
                body: request.body,
                declaredBytes: Number(headers.data["content-length"]),
                ...(headers.data["x-content-sha256"] ? { contentSha256: headers.data["x-content-sha256"] } : {}),
              },
            });
            return reply.code(201).send(uploaded);
          } catch (error) {
            // Typed errors keep their status (413 too large, 400 bad hash); the rest stay 400, as for JSON.
            if (error instanceof GoatError) return sendRouteError(reply, error, request.log);
            return reply.code(400).send({ error: (error as Error).message });
          }
        }

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
  });

  fastify.get("/api/v1/chat/attachments/:attachmentId", async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.chatAttachments.getChatAttachment(params.data.attachmentId));
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
