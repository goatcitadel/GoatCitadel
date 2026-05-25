import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import {
  assignChatSessionProject,
  createChatSession,
  listChatSessions,
  listRecentCrossProjectSessions,
  type ChatSessionDependencies,
} from "./chat-session-service.js";

function createStorage(): { storage: Storage; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-recents-"));
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

function touchSessionActivity(storage: Storage, sessionId: string, isoTimestamp: string): void {
  const session = storage.sessions.getBySessionId(sessionId);
  storage.sessions.upsert({
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    kind: session.kind,
    channel: session.channel,
    account: session.account,
    displayName: session.displayName,
    timestamp: isoTimestamp,
  });
}

describe("listRecentCrossProjectSessions", () => {
  it("returns only project-bound active sessions for the requested workspace, sorted by lastActivityAt desc", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Gateway",
        workspacePath: "apps/gateway",
      });
      const otherProject = storage.chatProjects.create({
        workspaceId: "default",
        name: "Mission Control",
        workspacePath: "apps/mission-control-next",
      });

      // Three project-bound sessions in workspace=default
      const sessionOldest = createChatSession(deps, {
        workspaceId: "default",
        title: "Oldest",
        projectId: project.projectId,
      });
      const sessionMid = createChatSession(deps, {
        workspaceId: "default",
        title: "Mid",
        projectId: otherProject.projectId,
      });
      const sessionNewest = createChatSession(deps, {
        workspaceId: "default",
        title: "Newest",
        projectId: project.projectId,
      });

      touchSessionActivity(storage, sessionOldest.sessionId, "2026-05-01T08:00:00.000Z");
      touchSessionActivity(storage, sessionMid.sessionId, "2026-05-03T08:00:00.000Z");
      touchSessionActivity(storage, sessionNewest.sessionId, "2026-05-05T08:00:00.000Z");

      // Unbound session — must be excluded
      const unbound = createChatSession(deps, { workspaceId: "default", title: "Unbound" });
      touchSessionActivity(storage, unbound.sessionId, "2026-05-04T08:00:00.000Z");

      const result = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 10 });

      expect(result.map((item) => item.sessionId)).toEqual([
        sessionNewest.sessionId,
        sessionMid.sessionId,
        sessionOldest.sessionId,
      ]);
      expect(result.every((item) => Boolean(item.projectId))).toBe(true);
      expect(result[0]).toMatchObject({
        title: "Newest",
        projectLabel: "Gateway",
        projectId: project.projectId,
        lifecycleStatus: "active",
        mode: "chat",
        sessionKey: sessionNewest.sessionKey,
      });
      expect(result.find((item) => item.sessionId === unbound.sessionId)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("scopes results to the requested workspaceId and ignores sessions from other workspaces", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const projectDefault = storage.chatProjects.create({
        workspaceId: "default",
        name: "Default Project",
        workspacePath: "apps/default",
      });
      const projectOther = storage.chatProjects.create({
        workspaceId: "other-workspace",
        name: "Other Project",
        workspacePath: "apps/other",
      });

      const defaultSession = createChatSession(deps, {
        workspaceId: "default",
        title: "Default scoped",
        projectId: projectDefault.projectId,
      });
      const otherSession = createChatSession(deps, {
        workspaceId: "other-workspace",
        title: "Other scoped",
        projectId: projectOther.projectId,
      });

      touchSessionActivity(storage, defaultSession.sessionId, "2026-05-01T10:00:00.000Z");
      touchSessionActivity(storage, otherSession.sessionId, "2026-05-05T10:00:00.000Z");

      const defaultResult = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 10 });
      expect(defaultResult.map((item) => item.sessionId)).toEqual([defaultSession.sessionId]);

      const otherResult = listRecentCrossProjectSessions(deps, { workspaceId: "other-workspace", limit: 10 });
      expect(otherResult.map((item) => item.sessionId)).toEqual([otherSession.sessionId]);
    } finally {
      cleanup();
    }
  });

  it("clamps limit between 1 and 20", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Bulk",
        workspacePath: "apps/bulk",
      });

      const sessionIds: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const session = createChatSession(deps, {
          workspaceId: "default",
          title: `Session ${index}`,
          projectId: project.projectId,
        });
        sessionIds.push(session.sessionId);
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        touchSessionActivity(storage, session.sessionId, timestamp);
      }

      const overLimit = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 100 });
      expect(overLimit).toHaveLength(20);

      const underLimit = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 0 });
      expect(underLimit).toHaveLength(1);

      const exactLimit = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 5 });
      expect(exactLimit).toHaveLength(5);
    } finally {
      cleanup();
    }
  });

  it("excludes archived sessions", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Lifecycle",
        workspacePath: "apps/lifecycle",
      });

      const active = createChatSession(deps, {
        workspaceId: "default",
        title: "Active",
        projectId: project.projectId,
      });
      const toArchive = createChatSession(deps, {
        workspaceId: "default",
        title: "ToArchive",
        projectId: project.projectId,
      });

      touchSessionActivity(storage, active.sessionId, "2026-05-01T01:00:00.000Z");
      touchSessionActivity(storage, toArchive.sessionId, "2026-05-05T01:00:00.000Z");

      storage.chatSessionMeta.patch(toArchive.sessionId, {
        lifecycleStatus: "archived",
        archivedAt: "2026-05-06T00:00:00.000Z",
      });

      const result = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 10 });
      expect(result.map((item) => item.sessionId)).toEqual([active.sessionId]);
    } finally {
      cleanup();
    }
  });

  it("uses projectId as projectLabel fallback when project name is unavailable", () => {
    const { storage, cleanup } = createStorage();
    try {
      const deps = createDeps(storage);
      const project = storage.chatProjects.create({
        workspaceId: "default",
        name: "Visible Name",
        workspacePath: "apps/visible",
      });
      const session = createChatSession(deps, {
        workspaceId: "default",
        title: "Bound session",
        projectId: project.projectId,
      });
      touchSessionActivity(storage, session.sessionId, "2026-05-01T01:00:00.000Z");

      const result = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 10 });
      expect(result[0]?.projectLabel).toBe("Visible Name");

      // Confirm that unassigning the project drops the session from results
      assignChatSessionProject(deps, session.sessionId, undefined);
      const after = listRecentCrossProjectSessions(deps, { workspaceId: "default", limit: 10 });
      expect(after).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
