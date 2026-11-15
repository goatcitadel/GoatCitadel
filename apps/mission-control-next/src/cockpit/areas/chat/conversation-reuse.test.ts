import { describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { findReusableEmptyConversation, startConversation } from "./conversation-reuse";

function session(id: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: id,
    workspaceId: "w",
    title: id,
    pinned: false,
    lifecycleStatus: "active",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastActivityAt: "2026-11-01T00:00:00.000Z",
    tokenTotal: 0,
    ...overrides,
  } as ChatSessionRecord;
}

function rail(sessions: ChatSessionRecord[], selectedProjectId = "all") {
  return {
    missionSessions: sessions,
    selectedProjectId,
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(),
  } as unknown as MissionThreadedRenderSurfaceInput["sessionRail"];
}

describe("findReusableEmptyConversation", () => {
  it("returns the empty conversation, not one with a message", () => {
    const found = findReusableEmptyConversation(
      [session("s-used", { lastMessagePreview: "hi" }), session("s-empty")],
      "all",
    );
    expect(found?.sessionId).toBe("s-empty");
  });

  it("prefers the most recently updated empty conversation", () => {
    const found = findReusableEmptyConversation(
      [session("old"), session("new", { updatedAt: "2026-11-02T00:00:00.000Z" })],
      "all",
    );
    expect(found?.sessionId).toBe("new");
  });

  it("skips pinned, archived and used-token conversations", () => {
    expect(
      findReusableEmptyConversation(
        [
          session("a", { pinned: true }),
          session("b", { lifecycleStatus: "archived" }),
          session("c", { tokenTotal: 5 }),
        ],
        "all",
      ),
    ).toBeUndefined();
  });

  it("matches the selected project", () => {
    expect(findReusableEmptyConversation([session("s-empty")], "p1")).toBeUndefined();
    expect(findReusableEmptyConversation([session("p", { projectId: "p1" })], "p1")?.sessionId).toBe("p");
    expect(findReusableEmptyConversation([session("p", { projectId: "p1" })], "none")).toBeUndefined();
  });
});

describe("startConversation", () => {
  it("selects the empty conversation and does not create", () => {
    const r = rail([session("s-empty")]);
    startConversation(r);
    expect(r.onSelectSession).toHaveBeenCalledWith("s-empty");
    expect(r.onCreateSession).not.toHaveBeenCalled();
  });

  it("creates when there is none", () => {
    const r = rail([session("s-used", { lastMessagePreview: "hi" })]);
    startConversation(r);
    expect(r.onCreateSession).toHaveBeenCalledTimes(1);
    expect(r.onSelectSession).not.toHaveBeenCalled();
  });
});
