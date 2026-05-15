import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import {
  archiveChatSession,
  archiveChatSessionsBulk,
  assignChatSessionProject,
  createChatSession,
  deleteChatSession,
  getChatSessionBinding,
  getChatSessionPrefs,
  listChatSessions,
  maybeAutoTitleChatSession,
  pinChatSession,
  restoreChatSession,
  setChatSessionBinding,
  type ChatSessionDependencies,
  unpinChatSession,
  updateChatSession,
  updateChatSessionPrefs,
} from "./chat-session-service.js";

const NOW = "2026-05-03T16:00:00.000Z";

function createStorage(): { storage: Storage; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-session-service-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  return {
    storage,
    cleanup: () => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function createDeps(storage: Storage): ChatSessionDependencies {
  const deps = {
    storage,
    operatorSummaryCache: {
      invalidate: vi.fn(),
    },
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
    ensureChatSessionRuntimeGrants: vi.fn(),
    requireChatSession: vi.fn() as never,
    getSession: (sessionId: string) => storage.sessions.getBySessionId(sessionId),
    publishRealtime: vi.fn(),
    clearChatTurnWriteLease: vi.fn(),
    removeChatSessionStoredFile: vi.fn(),
    ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
    hydrateChatPrefsWithAutonomy: (_sessionId, prefs) => prefs,
    patchSessionAutonomyPrefs: vi.fn(),
  };
  deps.requireChatSession = vi.fn((sessionId: string) => {
    const workspaceId = storage.chatSessionMeta.get(sessionId)?.workspaceId ?? "default";
    const session = listChatSessions(deps, {
      workspaceId,
      scope: "all",
      view: "all",
      includeHidden: true,
      limit: 1000,
    }).find((record) => record.sessionId === sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }) as never;
  return deps;
}

describe("chat session service", () => {
  it("creates, updates, titles, pins, archives, restores, and patches prefs with realtime evidence", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);

      const created = createChatSession(deps, {
        workspaceId: "default",
        title: "  Launch Room  ",
        includeInHistory: false,
        folderName: "Ops Desk",
        tags: ["incident", "Incident", " research "],
        mode: "cowork",
      });

      expect(created.title).toBe("Launch Room");
      expect(created.includeInHistory).toBe(false);
      expect(created.folderId).toBe("ops-desk");
      expect(created.tags).toEqual(["incident", "research"]);
      expect(storage.chatSessionBindings.get(created.sessionId)).toMatchObject({
        transport: "llm",
        writable: true,
      });
      expect(deps.ensureChatSessionRuntimeGrants).toHaveBeenCalledWith(created.sessionId);
      expect(deps.operatorSummaryCache.invalidate).toHaveBeenCalled();

      const renamed = updateChatSession(deps, created.sessionId, {
        title: "Launch Review",
        folderId: "reviews",
        folderName: "Reviews",
        tags: ["qa"],
      });
      expect(renamed).toMatchObject({
        title: "Launch Review",
        folderId: "reviews",
        folderName: "Reviews",
        tags: ["qa"],
      });
      expect(
        listChatSessions(deps, {
          workspaceId: "default",
          scope: "all",
          view: "all",
          includeHidden: true,
          folderId: "reviews",
          tag: "QA",
        }).map((record) => record.sessionId),
      ).toEqual([created.sessionId]);

      maybeAutoTitleChatSession(deps, created.sessionId, "This should not replace the explicit title");
      expect(storage.chatSessionMeta.get(created.sessionId)?.title).toBe("Launch Review");

      const untitled = createChatSession(deps, { workspaceId: "default" });
      maybeAutoTitleChatSession(deps, untitled.sessionId, "\n\n# Root cause writeup\nDetails");
      expect(storage.chatSessionMeta.get(untitled.sessionId)?.title).toBe("Root cause writeup");
      const blankTitle = createChatSession(deps, { workspaceId: "default" });
      maybeAutoTitleChatSession(deps, blankTitle.sessionId, "\n\n#   \n>   ");
      expect(storage.chatSessionMeta.get(blankTitle.sessionId)?.title).toBeUndefined();

      expect(pinChatSession(deps, created.sessionId).pinned).toBe(true);
      expect(unpinChatSession(deps, created.sessionId).pinned).toBe(false);
      expect(archiveChatSession(deps, created.sessionId).lifecycleStatus).toBe("archived");
      expect(restoreChatSession(deps, created.sessionId).lifecycleStatus).toBe("active");

      const prefs = updateChatSessionPrefs(deps, created.sessionId, {
        mode: "code",
        providerId: "openai",
        model: "gpt-5",
        proactiveMode: "suggest",
        autonomyBudget: {
          maxActionsPerTurn: 2,
          cooldownSeconds: 30,
        },
        retrievalMode: "layered",
        reflectionMode: "on",
      });
      expect(prefs).toMatchObject({
        mode: "code",
        providerId: "openai",
        model: "gpt-5",
      });
      expect(getChatSessionPrefs(deps, created.sessionId)).toMatchObject({
        mode: "code",
        providerId: "openai",
        model: "gpt-5",
      });
      expect(deps.patchSessionAutonomyPrefs).toHaveBeenCalledWith(
        created.sessionId,
        expect.objectContaining({
          proactiveMode: "suggest",
          maxActionsPerTurn: 2,
          cooldownSeconds: 30,
          retrievalMode: "layered",
          reflectionMode: "on",
        }),
      );
      expect(deps.publishRealtime).toHaveBeenCalledWith(
        "chat_session_updated",
        "chat",
        expect.objectContaining({
          type: "chat_session_prefs_updated",
          sessionId: created.sessionId,
        }),
      );
    } finally {
      cleanup();
    }
  });

  it("assigns projects, resets stale workbench state, and validates session bindings", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const session = createChatSession(deps, { workspaceId: "default", title: "Code Room" });
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Gateway",
        workspacePath: "apps/gateway",
      });
      const otherWorkspaceProject = storage.chatProjects.create({
        workspaceId: "other",
        name: "Other",
        workspacePath: "other",
      });
      const createdWithProject = createChatSession(deps, {
        workspaceId: "default",
        title: "Project at birth",
        projectId: project.projectId,
      });
      expect(createdWithProject.projectId).toBe(project.projectId);
      expect(
        listChatSessions(deps, {
          workspaceId: "default",
          scope: "all",
          view: "all",
          projectId: project.projectId,
        }).map((record) => record.sessionId),
      ).toContain(createdWithProject.sessionId);
      expect(() =>
        createChatSession(deps, {
          workspaceId: "default",
          title: "Wrong project",
          projectId: otherWorkspaceProject.projectId,
        }),
      ).toThrow("project workspace does not match requested session workspace");
      storage.chatSessionWorkbench.patch(session.sessionId, {
        baseRef: "main",
        worktreePath: "tmp/worktree",
        worktreeStatus: "ready",
        activeFilePath: "src/old.ts",
        diffArtifactId: "diff-1",
        outputArtifactId: "out-1",
        validationStatus: "passed",
      });

      const assigned = assignChatSessionProject(deps, session.sessionId, project.projectId);

      expect(assigned.projectId).toBe(project.projectId);
      expect(storage.chatSessionWorkbench.get(session.sessionId)).toMatchObject({
        projectId: project.projectId,
        worktreeStatus: "uninitialized",
        validationStatus: "idle",
      });
      expect(storage.chatSessionWorkbench.get(session.sessionId)?.baseRef).toBeUndefined();
      expect(() => assignChatSessionProject(deps, session.sessionId, otherWorkspaceProject.projectId)).toThrow(
        "project workspace does not match session workspace",
      );

      const unassigned = assignChatSessionProject(deps, session.sessionId);
      expect(unassigned.projectId).toBeUndefined();
      expect(storage.chatSessionWorkbench.get(session.sessionId)?.projectId).toBeUndefined();

      expect(getChatSessionBinding(deps, session.sessionId)).toMatchObject({ transport: "llm" });
      expect(() =>
        setChatSessionBinding(deps, {
          sessionId: session.sessionId,
          transport: "integration",
        }),
      ).toThrow("connectionId and target are required");

      const llmBinding = setChatSessionBinding(deps, {
        sessionId: session.sessionId,
        transport: "llm",
        target: "  local  ",
        writable: false,
      });
      expect(llmBinding).toMatchObject({
        transport: "llm",
        target: "local",
        writable: false,
      });
      const connection = storage.integrationConnections.create({
        catalogId: "slack",
        kind: "slack",
        key: "ops-slack",
        label: "Ops Slack",
        config: {},
      });
      expect(
        setChatSessionBinding(deps, {
          sessionId: session.sessionId,
          transport: "integration",
          connectionId: connection.connectionId,
          target: "  #ops  ",
          writable: true,
        }),
      ).toMatchObject({
        transport: "integration",
        connectionId: connection.connectionId,
        target: "#ops",
        writable: true,
      });
      expect(deps.publishRealtime).toHaveBeenCalledWith(
        "chat_session_updated",
        "chat",
        expect.objectContaining({
          type: "chat_session_binding_updated",
          sessionId: session.sessionId,
          transport: "llm",
        }),
      );
    } finally {
      cleanup();
    }
  });

  it("bulk archives active sessions and reports per-session failures", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const keep = createChatSession(deps, { workspaceId: "default", title: "Keep" });
      const fail = createChatSession(deps, { workspaceId: "default", title: "Fail" });
      createChatSession(deps, { workspaceId: "default", title: "Hidden", includeInHistory: false });
      const originalGetSession = deps.getSession;
      deps.getSession = vi.fn((sessionId: string) => {
        if (sessionId === fail.sessionId) {
          throw new Error("archive failed");
        }
        return originalGetSession(sessionId);
      });

      const result = await archiveChatSessionsBulk(deps, { workspaceId: "default" });

      expect(result).toMatchObject({
        workspaceId: "default",
        scope: "mission",
        attemptedCount: 2,
        archivedCount: 1,
        failedCount: 1,
        skippedCount: 0,
      });
      expect(result.archivedSessionIds).toEqual([keep.sessionId]);
      expect(result.failures).toEqual([{ sessionId: fail.sessionId, error: "archive failed" }]);
      expect(storage.chatSessionMeta.get(keep.sessionId)?.lifecycleStatus).toBe("archived");
      expect(storage.chatSessionMeta.get(fail.sessionId)?.lifecycleStatus).toBe("active");
    } finally {
      cleanup();
    }
  });

  it("deletes session data, clears leases, attempts file cleanup, and emits deletion realtime", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const session = createChatSession(deps, { workspaceId: "default", title: "Delete me" });
      const deleteSpy = vi.spyOn(storage, "deleteChatSessionData").mockReturnValue({
        sessionId: session.sessionId,
        deleted: true,
        cleanupRelPaths: ["chat/sess/file.txt"],
        attachments: [],
      });
      vi.spyOn(storage.transcripts, "delete").mockRejectedValue(new Error("transcript locked"));
      deps.removeChatSessionStoredFile = vi.fn().mockRejectedValue(new Error("missing file"));

      await expect(deleteChatSession(deps, session.sessionId)).resolves.toEqual({
        deleted: true,
        sessionId: session.sessionId,
      });

      expect(deleteSpy).toHaveBeenCalledWith(session.sessionId);
      expect(deps.clearChatTurnWriteLease).toHaveBeenCalledWith(session.sessionId);
      expect(deps.operatorSummaryCache.invalidate).toHaveBeenCalled();
      expect(deps.removeChatSessionStoredFile).toHaveBeenCalledWith("chat/sess/file.txt");
      expect(deps.publishRealtime).toHaveBeenCalledWith("chat_session_deleted", "chat", {
        type: "chat_session_deleted",
        sessionId: session.sessionId,
        mode: "hard",
      });
    } finally {
      cleanup();
    }
  });

  it("searches metadata and message content with scored snippets", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const searchSession = createChatSession(deps, {
        workspaceId: "default",
        title: "Diagnostics",
        tags: ["routing"],
      });
      const metadataSession = createChatSession(deps, {
        workspaceId: "default",
        title: "Infra Notebook",
        tags: ["ops"],
      });
      const ignoredSession = createChatSession(deps, {
        workspaceId: "default",
        title: "Design",
      });
      storage.chatMessages.upsertMany([
        {
          messageId: "msg-start",
          sessionId: searchSession.sessionId,
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "preflight starts the diagnostic trail",
          timestamp: "2026-05-03T16:01:00.000Z",
        },
        {
          messageId: "msg-space",
          sessionId: searchSession.sessionId,
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: `${"context ".repeat(12)}needs preflight evidence before retrying${" detail".repeat(20)}`,
          timestamp: "2026-05-03T16:02:00.000Z",
        },
        {
          messageId: "msg-contained",
          sessionId: searchSession.sessionId,
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "xpreflight should score below a word-boundary hit",
          timestamp: "2026-05-03T16:03:00.000Z",
        },
        {
          messageId: "msg-ignored",
          sessionId: ignoredSession.sessionId,
          role: "user",
          actorType: "user",
          actorId: "operator",
          content: "unrelated content",
          timestamp: "2026-05-03T16:04:00.000Z",
        },
      ]);

      const contentMatches = listChatSessions(deps, {
        workspaceId: "default",
        scope: "all",
        view: "all",
        q: "preflight",
      });

      expect(contentMatches.map((record) => record.sessionId)).toEqual([searchSession.sessionId]);
      expect(contentMatches[0]?.searchHits?.map((hit) => hit.messageId)).toEqual([
        "msg-start",
        "msg-space",
        "msg-contained",
      ]);
      expect(contentMatches[0]?.searchHits?.[1]).toMatchObject({
        excerpt: expect.stringMatching(/^\.\.\..*preflight.*\.\.\.$/),
        score: 4,
        matchedText: "preflight",
      });

      const metadataMatches = listChatSessions(deps, {
        workspaceId: "default",
        scope: "all",
        view: "all",
        q: "infra",
      });
      expect(metadataMatches.map((record) => record.sessionId)).toEqual([metadataSession.sessionId]);
      expect(metadataMatches[0]?.searchHits).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("includes delegation parent metadata for delegated child sessions", () => {
    const { storage, cleanup } = createStorage();
    try {
      storage.sessions.upsert({
        sessionId: "parent-session",
        sessionKey: "mission:operator:parent",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Parent Cowork run",
        timestamp: NOW,
      });
      storage.sessions.upsert({
        sessionId: "child-session",
        sessionKey: "mission:operator:child",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Delegate · Synthesis",
        timestamp: "2026-05-03T16:01:00.000Z",
      });
      storage.chatSessionMeta.ensure("parent-session", NOW, "default");
      storage.chatSessionMeta.ensure("child-session", NOW, "default");
      storage.chatSessionPrefs.ensure("parent-session", NOW);
      storage.chatSessionPrefs.patch("parent-session", { mode: "cowork" });
      storage.chatSessionPrefs.ensure("child-session", NOW);
      storage.chatSessionPrefs.patch("child-session", { mode: "cowork" });
      storage.chatDelegationRuns.create({
        runId: "run-1",
        sessionId: "parent-session",
        taskId: "task-1",
        objective: "Get beta users.",
        roles: ["Plan", "Synthesis"],
        mode: "sequential",
        workflowTemplate: "cowork.plan.work.synthesize",
        status: "running",
        startedAt: NOW,
      });
      storage.chatDelegationSteps.create({
        stepId: "run-1:step-2",
        runId: "run-1",
        role: "synthesizer",
        label: "Synthesis",
        index: 1,
        status: "completed",
        childSessionId: "child-session",
        startedAt: "2026-05-03T16:01:00.000Z",
      });

      const records = listChatSessions(createDeps(storage), {
        scope: "all",
        view: "all",
        workspaceId: "default",
      });

      expect(records.find((record) => record.sessionId === "parent-session")?.delegationParent).toBeUndefined();
      expect(records.find((record) => record.sessionId === "child-session")?.delegationParent).toEqual({
        parentSessionId: "parent-session",
        runId: "run-1",
        stepId: "run-1:step-2",
        role: "synthesizer",
        label: "Synthesis",
        index: 1,
      });
    } finally {
      cleanup();
    }
  });

  it("does not reclassify other-workspace or missing-meta sessions into the requested workspace", () => {
    const { storage, cleanup } = createStorage();
    try {
      storage.sessions.upsert({
        sessionId: "default-session",
        sessionKey: "mission:operator:default",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Default workspace",
        timestamp: NOW,
      });
      storage.sessions.upsert({
        sessionId: "other-session",
        sessionKey: "mission:operator:other",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Other workspace",
        timestamp: NOW,
      });
      storage.sessions.upsert({
        sessionId: "missing-meta-session",
        sessionKey: "mission:operator:missing",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Missing metadata",
        timestamp: NOW,
      });
      storage.chatSessionMeta.ensure("default-session", NOW, "default");
      storage.chatSessionMeta.ensure("other-session", NOW, "other");

      const records = listChatSessions(createDeps(storage), {
        scope: "all",
        view: "all",
        workspaceId: "default",
      });

      expect(records.map((record) => record.sessionId)).toContain("default-session");
      expect(records.map((record) => record.sessionId)).not.toContain("other-session");
      expect(records.map((record) => record.sessionId)).not.toContain("missing-meta-session");
    } finally {
      cleanup();
    }
  });

  it("uses caller limits and batch prefs lookup for unfiltered session lists", () => {
    const { storage, cleanup } = createStorage();
    try {
      for (let index = 0; index < 5; index += 1) {
        const sessionId = `session-${index}`;
        storage.sessions.upsert({
          sessionId,
          sessionKey: `mission:operator:${index}`,
          kind: "dm",
          channel: "mission",
          account: "operator",
          displayName: `Session ${index}`,
          timestamp: `2026-05-03T16:0${index}:00.000Z`,
        });
        storage.chatSessionMeta.ensure(sessionId, NOW, "default");
        storage.chatSessionPrefs.ensure(sessionId, NOW);
      }
      const listSpy = vi.spyOn(storage.sessions, "list");
      const getPrefsSpy = vi.spyOn(storage.chatSessionPrefs, "get");
      const listPrefsSpy = vi.spyOn(storage.chatSessionPrefs, "listBySessionIds");

      const records = listChatSessions(createDeps(storage), {
        scope: "all",
        view: "all",
        includeHidden: true,
        workspaceId: "default",
        limit: 2,
      });

      expect(records).toHaveLength(2);
      expect(listSpy).toHaveBeenCalledWith(2, undefined);
      expect(listPrefsSpy).toHaveBeenCalledTimes(1);
      expect(getPrefsSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
