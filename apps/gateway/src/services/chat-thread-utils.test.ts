import { describe, expect, it } from "vitest";
import type { ChatMessageRecord, ChatThreadSystemNoticeRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { buildChatThreadResponse, buildSelectedPathTurnIds, resolveNewestLeafTurnId } from "./chat-thread-utils.js";

function makeMessage(messageId: string, role: "user" | "assistant", content: string): ChatMessageRecord {
  return {
    messageId,
    sessionId: "sess-1",
    role,
    actorType: role === "user" ? "user" : "agent",
    actorId: role === "user" ? "operator" : "assistant",
    content,
    timestamp: "2026-03-07T00:00:00.000Z",
  };
}

function makeTrace(turnId: string, overrides: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId,
    sessionId: "sess-1",
    userMessageId: `user-${turnId}`,
    parentTurnId: undefined,
    branchKind: "append",
    sourceTurnId: undefined,
    assistantMessageId: `assistant-${turnId}`,
    status: "completed",
    mode: "chat",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: "2026-03-07T00:00:00.000Z",
    finishedAt: "2026-03-07T00:00:01.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
    ...overrides,
  };
}

describe("chat thread utils", () => {
  it("keeps system notices separate, chronological, and inert when no conversation branch exists", () => {
    const notice = (noticeId: string, timestamp: string): ChatThreadSystemNoticeRecord => ({
      kind: "system_heartbeat",
      noticeId,
      turnId: `turn-${noticeId}`,
      message: {
        messageId: noticeId,
        sessionId: "sess-1",
        role: "assistant",
        actorType: "system",
        actorId: "system-heartbeat",
        content: `Notice ${noticeId}`,
        timestamp,
      },
    });

    const thread = buildChatThreadResponse({
      sessionId: "sess-1",
      activeLeafTurnId: "turn-notice-late",
      turns: [],
      systemNotices: [
        notice("notice-late", "2026-03-07T00:02:00.000Z"),
        notice("notice-early", "2026-03-07T00:01:00.000Z"),
      ],
    });

    expect(thread.turns).toEqual([]);
    expect(thread.activeLeafTurnId).toBeUndefined();
    expect(thread.selectedTurnId).toBeUndefined();
    expect(thread.systemNotices.map((item) => item.noticeId)).toEqual(["notice-early", "notice-late"]);
    expect(thread.systemNoticeHiddenCount).toBe(0);
  });

  it("bounds the Gateway system-notice response and reports the omitted count", () => {
    const notices: ChatThreadSystemNoticeRecord[] = Array.from({ length: 75 }, (_, index) => ({
      kind: "system_heartbeat",
      noticeId: `notice-${String(index).padStart(3, "0")}`,
      turnId: `heartbeat-turn-${index}`,
      message: {
        messageId: `notice-${index}`,
        sessionId: "sess-1",
        role: "assistant",
        actorType: "system",
        actorId: "system-heartbeat",
        content: `Notice ${index}`,
        timestamp: new Date(Date.UTC(2026, 2, 7, 0, index)).toISOString(),
      },
    }));

    const thread = buildChatThreadResponse({
      sessionId: "sess-1",
      turns: [],
      systemNotices: notices,
      systemNoticeHiddenCount: 4,
    });

    expect(thread.systemNotices).toHaveLength(60);
    expect(thread.systemNotices[0]?.noticeId).toBe("notice-015");
    expect(thread.systemNotices.at(-1)?.noticeId).toBe("notice-074");
    expect(thread.systemNoticeHiddenCount).toBe(19);
  });

  it("builds the selected branch path and sibling metadata from an active leaf", () => {
    const thread = buildChatThreadResponse({
      sessionId: "sess-1",
      activeLeafTurnId: "turn-3b",
      turns: [
        {
          trace: makeTrace("turn-1"),
          userMessage: makeMessage("user-turn-1", "user", "Start"),
          assistantMessage: makeMessage("assistant-turn-1", "assistant", "Base"),
        },
        {
          trace: makeTrace("turn-2a", {
            parentTurnId: "turn-1",
            startedAt: "2026-03-07T00:01:00.000Z",
          }),
          userMessage: makeMessage("user-turn-2a", "user", "Path A"),
          assistantMessage: makeMessage("assistant-turn-2a", "assistant", "A"),
        },
        {
          trace: makeTrace("turn-2b", {
            parentTurnId: "turn-1",
            branchKind: "retry",
            sourceTurnId: "turn-2a",
            startedAt: "2026-03-07T00:02:00.000Z",
          }),
          userMessage: makeMessage("user-turn-2b", "user", "Path B"),
          assistantMessage: makeMessage("assistant-turn-2b", "assistant", "B"),
        },
        {
          trace: makeTrace("turn-3b", {
            parentTurnId: "turn-2b",
            startedAt: "2026-03-07T00:03:00.000Z",
          }),
          userMessage: makeMessage("user-turn-3b", "user", "Follow-up"),
          assistantMessage: makeMessage("assistant-turn-3b", "assistant", "Branch leaf"),
        },
      ],
    });

    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-1", "turn-2b", "turn-3b"]);
    expect(thread.turns[1]?.branch).toMatchObject({
      siblingTurnIds: ["turn-2a", "turn-2b"],
      activeSiblingIndex: 1,
      siblingCount: 2,
      newestLeafTurnId: "turn-3b",
    });
  });

  it("resolves the newest descendant leaf and selected path ids", () => {
    const turnsById = new Map([
      ["turn-1", { turnId: "turn-1", parentTurnId: undefined }],
      ["turn-2a", { turnId: "turn-2a", parentTurnId: "turn-1" }],
      ["turn-2b", { turnId: "turn-2b", parentTurnId: "turn-1" }],
      ["turn-3b", { turnId: "turn-3b", parentTurnId: "turn-2b" }],
    ]);
    expect(buildSelectedPathTurnIds(turnsById, "turn-3b")).toEqual(["turn-1", "turn-2b", "turn-3b"]);

    const newestLeaf = resolveNewestLeafTurnId(
      "turn-1",
      new Map([
        ["turn-1", { turnId: "turn-1", startedAtMs: 1 }],
        ["turn-2a", { turnId: "turn-2a", startedAtMs: 2 }],
        ["turn-2b", { turnId: "turn-2b", startedAtMs: 3 }],
        ["turn-3b", { turnId: "turn-3b", startedAtMs: 4 }],
      ]),
      new Map([
        ["turn-1", ["turn-2a", "turn-2b"]],
        ["turn-2b", ["turn-3b"]],
      ]),
    );

    expect(newestLeaf).toBe("turn-3b");
  });

  it("keeps malformed self-parented turns from recursing while hydrating a thread", () => {
    const thread = buildChatThreadResponse({
      sessionId: "sess-1",
      activeLeafTurnId: "turn-1",
      turns: [
        {
          trace: makeTrace("turn-1", {
            parentTurnId: "turn-1",
          }),
          userMessage: makeMessage("user-turn-1", "user", "Start"),
          assistantMessage: makeMessage("assistant-turn-1", "assistant", "Done"),
        },
      ],
    });

    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]?.parentTurnId).toBeUndefined();
    expect(thread.turns[0]?.branch.newestLeafTurnId).toBe("turn-1");
    expect(thread.turns[0]?.trace.parentTurnId).toBe("turn-1");
  });

  it("resolves newest leaves defensively when stored child edges contain a cycle", () => {
    const newestLeaf = resolveNewestLeafTurnId(
      "turn-a",
      new Map([
        ["turn-a", { turnId: "turn-a", startedAtMs: 1 }],
        ["turn-b", { turnId: "turn-b", startedAtMs: 2 }],
      ]),
      new Map([
        ["turn-a", ["turn-b"]],
        ["turn-b", ["turn-a"]],
      ]),
    );

    expect(newestLeaf).toBe("turn-b");
  });
});
