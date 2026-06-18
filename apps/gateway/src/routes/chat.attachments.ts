import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import {
  detectAttachmentMediaType,
  sniffAttachmentBytes,
  type SniffedMediaClass,
} from "../services/media-voice-service.js";

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

const CHAT_ATTACHMENT_TOKENIZED_MEDIA_INLINE_MIME_PREFIXES = ["audio/", "video/"] as const;
const SNIFFED_MISMATCH_CLASSES = new Set<SniffedMediaClass>(["image", "audio", "video", "archive", "document", "text"]);
const MEDIA_PREFIX_SNIFF_BYTES = 64;

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
  media_token: z.string().min(1).optional(),
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
      const content = await resolveAttachmentContentForRoute(fastify, params.data.attachmentId);
      const { record } = content;
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
      const mediaTokenValid = query.data.media_token
        ? Boolean(
            fastify.services.media?.validateMediaPlaybackToken?.({
              token: query.data.media_token,
              source: {
                kind: "chat_attachment",
                attachmentId: params.data.attachmentId,
              },
              variantId: "original",
            }),
          )
        : false;
      const isPassiveInline =
        query.data.disposition === "inline" &&
        CHAT_ATTACHMENT_PASSIVE_INLINE_MIME.has((record.mimeType || "").toLowerCase());
      const isTokenizedInlineMedia =
        query.data.disposition === "inline" &&
        mediaTokenValid &&
        (await isSafeTokenizedInlineMedia(content.fullPath, record.mimeType, record.mediaType));
      if (query.data.media_token && !isTokenizedInlineMedia) {
        return reply.code(mediaTokenValid ? 415 : 401).send({
          error: mediaTokenValid
            ? "Attachment is not safe for tokenized inline media playback."
            : "Media playback token is invalid or expired.",
        });
      }
      const isInline = isPassiveInline || isTokenizedInlineMedia;
      const responseContentType = isInline ? record.mimeType : "application/octet-stream";
      const responseDisposition = isInline ? "inline" : "attachment";
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("Content-Type", responseContentType);
      reply.header("Content-Disposition", `${responseDisposition}; filename="${encodeURIComponent(record.fileName)}"`);
      if (content.fullPath && isTokenizedInlineMedia) {
        return sendRangeAwareFile(reply, request.headers.range, content.fullPath, content.sizeBytes);
      }
      return reply.send(content.bytes ?? (content.fullPath ? await fs.readFile(content.fullPath) : Buffer.alloc(0)));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
}

async function resolveAttachmentContentForRoute(
  fastify: FastifyInstance,
  attachmentId: string,
): Promise<{
  record: {
    fileName: string;
    mimeType: string;
    mediaType?: string;
  };
  fullPath?: string;
  sizeBytes: number;
  bytes?: Buffer;
}> {
  const resolver = fastify.services.chatAttachments.resolveChatAttachmentContent as
    | ((id: string) => Promise<{
        record: {
          fileName: string;
          mimeType: string;
          mediaType?: string;
        };
        fullPath: string;
        sizeBytes: number;
      }>)
    | undefined;
  if (typeof resolver === "function") {
    return resolver(attachmentId);
  }
  const content = await fastify.services.chatAttachments.readChatAttachmentContent(attachmentId);
  return {
    record: content.record,
    fullPath: content.fullPath,
    sizeBytes: content.bytes.length,
    bytes: content.bytes,
  };
}

async function isSafeTokenizedInlineMedia(
  fullPath: string | undefined,
  mimeType: string,
  storedMediaType?: string,
): Promise<boolean> {
  if (!fullPath) {
    return false;
  }
  const normalizedMime = mimeType.toLowerCase();
  if (!CHAT_ATTACHMENT_TOKENIZED_MEDIA_INLINE_MIME_PREFIXES.some((prefix) => normalizedMime.startsWith(prefix))) {
    return false;
  }
  const mediaType = storedMediaType ?? detectAttachmentMediaType(mimeType);
  if (mediaType !== "audio" && mediaType !== "video") {
    return false;
  }
  const sniffed = sniffAttachmentBytes(await readFilePrefix(fullPath, MEDIA_PREFIX_SNIFF_BYTES));
  return sniffed === "unknown" || !SNIFFED_MISMATCH_CLASSES.has(sniffed) || sniffed === mediaType;
}

async function readFilePrefix(fullPath: string, maxBytes: number): Promise<Buffer> {
  const file = await fs.open(fullPath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await file.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await file.close();
  }
}

function sendRangeAwareFile(reply: FastifyReply, rangeHeader: string | undefined, fullPath: string, sizeBytes: number) {
  reply.header("Accept-Ranges", "bytes");
  const range = parseRangeHeader(rangeHeader, sizeBytes);
  if (range.kind === "invalid") {
    reply.header("Content-Range", `bytes */${sizeBytes}`);
    return reply.code(416).send();
  }
  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : Math.max(0, sizeBytes - 1);
  const contentLength = sizeBytes === 0 ? 0 : end - start + 1;
  reply.header("Content-Length", String(contentLength));
  if (range.kind === "partial") {
    reply.header("Content-Range", `bytes ${start}-${end}/${sizeBytes}`);
    reply.code(206);
  }
  if (sizeBytes === 0) {
    return reply.send(Buffer.alloc(0));
  }
  return reply.send(createReadStream(fullPath, { start, end }));
}

function parseRangeHeader(
  rangeHeader: string | undefined,
  sizeBytes: number,
): { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "invalid" } {
  if (!rangeHeader) {
    return { kind: "full" };
  }
  if (sizeBytes <= 0 || !rangeHeader.startsWith("bytes=") || rangeHeader.includes(",")) {
    return { kind: "invalid" };
  }
  const raw = rangeHeader.slice("bytes=".length).trim();
  const match = /^(\d*)-(\d*)$/.exec(raw);
  if (!match) {
    return { kind: "invalid" };
  }
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return { kind: "invalid" };
  }
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "invalid" };
    }
    const start = Math.max(0, sizeBytes - suffixLength);
    return { kind: "partial", start, end: sizeBytes - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= sizeBytes
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "partial",
    start,
    end: Math.min(requestedEnd, sizeBytes - 1),
  };
}
