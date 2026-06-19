import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { undoChatTurns, type ChatTurnUndoDependencies } from "./chat-turn-undo-service.js";

function createDeps(
  input: {
    traces?: ChatTurnTraceRecord[];
    activeLeafTurnId?: string;
    deleteMessages?: ReturnType<typeof vi.fn>;
    deleteTraces?: ReturnType<typeof vi.fn>;
    setActiveLeaf?: ReturnType<typeof vi.fn>;
    clearBranch?: ReturnType<typeof vi.fn>;
    lineage?: Array<{ turnId: string; parentTurnId?: string }>;
  } = {},
): ChatTurnUndoDependencies {
  const traces = input.traces ?? [];
  const deleteMessages = input.deleteMessages ?? vi.fn(() => 0);
  const deleteTraces = input.deleteTraces ?? vi.fn(() => 0);
  const setActiveLeaf = input.setActiveLeaf ?? vi.fn();
  const clearBranch = input.clearBranch ?? vi.fn();
  return {
    getSession: vi.fn(() => ({ sessionId: "session-1" })),
    loadChatTurnSessionState: vi.fn(async () => ({
      traces,
      tracesById: new Map(traces.map((trace) => [trace.turnId, trace])),
      turnLineageById: new Map(
        (input.lineage ?? traces).map((trace) => [
          trace.turnId,
          { turnId: trace.turnId, parentTurnId: trace.parentTurnId },
        ]),
      ),
      messages: [],
      messagesById: new Map(),
      childrenByTurnId: new Map(),
      activeLeafTurnId: input.activeLeafTurnId,
    })),
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    storage: {
      runImmediateTransaction: (callback) => callback(),
      chatMessages: { deleteByMessageIds: deleteMessages },
      chatTurnTraces: { deleteByTurnIds: deleteTraces },
      chatSessionBranchState: { setActiveLeaf, clear: clearBranch },
      chatSessionMeta: { get: vi.fn(() => ({ lifecycleStatus: "active" })) },
    },
    withChatTurnWriteLease: vi.fn(async (_sessionId, _operation, task) => task()),
  } as ChatTurnUndoDependencies;
}

