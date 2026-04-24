import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

const uploadSchema = z.object({
  relativePath: z.string().min(1),
  content: z.string(),
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

  fastify.post("/api/v1/files/upload", async (request, reply) => {
    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const uploaded = await fastify.services.files.uploadWorkspaceFile(parsed.data.relativePath, parsed.data.content);
      return reply.code(201).send(uploaded);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/files/download", async (request, reply) => {
    const parsed = downloadQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const file = await fastify.services.files.downloadWorkspaceFile(parsed.data.relativePath);

      if (parsed.data.raw) {
        reply.header("Content-Type", file.contentType);
        reply.header("Content-Length", String(file.size));
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

    if (!parsed.data.relativePath.endsWith(".html") && !parsed.data.relativePath.endsWith(".htm")) {
      return reply.code(400).send({ error: "Only HTML files can be previewed" });
    }

    try {
      const file = await fastify.services.files.downloadWorkspaceFile(parsed.data.relativePath);
      if (!file.isText) {
        return reply.code(400).send({ error: "Preview supports text HTML files only" });
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:");
      return reply.send(file.content);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
