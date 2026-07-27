import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import {
  projectChatGeneratedArtifactForPublic,
  projectChatSessionForPublic,
  projectChatSessionSearchResponseForPublic,
  projectChatWorkbenchExecutionForPublic,
  projectRecentCrossProjectSessionForPublic,
} from "../services/chat-secret-projection.js";

const chatOnlyModeSchema = z.enum(["chat", "cowork", "code"]).transform(() => "chat" as const);

const listChatSessionsSchema = z.object({
  scope: z.enum(["mission", "external", "all"]).optional(),
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  q: z.string().max(512).optional(),
  view: z.enum(["active", "archived", "all"]).optional(),
  mode: chatOnlyModeSchema.optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
  includeHidden: z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1")
    .optional(),
});

const searchChatSessionsSchema = z.object({
  query: z.string().trim().min(1).max(512),
  mode: z.enum(["discovery", "scroll", "browse"]).default("discovery"),
  view: z.enum(["active", "archived", "all"]).default("all"),
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  surface: chatOnlyModeSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).default(20),
  cursor: z.string().optional(),
  includeHidden: z
    .enum(["true", "false", "1", "0"])
    .transform((value) => value === "true" || value === "1")
    .optional(),
});

const sessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const sessionTurnParamsSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

const artifactParamsSchema = z.object({
  artifactId: z.string().min(1),
});

const artifactWorkspaceQuerySchema = z.object({
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
});

const createSessionSchema = z.object({
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  title: z.string().optional(),
  folderId: z.string().optional(),
  folderName: z.string().optional(),
  tags: z.array(z.string()).max(32).optional(),
  projectId: z.string().optional(),
  mode: chatOnlyModeSchema.optional(),
  origin: z.enum(["operator", "prompt_pack", "system"]).optional(),
  includeInHistory: z.boolean().optional(),
});

const createSideChatSchema = z.object({
  createdFromSurface: chatOnlyModeSchema.optional(),
  sourceTurnId: z.string().min(1).optional(),
});

const bulkArchiveSessionsSchema = z.object({
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  scope: z.enum(["mission", "external", "all"]).default("mission"),
  includeHidden: z.boolean().optional(),
});

const updateSessionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().optional(),
  folderId: z.string().optional(),
  folderName: z.string().optional(),
  tags: z.array(z.string()).max(32).optional(),
});

const assignProjectSchema = z.object({
  expectedRevision: z.number().int().positive(),
  projectId: z.string().optional(),
});

const sessionRevisionSchema = z.object({
  expectedRevision: z.number().int().positive(),
});

const deleteSessionQuerySchema = z.object({
  mode: z.literal("hard"),
  expectedRevision: z.coerce.number().int().positive(),
});

const bindingSchema = z.object({
  transport: z.enum(["llm", "integration"]),
  connectionId: z.string().optional(),
  target: z.string().optional(),
  writable: z.boolean().optional(),
});

const workbenchWorktreeBodySchema = z.object({
  baseRef: z.string().min(1).optional(),
});

const workbenchFileQuerySchema = z.object({
  path: z.string().min(1),
});

const workbenchSaveFileBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const workbenchFileOperationBodySchema = z.object({
  operation: z.enum(["create_file", "create_folder", "rename", "delete", "duplicate", "move"]),
  path: z.string().min(1),
  targetPath: z.string().min(1).optional(),
  content: z.string().optional(),
});

