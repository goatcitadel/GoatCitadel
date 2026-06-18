import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";

const createMediaJobSchema = z.object({
  type: z.enum(["ocr", "vision", "audio_transcribe", "video_transcribe", "video_derivatives", "analyze"]),
  sessionId: z.string().optional(),
  attachmentId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});

const mediaPlaybackSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chat_attachment"),
    attachmentId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("media_artifact"),
    artifactId: z.string().min(1),
  }),
]);

const mediaPlaybackTokenSchema = z.object({
  source: mediaPlaybackSourceSchema,
  variantId: z.enum(["original", "standard", "data_saver", "poster"]).optional(),
});

const mediaJobParamsSchema = z.object({
  jobId: z.string().min(1),
});

const mediaArtifactParamsSchema = z.object({
  artifactId: z.string().min(1),
});

const mediaArtifactContentQuerySchema = z.object({
  media_token: z.string().min(1),
});

const mediaListQuerySchema = z.object({
  sessionId: z.string().optional(),
});

const attachmentParamsSchema = z.object({
  attachmentId: z.string().min(1),
});

export const mediaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/media/playback-token", async (request, reply) => {
    const parsed = mediaPlaybackTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.media.issueMediaPlaybackToken(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/media/jobs", async (request, reply) => {
    const parsed = createMediaJobSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.media.createMediaJob(parsed.data));
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
      return reply.send(fastify.services.media.getMediaJob(params.data.jobId));
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
      items: fastify.services.media.listMediaJobs(query.data.sessionId),
    });
  });

  fastify.get("/api/v1/media/artifacts/:artifactId/content", async (request, reply) => {
    const params = mediaArtifactParamsSchema.safeParse(request.params);
    const query = mediaArtifactContentQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    const source = { kind: "media_artifact" as const, artifactId: params.data.artifactId };
    if (
      !fastify.services.media.validateMediaPlaybackToken({
        token: query.data.media_token,
        source,
      })
    ) {
      return reply.code(401).send({ error: "Media playback token is invalid or expired." });
    }
    try {
      const artifact = await fastify.services.media.resolveMediaArtifactContent(params.data.artifactId);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("Content-Type", artifact.mimeType);
      reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(params.data.artifactId)}"`);
      return sendRangeAwareFile(reply, request.headers.range, artifact.fullPath, artifact.sizeBytes);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/attachments/:attachmentId/preview", async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.media.getChatAttachmentPreview(params.data.attachmentId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
};

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
    return {
      kind: "partial",
      start: Math.max(0, sizeBytes - suffixLength),
      end: sizeBytes - 1,
    };
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
