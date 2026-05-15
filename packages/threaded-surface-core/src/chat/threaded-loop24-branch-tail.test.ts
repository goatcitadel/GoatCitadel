import { describe, expect, it } from "vitest";
import { deriveCoworkRunViewModel, resolveActiveWorkflowTurn } from "../cowork-view-model";
import { resolveSelectedTurnId } from "./chat-page-pure-helpers";
import { updateThreadFromStreamChunk, type PendingStreamTurnSeed } from "../chat-thread-reducer";

const sessionId = "session-loop24";

function userMessage(id = "user-1", content = "Loop 24 prompt") {
  return {
    messageId: id,
    sessionId,
    role: "user",
    actorType: "user",
    actorId: "operator",
    content,
    timestamp: "2026-05-15T00:00:00.000Z",
  };
}

function baseTurn(turnId = "turn-1") {
  return {
    turnId,
    userMessage: userMessage(`user-${turnId}`),
    assistantMessage: {
      messageId: `assistant-${turnId}`,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "Existing",
      timestamp: "2026-05-15T00:00:01.000Z",
    },
    trace: {
      turnId,
      sessionId,
      userMessageId: `user-${turnId}`,
      assistantMessageId: `assistant-${turnId}`,
      status: "completed",
      mode: "chat",
      toolRuns: [],
      citations: [],
      routing: {},
    },
    toolRuns: [],
    citations: [],
    branch: {
      siblingTurnIds: [turnId],
      activeSiblingIndex: 0,
      siblingCount: 1,
      isSelectedPath: true,
      newestLeafTurnId: turnId,
    },
  };
}

function baseThread() {
  return {
    sessionId,
    selectedTurnId: "turn-1",
    activeLeafTurnId: "turn-1",
    turns: [baseTurn("turn-1")],
  };
}

function seed(): PendingStreamTurnSeed {
  return {
    userMessage: userMessage("user-new", "New prompt"),
    parentTurnId: undefined,
    branchKind: "append",
    sourceTurnId: undefined,
    mode: "send",
  } as PendingStreamTurnSeed;
}

describe("threaded loop 24 branch tails", () => {
  it("resolves selected turn fallbacks in priority order", () => {
    const rows = [
      {
        name: "pending route wins",
        thread: { selectedTurnId: "turn-selected", activeLeafTurnId: "turn-active", turns: [{ turnId: "turn-route" }] },
        currentTurnId: "missing",
        pendingRouteTurnId: "turn-route",
        expected: "turn-route",
      },
      {
        name: "current turn wins",
        thread: {
          selectedTurnId: "turn-selected",
          activeLeafTurnId: "turn-active",
          turns: [{ turnId: "turn-current" }],
        },
        currentTurnId: "turn-current",
        pendingRouteTurnId: "missing",
        expected: "turn-current",
      },
      {
        name: "active leaf fallback",
        thread: { selectedTurnId: null, activeLeafTurnId: "turn-active", turns: [{ turnId: "turn-active" }] },
        currentTurnId: null,
        pendingRouteTurnId: null,
        expected: "turn-active",
      },
      {
        name: "last turn fallback",
        thread: { selectedTurnId: null, activeLeafTurnId: null, turns: [{ turnId: "turn-last" }] },
        currentTurnId: null,
        pendingRouteTurnId: null,
        expected: "turn-last",
      },
    ];

    for (const row of rows) {
      expect(resolveSelectedTurnId(row.thread, row.currentTurnId, row.pendingRouteTurnId), row.name).toBe(row.expected);
    }
  });

  it("preserves explicit tool autonomy and merges trace/citation fallbacks", () => {
    const started = updateThreadFromStreamChunk(
      null,
      {
        type: "message_start",
        sessionId,
        turnId: "turn-new",
        messageId: "assistant-new",
      } as never,
      seed(),
      sessionId,
      {
        mode: "chat",
        planningMode: "off",
        toolAutonomy: "auto",
      } as never,
    )!;
    expect(started.turns[0]?.trace.effectiveToolAutonomy).toBe("auto");

    const withTraceFallback = updateThreadFromStreamChunk(
      baseThread() as never,
      {
        type: "trace_update",
        sessionId,
        turnId: "turn-1",
        trace: {
          status: "running",
          citations: [
            { citationId: "cite-1", url: "https://example.test/a" },
            {
              citationId: "cite-2",
              url: "https://example.test/a",
              title: "Fallback title",
              snippet: "Fallback snippet",
              sourceType: "web",
            },
          ],
        },
      } as never,
      null,
      sessionId,
      null,
    )!;

    expect(withTraceFallback.turns[0]?.assistantMessage?.messageId).toBe("assistant-turn-1");
    expect(withTraceFallback.turns[0]?.citations).toEqual([
      {
        citationId: "cite-1",
        url: "https://example.test/a",
        title: "Fallback title",
        snippet: "Fallback snippet",
        sourceType: "web",
        knowledge: undefined,
      },
    ]);
  });

  it("keeps cowork fallback gates and delegation error labels behavior explicit", () => {
    const checkpointCreatedAt = "2026-05-15T00:05:00.000Z";
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestrationRun: {
        runId: "run-loop24",
        status: "completed",
      } as never,
      orchestrationCheckpoints: [
        {
          checkpointId: "checkpoint-loop24",
          checkpointKind: "continuation_gate",
          runId: "run-loop24",
          details: {
            continuationGate: {
              decision: "checkpoint",
              metrics: {
                stepsSinceCheckpoint: null,
                toolRunCount: null,
                failedToolRunCount: null,
                retryFailureStreak: null,
                approvalWait: false,
                userInputWait: false,
                evidenceGapCount: null,
              },
            },
          },
          createdAt: checkpointCreatedAt,
        },
      ],
      delegationRun: {
        runId: "delegation-loop24",
        label: "Loop 24 delegation",
        objective: "Cover fallback delegation branches.",
        mode: "parallel",
        status: "running",
        steps: [
          {
            stepId: "delegate-loop24",
            status: "failed",
            error: "Delegated worker failed.",
          },
        ],
      } as never,
      workbenchState: null,
    });

    expect(viewModel.continuationGate).toMatchObject({
      decision: "checkpoint",
      createdAt: checkpointCreatedAt,
      recommendedAction: "Review the run state before continuing.",
    });
    expect(viewModel.blockers.find((blocker) => blocker.id === "delegation-failed")?.title).toBe(
      "Delegated step failed",
    );
    expect(viewModel.stateGaps).not.toContain("Manual UI proof not attached");

    expect(resolveActiveWorkflowTurn({ activeLeafTurnId: null, turns: [] } as never)).toBeNull();
  });
});
