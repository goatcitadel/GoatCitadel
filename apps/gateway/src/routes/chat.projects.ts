import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

const projectViewSchema = z.object({
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  view: z.enum(["active", "archived", "all"]).default("active"),
  limit: z.coerce.number().int().positive().max(1000).default(300),
});

const createProjectSchema = z.object({
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  workspacePath: z.string().min(1),
  color: z.string().optional(),
});

const importProjectSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    citadelId: z.string().min(1).optional(),
    name: z.string().optional(),
    sourceType: z.enum(["local_folder", "github_repo"]),
    sourcePath: z.string().optional(),
    repoUrl: z.string().url().optional(),
    ref: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sourceType === "local_folder" && !value.sourcePath?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourcePath is required for local_folder imports",
        path: ["sourcePath"],
      });
    }
    if (value.sourceType === "github_repo" && !value.repoUrl?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repoUrl is required for github_repo imports",
        path: ["repoUrl"],
      });
    }
  });

const updateProjectSchema = z.object({
  expectedRevision: z.number().int().positive(),
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  workspacePath: z.string().min(1).optional(),
  color: z.string().optional(),
});

const projectRevisionSchema = z.object({
  expectedRevision: z.number().int().positive(),
});

const projectParamsSchema = z.object({
  projectId: z.string().min(1),
});

const deleteProjectQuerySchema = z.object({
  mode: z.enum(["hard", "soft"]),
  expectedRevision: z.coerce.number().int().positive(),
});

export function registerChatProjectRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/chat/projects", async (request, reply) => {
    const parsed = projectViewSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.chatProjects.listChatProjects(
        parsed.data.view,
        parsed.data.limit,
        parsed.data.workspaceId,
        parsed.data.citadelId,
      ),
      view: parsed.data.view,
    });
  });

  fastify.post("/api/v1/chat/projects", async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = fastify.services.chatProjects.createChatProject(parsed.data);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/projects/import", async (request, reply) => {
    const parsed = importProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await fastify.services.chatProjects.importChatProject(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/chat/projects/:projectId", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const body = updateProjectSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const { expectedRevision, ...input } = body.data;
      return reply.send(
        fastify.services.chatProjects.updateChatProject(params.data.projectId, input, expectedRevision),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/projects/:projectId/archive", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const body = projectRevisionSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.chatProjects.archiveChatProject(params.data.projectId, body.data.expectedRevision),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/projects/:projectId/restore", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const body = projectRevisionSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.chatProjects.restoreChatProject(params.data.projectId, body.data.expectedRevision),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/chat/projects/:projectId", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const query = deleteProjectQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    if (query.data.mode !== "hard") {
      return reply.code(400).send({ error: "Only hard delete is supported for chat projects." });
    }
    try {
      const deleted = fastify.services.chatProjects.hardDeleteChatProject(
        params.data.projectId,
        query.data.expectedRevision,
      );
      return reply.send({ deleted, projectId: params.data.projectId, mode: "hard" as const });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
}
