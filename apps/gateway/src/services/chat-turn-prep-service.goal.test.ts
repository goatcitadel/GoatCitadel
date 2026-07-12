import { describe, expect, it, vi } from "vitest";
import {
  applyGoalToGuidanceSystemInstruction,
  advanceGoalForTurn,
  DEFAULT_GOAL_TURN_BUDGET,
  prepareAgentChatTurn,
} from "./chat-turn-prep-service.js";

describe("applyGoalToGuidanceSystemInstruction", () => {
  it("returns base instruction when goal is null", () => {
    expect(applyGoalToGuidanceSystemInstruction({ baseInstruction: "base", goal: null })).toBe("base");
  });
  it("returns empty string when no goal and no base instruction", () => {
    expect(applyGoalToGuidanceSystemInstruction({ baseInstruction: undefined, goal: null })).toBe("");
  });
  it("returns just the goal block when goal is set but no base instruction", () => {
    expect(applyGoalToGuidanceSystemInstruction({ baseInstruction: undefined, goal: "ship kanban" })).toContain(
      "Pinned goal: ship kanban",
    );
  });
  it("prepends Pinned goal section when goal is set", () => {
    const out = applyGoalToGuidanceSystemInstruction({ baseInstruction: "base", goal: "ship kanban" });
    expect(out).toContain("Pinned goal: ship kanban");
    expect(out).toContain("base");
    expect(out.indexOf("Pinned goal")).toBeLessThan(out.indexOf("base"));
  });
});

describe("advanceGoalForTurn", () => {
  it("returns { cleared: false } when below budget", () => {
    expect(advanceGoalForTurn({ turnsUsed: 1, turnBudget: 20 })).toEqual({ cleared: false });
  });
  it("returns { cleared: true } when at or above budget", () => {
    expect(advanceGoalForTurn({ turnsUsed: 20, turnBudget: 20 })).toEqual({ cleared: true });
    expect(advanceGoalForTurn({ turnsUsed: 25, turnBudget: 20 })).toEqual({ cleared: true });
  });
  it("treats null budget as DEFAULT_GOAL_TURN_BUDGET", () => {
    expect(advanceGoalForTurn({ turnsUsed: DEFAULT_GOAL_TURN_BUDGET - 1, turnBudget: null })).toEqual({
      cleared: false,
    });
    expect(advanceGoalForTurn({ turnsUsed: DEFAULT_GOAL_TURN_BUDGET, turnBudget: null })).toEqual({ cleared: true });
  });
});

describe("prepareAgentChatTurn stream mutation commit truth", () => {
  it("signals commit only after user-event ingestion commits before a post-commit projection failure escapes", async () => {
    const markCommitted = vi.fn();
    const commitAlongsideCanonicalWrite = vi.fn();
    const ingestEvent = vi.fn(async (_key, _payload, options?: { onCommit?: () => void; afterCommit?: () => void }) => {
      options?.onCommit?.();
      options?.afterCommit?.();
      throw new Error("transcript projection failed after commit");
    });
    const host = {
      storage: {
        chatSessionMeta: {
          ensure: vi.fn(() => ({ lifecycleStatus: "active", workspaceId: "default" })),
        },
        workspaces: {
          find: vi.fn(() => ({ workspaceId: "default", citadelId: "personal" })),
        },
        chatAttachments: {
          listByIds: vi.fn(() => []),
        },
      },
      getSession: vi.fn(() => ({
        sessionId: "session-1",
        sessionKey: "mission:operator",
        kind: "mission",
        channel: "mission",
        account: "operator",
      })),
      ensureChatSessionRuntimeGrants: vi.fn(),
      normalizeWorkspaceId: vi.fn(() => "default"),
      maybeAutoTitleChatSession: vi.fn(),
      routeFromSession: vi.fn(() => ({ channel: "mission", account: "operator" })),
      loadChatTurnSessionState: vi.fn(async () => ({
        traces: [],
        tracesById: new Map(),
        messages: [],
        messagesById: new Map(),
        childrenByTurnId: new Map(),
        turnLineageById: new Map(),
      })),
      ingestEvent,
    } as never;

    await expect(
      prepareAgentChatTurn(
        host,
        "session-1",
        { content: "hello" },
        {
          mutationLifecycle: { commitAlongsideCanonicalWrite, markCommitted },
        },
      ),
    ).rejects.toThrow("transcript projection failed after commit");

    expect(commitAlongsideCanonicalWrite).toHaveBeenCalledTimes(1);
    expect(markCommitted).toHaveBeenCalledTimes(1);
    expect(ingestEvent).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      onCommit: expect.any(Function),
      afterCommit: expect.any(Function),
    });
  });

  it("does not signal commit when user-event ingestion rolls back", async () => {
    const markCommitted = vi.fn();
    const commitAlongsideCanonicalWrite = vi.fn();
    const ingestEvent = vi.fn(async (_key, _payload, options?: { onCommit?: () => void; afterCommit?: () => void }) => {
      options?.onCommit?.();
      throw new Error("usage write failed inside ingest transaction");
    });
    const host = {
      storage: {
        chatSessionMeta: {
          ensure: vi.fn(() => ({ lifecycleStatus: "active", workspaceId: "default" })),
        },
        workspaces: {
          find: vi.fn(() => ({ workspaceId: "default", citadelId: "personal" })),
        },
        chatAttachments: {
          listByIds: vi.fn(() => []),
        },
      },
      getSession: vi.fn(() => ({
        sessionId: "session-1",
        sessionKey: "mission:operator",
        kind: "mission",
        channel: "mission",
        account: "operator",
      })),
      ensureChatSessionRuntimeGrants: vi.fn(),
      normalizeWorkspaceId: vi.fn(() => "default"),
      maybeAutoTitleChatSession: vi.fn(),
      routeFromSession: vi.fn(() => ({ channel: "mission", account: "operator" })),
      loadChatTurnSessionState: vi.fn(async () => ({
        traces: [],
        tracesById: new Map(),
        messages: [],
        messagesById: new Map(),
        childrenByTurnId: new Map(),
        turnLineageById: new Map(),
      })),
      ingestEvent,
    } as never;

    await expect(
      prepareAgentChatTurn(
        host,
        "session-1",
        { content: "hello" },
        {
          mutationLifecycle: { commitAlongsideCanonicalWrite, markCommitted },
        },
      ),
    ).rejects.toThrow("usage write failed inside ingest transaction");

    expect(commitAlongsideCanonicalWrite).toHaveBeenCalledTimes(1);
    expect(markCommitted).not.toHaveBeenCalled();
    expect(ingestEvent).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      onCommit: expect.any(Function),
      afterCommit: expect.any(Function),
    });
  });
});
