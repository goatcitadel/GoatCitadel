import { describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { findReusableEmptyConversation, startConversation } from "./conversation-reuse";

const idle = {
  observedAt: "2026-11-01T00:00:00.000Z",
  latestTurn: null,
  turnCounts: { queued: 0, running: 0, waiting_for_tool: 0, waiting_for_approval: 0, waiting_for_user_input: 0 },
};

function session(id: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: id,
    workspaceId: "w",
    scope: "mission",
    mode: "chat",
    includeInHistory: true,
    pinned: false,
    lifecycleStatus: "active",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastActivityAt: "2026-11-01T00:00:00.000Z",
    tokenTotal: 0,
    activity: idle,
    ...overrides,
  } as ChatSessionRecord;
}

function rail(sessions: ChatSessionRecord[], extra: Record<string, unknown> = {}) {
  return {
    missionSessions: sessions,
    selectedProjectId: "all",
    loading: false,
    creatingSession: false,
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(),
    ...extra,
  } as unknown as MissionThreadedRenderSurfaceInput["sessionRail"];
}

const find = (sessions: ChatSessionRecord[], project = "all", workspace: string | undefined = "w") =>
  findReusableEmptyConversation(sessions, project, workspace)?.sessionId;

describe("findReusableEmptyConversation", () => {
  it("returns the untouched conversation, not one with a message", () => {
    expect(find([session("used", { lastMessagePreview: "hi" }), session("empty")])).toBe("empty");
  });

  it("prefers the most recently updated untouched conversation", () => {
    expect(find([session("old"), session("new", { updatedAt: "2026-11-02T00:00:00.000Z" })])).toBe("new");
  });

  it.each([
    ["a pinned conversation", { pinned: true }],
    ["an archived conversation", { lifecycleStatus: "archived" }],
    ["tokens already used", { tokenTotal: 5 }],
    ["a title", { title: "Release plan" }],
    ["a folder", { folderId: "f1" }],
    ["a folder name", { folderName: "Ideas" }],
    ["a tag", { tags: ["x"] }],
    ["a goal", { pinnedGoal: "ship it" }],
    ["a turn that started", { activity: { ...idle, latestTurn: { turnId: "t", status: "running", startedAt: "x" } } }],
    ["a running count", { activity: { ...idle, turnCounts: { ...idle.turnCounts, running: 1 } } }],
    ["no activity summary, so a send cannot be ruled out", { activity: undefined }],
    ["another mode", { mode: "code" }],
    ["a channel conversation", { scope: "external", channelConnectionId: "c1" }],
    ["another workspace", { workspaceId: "other" }],
    ["a handoff", { lastHandoff: {} }],
    ["generated artifacts", { generatedArtifacts: [{}] }],
  ])("does not reuse %s", (_name, overrides) => {
    expect(find([session("s", overrides as Partial<ChatSessionRecord>)])).toBeUndefined();
  });

  it("matches the selected project", () => {
    expect(find([session("s")], "p1")).toBeUndefined();
    expect(find([session("p", { projectId: "p1" })], "p1")).toBe("p");
    expect(find([session("p", { projectId: "p1" })], "none")).toBeUndefined();
  });

  it("reuses nothing when the workspace is not known", () => {
    expect(findReusableEmptyConversation([session("s")], "all", undefined)).toBeUndefined();
  });
});

describe("startConversation", () => {
  it("selects the empty conversation and does not create", () => {
    const r = rail([session("s-empty")]);
    startConversation(r, "w");
    expect(r.onSelectSession).toHaveBeenCalledWith("s-empty");
    expect(r.onCreateSession).not.toHaveBeenCalled();
  });

  it("creates when there is none", () => {
    const r = rail([session("s-used", { lastMessagePreview: "hi" })]);
    startConversation(r, "w");
    expect(r.onCreateSession).toHaveBeenCalledTimes(1);
    expect(r.onSelectSession).not.toHaveBeenCalled();
  });

  it("creates while the list is still loading", () => {
    const r = rail([session("s-empty")], { loading: true });
    startConversation(r, "w");
    expect(r.onCreateSession).toHaveBeenCalledTimes(1);
    expect(r.onSelectSession).not.toHaveBeenCalled();
  });
});
