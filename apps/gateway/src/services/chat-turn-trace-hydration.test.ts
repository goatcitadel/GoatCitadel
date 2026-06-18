import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import {
  buildChatTurnChildrenMap,
  createHydratedChatTurnTrace,
  listHydratedChatTurnTraces,
  resolveChatActiveLeafTurnId,
} from "./chat-turn-trace-hydration.js";

describe("chat turn trace hydration", () => {
  it("hydrates a single trace with persisted tool runs and default citations", () => {
    const storage = createStorage();
    const trace = createTrace({ citations: undefined });

    const hydrated = createHydratedChatTurnTrace({ storage }, "turn-1", trace);

    expect(storage.chatToolRuns.listByTurn).toHaveBeenCalledWith("turn-1");
    expect(hydrated).toEqual(
      expect.objectContaining({
        turnId: "turn-1",
        citations: [],
        toolRuns: [{ toolRunId: "tool-1", toolName: "memory.search", status: "executed" }],
      }),
    );
  });

  it("hydrates trace lists with ordered tool runs and skips missing execution plans", () => {
    const storage = createStorage({
      traces: [
        createTrace({ turnId: "turn-1", executionPlanId: "plan-1", citations: undefined }),
        createTrace({ turnId: "turn-2", executionPlanId: "missing-plan", citations: [{ citationId: "c-2" }] }),
        createTrace({ turnId: "turn-3" }),
      ],
    });
    storage.chatExecutionPlans.get = vi.fn((planId: string) => {
      if (planId === "missing-plan") {
        throw new Error("missing plan");
      }
      return { planId, steps: [{ stepId: "step-1" }] };
    }) as never;

    const hydrated = listHydratedChatTurnTraces({ storage }, "session-1", 3);

    expect(storage.chatTurnTraces.listBySession).toHaveBeenCalledWith("session-1", 3);
    expect(storage.chatToolRuns.listByTurnIds).toHaveBeenCalledWith(["turn-1", "turn-2", "turn-3"]);
    expect(hydrated).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        citations: [],
        toolRuns: [{ toolRunId: "tool-turn-1", toolName: "browser.search", status: "executed" }],
        executionPlan: { planId: "plan-1", steps: [{ stepId: "step-1" }] },
      }),
      expect.objectContaining({
        turnId: "turn-2",
        citations: [{ citationId: "c-2" }],
        toolRuns: [],
        executionPlan: undefined,
      }),
      expect.objectContaining({
        turnId: "turn-3",
        citations: [],
        executionPlan: undefined,
      }),
    ]);
  });

  it("only hydrates decision trace records when explicitly requested", () => {
    const storage = createStorage({
      traces: [createTrace({ turnId: "turn-1" }), createTrace({ turnId: "turn-2" })],
    });
    storage.runtimeDecisionTraces = {
      list: vi.fn(() => [
        {
          decisionId: "decision-1",
          kind: "workflow_choice",
          scope: { sessionId: "session-1", turnId: "turn-1" },
          selected: "Use Cowork orchestration",
          rationale: "The turn requested supervised implementation.",
          alternatives: [],
          signals: [],
          evidenceRefs: [],
          createdAt: "2026-06-18T00:00:00.000Z",
        },
      ]),
    } as never;

    const defaultHydrated = listHydratedChatTurnTraces({ storage }, "session-1", 2);
    const explicitHydrated = listHydratedChatTurnTraces({ storage }, "session-1", 2, {
      includeDecisionTrace: true,
    });

    expect(defaultHydrated[0]?.decisionTrace).toBeUndefined();
    expect(explicitHydrated[0]?.decisionTrace?.[0]?.decisionId).toBe("decision-1");
    expect(storage.runtimeDecisionTraces.list).toHaveBeenCalledWith({ sessionId: "session-1", limit: 100 });
  });

  it("builds child turn maps and reuses persisted active leaves", () => {
    const storage = createStorage();
    const traces = [
      createTrace({ turnId: "root", parentTurnId: undefined }),
      createTrace({ turnId: "child-a", parentTurnId: "root" }),
      createTrace({ turnId: "child-b", parentTurnId: "root" }),
      createTrace({ turnId: "grandchild", parentTurnId: "child-a" }),
    ];
    storage.chatSessionBranchState.get = vi.fn(() => ({
      sessionId: "session-1",
      activeLeafTurnId: "child-b",
    })) as never;

    expect(buildChatTurnChildrenMap(traces)).toEqual(
      new Map([
        ["root", ["child-a", "child-b"]],
        ["child-a", ["grandchild"]],
      ]),
    );
    expect(resolveChatActiveLeafTurnId({ storage }, "session-1", traces)).toBe("child-b");
    expect(storage.chatSessionBranchState.setActiveLeaf).not.toHaveBeenCalled();
  });

  it("resolves and persists the newest leaf when branch state is absent or stale", () => {
    const storage = createStorage();
    storage.chatSessionBranchState.get = vi.fn(() => ({
      sessionId: "session-1",
      activeLeafTurnId: "missing",
    })) as never;
    const traces = [
      createTrace({
        turnId: "root",
        parentTurnId: undefined,
        startedAt: "2026-05-14T00:00:00.000Z",
      }),
      createTrace({
        turnId: "new-parent",
        parentTurnId: "root",
        startedAt: "2026-05-14T00:02:00.000Z",
      }),
      createTrace({
        turnId: "new-leaf",
        parentTurnId: "new-parent",
        startedAt: "2026-05-14T00:03:00.000Z",
        finishedAt: "2026-05-14T00:04:00.000Z",
      }),
      createTrace({
        turnId: "older-leaf",
        parentTurnId: "root",
        startedAt: "2026-05-14T00:01:00.000Z",
      }),
    ];

    expect(resolveChatActiveLeafTurnId({ storage }, "session-1", traces)).toBe("new-leaf");
    expect(storage.chatSessionBranchState.setActiveLeaf).toHaveBeenCalledWith(
      "session-1",
      "new-leaf",
      "2026-05-14T00:04:00.000Z",
    );
  });

  it("uses turn id ordering as the active-leaf tie breaker for equal start times", () => {
    const storage = createStorage();
    const traces = [
      createTrace({
        turnId: "turn-a",
        parentTurnId: undefined,
        startedAt: "2026-05-14T00:00:00.000Z",
      }),
      createTrace({
        turnId: "turn-b",
        parentTurnId: undefined,
        startedAt: "2026-05-14T00:00:00.000Z",
      }),
    ];

    expect(resolveChatActiveLeafTurnId({ storage }, "session-1", traces)).toBe("turn-b");
    expect(storage.chatSessionBranchState.setActiveLeaf).toHaveBeenCalledWith(
      "session-1",
      "turn-b",
      "2026-05-14T00:00:00.000Z",
    );
  });

  it("ignores malformed self-parent and missing-parent child edges", () => {
    const traces = [
      createTrace({ turnId: "root", parentTurnId: undefined }),
      createTrace({ turnId: "self-parent", parentTurnId: "self-parent" }),
      createTrace({ turnId: "missing-parent", parentTurnId: "missing" }),
      createTrace({ turnId: "child", parentTurnId: "root" }),
    ];

    expect(buildChatTurnChildrenMap(traces)).toEqual(new Map([["root", ["child"]]]));
  });

  it("returns undefined when there are no traces to hydrate into an active leaf", () => {
    const storage = createStorage();

    expect(resolveChatActiveLeafTurnId({ storage }, "session-1", [])).toBeUndefined();
    expect(storage.chatSessionBranchState.setActiveLeaf).not.toHaveBeenCalled();
  });
});

function createTrace(patch: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId: patch.turnId ?? "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    parentTurnId: "root",
    branchKind: "append",
    status: "completed",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: "2026-05-14T00:00:00.000Z",
    routing: {},
    toolRuns: [],
    citations: [],
    ...patch,
  };
}

function createStorage(options: { traces?: ChatTurnTraceRecord[] } = {}) {
  return {
    chatExecutionPlans: {
      get: vi.fn((planId: string) => ({ planId, steps: [] })),
    },
    chatSessionBranchState: {
      get: vi.fn(() => undefined),
      setActiveLeaf: vi.fn(),
    },
    chatToolRuns: {
      listByTurn: vi.fn(() => [{ toolRunId: "tool-1", toolName: "memory.search", status: "executed" }]),
      listByTurnIds: vi.fn(
        () =>
          new Map([
            ["turn-1", [{ toolRunId: "tool-turn-1", toolName: "browser.search", status: "executed" }]],
            ["turn-2", []],
          ]),
      ),
    },
    chatTurnTraces: {
      listBySession: vi.fn(() => options.traces ?? []),
    },
    runtimeDecisionTraces: undefined,
  } as never;
}
