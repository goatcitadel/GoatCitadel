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
  it("blocks a synchronous prep mutation when admission changes at its transaction boundary", async () => {
    let inTransaction = false;
    const ensureChatSessionRuntimeGrants = vi.fn();
    const host = {
      storage: {
        runImmediateTransaction: vi.fn((work) => {
          inTransaction = true;
          try {
            return work();
          } finally {
            inTransaction = false;
          }
        }),
      },
      assertTurnAdmissionWrite: vi.fn(() => {
        if (inTransaction) throw new Error("generation changed at write");
      }),
      getSession: vi.fn(() => ({ sessionId: "session-1" })),
      ensureChatSessionRuntimeGrants,
    } as never;
    const turnAdmission = {
      identity: {
        admissionId: "admission-1",
        sessionIncarnationId: "incarnation-1",
        workspaceId: "default",
        sessionId: "session-1",
        turnId: "turn-1",
        aggregateRevision: 1,
        controllerGeneration: 1,
        materialSha256: "a".repeat(64),
      },
      admittedRequest: { content: "hello" },
      requestActor: { actorKind: "operator", actorId: "operator:test" },
      requestClaim: { runtimeOwnerId: "runtime-1", leaseRevision: 1 },
    };

    await expect(
      prepareAgentChatTurn(host, "session-1", { content: "hello" }, { turnId: "turn-1", turnAdmission }),
    ).rejects.toThrow("generation changed at write");
    expect(ensureChatSessionRuntimeGrants).not.toHaveBeenCalled();
  });

  it("checks the exact admission inside user ingest and again before append-only mobile provenance", async () => {
    let insideIngestCommit = false;
    let ingestReturned = false;
    let checkedInsideIngest = false;
    let checkedAfterIngest = false;
    const assertTurnAdmissionWrite = vi.fn(() => {
      if (insideIngestCommit) checkedInsideIngest = true;
      if (ingestReturned) checkedAfterIngest = true;
    });
    const auditAppend = vi.fn(async () => {
      expect(checkedInsideIngest).toBe(true);
      expect(checkedAfterIngest).toBe(true);
      throw new Error("stop after provenance");
    });
    const host = {
      storage: {
        runImmediateTransaction: vi.fn((work) => work()),
        chatSessionMeta: {
          get: vi.fn(() => ({ lifecycleStatus: "active", workspaceId: "default" })),
        },
        workspaces: { find: vi.fn(() => ({ workspaceId: "default", citadelId: "personal" })) },
        chatAttachments: { listByIds: vi.fn(() => []) },
        audit: { append: auditAppend },
      },
      assertTurnAdmissionWrite,
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
      ingestEvent: vi.fn(async (_key, _payload, options?: { onCommit?: () => void; afterCommit?: () => void }) => {
        insideIngestCommit = true;
        options?.onCommit?.();
        insideIngestCommit = false;
        options?.afterCommit?.();
        ingestReturned = true;
      }),
    } as never;
    const turnAdmission = {
      identity: {
        admissionId: "admission-1",
        sessionIncarnationId: "incarnation-1",
        workspaceId: "default",
        sessionId: "session-1",
        turnId: "turn-1",
        aggregateRevision: 1,
        controllerGeneration: 1,
        materialSha256: "a".repeat(64),
      },
      admittedRequest: { content: "hello", mobileContext: [] },
      requestActor: { actorKind: "operator", actorId: "operator:test" },
      requestClaim: { runtimeOwnerId: "runtime-1", leaseRevision: 1 },
    };

    await expect(
      prepareAgentChatTurn(
        host,
        "session-1",
        {
          content: "hello",
          mobileContext: [
            {
              contextId: "mobile-context-1",
              capabilityId: "location",
              userVisibleReason: "Nearby context",
              summary: "Near Seattle",
              capturedAt: "2026-07-15T00:00:00.000Z",
              sensitivity: "coarse",
              structuredFields: {},
            },
          ],
        },
        { turnId: "turn-1", turnAdmission },
      ),
    ).rejects.toThrow("stop after provenance");

    expect(assertTurnAdmissionWrite).toHaveBeenCalledWith(turnAdmission);
    expect(auditAppend).toHaveBeenCalledTimes(1);
  });

  it("signals commit only after user-event ingestion commits before a post-commit projection failure escapes", async () => {
    const markCommitted = vi.fn();
    const commitAlongsideCanonicalWrite = vi.fn();
    const onUserMessageCommitted = vi.fn();
    const ingestEvent = vi.fn(async (_key, _payload, options?: { onCommit?: () => void; afterCommit?: () => void }) => {
      options?.onCommit?.();
      options?.afterCommit?.();
      throw new Error("transcript projection failed after commit");
    });
    const host = {
      storage: {
        chatSessionMeta: {
          get: vi.fn(() => ({ lifecycleStatus: "active", workspaceId: "default" })),
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
      onUserMessageCommitted,
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
    expect(onUserMessageCommitted).toHaveBeenCalledWith("session-1", expect.any(String));
    expect(ingestEvent).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      onCommit: expect.any(Function),
      afterCommit: expect.any(Function),
    });
  });

  it("does not signal commit when user-event ingestion rolls back", async () => {
    const markCommitted = vi.fn();
    const commitAlongsideCanonicalWrite = vi.fn();
    const onUserMessageCommitted = vi.fn();
    const ingestEvent = vi.fn(async (_key, _payload, options?: { onCommit?: () => void; afterCommit?: () => void }) => {
      options?.onCommit?.();
      throw new Error("usage write failed inside ingest transaction");
    });
    const host = {
      storage: {
        chatSessionMeta: {
          get: vi.fn(() => ({ lifecycleStatus: "active", workspaceId: "default" })),
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
      onUserMessageCommitted,
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
    expect(onUserMessageCommitted).not.toHaveBeenCalled();
    expect(ingestEvent).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      onCommit: expect.any(Function),
      afterCommit: expect.any(Function),
    });
  });
});
