import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
import { chatRoutes } from "./chat.js";

function testRouteDecision(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "send",
    issuedAt: "2026-04-24T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    requestedProviderId: "openai",
    requestedModel: "gpt-5.1",
    effectiveProviderId: "openai",
    effectiveModel: "gpt-5.1",
    selectionSource: "manual",
    fallbackPolicy: "off",
    fallbackResult: "not_applicable",
    runtimeReachability: "not_checked",
    runtimeClass: "cloud",
    fingerprint: "route-fingerprint",
    ...overrides,
  };
}

function matchingRoutePreflight(overrides: Partial<Record<string, unknown>> = {}) {
  const decision = testRouteDecision(overrides);
  return {
    ...decision,
    decision,
  };
}

describe("chat routes additional coverage", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("creates sessions and returns pagination cursors", async () => {
    const listChatSessions = vi.fn(() => [
      {
        sessionId: "sess-2",
        updatedAt: "2026-03-05T10:00:02.000Z",
      },
      {
        sessionId: "sess-1",
        updatedAt: "2026-03-05T10:00:01.000Z",
      },
    ]);
    const createChatSession = vi.fn(() => ({
      sessionId: "sess-new",
      title: "Fresh chat",
    }));
    app = Fastify();
    app.decorate("services", { chatSessions: { listChatSessions, createChatSession } } as never);
    await app.register(chatRoutes);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions?limit=2&includeHidden=true",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      nextCursor: "2026-03-05T10:00:01.000Z|sess-1",
    });
    expect(listChatSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        includeHidden: true,
        limit: 2,
      }),
    );

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions",
      payload: {
        title: "Fresh chat",
        mode: "cowork",
        origin: "prompt_pack",
        includeInHistory: false,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createChatSession).toHaveBeenCalledWith({
      title: "Fresh chat",
      mode: "chat",
      origin: "prompt_pack",
      includeInHistory: false,
    });
  });

  it("imports a chat project from a code source", async () => {
    const importChatProject = vi.fn(async () => ({
      project: {
        projectId: "proj-imported",
        workspaceId: "default",
        name: "demo-repo",
        workspacePath: "imports/demo-repo",
        lifecycleStatus: "active",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
      sourceType: "github_repo",
      materializedPath: "imports/demo-repo",
      repoReady: true,
      imported: true,
    }));
    app = Fastify();
    app.decorate("services", { chatProjects: { importChatProject } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/projects/import",
      payload: {
        sourceType: "github_repo",
        repoUrl: "https://github.com/example/demo-repo.git",
        ref: "main",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(importChatProject).toHaveBeenCalledWith({
      sourceType: "github_repo",
      repoUrl: "https://github.com/example/demo-repo.git",
      ref: "main",
    });
    expect(response.json()).toMatchObject({
      project: {
        projectId: "proj-imported",
      },
      repoReady: true,
    });
  });

  it("archives workspace chat sessions through the bulk archive route", async () => {
    const archiveChatSessionsBulk = vi.fn(async () => ({
      workspaceId: "default",
      scope: "mission",
      includeHidden: false,
      archivedCount: 4,
      skippedCount: 1,
      failedCount: 0,
      archivedSessionIds: ["sess-1", "sess-2", "sess-3", "sess-4"],
      failures: [],
    }));
    app = Fastify();
    app.decorate("services", { chatSessions: { archiveChatSessionsBulk } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/archive-bulk",
      payload: {
        workspaceId: "default",
        scope: "mission",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(archiveChatSessionsBulk).toHaveBeenCalledWith({
      workspaceId: "default",
      scope: "mission",
    });
    expect(response.json()).toMatchObject({
      archivedCount: 4,
      skippedCount: 1,
      failedCount: 0,
    });
  });

  it("serves session-scoped workbench routes", async () => {
    const getChatSessionWorkbench = vi.fn(async () => ({
      sessionId: "sess-1",
      projectId: "proj-1",
      worktreeStatus: "uninitialized",
      validationStatus: "idle",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
    }));
    const createChatSessionWorkbenchWorktree = vi.fn(async () => ({
      sessionId: "sess-1",
      projectId: "proj-1",
      baseRef: "main",
      worktreePath: "./.worktrees/sess-1",
      worktreeStatus: "ready",
      validationStatus: "idle",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:01:00.000Z",
    }));
    const getChatSessionWorkbenchTree = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      rootPath: "demo",
      changedFiles: ["index.ts"],
      items: [{ path: "index.ts", name: "index.ts", kind: "file", changed: true, depth: 0 }],
    }));
    const getChatSessionWorkbenchFile = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      path: "index.ts",
      sizeBytes: 32,
      modifiedAt: "2026-04-10T00:01:00.000Z",
      contentType: "text/typescript",
      language: "ts",
      changed: true,
      content: "export const demo = true;",
    }));
    const saveChatSessionWorkbenchFile = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:02:00.000Z",
      },
      path: "index.ts",
      sizeBytes: 33,
      modifiedAt: "2026-04-10T00:02:00.000Z",
      contentType: "text/typescript",
      language: "ts",
      changed: true,
      content: "export const demo = false;",
    }));
    const getChatSessionWorkbenchFileDiff = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:02:00.000Z",
      },
      path: "index.ts",
      language: "ts",
      changed: true,
      originalContent: "export const demo = true;",
      modifiedContent: "export const demo = false;",
    }));
    const getChatSessionWorkbenchDiff = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      scopePath: "demo",
      changedFiles: ["index.ts"],
      summary: { changedFiles: 1, additions: 4, deletions: 1 },
      diff: "diff --git a/index.ts b/index.ts",
    }));
    const rawWorkbenchOutput = {
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "passed",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:01:00.000Z",
      },
      helperRuns: [],
      output: "Authorization: Bearer workbench-output-secret",
    };
    const getChatSessionWorkbenchOutput = vi.fn(async () => rawWorkbenchOutput);
    const rawWorkbenchCommand = {
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "passed",
        outputArtifactId: "workbench-command:run-1",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:03:00.000Z",
      },
      run: {
        commandRunId: "workbench-command:run-1",
        sessionId: "sess-1",
        worktreePath: "./.worktrees/sess-1",
        command: "pnpm --api-key workbench-command-secret",
        args: ["test", "--token", "workbench-argument-secret"],
        status: "passed",
        exitCode: 0,
        timedOut: false,
        startedAt: "2026-04-10T00:03:00.000Z",
        completedAt: "2026-04-10T00:03:01.000Z",
        stdoutPreview: "token=workbench-stdout-secret",
        stderrPreview: "Authorization: Bearer workbench-stderr-secret",
        validationStatus: "passed",
        cwd: "./.worktrees/sess-1",
        durationMs: 1000,
        stdoutBytes: 2,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    };
    const runChatSessionWorkbenchCommand = vi.fn(async () => rawWorkbenchCommand);
    const runChatSessionWorkbenchFileOperation = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "passed",
        activeFilePath: "src/new.ts",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:03:00.000Z",
      },
      operation: "create_file",
      path: "src/new.ts",
      changedFiles: ["src/new.ts"],
      tree: {
        state: {
          sessionId: "sess-1",
          projectId: "proj-1",
          worktreeStatus: "ready",
          validationStatus: "passed",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:03:00.000Z",
        },
        rootPath: "workspace/demo",
        changedFiles: ["src/new.ts"],
        items: [{ path: "src/new.ts", name: "new.ts", kind: "file", changed: true, depth: 1 }],
      },
      output: {
        state: {
          sessionId: "sess-1",
          projectId: "proj-1",
          worktreeStatus: "ready",
          validationStatus: "passed",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:03:00.000Z",
        },
        helperRuns: [],
        output: "Created file src/new.ts.",
      },
    }));
    const applyChatSessionWorkbenchPatch = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "passed",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:04:00.000Z",
      },
      applied: true,
      checkOnly: false,
      changedFiles: ["index.ts"],
      output: {
        state: {
          sessionId: "sess-1",
          projectId: "proj-1",
          worktreeStatus: "ready",
          validationStatus: "passed",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:04:00.000Z",
        },
        helperRuns: [],
        output: "git apply · passed",
      },
    }));
    const exportChatSessionWorkbenchPatch = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:04:00.000Z",
      },
      patch: "diff --git a/index.ts b/index.ts\n",
      changedFiles: ["index.ts"],
      summary: {
        changedFiles: 1,
        additions: 1,
        deletions: 1,
      },
      generatedAt: "2026-04-10T00:04:00.000Z",
    }));
    const revertChatSessionWorkbenchFile = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:04:00.000Z",
      },
      revertedFiles: ["index.ts"],
      changedFiles: [],
      output: {
        state: {
          sessionId: "sess-1",
          projectId: "proj-1",
          worktreeStatus: "ready",
          validationStatus: "idle",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:04:00.000Z",
        },
        helperRuns: [],
        output: "Reverted index.ts.",
      },
    }));
    const revertChatSessionWorkbenchChanges = vi.fn(async () => ({
      state: {
        sessionId: "sess-1",
        projectId: "proj-1",
        worktreeStatus: "ready",
        validationStatus: "idle",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:04:00.000Z",
      },
      revertedFiles: ["index.ts"],
      changedFiles: [],
      output: {
        state: {
          sessionId: "sess-1",
          projectId: "proj-1",
          worktreeStatus: "ready",
          validationStatus: "idle",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:04:00.000Z",
        },
        helperRuns: [],
        output: "Reverted 1 file change(s).",
      },
    }));

    app = Fastify();
    app.decorate("services", {
      chatSessions: {
        applyChatSessionWorkbenchPatch,
        exportChatSessionWorkbenchPatch,
        getChatSessionWorkbench,
        createChatSessionWorkbenchWorktree,
        getChatSessionWorkbenchTree,
        getChatSessionWorkbenchFile,
        saveChatSessionWorkbenchFile,
        getChatSessionWorkbenchFileDiff,
        getChatSessionWorkbenchDiff,
        getChatSessionWorkbenchOutput,
        revertChatSessionWorkbenchChanges,
        revertChatSessionWorkbenchFile,
        runChatSessionWorkbenchCommand,
        runChatSessionWorkbenchFileOperation,
      },
    } as never);
    await app.register(chatRoutes);

    const stateResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench",
    });
    expect(stateResponse.statusCode).toBe(200);
    expect(getChatSessionWorkbench).toHaveBeenCalledWith("sess-1");

    const worktreeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/workbench/worktree",
      payload: { baseRef: "main" },
    });
    expect(worktreeResponse.statusCode).toBe(200);
    expect(createChatSessionWorkbenchWorktree).toHaveBeenCalledWith("sess-1", { baseRef: "main" });

    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/tree",
    });
    expect(treeResponse.statusCode).toBe(200);
    expect(treeResponse.json()).toMatchObject({
      changedFiles: ["index.ts"],
    });

    const fileResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/file?path=index.ts",
    });
    expect(fileResponse.statusCode).toBe(200);
    expect(getChatSessionWorkbenchFile).toHaveBeenCalledWith("sess-1", "index.ts");

    const saveFileResponse = await app.inject({
      method: "PUT",
      url: "/api/v1/chat/sessions/sess-1/workbench/file",
      payload: {
        path: "index.ts",
        content: "export const demo = false;",
      },
    });
    expect(saveFileResponse.statusCode).toBe(200);
    expect(saveChatSessionWorkbenchFile).toHaveBeenCalledWith("sess-1", {
      path: "index.ts",
      content: "export const demo = false;",
    });

    const fileDiffResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/file-diff?path=index.ts",
    });
    expect(fileDiffResponse.statusCode).toBe(200);
    expect(fileDiffResponse.json()).toMatchObject({
      changed: true,
      path: "index.ts",
    });
    expect(getChatSessionWorkbenchFileDiff).toHaveBeenCalledWith("sess-1", "index.ts");

    const diffResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/diff",
    });
    expect(diffResponse.statusCode).toBe(200);
    expect(diffResponse.json()).toMatchObject({
      summary: { changedFiles: 1 },
    });

    const outputResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/output",
    });
    expect(outputResponse.statusCode).toBe(200);
    expect(outputResponse.json()).toMatchObject({
      output: "Authorization: [REDACTED]",
    });

    const commandResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/workbench/command",
      payload: {
        command: "pnpm",
        args: ["test"],
        timeoutMs: 30_000,
      },
    });
    expect(commandResponse.statusCode).toBe(200);
    expect(commandResponse.json()).toMatchObject({
      run: {
        command: "pnpm --api-key [REDACTED]",
        args: ["test", "--token", "[REDACTED]"],
        status: "passed",
        exitCode: 0,
        stdoutPreview: "token=[REDACTED]",
        stderrPreview: "Authorization: [REDACTED]",
      },
      state: {
        validationStatus: "passed",
      },
    });
    expect(runChatSessionWorkbenchCommand).toHaveBeenCalledWith("sess-1", {
      command: "pnpm",
      args: ["test"],
      timeoutMs: 30_000,
    });
    expect(rawWorkbenchOutput.output).toContain("workbench-output-secret");
    expect(rawWorkbenchCommand.run.stdoutPreview).toContain("workbench-stdout-secret");

    const fileOperationResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/workbench/file-operation",
      payload: {
        operation: "create_file",
        path: "src/new.ts",
      },
    });
    expect(fileOperationResponse.statusCode).toBe(200);
    expect(fileOperationResponse.json()).toMatchObject({
      operation: "create_file",
      path: "src/new.ts",
    });
    expect(runChatSessionWorkbenchFileOperation).toHaveBeenCalledWith("sess-1", {
      operation: "create_file",
      path: "src/new.ts",
    });

    const patchApplyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/workbench/patch/apply",
      payload: {
        patch: "diff --git a/index.ts b/index.ts\n",
      },
    });
    expect(patchApplyResponse.statusCode).toBe(200);
    expect(applyChatSessionWorkbenchPatch).toHaveBeenCalledWith("sess-1", {
      patch: "diff --git a/index.ts b/index.ts\n",
    });

    const patchExportResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/workbench/patch/export",
    });
    expect(patchExportResponse.statusCode).toBe(200);
    expect(patchExportResponse.json()).toMatchObject({
      changedFiles: ["index.ts"],
      summary: { changedFiles: 1 },
    });
    expect(exportChatSessionWorkbenchPatch).toHaveBeenCalledWith("sess-1");

    const revertFileResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/workbench/revert-file",
      payload: { path: "index.ts" },
    });
    expect(revertFileResponse.statusCode).toBe(200);
    expect(revertChatSessionWorkbenchFile).toHaveBeenCalledWith("sess-1", { path: "index.ts" });

    const revertAllResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/workbench/revert-all",
    });
    expect(revertAllResponse.statusCode).toBe(200);
    expect(revertChatSessionWorkbenchChanges).toHaveBeenCalledWith("sess-1");
  });

  it("deletes chat sessions through the gateway", async () => {
    const deleteChatSession = vi.fn(async () => ({
      deleted: true,
      sessionId: "sess-1",
    }));
    app = Fastify();
    app.decorate("services", { chatSessions: { deleteChatSession } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/chat/sessions/sess-1?mode=hard&expectedRevision=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deleted: true,
      sessionId: "sess-1",
    });
    expect(deleteChatSession).toHaveBeenCalledWith("sess-1", 1);
  });

  it("streams branch-aware chat message chunks over SSE", async () => {
    const agentSendChatMessageStream = vi.fn(async function* () {
      yield { type: "delta", value: "Hello" };
      yield { type: "done" };
    });
    const routePreflight = vi.fn(async () => matchingRoutePreflight());
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessageStream, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send/stream",
      payload: {
        content: "Hello",
        providerId: "openai",
        model: "gpt-5.1",
        routeDecision: testRouteDecision(),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"type":"delta"');
    expect(agentSendChatMessageStream).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ content: "Hello" }),
      expect.any(AbortSignal),
      expect.objectContaining({ markCommitted: expect.any(Function) }),
    );
  });

  it("exposes chat route preflight through the gateway route stack", async () => {
    const routePreflight = vi.fn(async () => ({
      requestedProviderId: "ollama",
      requestedModel: "llama3.2",
      effectiveProviderId: "ollama",
      effectiveModel: "llama3.2",
      selectionSource: "global",
      fallbackPolicy: "armed",
      fallbackResult: "local_to_cloud",
      runtimeReachability: "reachable",
      runtimeClass: "local",
      degradedReason: "Fallback may move this run from local to cloud if the primary route fails.",
    }));
    app = Fastify();
    app.decorate("services", { chatMessages: { routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/route-preflight",
      payload: {
        action: "send",
        prefsOverride: {
          mode: "cowork",
          webMode: "auto",
          thinkingLevel: "extended",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(routePreflight).toHaveBeenCalledWith("sess-1", {
      action: "send",
      prefsOverride: {
        mode: "chat",
        webMode: "auto",
        thinkingLevel: "extended",
      },
    });
    expect(response.json()).toMatchObject({
      selectionSource: "global",
      fallbackResult: "local_to_cloud",
      runtimeReachability: "reachable",
    });
  });

  it("requires a fresh route decision before HTTP agent send", async () => {
    const agentSendChatMessage = vi.fn();
    const routePreflight = vi.fn(async () => matchingRoutePreflight());
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, routePreflight } } as never);
    await app.register(chatRoutes);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
      },
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatchObject({ code: "route_changed", reason: "route_decision_required" });

    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
        routeDecision: testRouteDecision({ expiresAt: "2000-01-01T00:00:00.000Z" }),
      },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error).toMatchObject({ code: "route_changed", reason: "route_decision_expired" });
    expect(agentSendChatMessage).not.toHaveBeenCalled();
  });

  it("rejects agent send when the route decision fingerprint changed", async () => {
    const agentSendChatMessage = vi.fn();
    const routePreflight = vi.fn(async () => matchingRoutePreflight({ fingerprint: "current-fingerprint" }));
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
        providerId: "openai",
        model: "gpt-5.1",
        routeDecision: testRouteDecision({ fingerprint: "stale-fingerprint" }),
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "route_changed", reason: "route_fingerprint_mismatch" });
    expect(agentSendChatMessage).not.toHaveBeenCalled();
  });

  it("validates fallback decisions against the requested route while sending the effective route", async () => {
    const agentSendChatMessage = vi.fn(async () => ({ turnId: "turn-1" }));
    const decision = testRouteDecision({
      requestedProviderId: "ollama",
      requestedModel: "llama3.2",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.1",
      fallbackPolicy: "armed",
      fallbackResult: "local_to_cloud",
      fingerprint: "fallback-fingerprint",
    });
    const routePreflight = vi.fn(async () => matchingRoutePreflight(decision));
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
        providerId: "openai",
        model: "gpt-5.1",
        routeDecision: decision,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(routePreflight).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        action: "send",
        providerId: "ollama",
        model: "llama3.2",
      }),
    );
    expect(agentSendChatMessage).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-5.1",
      }),
    );
  });

  it("preserves session-selected route decisions when validating send freshness", async () => {
    const agentSendChatMessage = vi.fn(async () => ({ turnId: "turn-1" }));
    const decision = testRouteDecision({
      requestedProviderId: "openai-codex",
      requestedModel: "gpt-5.5",
      effectiveProviderId: "openai-codex",
      effectiveModel: "gpt-5.5",
      selectionSource: "session",
      fingerprint: "session-route-fingerprint",
    });
    const routePreflight = vi.fn(async () => matchingRoutePreflight(decision));
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
        providerId: "openai-codex",
        model: "gpt-5.5",
        routeDecision: decision,
        mode: "chat",
        webMode: "auto",
        thinkingLevel: "standard",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(routePreflight).toHaveBeenCalledTimes(1);
    const [, preflightInput] = routePreflight.mock.calls[0] as [string, Record<string, unknown>];
    expect(preflightInput).toMatchObject({
      action: "send",
      mode: "chat",
      webMode: "auto",
      thinkingLevel: "standard",
      prefsOverride: {
        providerId: "openai-codex",
        model: "gpt-5.5",
      },
    });
    expect(preflightInput.providerId).toBeUndefined();
    expect(preflightInput.model).toBeUndefined();
    expect(agentSendChatMessage).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        providerId: "openai-codex",
        model: "gpt-5.5",
      }),
    );
  });

  it("rejects agent send when the execution payload disagrees with the effective route decision", async () => {
    const agentSendChatMessage = vi.fn();
    const routePreflight = vi.fn(async () => matchingRoutePreflight());
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
        providerId: "anthropic",
        model: "claude-sonnet-4.5",
        routeDecision: testRouteDecision(),
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "route_changed", reason: "route_effective_mismatch" });
    expect(routePreflight).not.toHaveBeenCalled();
    expect(agentSendChatMessage).not.toHaveBeenCalled();
  });

  it("emits an error chunk without a fabricated done chunk when SSE streaming fails", async () => {
    const agentSendChatMessageStream = vi.fn(async function* () {
      yield* [];
      throw new Error("stream exploded");
    });
    const routePreflight = vi.fn(async () => matchingRoutePreflight());
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessageStream, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send/stream",
      payload: {
        content: "Hello",
        providerId: "openai",
        model: "gpt-5.1",
        routeDecision: testRouteDecision(),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"error"');
    expect(response.body).toContain("Check gateway diagnostics and retry");
    expect(response.body).not.toContain("stream exploded");
    expect(response.body).not.toContain('"type":"done"');
  });

  it("streams progressive delegation chunks over SSE", async () => {
    const runChatDelegationStream = vi.fn(async function* () {
      yield {
        type: "status" as const,
        runId: "run-1",
        taskId: "task-1",
        message: "Delegation started.",
      };
      yield {
        type: "step" as const,
        runId: "run-1",
        taskId: "task-1",
        step: {
          stepId: "step-2",
          runId: "run-1",
          role: "qa",
          status: "completed",
          index: 1,
          startedAt: "2026-03-11T20:00:02.000Z",
          finishedAt: "2026-03-11T20:00:03.000Z",
          output: "Authorization: Bearer delegation-sse-step-secret",
        },
      };
      yield {
        type: "step" as const,
        runId: "run-1",
        taskId: "task-1",
        step: {
          stepId: "step-1",
          runId: "run-1",
          role: "architect",
          status: "completed",
          index: 0,
          startedAt: "2026-03-11T20:00:00.000Z",
          finishedAt: "2026-03-11T20:00:04.000Z",
          output: "apiKey=delegation-sse-design-secret",
        },
      };
      yield {
        type: "done" as const,
        runId: "run-1",
        taskId: "task-1",
        result: {
          runId: "run-1",
          taskId: "task-1",
          executionPlanId: "plan-1",
          steps: [
            {
              stepId: "step-1",
              runId: "run-1",
              role: "architect",
              status: "completed",
              index: 0,
              startedAt: "2026-03-11T20:00:00.000Z",
              finishedAt: "2026-03-11T20:00:04.000Z",
              childSessionId: "sess-child-1",
              childTurnId: "turn-child-1",
              durableRunId: "durable-child-1",
              output: "apiKey=delegation-sse-done-secret",
            },
            {
              stepId: "step-2",
              runId: "run-1",
              role: "qa",
              status: "completed",
              index: 1,
              startedAt: "2026-03-11T20:00:02.000Z",
              finishedAt: "2026-03-11T20:00:03.000Z",
              childSessionId: "sess-child-2",
              childTurnId: "turn-child-2",
              durableRunId: "durable-child-2",
              output: "Authorization: Bearer delegation-sse-validation-secret",
            },
          ],
          stitchedOutput: "Authorization: Bearer delegation-sse-stitched-secret",
          citations: [],
        },
      };
    });
    app = Fastify();
    app.decorate("services", { chatDelegate: { runChatDelegationStream } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/stream",
      payload: {
        objective: "Implement the fix",
        roles: ["Architect", "QA"],
        mode: "parallel",
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "Architect",
            parallelizable: true,
          },
          {
            stepId: "step-2",
            index: 1,
            role: "QA",
            parallelizable: true,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"type":"status"');
    expect(response.body).toContain('"type":"step"');
    expect(response.body).toContain('"type":"done"');
    expect(response.body).toContain("[REDACTED]");
    expect(response.body).not.toContain("delegation-sse-step-secret");
    expect(response.body).not.toContain("delegation-sse-design-secret");
    expect(response.body).not.toContain("delegation-sse-done-secret");
    expect(response.body).not.toContain("delegation-sse-validation-secret");
    expect(response.body).not.toContain("delegation-sse-stitched-secret");
    expect(runChatDelegationStream).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        objective: "Implement the fix",
        roles: ["Architect", "QA"],
        mode: "parallel",
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "Architect",
            parallelizable: true,
          },
          {
            stepId: "step-2",
            index: 1,
            role: "QA",
            parallelizable: true,
          },
        ],
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(response.body.indexOf('"stepId":"step-2"')).toBeLessThan(response.body.indexOf('"stepId":"step-1"'));
    expect(response.body).toContain('"durableRunId":"durable-child-1"');
  });

  it("accepts dependency-aware delegation steps over the route stack", async () => {
    const runChatDelegation = vi.fn(async () => ({
      runId: "run-2",
      taskId: "task-2",
      executionPlanId: "plan-2",
      steps: [
        {
          stepId: "step-1",
          runId: "run-2",
          role: "architect",
          status: "completed",
          index: 0,
          startedAt: "2026-03-11T20:10:00.000Z",
          finishedAt: "2026-03-11T20:10:04.000Z",
          childSessionId: "sess-child-a",
          childTurnId: "turn-child-a",
          durableRunId: "durable-child-a",
          output: "Design complete.",
        },
        {
          stepId: "step-2",
          runId: "run-2",
          role: "coder",
          status: "skipped",
          index: 1,
          startedAt: "2026-03-11T20:10:05.000Z",
          error: "Skipped because architect failed dependency checks.",
        },
      ],
      stitchedOutput: "### Architect\nDesign complete.",
      citations: [],
    }));
    app = Fastify();
    app.decorate("services", { chatDelegate: { runChatDelegation } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate",
      payload: {
        objective: "Implement the fix",
        roles: ["Architect", "Coder"],
        mode: "parallel",
        steps: [
          {
            stepId: "step-1",
            index: 0,
            role: "Architect",
            parallelizable: true,
          },
          {
            stepId: "step-2",
            index: 1,
            role: "Coder",
            dependsOnStepIds: ["step-1"],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runChatDelegation).toHaveBeenCalledWith("sess-1", {
      objective: "Implement the fix",
      roles: ["Architect", "Coder"],
      mode: "parallel",
      steps: [
        {
          stepId: "step-1",
          index: 0,
          role: "Architect",
          parallelizable: true,
        },
        {
          stepId: "step-2",
          index: 1,
          role: "Coder",
          dependsOnStepIds: ["step-1"],
        },
      ],
    });
    expect(response.json()).toMatchObject({
      executionPlanId: "plan-2",
      steps: [
        {
          stepId: "step-1",
          childSessionId: "sess-child-a",
          childTurnId: "turn-child-a",
          durableRunId: "durable-child-a",
        },
        {
          stepId: "step-2",
          status: "skipped",
        },
      ],
    });
  });

  it("returns delegation run details for a matching session", async () => {
    const getChatDelegationRun = vi.fn(() => ({
      run: {
        runId: "run-1",
        sessionId: "sess-1",
        taskId: "task-1",
        objective: "Check route details",
        roles: ["QA"],
        mode: "sequential",
        status: "completed",
        startedAt: "2026-03-11T20:20:00.000Z",
        finishedAt: "2026-03-11T20:20:01.000Z",
        citations: [],
      },
      steps: [
        {
          stepId: "step-1",
          runId: "run-1",
          role: "QA",
          status: "completed",
          index: 0,
          startedAt: "2026-03-11T20:20:00.000Z",
          finishedAt: "2026-03-11T20:20:01.000Z",
          output: "Looks good.",
        },
      ],
    }));
    app = Fastify();
    app.decorate("services", { chatDelegate: { getChatDelegationRun } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/delegations/run-1",
    });

    expect(response.statusCode).toBe(200);
    expect(getChatDelegationRun).toHaveBeenCalledWith("sess-1", "run-1");
    expect(response.json()).toMatchObject({
      run: { runId: "run-1", sessionId: "sess-1" },
      steps: [{ stepId: "step-1", runId: "run-1" }],
    });
  });

  it("returns 404 for missing delegation run details", async () => {
    const getChatDelegationRun = vi.fn(() => {
      throw new NotFoundError({ entity: "Delegation run", id: "run-missing" });
    });
    app = Fastify();
    app.decorate("services", { chatDelegate: { getChatDelegationRun } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/delegations/run-missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      error: "Delegation run run-missing not found",
    });
  });

  it("does not expose cross-session delegation run details", async () => {
    const getChatDelegationRun = vi.fn(() => {
      throw new NotFoundError("Delegation run run-1 not found for session sess-2");
    });
    app = Fastify();
    app.decorate("services", { chatDelegate: { getChatDelegationRun } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-2/delegations/run-1",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      error: "Delegation run run-1 not found for session sess-2",
    });
  });

  it("sanitizes delegation SSE failures without a fabricated done chunk", async () => {
    const runChatDelegationStream = vi.fn(async function* () {
      yield* [];
      throw new Error("delegate exploded");
    });
    app = Fastify();
    app.decorate("services", { chatDelegate: { runChatDelegationStream } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/delegate/stream",
      payload: {
        objective: "Implement the fix",
        roles: ["Architect"],
        mode: "sequential",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"error"');
    expect(response.body).toContain("Check gateway diagnostics and retry");
    expect(response.body).not.toContain("delegate exploded");
    expect(response.body).not.toContain('"type":"done"');
  });

  it("rejects removed legacy chat write routes", async () => {
    app = Fastify();
    app.decorate("services", {} as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/messages",
      payload: {
        content: "Hello",
      },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("/agent-send"),
    });
  });

  it("wires thread routes and planning-mode prefs through the gateway", async () => {
    const getChatThread = vi.fn(async () => ({
      sessionId: "sess-1",
      activeLeafTurnId: "turn-2",
      selectedTurnId: "turn-2",
      turns: [],
    }));
    const selectChatBranchTurn = vi.fn(async () => ({
      sessionId: "sess-1",
      activeLeafTurnId: "turn-3",
      selectedTurnId: "turn-3",
      turns: [],
    }));
    const updateChatSessionPrefs = vi.fn(() => ({
      sessionId: "sess-1",
      mode: "chat",
      planningMode: "advisory",
      providerId: "glm",
      model: "glm-5",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      visionFallbackModel: undefined,
      proactiveMode: "off",
      autonomyBudget: {
        maxActionsPerHour: 2,
        maxActionsPerTurn: 1,
        cooldownSeconds: 60,
      },
      retrievalMode: "standard",
      reflectionMode: "off",
      createdAt: "2026-03-07T00:00:00.000Z",
      updatedAt: "2026-03-07T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorate("services", {
      chatMessages: {
        getChatThread,
        selectChatBranchTurn,
      },
      chatSupport: {
        updateChatSessionPrefs,
      },
    } as never);
    await app.register(chatRoutes);

    const threadResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/thread",
    });
    expect(threadResponse.statusCode).toBe(200);
    expect(getChatThread).toHaveBeenCalledWith("sess-1", { includeDecisionTrace: false });

    const selectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-2/select",
    });
    expect(selectResponse.statusCode).toBe(200);
    expect(selectChatBranchTurn).toHaveBeenCalledWith("sess-1", "turn-2");

    const prefsResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/chat/sessions/sess-1/prefs",
      payload: {
        expectedRevision: 1,
        planningMode: "advisory",
      },
    });
    expect(prefsResponse.statusCode).toBe(200);
    expect(updateChatSessionPrefs).toHaveBeenCalledWith("sess-1", {
      expectedRevision: 1,
      planningMode: "advisory",
    });
  });

  it("accepts attachment payloads larger than Fastify's default JSON body limit", async () => {
    const uploadChatAttachment = vi.fn(async (input: Record<string, unknown>) => ({
      attachmentId: "att-1",
      sessionId: input.sessionId,
      fileName: input.fileName,
      mimeType: input.mimeType,
    }));
    const largeBase64 = "a".repeat(1_500_000);

    app = Fastify();
    app.decorate("services", { chatAttachments: { uploadChatAttachment } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/attachments",
      payload: {
        sessionId: "sess-1",
        fileName: "large-image.png",
        mimeType: "image/png",
        bytesBase64: largeBase64,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(uploadChatAttachment).toHaveBeenCalledWith({
      sessionId: "sess-1",
      fileName: "large-image.png",
      mimeType: "image/png",
      bytesBase64: largeBase64,
    });
  });

  it("answers pending user-input prompts through the gateway", async () => {
    const answerChatUserInputPrompt = vi.fn(async () => ({
      ok: true,
      sessionId: "sess-1",
      turnId: "turn-2",
      promptId: "prompt-1",
      resumed: false,
    }));
    app = Fastify();
    app.decorate("services", { chatMessages: { answerChatUserInputPrompt } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-2/user-input/prompt-1/respond",
      payload: {
        response: {
          kind: "single_select",
          optionId: "opt-1",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(answerChatUserInputPrompt).toHaveBeenCalledWith("sess-1", "turn-2", "prompt-1", {
      kind: "single_select",
      optionId: "opt-1",
    });
  });

  it("lists, creates, and updates specialist candidates through the gateway", async () => {
    const listChatSessionSpecialistCandidates = vi.fn(() => ({
      items: [
        {
          candidateId: "cand-1",
          sessionId: "sess-1",
          title: "Research Specialist",
          role: "researcher",
          summary: "Reusable researcher persona",
          reason: "Repeated research gap",
          source: "runtime_gap",
          status: "drafted",
          routingMode: "manual_only",
          confidence: 0.74,
          requiresApproval: true,
          routingHints: { preferredModes: ["cowork"] },
          evidence: [],
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
        },
      ],
    }));
    const createChatSessionSpecialistCandidate = vi.fn(() => ({
      candidateId: "cand-2",
      sessionId: "sess-1",
      title: "Research Specialist",
      role: "researcher",
      summary: "Reusable researcher persona",
      reason: "Repeated research gap",
      source: "runtime_gap",
      status: "drafted",
      routingMode: "manual_only",
      confidence: 0.74,
      requiresApproval: true,
      routingHints: { preferredModes: ["cowork"] },
      evidence: [],
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    }));
    const updateChatSessionSpecialistCandidate = vi.fn(() => ({
      candidateId: "cand-2",
      sessionId: "sess-1",
      title: "Research Specialist",
      role: "researcher",
      summary: "Reusable researcher persona",
      reason: "Repeated research gap",
      source: "runtime_gap",
      status: "active",
      routingMode: "strong_match_only",
      confidence: 0.74,
      requiresApproval: true,
      routingHints: { preferredModes: ["cowork"] },
      evidence: [],
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:05:00.000Z",
      activatedAt: "2026-03-12T00:05:00.000Z",
    }));
    app = Fastify();
    app.decorate("services", {
      chatSupport: {
        listChatSessionSpecialistCandidates,
        createChatSessionSpecialistCandidate,
        updateChatSessionSpecialistCandidate,
      },
    } as never);
    await app.register(chatRoutes);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/specialist-candidates?limit=50",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listChatSessionSpecialistCandidates).toHaveBeenCalledWith("sess-1", 50);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/specialist-candidates",
      payload: {
        turnId: "turn-1",
        suggestion: {
          candidateId: "suggestion-1",
          title: "Research Specialist",
          role: "researcher",
          summary: "Reusable researcher persona",
          reason: "Repeated research gap",
          source: "runtime_gap",
          confidence: 0.74,
          suggestedStatus: "suggested",
          suggestedRoutingMode: "manual_only",
          requiresApproval: true,
          routingHints: { preferredModes: ["cowork"] },
          evidence: [],
        },
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createChatSessionSpecialistCandidate).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        turnId: "turn-1",
        suggestion: expect.objectContaining({
          title: "Research Specialist",
        }),
      }),
    );

    const patchResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/chat/sessions/sess-1/specialist-candidates/cand-2",
      payload: {
        status: "active",
        routingMode: "strong_match_only",
      },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(updateChatSessionSpecialistCandidate).toHaveBeenCalledWith("sess-1", "cand-2", {
      status: "active",
      routingMode: "strong_match_only",
    });
  });

  it("cancels active turns through the gateway", async () => {
    const cancelChatTurn = vi.fn(async () => ({
      sessionId: "sess-1",
      turnId: "turn-9",
      cancelled: true,
      trace: {
        turnId: "turn-9",
        sessionId: "sess-1",
        userMessageId: "msg-user-9",
        branchKind: "append",
        status: "cancelled",
        mode: "chat",
        startedAt: "2026-03-11T20:00:00.000Z",
        finishedAt: "2026-03-11T20:00:02.000Z",
        citations: [],
        toolRuns: [],
        routing: {},
      },
    }));
    app = Fastify();
    app.decorate("services", { chatMessages: { cancelChatTurn } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-9/cancel",
      payload: {
        cancelledBy: "mission-control",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(cancelChatTurn).toHaveBeenCalledWith("sess-1", "turn-9", "mission-control");
    expect(response.json()).toMatchObject({
      sessionId: "sess-1",
      turnId: "turn-9",
      cancelled: true,
      trace: {
        status: "cancelled",
      },
    });
  });

  it("returns persisted turn context manifests", async () => {
    const rawDetail = {
      manifest: {
        manifestId: "manifest-1",
        scope: "chat_turn",
        turnId: "turn-9",
        sessionId: "sess-1",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:01.000Z",
        entryCount: 2,
      },
      entries: [
        {
          entryId: "entry-1",
          manifestId: "manifest-1",
          kind: "system_message",
          entryIndex: 0,
          sourceRef: "system:0",
          contentText: "System instructions Authorization: Bearer context-system-secret",
          contentHash: "hash-1",
          metadata: {},
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          entryId: "entry-2",
          manifestId: "manifest-1",
          kind: "memory_context",
          entryIndex: 1,
          sourceRef: "memory-1",
          contentText: "Relevant memory context password=context-memory-secret",
          contentHash: "hash-2",
          metadata: {
            status: "generated",
            webhookUrl: "https://hooks.example.test/services/team/context-path-secret",
          },
          createdAt: "2026-04-01T00:00:01.000Z",
        },
      ],
    };
    const getTurnContextManifestForSession = vi.fn(() => rawDetail);
    app = Fastify();
    app.decorate("services", { chatMessages: { getTurnContextManifestForSession } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/chat/sessions/sess-1/turns/turn-9/context-manifest",
    });

    expect(response.statusCode).toBe(200);
    expect(getTurnContextManifestForSession).toHaveBeenCalledWith("sess-1", "turn-9");
    expect(response.json()).toMatchObject({
      manifest: {
        manifestId: "manifest-1",
        turnId: "turn-9",
      },
      entries: [{ kind: "system_message" }, { kind: "memory_context" }],
    });
    expect(response.json().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentHash: "hash-1",
          publicProjection: expect.objectContaining({
            entryRedacted: true,
            contentRedacted: true,
            canonicalContentHashRefersToStoredEntry: true,
          }),
        }),
        expect.objectContaining({
          contentHash: "hash-2",
          publicProjection: expect.objectContaining({
            entryRedacted: true,
            contentRedacted: true,
            metadataRedacted: true,
            canonicalContentHashRefersToStoredEntry: true,
          }),
        }),
      ]),
    );
    for (const secret of ["context-system-secret", "context-memory-secret", "context-path-secret"]) {
      expect(response.body).not.toContain(secret);
    }
    expect(rawDetail.entries[0]!.contentText).toContain("context-system-secret");
    expect(rawDetail.entries[1]!.metadata.webhookUrl).toContain("context-path-secret");
  });

  it("returns 409 for branch-write conflicts on agent send", async () => {
    const agentSendChatMessage = vi.fn(async () => {
      const error = new Error("chat turn conflict");
      error.name = "ChatTurnWriteConflictError";
      throw error;
    });
    const routePreflight = vi.fn(async () => matchingRoutePreflight());
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
        providerId: "openai",
        model: "gpt-5.1",
        routeDecision: testRouteDecision(),
      },
    });

    expect(response.statusCode).toBe(409);
  });

  it("sanitizes non-conflict agent-send failures", async () => {
    const agentSendChatMessage = vi.fn(async () => {
      throw new Error("database exploded");
    });
    const routePreflight = vi.fn(async () => matchingRoutePreflight());
    app = Fastify();
    app.decorate("services", { chatMessages: { agentSendChatMessage, routePreflight } } as never);
    await app.register(chatRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions/sess-1/agent-send",
      payload: {
        content: "Hello",
        providerId: "openai",
        model: "gpt-5.1",
        routeDecision: testRouteDecision(),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Check gateway diagnostics and retry");
    expect(response.body).not.toContain("database exploded");
  });
});
