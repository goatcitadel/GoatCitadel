import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  MAX_FILE_UPLOAD_BYTES,
  MAX_HTML_PREVIEW_BYTES,
  MAX_INLINE_FILE_DOWNLOAD_BYTES,
} from "../services/files-route-service.js";
import { sendRouteError } from "./_error-handler.js";

const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_FILE_UPLOAD_BYTES * 1.05) + 4096;
const FILE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'none'; style-src 'self'; img-src data: blob:; font-src 'none'; connect-src 'none'";
const BROWSER_ACTIVE_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/pdf",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/html",
  "text/javascript",
  "text/xml",
]);

const uploadSchema = z.object({
  relativePath: z.string().min(1).max(2048),
  content: z.string().max(MAX_FILE_UPLOAD_BYTES),
});

const downloadQuerySchema = z.object({
  relativePath: z.string().min(1),
  raw: z.coerce.boolean().default(false),
});

const previewQuerySchema = z.object({
  relativePath: z.string().min(1),
});

const listQuerySchema = z.object({
  dir: z.string().default("."),
  limit: z.coerce.number().int().positive().max(5000).default(1000),
});

const suggestionsQuerySchema = z.object({
  root: z.string().default("."),
  limit: z.coerce.number().int().positive().max(500).default(150),
});

const createTemplateParamsSchema = z.object({
  templateId: z.string().min(1),
});

const createTemplateBodySchema = z.object({
  targetPath: z.string().min(1).optional(),
});

export const filesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/files/templates", async (_request, reply) => {
    return reply.send({ items: fastify.services.files.listFileTemplates() });
  });

  fastify.post("/api/v1/files/templates/:templateId/create", async (request, reply) => {
    const params = createTemplateParamsSchema.safeParse(request.params);
    const body = createTemplateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const created = await fastify.services.files.createWorkspaceFileFromTemplate(
        params.data.templateId,
        body.data.targetPath,
      );
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/files/list", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const items = await fastify.services.files.listWorkspaceFiles(parsed.data.dir, parsed.data.limit);
      return reply.send({ items });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/files/path-suggestions", async (request, reply) => {
    const parsed = suggestionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const items = await fastify.services.files.listWorkspacePathSuggestions(parsed.data.root, parsed.data.limit);
      return reply.send({ items });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/files/upload", { bodyLimit: MAX_UPLOAD_BODY_BYTES }, async (request, reply) => {
    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const uploaded = await fastify.services.files.uploadWorkspaceFile(parsed.data.relativePath, parsed.data.content);
      return reply.code(201).send(uploaded);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/files/download", async (request, reply) => {
    const parsed = downloadQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const file = await fastify.services.files.downloadWorkspaceFile(parsed.data.relativePath, {
        maxBytes: MAX_INLINE_FILE_DOWNLOAD_BYTES,
      });

      if (parsed.data.raw) {
        const activeContent = isBrowserActiveContentType(file.contentType);
        reply.header("Content-Type", activeContent ? "application/octet-stream" : file.contentType);
        reply.header("Content-Length", String(file.size));
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Content-Security-Policy", FILE_CONTENT_SECURITY_POLICY);
        if (activeContent) {
          const fileName = file.relativePath.split(/[\\/]/u).at(-1) || "download";
          reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        }
        return reply.send(file.content);
      }

      return reply.send({
        relativePath: file.relativePath,
        fullPath: file.fullPath,
        size: file.size,
        modifiedAt: file.modifiedAt,
        contentType: file.contentType,
        encoding: file.isText ? "utf8" : "base64",
        content: file.isText ? file.content : Buffer.from(file.content).toString("base64"),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/files/preview", async (request, reply) => {
    const parsed = previewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const previewPath = parsed.data.relativePath.toLowerCase();
    if (!previewPath.endsWith(".html") && !previewPath.endsWith(".htm")) {
      return reply.code(400).send({ error: "Only HTML files can be previewed" });
    }

    try {
      const file = await fastify.services.files.downloadWorkspaceFile(parsed.data.relativePath, {
        maxBytes: MAX_HTML_PREVIEW_BYTES,
      });
      if (!file.isText) {
        return reply.code(400).send({ error: "Preview supports text HTML files only" });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", FILE_CONTENT_SECURITY_POLICY);
      return reply.send(file.content);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};

function isBrowserActiveContentType(contentType: string): boolean {
  return BROWSER_ACTIVE_CONTENT_TYPES.has(contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}