describe("chat turn undo service", () => {
  it("returns an empty result when the session has no active leaf", async () => {
    const deps = createDeps();

    await expect(undoChatTurns(deps, "session-1", 3)).resolves.toEqual({
      undoneCount: 0,
      requestedCount: 3,
      removedTurnIds: [],
      removedMessageCount: 0,
    });
  });

  it("deletes completed tail turns and points the active branch at the retained parent", async () => {
    const deleteMessages = vi.fn(() => 4);
    const deleteTraces = vi.fn(() => 2);
    const setActiveLeaf = vi.fn();
    const clearBranch = vi.fn();
    const traces = [
      {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        status: "completed",
      },
      {
        turnId: "turn-2",
        sessionId: "session-1",
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        parentTurnId: "turn-1",
        status: "completed",
      },
      {
        turnId: "turn-3",
        sessionId: "session-1",
        userMessageId: "user-3",
        assistantMessageId: "assistant-3",
        parentTurnId: "turn-2",
        status: "completed",
      },
    ] as ChatTurnTraceRecord[];
    const deps = createDeps({
      traces,
      activeLeafTurnId: "turn-3",
      deleteMessages,
      deleteTraces,
      setActiveLeaf,
      clearBranch,
    });

    await expect(undoChatTurns(deps, "session-1", 2, { operatorId: "operator-test" })).resolves.toMatchObject({
      undoneCount: 2,
      removedTurnIds: ["turn-2", "turn-3"],
      removedMessageCount: 4,
      activeLeafTurnId: "turn-1",
    });

    expect(deleteMessages).toHaveBeenCalledWith("session-1", ["user-2", "assistant-2", "user-3", "assistant-3"]);
    expect(deleteTraces).toHaveBeenCalledWith("session-1", ["turn-2", "turn-3"]);
    expect(setActiveLeaf).toHaveBeenCalledWith("session-1", "turn-1", expect.any(String));
    expect(clearBranch).not.toHaveBeenCalled();
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.turns_undone",
        context: expect.objectContaining({ operatorId: "operator-test" }),
      }),
    );
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.objectContaining({ type: "chat_thread_undone", activeLeafTurnId: "turn-1" }),
      expect.objectContaining({ eventAuthority: "retained_stream" }),
    );
  });

  it("clears branch state when undo removes the full selected path", async () => {
    const clearBranch = vi.fn();
    const traces = [
      {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "completed",
      },
    ] as ChatTurnTraceRecord[];
    const deps = createDeps({
      traces,
      activeLeafTurnId: "turn-1",
      deleteMessages: vi.fn(() => 1),
      deleteTraces: vi.fn(() => 1),
      clearBranch,
    });

    await expect(undoChatTurns(deps, "session-1", 1)).resolves.toMatchObject({
      undoneCount: 1,
      activeLeafTurnId: undefined,
    });

    expect(clearBranch).toHaveBeenCalledWith("session-1");
  });

  it("clamps counts below one to a single tail turn", async () => {
    const traces = [
      {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "completed",
      },
      {
        turnId: "turn-2",
        sessionId: "session-1",
        userMessageId: "user-2",
        parentTurnId: "turn-1",
        status: "completed",
      },
    ] as ChatTurnTraceRecord[];
    const deps = createDeps({
      traces,
      activeLeafTurnId: "turn-2",
      deleteMessages: vi.fn(() => 1),
      deleteTraces: vi.fn(() => 1),
    });

    await expect(undoChatTurns(deps, "session-1", 0)).resolves.toMatchObject({
      undoneCount: 1,
      requestedCount: 1,
      removedTurnIds: ["turn-2"],
      activeLeafTurnId: "turn-1",
    });
  });

  it("clamps counts above twenty while removing the available selected path", async () => {
    const traces = [
      {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "completed",
      },
      {
        turnId: "turn-2",
        sessionId: "session-1",
        userMessageId: "user-2",
        parentTurnId: "turn-1",
        status: "completed",
      },
      {
        turnId: "turn-3",
        sessionId: "session-1",
        userMessageId: "user-3",
        parentTurnId: "turn-2",
        status: "completed",
      },
    ] as ChatTurnTraceRecord[];
    const deps = createDeps({
      traces,
      activeLeafTurnId: "turn-3",
      deleteMessages: vi.fn(() => 3),
      deleteTraces: vi.fn(() => 3),
    });

    await expect(undoChatTurns(deps, "session-1", 25)).resolves.toMatchObject({
      undoneCount: 3,
      requestedCount: 20,
      removedTurnIds: ["turn-1", "turn-2", "turn-3"],
      activeLeafTurnId: undefined,
    });
  });

  it("preserves the active leaf when lineage exists without matching trace records", async () => {
    const deleteMessages = vi.fn(() => 0);
    const deleteTraces = vi.fn(() => 0);
    const setActiveLeaf = vi.fn();
    const clearBranch = vi.fn();
    const deps = createDeps({
      traces: [],
      lineage: [{ turnId: "turn-1" }, { turnId: "turn-2", parentTurnId: "turn-1" }],
      activeLeafTurnId: "turn-2",
      deleteMessages,
      deleteTraces,
      setActiveLeaf,
      clearBranch,
    });

    await expect(undoChatTurns(deps, "session-1", 1)).resolves.toEqual({
      undoneCount: 0,
      requestedCount: 1,
      removedTurnIds: [],
      removedMessageCount: 0,
      activeLeafTurnId: "turn-2",
    });

    expect(deleteMessages).not.toHaveBeenCalled();
    expect(deleteTraces).not.toHaveBeenCalled();
    expect(setActiveLeaf).not.toHaveBeenCalled();
    expect(clearBranch).not.toHaveBeenCalled();
    expect(deps.recordDevDiagnostic).not.toHaveBeenCalled();
    expect(deps.publishRealtime).not.toHaveBeenCalled();
  });

  it("blocks undo while the selected tail includes an active turn", async () => {
    const traces = [
      {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "running",
      },
    ] as ChatTurnTraceRecord[];
    const deps = createDeps({ traces, activeLeafTurnId: "turn-1" });

    await expect(undoChatTurns(deps, "session-1", 1)).rejects.toThrow(
      "Chat turn turn-1 is running; cancel or finish it before undoing.",
    );
  });
});
