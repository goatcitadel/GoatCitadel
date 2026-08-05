import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import {
  archiveChatSession,
  archiveChatSessionsBulk,
  assignChatSessionProject,
  createChatSideChat,
  createChatSession,
  ensureChatSessionWithStableKey,
  deleteChatSession,
  getChatSideChat,
  getChatSessionBinding,
  getChatSessionPrefs,
  listChatSessions,
  maybeAutoTitleChatSession,
  pinChatSession,
  restoreChatSession,
  searchChatSessions,
  setChatSessionBinding,
  type ChatSessionDependencies,
  unpinChatSession,
  updateChatSession,
  updateChatSessionPrefs,
} from "./chat-session-service.js";
import { projectChatSessionForPublic } from "./chat-secret-projection.js";
import { handleChatGoalClearRequest, handleChatGoalSetRequest } from "./chat-steer-route.js";

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
  const asyncStorage = createSqliteAsyncStorage(storage);
  const deps = {
    storage: asyncStorage,
    operatorSummaryCache: {
      invalidate: vi.fn(),
    },
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
    ensureChatSessionRuntimeGrants: vi.fn(),
    requireChatSession: vi.fn() as never,
    getSession: (sessionId: string) => asyncStorage.sessions.getBySessionId(sessionId),
    publishRealtime: vi.fn(),
    clearChatTurnWriteLease: vi.fn(),
    removeChatSessionStoredFile: vi.fn(),
    ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
    hydrateChatPrefsWithAutonomy: (_sessionId, prefs) => prefs,
    patchSessionAutonomyPrefs: vi.fn(),
  };
  deps.requireChatSession = vi.fn(async (sessionId: string) => {
    const workspaceId = storage.chatSessionMeta.get(sessionId)?.workspaceId ?? "default";
    const session = (
      await listChatSessions(deps, {
        workspaceId,
        scope: "all",
        view: "all",
        includeHidden: true,
        limit: 1000,
      })
    ).find((record) => record.sessionId === sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }) as never;
  return deps;
}

