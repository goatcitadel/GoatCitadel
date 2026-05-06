import type { FastifyInstance } from "fastify";
import { z } from "zod";

const listChatSessionsSchema = z.object({
  scope: z.enum(["mission", "external", "all"]).optional(),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  q: z.string().optional(),
  view: z.enum(["active", "archived", "all"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
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
  workspaceId: z.string().min(1),
});

const createSessionSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  title: z.string().optional(),
  folderId: z.string().optional(),
  folderName: z.string().optional(),
  tags: z.array(z.string()).max(32).optional(),
  projectId: z.string().optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  origin: z.enum(["operator", "prompt_pack", "system"]).optional(),
  includeInHistory: z.boolean().optional(),
});

const bulkArchiveSessionsSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: z.enum(["mission", "external", "all"]).default("mission"),
  includeHidden: z.boolean().optional(),
});

const updateSessionSchema = z.object({
  title: z.string().optional(),
  folderId: z.string().optional(),
  folderName: z.string().optional(),
  tags: z.array(z.string()).max(32).optional(),
});

const assignProjectSchema = z.object({
  projectId: z.string().optional(),
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
  sessionId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  sourceSurface: z.enum(["chat", "cowork", "code"]).optional(),
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

export function registerChatSessionRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/chat/generated-artifacts", async (request, reply) => {
    const parsed = generatedArtifactsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: fastify.services.chatSessions.listChatGeneratedArtifacts(parsed.data),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
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
        item: fastify.services.chatSessions.getChatGeneratedArtifact(params.data.artifactId, {
          workspaceId: query.data.workspaceId,
        }),
      });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions", async (request, reply) => {
    const parsed = listChatSessionsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = fastify.services.chatSessions.listChatSessions(parsed.data);
    const last = items.at(-1);
    const nextCursor = items.length === parsed.data.limit && last ? `${last.updatedAt}|${last.sessionId}` : undefined;
    return reply.send({ items, nextCursor });
  });

  fastify.post("/api/v1/chat/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = fastify.services.chatSessions.createChatSession(parsed.data);
      return reply.code(201).send(created);
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
      return reply.send(fastify.services.chatSessions.updateChatSession(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/chat/sessions/:sessionId", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.chatSessions.deleteChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/pin", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.chatSessions.pinChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/unpin", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.chatSessions.unpinChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/archive", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.chatSessions.archiveChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/restore", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.chatSessions.restoreChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
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
        fastify.services.chatSessions.assignChatSessionProject(params.data.sessionId, body.data.projectId),
      );
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
      return reply.send(await fastify.services.chatSessions.getChatSessionWorkbenchOutput(params.data.sessionId));
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
        await fastify.services.chatSessions.runChatSessionWorkbenchCommand(params.data.sessionId, body.data),
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
        items: fastify.services.chatSessions.listChatGeneratedArtifacts({
          ...query.data,
          sessionId: params.data.sessionId,
        }),
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
        item: fastify.services.chatSessions.createChatGeneratedArtifactFromTurn({
          sessionId: params.data.sessionId,
          turnId: params.data.turnId,
          supersedeLatest: body.data.supersedeLatest,
        }),
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
