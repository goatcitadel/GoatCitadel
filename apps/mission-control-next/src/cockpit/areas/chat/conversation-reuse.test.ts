// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { createAttachmentStorageKey, createDraftStorageKey } from "@goatcitadel/threaded-surface-core";
import { findReusableEmptyConversation, startConversation, unsentConversationId } from "./conversation-reuse";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

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

describe("a conversation that holds unsent work", () => {
  it("names the open conversation only while text or attachments are in memory", () => {
    const base = { draft: "", pendingAttachments: [], selectedSessionId: "s" };
    expect(unsentConversationId(null)).toBeNull();
    expect(unsentConversationId(base)).toBeNull();
    expect(unsentConversationId({ ...base, draft: "  " })).toBeNull();
    expect(unsentConversationId({ ...base, draft: "hi" })).toBe("s");
    expect(unsentConversationId({ ...base, pendingAttachments: [{}] as never })).toBe("s");
  });

  it("is not reused when it is the selected one with typed text: a new one is created, the draft stays", () => {
    const r = rail([session("s-typed")], { selectedSessionId: "s-typed" });
    startConversation(r, "w", "s-typed");
    expect(r.onCreateSession).toHaveBeenCalledTimes(1);
    expect(r.onSelectSession).not.toHaveBeenCalled();
  });

  it("does not reuse another empty conversation that has a stored draft", () => {
    window.localStorage.setItem(createDraftStorageKey("w", "s-draft"), "half a thought");
    expect(find([session("s-draft")])).toBeUndefined();
  });

  it("does not reuse another empty conversation that has stored attachments", () => {
    window.localStorage.setItem(createAttachmentStorageKey("w", "s-att"), JSON.stringify([{ attachmentId: "a1" }]));
    expect(find([session("s-att")])).toBeUndefined();
  });

  it("falls through to the next untouched conversation", () => {
    window.localStorage.setItem(createDraftStorageKey("w", "newer"), "typed");
    const sessions = [session("older"), session("newer", { updatedAt: "2026-11-02T00:00:00.000Z" })];
    expect(find(sessions)).toBe("older");
  });

  it("ignores a blank stored draft and an empty attachment list", () => {
    window.localStorage.setItem(createDraftStorageKey("w", "s"), "   ");
    window.localStorage.setItem(createAttachmentStorageKey("w", "s"), "[]");
    expect(find([session("s")])).toBe("s");
  });

  it("is not reused when storage cannot be read: a new one is created", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    const r = rail([session("s-empty")]);
    startConversation(r, "w");
    expect(r.onCreateSession).toHaveBeenCalledTimes(1);
    expect(r.onSelectSession).not.toHaveBeenCalled();
  });

  it("still reuses a truly untouched conversation", () => {
    const r = rail([session("s-empty")], { selectedSessionId: "other" });
    startConversation(r, "w", "other");
    expect(r.onSelectSession).toHaveBeenCalledWith("s-empty");
  });
});