const workbenchCommandRunBodySchema = z.object({
  command: z.string().min(1).max(128),
  args: z.array(z.string().max(4096)).max(64).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

const workbenchPatchApplyBodySchema = z.object({
  patch: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024),
  checkOnly: z.boolean().optional(),
});

const workbenchRevertFileBodySchema = z.object({
  path: z.string().min(1),
});

const generatedArtifactsQuerySchema = z.object({
  citadelId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  sourceSurface: chatOnlyModeSchema.optional(),
  kind: z.enum(["markdown", "html", "mermaid", "code", "text"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(300),
});

const createGeneratedArtifactSchema = z.object({
  supersedeLatest: z.boolean().optional(),
});

const attachKnowledgeSchema = z
  .object({
    chatAttachmentId: z.string().min(1).optional(),
    url: z.string().url().optional(),
    title: z.string().optional(),
    retrievalMode: z.enum(["full_text", "retrieval"]),
  })
  .refine((value) => Boolean(value.chatAttachmentId || value.url), {
    message: "chatAttachmentId or url is required",
  });

const crossProjectRecentsQuerySchema = z.object({
  citadelId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(20).default(8),
});

export function registerChatSessionRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/chat/generated-artifacts", async (request, reply) => {
    const parsed = generatedArtifactsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: fastify.services.chatSessions
          .listChatGeneratedArtifacts(parsed.data)
          .map(projectChatGeneratedArtifactForPublic),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/chat/generated-artifacts/:artifactId", async (request, reply) => {
    const params = artifactParamsSchema.safeParse(request.params);
    const query = artifactWorkspaceQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send({
        item: projectChatGeneratedArtifactForPublic(
          fastify.services.chatSessions.getChatGeneratedArtifact(params.data.artifactId, {
            workspaceId: query.data.workspaceId,
            citadelId: query.data.citadelId,
          }),
        ),
      });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/session-search", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    reply.header("pragma", "no-cache");
    const parsed = searchChatSessionsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(
        projectChatSessionSearchResponseForPublic(fastify.services.chatSessions.searchChatSessions(parsed.data)),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions", async (request, reply) => {
    const parsed = listChatSessionsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (parsed.data.q?.trim()) {
      reply.header("cache-control", "private, no-store");
      reply.header("pragma", "no-cache");
    }
    try {
      const items = fastify.services.chatSessions.listChatSessions(parsed.data);
      const last = items.at(-1);
      const nextCursor = items.length === parsed.data.limit && last ? `${last.updatedAt}|${last.sessionId}` : undefined;
      return reply.send({ items: items.map(projectChatSessionForPublic), nextCursor });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = fastify.services.chatSessions.createChatSession(parsed.data);
      return reply.code(201).send(projectChatSessionForPublic(created));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/archive-bulk", async (request, reply) => {
    const parsed = bulkArchiveSessionsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.chatSessions.archiveChatSessionsBulk(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/recents", async (request, reply) => {
    const parsed = crossProjectRecentsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const workspaceId = parsed.data.workspaceId;
    const items = fastify.services.chatSessions
      .listRecentCrossProjectSessions({
        citadelId: parsed.data.citadelId,
        workspaceId,
        limit: parsed.data.limit,
      })
      .map(projectRecentCrossProjectSessionForPublic);
    return reply.send({
      items,
      workspaceId,
      generatedAt: new Date().toISOString(),
    });
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/status", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      reply.header("cache-control", "private, no-store");
      return reply.send(fastify.services.chatSessions.getChatSessionStatus(params.data.sessionId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/chat/sessions/:sessionId", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = updateSessionSchema.safeParse(request.body);
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
        projectChatSessionForPublic(
          fastify.services.chatSessions.updateChatSession(params.data.sessionId, input, expectedRevision),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/chat/sessions/:sessionId", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = deleteSessionQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.chatSessions.deleteChatSession(params.data.sessionId, query.data.expectedRevision),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/pin", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sessionRevisionSchema.safeParse(request.body ?? {});
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
        projectChatSessionForPublic(
          fastify.services.chatSessions.pinChatSession(params.data.sessionId, body.data.expectedRevision),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/unpin", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sessionRevisionSchema.safeParse(request.body ?? {});
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
        projectChatSessionForPublic(
          fastify.services.chatSessions.unpinChatSession(params.data.sessionId, body.data.expectedRevision),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/archive", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sessionRevisionSchema.safeParse(request.body ?? {});
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
        projectChatSessionForPublic(
          fastify.services.chatSessions.archiveChatSession(params.data.sessionId, body.data.expectedRevision),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/restore", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sessionRevisionSchema.safeParse(request.body ?? {});
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
        projectChatSessionForPublic(
          fastify.services.chatSessions.restoreChatSession(params.data.sessionId, body.data.expectedRevision),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/project", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = assignProjectSchema.safeParse(request.body);
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
        projectChatSessionForPublic(
          fastify.services.chatSessions.assignChatSessionProject(
            params.data.sessionId,
            body.data.projectId,
            body.data.expectedRevision,
          ),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/side-chats", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = fastify.services.chatSessions.getChatSideChat(params.data.sessionId);
      return reply.send({
        ...result,
        ...(result.childSession ? { childSession: projectChatSessionForPublic(result.childSession) } : {}),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/side-chats", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = createSideChatSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const result = fastify.services.chatSessions.createChatSideChat(params.data.sessionId, body.data);
      return reply.code(201).send({
        ...result,
        childSession: projectChatSessionForPublic(result.childSession),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/binding", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = bindingSchema.safeParse(request.body);
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
        fastify.services.chatSessions.setChatSessionBinding({
          sessionId: params.data.sessionId,
          ...body.data,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/binding", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({
        item: fastify.services.chatSessions.getChatSessionBinding(params.data.sessionId) ?? null,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/workbench", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({
        state: await fastify.services.chatSessions.getChatSessionWorkbench(params.data.sessionId),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/workbench/worktree", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = workbenchWorktreeBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send({
        state: await fastify.services.chatSessions.createChatSessionWorkbenchWorktree(params.data.sessionId, body.data),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/workbench/tree", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.chatSessions.getChatSessionWorkbenchTree(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/workbench/file", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = workbenchFileQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.chatSessions.getChatSessionWorkbenchFile(params.data.sessionId, query.data.path),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.put("/api/v1/chat/sessions/:sessionId/workbench/file", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = workbenchSaveFileBodySchema.safeParse(request.body);
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
        await fastify.services.chatSessions.saveChatSessionWorkbenchFile(params.data.sessionId, body.data),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/workbench/file-operation", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = workbenchFileOperationBodySchema.safeParse(request.body);
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
        await fastify.services.chatSessions.runChatSessionWorkbenchFileOperation(params.data.sessionId, body.data),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/workbench/file-diff", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = workbenchFileQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.chatSessions.getChatSessionWorkbenchFileDiff(params.data.sessionId, query.data.path),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/workbench/diff", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.chatSessions.getChatSessionWorkbenchDiff(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/workbench/output", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(
        projectChatWorkbenchExecutionForPublic(
          await fastify.services.chatSessions.getChatSessionWorkbenchOutput(params.data.sessionId),
        ),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/workbench/command", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = workbenchCommandRunBodySchema.safeParse(request.body);
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
        projectChatWorkbenchExecutionForPublic(
          await fastify.services.chatSessions.runChatSessionWorkbenchCommand(params.data.sessionId, body.data),
        ),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/workbench/patch/apply", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = workbenchPatchApplyBodySchema.safeParse(request.body);
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
        await fastify.services.chatSessions.applyChatSessionWorkbenchPatch(params.data.sessionId, body.data),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/workbench/patch/export", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.chatSessions.exportChatSessionWorkbenchPatch(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/workbench/revert-file", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = workbenchRevertFileBodySchema.safeParse(request.body);
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
        await fastify.services.chatSessions.revertChatSessionWorkbenchFile(params.data.sessionId, body.data),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/workbench/revert-all", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.chatSessions.revertChatSessionWorkbenchChanges(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/generated-artifacts", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = generatedArtifactsQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send({
        items: fastify.services.chatSessions
          .listChatGeneratedArtifacts({
            ...query.data,
            sessionId: params.data.sessionId,
          })
          .map(projectChatGeneratedArtifactForPublic),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/generated-artifact", async (request, reply) => {
    const params = sessionTurnParamsSchema.safeParse(request.params);
    const body = createGeneratedArtifactSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.code(201).send({
        item: projectChatGeneratedArtifactForPublic(
          fastify.services.chatSessions.createChatGeneratedArtifactFromTurn({
            sessionId: params.data.sessionId,
            turnId: params.data.turnId,
            supersedeLatest: body.data.supersedeLatest,
          }),
        ),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/knowledge-attachments", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({
        items: fastify.services.chatSessions.listChatThreadKnowledgeAttachments(params.data.sessionId),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/knowledge-attachments", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = attachKnowledgeSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.code(201).send({
        item: await fastify.services.chatSessions.attachChatThreadKnowledgeAttachment(params.data.sessionId, body.data),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/chat/sessions/:sessionId/knowledge-attachments/:attachmentId", async (request, reply) => {
    const params = z
      .object({
        sessionId: z.string().min(1),
        attachmentId: z.string().min(1),
      })
      .safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(
        fastify.services.chatSessions.removeChatThreadKnowledgeAttachment(
          params.data.sessionId,
          params.data.attachmentId,
        ),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
