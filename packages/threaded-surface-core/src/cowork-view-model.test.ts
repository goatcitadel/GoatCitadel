import { describe, expect, it } from "vitest";
import { deriveCoworkRunViewModel } from "./cowork-view-model";

describe("deriveCoworkRunViewModel", () => {
  it("surfaces approval waits through the continuation gate and run map", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn: {
        turnId: "turn-1",
        userMessage: { content: "Research and patch channel setup." },
        trace: {
          status: "waiting_for_approval",
          toolRuns: [],
          startedAt: "2026-05-04T00:00:00.000Z",
        },
      } as never,
    });

    expect(viewModel.continuationGate.decision).toBe("pause");
    expect(viewModel.continuationGate.reasonCodes).toContain("approval_wait");
    expect(viewModel.runMap.objective).toContain("Research and patch");
    expect(viewModel.stateGaps).toContain("Approval unresolved");
  });

  it("prefers persisted continuation gate checkpoints when present", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestrationCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          checkpointKind: "continuation_gate",
          runId: "run-1",
          planId: "plan-1",
          details: {
            continuationGate: {
              decision: "checkpoint",
              reasonCodes: ["checkpoint_interval"],
              summary: "Checkpoint required before continuing.",
              metrics: {
                stepsSinceCheckpoint: 8,
                toolRunCount: 3,
                failedToolRunCount: 0,
                retryFailureStreak: 0,
                approvalWait: false,
                userInputWait: false,
                evidenceGapCount: 0,
              },
              recommendedAction: "Review checkpoint.",
              createdAt: "2026-05-04T00:00:00.000Z",
            },
          },
          createdAt: "2026-05-04T00:00:00.000Z",
        },
      ],
    });

    expect(viewModel.continuationGate.decision).toBe("checkpoint");
    expect(viewModel.evidenceSummary.label).toBe("Evidence: checkpoint gate");
    expect(viewModel.runMap.checkpoints[0]?.title).toBe("Continuation gate");
  });
});
