import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChatSessionRoutes } from "./chat.sessions.js";

describe("chat session routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("wires session, workbench, artifact, and knowledge routes to chat session services", async () => {
    const chatSessions = createChatSessionsService();
    app = buildApp(chatSessions);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions?scope=mission&workspaceId=default&limit=1&includeHidden=1",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [{ sessionId: "sess-1", updatedAt: "2026-05-14T00:00:00.000Z" }],
      nextCursor: "2026-05-14T00:00:00.000Z|sess-1",
    });
    expect(chatSessions.listChatSessions).toHaveBeenCalledWith({
      scope: "mission",
      workspaceId: "default",
      limit: 1,
      includeHidden: true,
    });

    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions",
        payload: { title: "New", mode: "cowork", tags: ["ops"], includeInHistory: false },
      }),
    ).resolves.toMatchObject({ statusCode: 201 });
    expect(chatSessions.createChatSession).toHaveBeenCalledWith({
      title: "New",
      mode: "cowork",
      tags: ["ops"],
      includeInHistory: false,
    });

    await expect(
      app.inject({
        method: "PATCH",
        url: "/api/v1/chat/sessions/sess-1",
        payload: { title: "Renamed", folderName: "Work" },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(chatSessions.updateChatSession).toHaveBeenCalledWith("sess-1", {
      title: "Renamed",
      folderName: "Work",
    });

    await expect(app.inject({ method: "DELETE", url: "/api/v1/chat/sessions/sess-1" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/chat/sessions/sess-1/pin" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/chat/sessions/sess-1/unpin" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/chat/sessions/sess-1/archive" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/chat/sessions/sess-1/restore" })).resolves.toMatchObject({
      statusCode: 200,
    });

    const project = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/project",
      payload: { projectId: "project-1" },
    });
    expect(project.statusCode).toBe(200);
    expect(chatSessions.assignChatSessionProject).toHaveBeenCalledWith("sess-1", "project-1");

    const bindingSet = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/binding",
      payload: { transport: "integration", connectionId: "conn-1", target: "slack", writable: false },
    });
    expect(bindingSet.statusCode).toBe(200);
    expect(chatSessions.setChatSessionBinding).toHaveBeenCalledWith({
      sessionId: "sess-1",
      transport: "integration",
      connectionId: "conn-1",
      target: "slack",
      writable: false,
    });

    await expect(app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/binding" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/workbench" })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/workbench/worktree",
        payload: { baseRef: "main" },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/workbench/tree" }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/workbench/file?path=README.md" }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "PUT",
        url: "/api/v1/chat/sessions/sess-1/workbench/file",
        payload: { path: "README.md", content: "updated" },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/workbench/file-diff?path=README.md" }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/workbench/diff" }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/workbench/output" }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/workbench/command",
        payload: { command: "pnpm", args: ["test"], timeoutMs: 1000 },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/workbench/patch/apply",
        payload: { patch: "diff --git a/a b/a", checkOnly: true },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/workbench/revert-file",
        payload: { path: "README.md" },
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/sessions/sess-1/workbench/revert-all" }),
    ).resolves.toMatchObject({ statusCode: 200 });

    await expect(
      app.inject({
        method: "GET",
        url: "/api/v1/chat/generated-artifacts?workspaceId=default&sourceSurface=chat&kind=markdown&limit=2",
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/v1/chat/generated-artifacts/artifact-1?workspaceId=default",
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/v1/chat/sessions/sess-1/generated-artifacts?workspaceId=default",
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/turns/turn-1/generated-artifact",
        payload: { supersedeLatest: true },
      }),
    ).resolves.toMatchObject({ statusCode: 201 });

    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/sessions/sess-1/knowledge-attachments" }),
    ).resolves.toMatchObject({ statusCode: 200 });
    const attached = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/knowledge-attachments",
      payload: { url: "https://example.com/guide", retrievalMode: "full_text", title: "Guide" },
    });
    expect(attached.statusCode).toBe(201);
    expect(chatSessions.attachChatThreadKnowledgeAttachment).toHaveBeenCalledWith("sess-1", {
      url: "https://example.com/guide",
      retrievalMode: "full_text",
      title: "Guide",
    });
    await expect(
      app.inject({
        method: "DELETE",
        url: "/api/v1/chat/sessions/sess-1/knowledge-attachments/attachment-1",
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it("returns validation and service errors without invoking invalid mutations", async () => {
    const chatSessions = createChatSessionsService({
      createChatSession: vi.fn(() => {
        throw new Error("create failed");
      }),
      getChatGeneratedArtifact: vi.fn(() => {
        throw new Error("artifact missing");
      }),
      archiveChatSessionsBulk: vi.fn(async () => {
        throw new Error("bulk failed");
      }),
      saveChatSessionWorkbenchFile: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    app = buildApp(chatSessions);

    await expect(app.inject({ method: "GET", url: "/api/v1/chat/sessions?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/sessions", payload: { mode: "invalid" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/sessions", payload: { title: "fails" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/chat/sessions/archive-bulk", payload: { scope: "mission" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/generated-artifacts/artifact-1" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/chat/generated-artifacts/artifact-1?workspaceId=default" }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      app.inject({
        method: "PUT",
        url: "/api/v1/chat/sessions/sess-1/workbench/file",
        payload: { path: "README.md", content: "updated" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/sess-1/knowledge-attachments",
        payload: { retrievalMode: "full_text" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });
});

function buildApp(chatSessions: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { chatSessions } as never);
  registerChatSessionRoutes(next);
  return next;
}

function createChatSessionsService(overrides: Record<string, unknown> = {}) {
  return {
    listChatSessions: vi.fn(() => [{ sessionId: "sess-1", updatedAt: "2026-05-14T00:00:00.000Z" }]),
    createChatSession: vi.fn(() => ({ sessionId: "sess-created" })),
    archiveChatSessionsBulk: vi.fn(async () => ({ archived: 2 })),
    updateChatSession: vi.fn(() => ({ sessionId: "sess-1", title: "Renamed" })),
    deleteChatSession: vi.fn(async () => ({ deleted: true })),
    pinChatSession: vi.fn(() => ({ sessionId: "sess-1", pinned: true })),
    unpinChatSession: vi.fn(() => ({ sessionId: "sess-1", pinned: false })),
    archiveChatSession: vi.fn(() => ({ sessionId: "sess-1", lifecycleStatus: "archived" })),
    restoreChatSession: vi.fn(() => ({ sessionId: "sess-1", lifecycleStatus: "active" })),
    assignChatSessionProject: vi.fn(() => ({ sessionId: "sess-1", projectId: "project-1" })),
    setChatSessionBinding: vi.fn(() => ({ sessionId: "sess-1", transport: "integration" })),
    getChatSessionBinding: vi.fn(() => ({ sessionId: "sess-1", transport: "integration" })),
    getChatSessionWorkbench: vi.fn(async () => ({ sessionId: "sess-1", status: "ready" })),
    createChatSessionWorkbenchWorktree: vi.fn(async () => ({ sessionId: "sess-1", worktreePath: "worktree" })),
    getChatSessionWorkbenchTree: vi.fn(async () => ({ rootPath: "repo", items: [] })),
    getChatSessionWorkbenchFile: vi.fn(async () => ({ path: "README.md", content: "notes" })),
    saveChatSessionWorkbenchFile: vi.fn(async () => ({ path: "README.md", changed: true })),
    getChatSessionWorkbenchFileDiff: vi.fn(async () => ({ path: "README.md", diff: "@@" })),
    getChatSessionWorkbenchDiff: vi.fn(async () => ({ changedFiles: ["README.md"], diff: "@@" })),
    getChatSessionWorkbenchOutput: vi.fn(async () => ({ output: "ok" })),
    runChatSessionWorkbenchCommand: vi.fn(async () => ({ exitCode: 0 })),
    applyChatSessionWorkbenchPatch: vi.fn(async () => ({ applied: true })),
    exportChatSessionWorkbenchPatch: vi.fn(async () => ({ patch: "@@" })),
    revertChatSessionWorkbenchFile: vi.fn(async () => ({ revertedFiles: ["README.md"] })),
    revertChatSessionWorkbenchChanges: vi.fn(async () => ({ revertedFiles: ["README.md"] })),
    listChatGeneratedArtifacts: vi.fn(() => [{ artifactId: "artifact-1" }]),
    getChatGeneratedArtifact: vi.fn(() => ({ artifactId: "artifact-1" })),
    createChatGeneratedArtifactFromTurn: vi.fn(() => ({ artifactId: "artifact-2" })),
    listChatThreadKnowledgeAttachments: vi.fn(() => [{ attachmentId: "attachment-1" }]),
    attachChatThreadKnowledgeAttachment: vi.fn(async () => ({ attachmentId: "attachment-2" })),
    removeChatThreadKnowledgeAttachment: vi.fn(() => ({ removed: true })),
    ...overrides,
  };
}
