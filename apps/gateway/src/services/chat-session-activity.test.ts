import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import {
  createChatSession,
  listChatSessions,
  searchChatSessions,
  type ChatSessionDependencies,
} from "./chat-session-service.js";
import { ChatSessionStatusService } from "./chat-session-status-service.js";
import { projectChatSessionForPublic } from "./chat-secret-projection.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-chat-activity-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const asyncStorage = createSqliteAsyncStorage(storage);
  const deps = {} as ChatSessionDependencies;
  Object.assign(deps, {
    storage: asyncStorage,
    operatorSummaryCache: { invalidate() {} },
    normalizeWorkspaceId: (value?: string) => value?.trim() || "workspace-1",
    ensureChatSessionRuntimeGrants() {},
    requireChatSession: async (sessionId: string) =>
      (await listChatSessions(deps, { workspaceId: "workspace-1", view: "all", includeHidden: true })).find(
        (item) => item.sessionId === sessionId,
      )!,
    getSession: (sessionId: string) => asyncStorage.sessions.getBySessionId(sessionId),
    async publishRealtime() {},
    clearChatTurnWriteLease() {},
    removeChatSessionStoredFile: async () => undefined,
    getChatSessionModelDefaults: () => ({
      providerId: undefined,
      model: undefined,
      thinkingLevel: "standard" as const,
    }),
    copyChatSessionStoredFile: async (value: string) => value,
    ensureChatSessionModelDefaults: (_sessionId: string, prefs: unknown) => prefs,
    hydrateChatPrefsWithAutonomy: (_sessionId: string, prefs: unknown) => prefs,
    patchSessionAutonomyPrefs() {},
  });
  const status = new ChatSessionStatusService({
    storage: asyncStorage,
    getModelContextWindow: () => undefined,
    getRuntimeIdentity: () => ({ identitySource: "unavailable", integrity: "unknown" }) as never,
  });
  const trace = (sessionId: string, turnId: string, startedAt: string, statusValue: string) =>
    storage.chatTurnTraces.create({
      sessionId,
      turnId,
      userMessageId: `message-${turnId}`,
      mode: "chat",
      webMode: "off",
      memoryMode: "auto",
      thinkingLevel: "standard",
      routing: {},
      startedAt,
      status: statusValue as never,
    });
  return { deps, status, trace };
}

describe("sessions list activity (CH-08)", () => {
  it("returns the same latest turn and counts as the session status route", async () => {
    const { deps, status, trace } = harness();
    const busy = await createChatSession(deps, { workspaceId: "workspace-1", title: "Busy" });
    const idle = await createChatSession(deps, { workspaceId: "workspace-1", title: "Idle" });
    trace(busy.sessionId, "done", "2026-10-05T10:00:00.000Z", "completed");
    trace(busy.sessionId, "working", "2026-10-05T10:01:00.000Z", "running");
    trace(busy.sessionId, "asking", "2026-10-05T10:02:00.000Z", "waiting_for_approval");

    const items = await listChatSessions(deps, { workspaceId: "workspace-1", includeActivity: true });
    const busyRecord = items.find((item) => item.sessionId === busy.sessionId);
    const idleRecord = items.find((item) => item.sessionId === idle.sessionId);
    const busyStatus = await status.getOperatorStatus(busy.sessionId);
    const idleStatus = await status.getOperatorStatus(idle.sessionId);
    if (busyStatus.work.availability !== "available" || idleStatus.work.availability !== "available") {
      throw new Error("status work unavailable");
    }

    expect(busyRecord?.activity?.turnCounts).toEqual(busyStatus.work.value.turnCounts);
    expect(busyRecord?.activity?.latestTurn).toEqual(busyStatus.work.value.latestTurn);
    expect(idleRecord?.activity?.turnCounts).toEqual(idleStatus.work.value.turnCounts);
    expect(idleRecord?.activity?.latestTurn).toBeNull();
    expect(idleStatus.work.value.latestTurn).toBeNull();
    expect(new Set(items.map((item) => item.activity?.observedAt)).size).toBe(1);
  });

  it("does not read activity unless asked", async () => {
    const { deps, trace } = harness();
    const session = await createChatSession(deps, { workspaceId: "workspace-1" });
    trace(session.sessionId, "working", "2026-10-05T10:01:00.000Z", "running");
    const items = await listChatSessions(deps, { workspaceId: "workspace-1" });
    expect(items[0]?.activity).toBeUndefined();
  });

  it("returns turn activity with session search results only when asked", async () => {
    const { deps, trace } = harness();
    const busy = await createChatSession(deps, { workspaceId: "workspace-1", title: "Deploy plan" });
    await createChatSession(deps, { workspaceId: "workspace-1", title: "Unrelated" });
    trace(busy.sessionId, "asking", "2026-10-05T10:02:00.000Z", "waiting_for_approval");

    const searched = await searchChatSessions(deps, {
      query: "deploy",
      workspaceId: "workspace-1",
      includeActivity: true,
    });
    expect(searched.items.map((item) => item.session.sessionId)).toEqual([busy.sessionId]);
    expect(searched.items[0]?.session.activity?.latestTurn).toMatchObject({
      turnId: "asking",
      status: "waiting_for_approval",
    });
    expect(searched.items[0]?.session.activity?.turnCounts.waiting_for_approval).toBe(1);

    const plain = await searchChatSessions(deps, { query: "deploy", workspaceId: "workspace-1" });
    expect(plain.items[0]?.session.activity).toBeUndefined();
  });

  it("keeps activity in the public projection", () => {
    const activity = {
      observedAt: "2026-10-05T10:03:00.000Z",
      latestTurn: { turnId: "asking", status: "waiting_for_approval" as const, startedAt: "2026-10-05T10:02:00.000Z" },
      turnCounts: { queued: 0, running: 1, waiting_for_tool: 0, waiting_for_approval: 1, waiting_for_user_input: 0 },
    };
    const projected = projectChatSessionForPublic({ sessionId: "s", activity } as ChatSessionRecord);
    expect(projected.activity).toEqual(activity);
  });
});