describe("chat session service", () => {
  it("rejects stale two-client writes across the chat-session aggregate and rolls back project side effects", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);

      const metaSession = await createChatSession(deps, { workspaceId: "default", title: "Original" });
      const clientAMeta = await deps.requireChatSession(metaSession.sessionId);
      const clientBMeta = await deps.requireChatSession(metaSession.sessionId);
      const renamed = await updateChatSession(deps, metaSession.sessionId, { title: "Client A" }, clientAMeta.revision);
      expect(renamed.revision).toBe(clientAMeta.revision + 1);
      await expect(pinChatSession(deps, metaSession.sessionId, clientBMeta.revision)).rejects.toThrow(ConflictError);
      await expect(deps.requireChatSession(metaSession.sessionId)).resolves.toMatchObject({
        title: "Client A",
        pinned: false,
      });

      const prefsBefore = await getChatSessionPrefs(deps, metaSession.sessionId);
      const prefsUpdated = await updateChatSessionPrefs(
        deps,
        metaSession.sessionId,
        {
          providerId: "openai",
          model: "gpt-5",
          proactiveMode: "suggest",
          autonomyBudget: { maxActionsPerTurn: 4 },
        },
        prefsBefore.revision,
      );
      expect(prefsUpdated.revision).toBe(prefsBefore.revision + 1);
      await expect(
        updateChatSessionPrefs(
          deps,
          metaSession.sessionId,
          { model: "gpt-4.1", reflectionMode: "on" },
          prefsBefore.revision,
        ),
      ).rejects.toThrow(ConflictError);
      await expect(getChatSessionPrefs(deps, metaSession.sessionId)).resolves.toMatchObject({
        revision: prefsUpdated.revision,
        model: "gpt-5",
      });
      expect(storage.sessionAutonomyPrefs.get(metaSession.sessionId)).toMatchObject({
        revision: prefsUpdated.revision,
        proactiveMode: "suggest",
        maxActionsPerTurn: 4,
      });

      const projectSession = await createChatSession(deps, { workspaceId: "default", title: "Project race" });
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Atomic project",
        workspacePath: "projects/atomic",
      });
      storage.chatGeneratedArtifacts.create({
        artifactId: "artifact-project-race",
        sessionId: projectSession.sessionId,
        workspaceId: "default",
        turnId: "turn-project-race",
        title: "Plan",
        kind: "markdown",
        content: "plan",
        sourceSurface: "chat",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const projectRevision = (await deps.requireChatSession(projectSession.sessionId)).revision;
      const workbenchPatch = vi.spyOn(storage.chatSessionWorkbench, "patch").mockImplementationOnce(() => {
        throw new Error("workbench reset failed");
      });
      await expect(
        assignChatSessionProject(deps, projectSession.sessionId, project.projectId, projectRevision),
      ).rejects.toThrow("workbench reset failed");
      workbenchPatch.mockRestore();
      expect(storage.chatSessionProjects.get(projectSession.sessionId)).toBeUndefined();
      expect(storage.chatGeneratedArtifacts.get("artifact-project-race").projectId).toBeUndefined();
      expect(storage.chatSessionRevisions.get(projectSession.sessionId)?.revision).toBe(projectRevision);

      const goalSession = await createChatSession(deps, { workspaceId: "default", title: "Goal race" });
      const goalSnapshot = storage.chatSessionMeta.ensure(goalSession.sessionId);
      const goal = await handleChatGoalSetRequest({
        sessionId: goalSession.sessionId,
        body: { goal: "Ship", expectedRevision: goalSnapshot.revision },
        chatSessionMeta: storage.chatSessionMeta,
      });
      expect(goal.revision).toBe(goalSnapshot.revision + 1);
      await expect(
        handleChatGoalClearRequest({
          sessionId: goalSession.sessionId,
          expectedRevision: goalSnapshot.revision,
          chatSessionMeta: storage.chatSessionMeta,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(storage.chatSessionMeta.get(goalSession.sessionId)?.pinnedGoal).toBe("Ship");

      const policySnapshot = storage.sessionAutonomyPrefs.ensure(goalSession.sessionId);
      const policy = storage.sessionAutonomyPrefs.patchWithRevision(
        goalSession.sessionId,
        { proactiveMode: "suggest" },
        policySnapshot.revision,
      );
      expect(policy.revision).toBe(policySnapshot.revision + 1);
      expect(() =>
        storage.sessionAutonomyPrefs.patchWithRevision(
          goalSession.sessionId,
          { reflectionMode: "on" },
          policySnapshot.revision,
        ),
      ).toThrow(ConflictError);

      const deleteSessionRecord = await createChatSession(deps, { workspaceId: "default", title: "Delete race" });
      const deleteSnapshot = await deps.requireChatSession(deleteSessionRecord.sessionId);
      await updateChatSession(deps, deleteSessionRecord.sessionId, { title: "Newer title" }, deleteSnapshot.revision);
      await expect(
        deleteChatSession(deps, deleteSessionRecord.sessionId, deleteSnapshot.revision),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(storage.sessions.getBySessionId(deleteSessionRecord.sessionId).sessionId).toBe(
        deleteSessionRecord.sessionId,
      );
    } finally {
      cleanup();
    }
  });

  it("lets a newer operator title win an auto-title race", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const session = await createChatSession(deps, { workspaceId: "default" });
      const originalPatchWithRevision = storage.chatSessionMeta.patchWithRevision.bind(storage.chatSessionMeta);
      vi.spyOn(storage.chatSessionMeta, "patchWithRevision").mockImplementationOnce(
        (sessionId, patch, expectedRevision, now) => {
          originalPatchWithRevision(sessionId, { title: "Operator title" }, expectedRevision, now);
          return originalPatchWithRevision(sessionId, patch, expectedRevision, now);
        },
      );

      await expect(maybeAutoTitleChatSession(deps, session.sessionId, "Generated title")).resolves.toBeUndefined();
      expect(storage.chatSessionMeta.get(session.sessionId)?.title).toBe("Operator title");
    } finally {
      cleanup();
    }
  });

  it("upserts one deterministic internal session for a stable orchestration key", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const first = await ensureChatSessionWithStableKey(deps, "delegation-run-a:step-a", {
        workspaceId: "default",
        title: "Delegate - Coder",
        mode: "chat",
      });
      const second = await ensureChatSessionWithStableKey(deps, "delegation-run-a:step-a", {
        workspaceId: "default",
        title: "Delegate - Coder",
        mode: "chat",
      });
      const other = await ensureChatSessionWithStableKey(deps, "delegation-run-a:step-b", {
        workspaceId: "default",
        title: "Delegate - QA",
        mode: "chat",
      });

      expect(second.sessionId).toBe(first.sessionId);
      expect(other.sessionId).not.toBe(first.sessionId);
      expect(first.sessionKey).toMatch(/^mission:operator:chat_[0-9a-f]{24}$/u);
      await expect(listChatSessions(deps, { workspaceId: "default", includeHidden: true })).resolves.toHaveLength(2);
      expect(deps.ensureChatSessionRuntimeGrants).toHaveBeenCalledTimes(3);
      await expect(
        ensureChatSessionWithStableKey(deps, "delegation-run-a:step-a", {
          workspaceId: "other-workspace",
          title: "Must not move",
          mode: "chat",
        }),
      ).rejects.toThrow("stable chat session key already belongs to another workspace");
      expect(storage.chatSessionMeta.get(first.sessionId)?.workspaceId).toBe("default");
      expect(storage.chatSessionMeta.get(first.sessionId)?.title).toBe("Delegate - Coder");
    } finally {
      cleanup();
    }
  });

  it("does not persist public projection markers during editable session round trips", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const created = await createChatSession(deps, {
        workspaceId: "default",
        title: "Deploy password=title-secret prod",
        folderId: "safe-folder-id",
        folderName: "password=folder-secret prod",
        tags: ["Bearer tag-secret prod", "keep"],
      });
      const displayed = projectChatSessionForPublic(created);

      expect(JSON.stringify(displayed)).not.toContain("title-secret");
      expect(JSON.stringify(displayed)).not.toContain("folder-secret");
      expect(JSON.stringify(displayed)).not.toContain("tag-secret");

      const updated = await updateChatSession(deps, created.sessionId, {
        title: displayed.title,
        folderName: displayed.folderName,
        tags: displayed.tags,
      });

      expect(updated.title).toBe("Deploy password=title-secret prod");
      expect(updated.folderName).toBe("password=folder-secret prod");
      expect(updated.tags).toEqual(["Bearer tag-secret prod", "keep"]);
      expect(JSON.stringify(storage.chatSessionMeta.get(created.sessionId))).not.toContain("[REDACTED]");

      await expect(
        updateChatSession(deps, created.sessionId, {
          tags: [displayed.tags?.[1] ?? "", displayed.tags?.[0] ?? ""],
        }),
      ).rejects.toThrow("Projected session tags with hidden values cannot be reordered or resized.");
      expect(storage.chatSessionMeta.get(created.sessionId)?.tags).toEqual(["Bearer tag-secret prod", "keep"]);

      const surroundingTextEdited = await updateChatSession(deps, created.sessionId, {
        title: displayed.title?.replace("prod", "staging"),
        folderName: displayed.folderName?.replace("prod", "staging"),
        tags: [displayed.tags?.[0]?.replace("prod", "staging") ?? "", "changed"],
      });
      expect(surroundingTextEdited.title).toBe("Deploy password=title-secret staging");
      expect(surroundingTextEdited.folderName).toBe("password=folder-secret staging");
      expect(surroundingTextEdited.tags).toEqual(["Bearer tag-secret staging", "changed"]);

      const safelyEdited = await updateChatSession(deps, created.sessionId, {
        title: "Safe replacement",
        folderName: displayed.folderName,
      });
      expect(safelyEdited.title).toBe("Safe replacement");
      expect(safelyEdited.folderName).toBe("password=folder-secret prod");
    } finally {
      cleanup();
    }
  });

  it("round-trips case-normalized public markers without deleting hidden session metadata", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const created = await createChatSession(deps, {
        workspaceId: "default",
        title: "apiKey=first-secret alpha; password=second-secret beta",
        tags: ["Bearer tag-secret prod", "password=other-secret stage"],
      });
      const displayed = projectChatSessionForPublic(created);

      const updated = await updateChatSession(deps, created.sessionId, {
        title: displayed.title?.replaceAll("[REDACTED]", "[redacted]"),
        tags: displayed.tags?.map((tag) => tag.replaceAll("[REDACTED]", "[redacted]")),
      });

      expect(updated.title).toBe("apiKey=first-secret alpha; password=second-secret beta");
      expect(updated.tags).toEqual(["Bearer tag-secret prod", "password=other-secret stage"]);
      expect(JSON.stringify(storage.chatSessionMeta.get(created.sessionId))).not.toContain("[redacted]");
    } finally {
      cleanup();
    }
  });

  it("allows anchored partial replacement while preserving untouched hidden slots", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const created = await createChatSession(deps, {
        workspaceId: "default",
        title: "apiKey=first-secret alpha; password=second-secret beta",
        tags: ["Bearer first-tag prod", "password=second-tag stage"],
      });
      const displayed = projectChatSessionForPublic(created);

      const updated = await updateChatSession(deps, created.sessionId, {
        title: "apiKey=replacement-key alpha; password=[REDACTED] beta",
        tags: ["replacement-tag", displayed.tags?.[1] ?? ""],
      });

      expect(updated.title).toBe("apiKey=replacement-key alpha; password=second-secret beta");
      expect(updated.tags).toEqual(["replacement-tag", "password=second-tag stage"]);
    } finally {
      cleanup();
    }
  });

  it("restores URL query secrets only when their public URL identity stays bound", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const created = await createChatSession(deps, {
        workspaceId: "default",
        title: "https://old.example/path?token=title-secret&mode=sync",
        tags: ["Bearer tag-secret"],
      });
      const displayed = projectChatSessionForPublic(created);
      const moved = new URL(displayed.title ?? "");
      moved.hostname = "new.example";

      await expect(updateChatSession(deps, created.sessionId, { title: moved.toString() })).rejects.toThrow(
        "Projected session URL metadata cannot move or encode a hidden credential slot.",
      );
      await expect(
        updateChatSession(deps, created.sessionId, {
          tags: [displayed.tags?.[0]?.replace("[REDACTED]", "%5BREDACTED%5D") ?? ""],
        }),
      ).rejects.toThrow("Projected session URL metadata cannot move or encode a hidden credential slot.");
      expect(storage.chatSessionMeta.get(created.sessionId)?.title).toBe(
        "https://old.example/path?token=title-secret&mode=sync",
      );
      expect(storage.chatSessionMeta.get(created.sessionId)?.tags).toEqual(["Bearer tag-secret"]);

      const edited = new URL(displayed.title ?? "");
      edited.searchParams.set("mode", "async");
      const updated = await updateChatSession(deps, created.sessionId, { title: edited.toString() });

      expect(updated.title).toBe("https://old.example/path?token=title-secret&mode=async");
      expect(updated.title).not.toContain("%5BREDACTED%5D");
    } finally {
      cleanup();
    }
  });

  it("rejects reordering multiple marker-bearing session tags", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const created = await createChatSession(deps, {
        workspaceId: "default",
        tags: ["Bearer first-secret prod", "Bearer second-secret staging"],
      });
      const displayed = projectChatSessionForPublic(created);

      await expect(
        updateChatSession(deps, created.sessionId, {
          tags: [displayed.tags?.[1] ?? "", displayed.tags?.[0] ?? ""],
        }),
      ).rejects.toThrow("Projected session tags with hidden values cannot be reordered or resized.");
      expect(storage.chatSessionMeta.get(created.sessionId)?.tags).toEqual([
        "Bearer first-secret prod",
        "Bearer second-secret staging",
      ]);
    } finally {
      cleanup();
    }
  });

  it("rejects ambiguous reordering of repeated scalar metadata secret slots", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const created = await createChatSession(deps, {
        workspaceId: "default",
        title: "password=title-first alpha; password=title-second beta",
        folderName: "Bearer folder-first alpha; Bearer folder-second beta",
      });
      const displayed = projectChatSessionForPublic(created);

      expect(displayed.title).toBe("password=[REDACTED] alpha; password=[REDACTED] beta");
      expect(displayed.folderName).toBe("Bearer [REDACTED] alpha; Bearer [REDACTED] beta");
      const roundTripped = await updateChatSession(deps, created.sessionId, {
        title: displayed.title,
        folderName: displayed.folderName,
      });
      expect(roundTripped.title).toBe("password=title-first alpha; password=title-second beta");
      expect(roundTripped.folderName).toBe("Bearer folder-first alpha; Bearer folder-second beta");
      await expect(
        updateChatSession(deps, created.sessionId, {
          title: "password=[REDACTED] beta; password=[REDACTED] alpha",
        }),
      ).rejects.toThrow(
        "Projected session metadata with repeated credential slots cannot be reordered or edited in place.",
      );
      expect(storage.chatSessionMeta.get(created.sessionId)?.title).toBe(
        "password=title-first alpha; password=title-second beta",
      );
      await expect(
        updateChatSession(deps, created.sessionId, {
          folderName: "Bearer [REDACTED] beta; Bearer [REDACTED] alpha",
        }),
      ).rejects.toThrow(
        "Projected session metadata with repeated credential slots cannot be reordered or edited in place.",
      );
      expect(storage.chatSessionMeta.get(created.sessionId)?.folderName).toBe(
        "Bearer folder-first alpha; Bearer folder-second beta",
      );

      const replaced = await updateChatSession(deps, created.sessionId, {
        title: "Safe replacement title",
        folderName: "Safe replacement folder",
      });
      expect(replaced.title).toBe("Safe replacement title");
      expect(replaced.folderName).toBe("Safe replacement folder");
    } finally {
      cleanup();
    }
  });

  it("creates one hidden durable side chat per parent session", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Launch Project",
        workspacePath: "apps/gateway",
      });
      const parent = await createChatSession(deps, {
        workspaceId: "default",
        projectId: project.projectId,
        title: "Parent Launch Room",
        mode: "cowork",
      });

      const created = await createChatSideChat(deps, parent.sessionId, {
        createdFromSurface: "code",
        sourceTurnId: "turn-1",
      });

      expect(created.item).toMatchObject({
        parentSessionId: parent.sessionId,
        childSessionId: created.childSession.sessionId,
        workspaceId: "default",
        createdFromSurface: "code",
        sourceTurnId: "turn-1",
      });
      expect(created.childSession).toMatchObject({
        mode: "chat",
        origin: "operator",
        includeInHistory: false,
        projectId: project.projectId,
      });
      expect(
        (
          await listChatSessions(deps, {
            workspaceId: "default",
            scope: "all",
            view: "active",
            includeHidden: false,
          })
        ).map((session) => session.sessionId),
      ).not.toContain(created.childSession.sessionId);

      const reused = await createChatSideChat(deps, parent.sessionId, { createdFromSurface: "chat" });
      expect(reused.item.sideChatId).toBe(created.item.sideChatId);
      expect(reused.childSession.sessionId).toBe(created.childSession.sessionId);
      await expect(getChatSideChat(deps, parent.sessionId)).resolves.toMatchObject({
        item: { sideChatId: created.item.sideChatId },
        childSession: { sessionId: created.childSession.sessionId },
      });
      expect(deps.publishRealtime).toHaveBeenCalledWith(
        "chat_session_updated",
        "chat",
        expect.objectContaining({
          type: "chat_side_chat_created",
          sessionId: parent.sessionId,
          childSessionId: created.childSession.sessionId,
        }),
      );
    } finally {
      cleanup();
    }
  });

  it("creates, updates, titles, pins, archives, restores, and patches prefs with realtime evidence", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);

      const created = await createChatSession(deps, {
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

      const renamed = await updateChatSession(deps, created.sessionId, {
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
        (
          await listChatSessions(deps, {
            workspaceId: "default",
            scope: "all",
            view: "all",
            includeHidden: true,
            folderId: "reviews",
            tag: "QA",
          })
        ).map((record) => record.sessionId),
      ).toEqual([created.sessionId]);

      await maybeAutoTitleChatSession(deps, created.sessionId, "This should not replace the explicit title");
      expect(storage.chatSessionMeta.get(created.sessionId)?.title).toBe("Launch Review");

      const untitled = await createChatSession(deps, { workspaceId: "default" });
      await maybeAutoTitleChatSession(deps, untitled.sessionId, "\n\n# Root cause writeup\nDetails");
      expect(storage.chatSessionMeta.get(untitled.sessionId)?.title).toBe("Root cause writeup");
      const blankTitle = await createChatSession(deps, { workspaceId: "default" });
      await maybeAutoTitleChatSession(deps, blankTitle.sessionId, "\n\n#   \n>   ");
      expect(storage.chatSessionMeta.get(blankTitle.sessionId)?.title).toBeUndefined();

      expect((await pinChatSession(deps, created.sessionId)).pinned).toBe(true);
      expect((await unpinChatSession(deps, created.sessionId)).pinned).toBe(false);
      expect((await archiveChatSession(deps, created.sessionId)).lifecycleStatus).toBe("archived");
      expect((await restoreChatSession(deps, created.sessionId)).lifecycleStatus).toBe("active");

      const prefsRevisionBefore = storage.chatSessionRevisions.get(created.sessionId)?.revision;
      const prefs = await updateChatSessionPrefs(deps, created.sessionId, {
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
        mode: "chat",
        providerId: "openai",
        model: "gpt-5",
      });
      await expect(getChatSessionPrefs(deps, created.sessionId)).resolves.toMatchObject({
        mode: "chat",
        providerId: "openai",
        model: "gpt-5",
      });
      expect(prefs.revision).toBe((prefsRevisionBefore ?? 0) + 1);
      expect(storage.sessionAutonomyPrefs.get(created.sessionId)).toMatchObject({
        proactiveMode: "suggest",
        maxActionsPerTurn: 2,
        cooldownSeconds: 30,
        retrievalMode: "layered",
        reflectionMode: "on",
      });
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

  it("assigns projects, resets stale workbench state, and validates session bindings", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const session = await createChatSession(deps, { workspaceId: "default", title: "Code Room" });
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
      const createdWithProject = await createChatSession(deps, {
        workspaceId: "default",
        title: "Project at birth",
        projectId: project.projectId,
      });
      expect(createdWithProject.projectId).toBe(project.projectId);
      expect(
        (
          await listChatSessions(deps, {
            workspaceId: "default",
            scope: "all",
            view: "all",
            projectId: project.projectId,
          })
        ).map((record) => record.sessionId),
      ).toContain(createdWithProject.sessionId);
      await expect(
        createChatSession(deps, {
          workspaceId: "default",
          title: "Wrong project",
          projectId: otherWorkspaceProject.projectId,
        }),
      ).rejects.toThrow("project workspace does not match requested session workspace");
      storage.chatSessionWorkbench.patch(session.sessionId, {
        baseRef: "main",
        worktreePath: "tmp/worktree",
        worktreeStatus: "ready",
        activeFilePath: "src/old.ts",
        diffArtifactId: "diff-1",
        outputArtifactId: "out-1",
        validationStatus: "passed",
      });
      storage.chatGeneratedArtifacts.create({
        artifactId: "artifact-before-project",
        sessionId: session.sessionId,
        workspaceId: "default",
        turnId: "turn-before-project",
        title: "Pre-assignment artifact",
        kind: "markdown",
        content: "# Artifact",
        sourceSurface: "code",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const assigned = await assignChatSessionProject(deps, session.sessionId, project.projectId);

      expect(assigned.projectId).toBe(project.projectId);
      expect(storage.chatGeneratedArtifacts.get("artifact-before-project").projectId).toBe(project.projectId);
      expect(storage.chatSessionWorkbench.get(session.sessionId)).toMatchObject({
        projectId: project.projectId,
        worktreeStatus: "uninitialized",
        validationStatus: "idle",
      });
      expect(storage.chatSessionWorkbench.get(session.sessionId)?.baseRef).toBeUndefined();
      await expect(assignChatSessionProject(deps, session.sessionId, otherWorkspaceProject.projectId)).rejects.toThrow(
        "project workspace does not match session workspace",
      );

      const unassigned = await assignChatSessionProject(deps, session.sessionId);
      expect(unassigned.projectId).toBeUndefined();
      expect(storage.chatGeneratedArtifacts.get("artifact-before-project").projectId).toBeUndefined();
      expect(storage.chatSessionWorkbench.get(session.sessionId)?.projectId).toBeUndefined();

      await expect(getChatSessionBinding(deps, session.sessionId)).resolves.toMatchObject({ transport: "llm" });
      await expect(
        setChatSessionBinding(deps, {
          sessionId: session.sessionId,
          transport: "integration",
        }),
      ).rejects.toThrow("connectionId and target are required");

      const llmBinding = await setChatSessionBinding(deps, {
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
      await expect(
        setChatSessionBinding(deps, {
          sessionId: session.sessionId,
          transport: "integration",
          connectionId: connection.connectionId,
          target: "  #ops  ",
          writable: true,
        }),
      ).resolves.toMatchObject({
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
      const keep = await createChatSession(deps, { workspaceId: "default", title: "Keep" });
      const fail = await createChatSession(deps, { workspaceId: "default", title: "Fail" });
      await createChatSession(deps, { workspaceId: "default", title: "Hidden", includeInHistory: false });
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
      const session = await createChatSession(deps, { workspaceId: "default", title: "Delete me" });
      const deleteSpy = vi.spyOn(storage, "deleteChatSessionTreeWithRevision").mockReturnValue([
        {
          sessionId: session.sessionId,
          deleted: true,
          cleanupRelPaths: ["chat/sess/file.txt"],
          attachments: [],
        },
      ]);
      vi.spyOn(storage.transcripts, "delete").mockRejectedValue(new Error("transcript locked"));
      deps.removeChatSessionStoredFile = vi.fn().mockRejectedValue(new Error("missing file"));

      await expect(deleteChatSession(deps, session.sessionId)).resolves.toEqual({
        deleted: true,
        sessionId: session.sessionId,
      });

      expect(deleteSpy).toHaveBeenCalledWith({
        workspaceId: "default",
        rootSessionId: session.sessionId,
        expectedRootRevision: session.revision,
        actorId: "operator",
        idempotencyKey: `lifecycle:delete:${session.sessionId}:${session.revision}`,
        correlationId: `chat-session-delete:${session.sessionId}:${session.revision}`,
      });
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

  it("replays an acknowledged-lost delete after session metadata removal without transport pre-reads", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      deps.getSession = vi.fn(deps.getSession);
      const session = await createChatSession(deps, { workspaceId: "default", title: "Delete replay" });
      const expectedRevision = session.revision;

      await expect(deleteChatSession(deps, session.sessionId, expectedRevision)).resolves.toEqual({
        deleted: true,
        sessionId: session.sessionId,
      });
      expect(storage.sessions.listBySessionIds([session.sessionId]).size).toBe(0);
      expect(storage.chatSessionMeta.get(session.sessionId)).toBeUndefined();

      vi.mocked(deps.getSession).mockClear();
      vi.mocked(deps.requireChatSession).mockClear();
      const replaySpy = vi.spyOn(storage, "replayChatSessionTreeDeletion");
      await expect(deleteChatSession(deps, session.sessionId, expectedRevision)).resolves.toEqual({
        deleted: true,
        sessionId: session.sessionId,
      });

      expect(replaySpy).toHaveBeenCalledWith({
        rootSessionId: session.sessionId,
        expectedRootRevision: expectedRevision,
        actorId: "operator",
        idempotencyKey: `lifecycle:delete:${session.sessionId}:${expectedRevision}`,
        correlationId: `chat-session-delete:${session.sessionId}:${expectedRevision}`,
      });
      expect(deps.getSession).not.toHaveBeenCalled();
      expect(deps.requireChatSession).not.toHaveBeenCalled();

      await expect(deleteChatSession(deps, session.sessionId, expectedRevision + 1)).rejects.toMatchObject({
        code: "ENTITY_NOT_FOUND",
      });
      storage.chatSessionLifecycles.reactivate({
        workspaceId: "default",
        sessionId: session.sessionId,
        expectedTerminalGeneration: 1,
        actorId: "operator",
        idempotencyKey: `lifecycle:reactivate:${session.sessionId}:2`,
        correlationId: `chat-session-reactivate:${session.sessionId}:2`,
      });
      await expect(deleteChatSession(deps, session.sessionId, expectedRevision)).rejects.toMatchObject({
        code: "STATE_CONFLICT",
        details: { sessionLifecycleCode: "CHAT_SESSION_DELETE_REPLAY_REACTIVATED" },
      });
      expect(storage.chatSessionMeta.get(session.sessionId)?.workspaceId).toBe("default");
    } finally {
      cleanup();
    }
  });

  it("searches metadata and message content with scored snippets", async () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const searchSession = await createChatSession(deps, {
        workspaceId: "default",
        title: "Diagnostics",
        tags: ["routing"],
      });
      const metadataSession = await createChatSession(deps, {
        workspaceId: "default",
        title: "Infra Notebook",
        tags: ["ops"],
      });
      const ignoredSession = await createChatSession(deps, {
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

      const contentMatches = await listChatSessions(deps, {
        workspaceId: "default",
        scope: "all",
        view: "all",
        q: "preflight",
      });

      expect(contentMatches.map((record) => record.sessionId)).toEqual([searchSession.sessionId]);
      expect(contentMatches[0]?.searchHits?.map((hit) => hit.messageId)).toEqual(["msg-start", "msg-space"]);
      expect(contentMatches[0]?.searchHits?.[1]).toMatchObject({
        excerpt: expect.stringMatching(/^\.\.\..*preflight.*\.\.\.$/),
        score: 4,
        matchedText: "preflight",
      });

      const metadataMatches = await listChatSessions(deps, {
        workspaceId: "default",
        scope: "all",
        view: "all",
        q: "infra",
      });
      expect(metadataMatches.map((record) => record.sessionId)).toEqual([metadataSession.sessionId]);
      expect(metadataMatches[0]?.searchHits).toEqual([]);

      const noLlmSearch = await searchChatSessions(deps, {
        query: "preflight",
        mode: "discovery",
        workspaceId: "default",
        surface: "chat",
        limit: 5,
      });
      expect(noLlmSearch).toMatchObject({
        query: "preflight",
        mode: "discovery",
        items: [
          {
            session: { sessionId: searchSession.sessionId },
            matchedFields: [],
            hits: expect.arrayContaining([
              expect.objectContaining({
                messageId: "msg-start",
                excerpt: expect.stringContaining("preflight"),
              }),
            ]),
          },
        ],
      });
      expect(noLlmSearch.nextCursor).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("includes delegation parent metadata for delegated child sessions", async () => {
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

      const records = await listChatSessions(createDeps(storage), {
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

  it("does not reclassify other-workspace or missing-meta sessions into the requested workspace", async () => {
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

      const records = await listChatSessions(createDeps(storage), {
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

  it("continues paginating after an older pinned session without dropping newer unpinned sessions", async () => {
    const { storage, cleanup } = createStorage();
    try {
      storage.sessions.upsert({
        sessionId: "session-pinned",
        sessionKey: "mission:operator:pinned",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Pinned incident",
        timestamp: "2026-05-03T15:00:00.000Z",
      });
      storage.sessions.upsert({
        sessionId: "session-new",
        sessionKey: "mission:operator:new",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Newer follow-up",
        timestamp: "2026-05-03T16:00:00.000Z",
      });
      storage.sessions.upsert({
        sessionId: "session-old",
        sessionKey: "mission:operator:old",
        kind: "dm",
        channel: "mission",
        account: "operator",
        displayName: "Older follow-up",
        timestamp: "2026-05-03T14:00:00.000Z",
      });
      for (const sessionId of ["session-pinned", "session-new", "session-old"]) {
        storage.chatSessionMeta.ensure(sessionId, "2026-05-03T13:00:00.000Z", "default");
        storage.chatSessionPrefs.ensure(sessionId, "2026-05-03T13:00:00.000Z");
      }
      storage.chatSessionMeta.patch("session-pinned", { pinned: true }, "2026-05-03T13:01:00.000Z");

      const deps = createDeps(storage);
      const first = await listChatSessions(deps, {
        scope: "all",
        view: "all",
        includeHidden: true,
        workspaceId: "default",
        limit: 1,
      });
      expect(first.map((record) => record.sessionId)).toEqual(["session-pinned"]);

      const second = await listChatSessions(deps, {
        scope: "all",
        view: "all",
        includeHidden: true,
        workspaceId: "default",
        limit: 2,
        cursor: `${first[0]!.updatedAt}|${first[0]!.sessionId}`,
      });
      expect(second.map((record) => record.sessionId)).toEqual(["session-new", "session-old"]);
    } finally {
      cleanup();
    }
  });

  it("uses caller limits and batch prefs lookup for unfiltered session lists", async () => {
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
      const listCandidatesSpy = vi.spyOn(storage.chatSessionLists, "listCandidates");
      const listBySessionIdsSpy = vi.spyOn(storage.sessions, "listBySessionIds");
      const getPrefsSpy = vi.spyOn(storage.chatSessionPrefs, "get");
      const listPrefsSpy = vi.spyOn(storage.chatSessionPrefs, "listBySessionIds");
      const generatedArtifactsSpy = vi.spyOn(storage.chatGeneratedArtifacts, "listBySessionIds");
      const delegationParentsSpy = vi.spyOn(storage.chatDelegationSteps, "listParentsByChildSessionIds");

      const records = await listChatSessions(createDeps(storage), {
        scope: "all",
        view: "all",
        includeHidden: true,
        workspaceId: "default",
        limit: 2,
      });

      expect(records).toHaveLength(2);
      expect(listCandidatesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "default",
          scope: "all",
          view: "all",
          includeHidden: true,
          limit: 3,
        }),
      );
      expect(listBySessionIdsSpy).toHaveBeenCalledWith(
        expect.arrayContaining(records.map((record) => record.sessionId)),
      );
      expect(generatedArtifactsSpy).toHaveBeenCalledWith(records.map((record) => record.sessionId));
      expect(delegationParentsSpy).toHaveBeenCalledWith(
        records.map((record) => record.sessionId),
        "default",
      );
      expect(listPrefsSpy).toHaveBeenCalledTimes(1);
      expect(getPrefsSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});
