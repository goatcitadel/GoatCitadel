import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { listChatSessions, type ChatSessionDependencies } from "./chat-session-service.js";

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
  return {
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
}

describe("chat session service", () => {
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
