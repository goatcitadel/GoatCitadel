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

  it("treats a loaded delegation run as linked Cowork state for trace-backed turns", () => {
    const orchestration = {
      runId: "delegation-run-1",
      status: "completed",
      workflowTemplate: "cowork.plan.work.synthesize",
      routeDecision: {
        selectedRoles: ["planner", "worker", "reviewer", "synthesizer"],
      },
      finalSummary: "Launch plan completed.",
    };
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestration: orchestration as never,
      activeTurn: {
        turnId: "turn-1",
        userMessage: { content: "Build a launch plan." },
        trace: {
          status: "running",
          durable: {
            runId: "durable-run-1",
            status: "running",
          },
          orchestration,
          toolRuns: [],
          startedAt: "2026-05-04T00:00:00.000Z",
        },
      } as never,
      delegationRun: {
        runId: "delegation-run-1",
        label: "Launch plan",
        objective: "Build a launch plan.",
        mode: "cowork",
        status: "completed",
        steps: [],
      },
    });

    expect(viewModel.sourceLabel).toBe("Source: delegation run");
    expect(viewModel.completenessLabel).toBe("Completeness: delegation-backed");
    expect(viewModel.stageCards.find((item) => item.label === "Execution")?.value).toBe("completed");
    expect(viewModel.stateGaps).not.toContain("Canonical run not loaded");
  });

  it("summarizes optional agentic run-tree diagnostics and controls", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [],
      agenticRunTree: {
        runId: "agentic-run-1",
        generatedAt: "2026-05-04T00:00:00.000Z",
        nodes: [
          {
            id: "root",
            kind: "run",
            label: "Main Cowork run",
            status: "running",
          },
        ],
        edges: [],
        diagnostics: [
          {
            signalId: "signal-1",
            code: "child_timeout",
            severity: "warning",
            title: "Child timed out",
            summary: "A child agent exceeded its runtime budget.",
            createdAt: "2026-05-04T00:00:00.000Z",
          },
        ],
        controls: [
          {
            action: "retry",
            label: "Retry child",
            enabled: true,
            runtimeEffect: "state_only",
            reason: "Records retry intent without replaying commands.",
          },
        ],
      },
    });

    expect(viewModel.agenticRuntime?.runId).toBe("agentic-run-1");
    expect(viewModel.agenticRuntime?.treeNodes[0]?.label).toBe("Main Cowork run");
    expect(viewModel.agenticRuntime?.diagnostics[0]?.title).toBe("Child timed out");
    expect(viewModel.agenticRuntime?.controls[0]?.status).toBe("available");
    expect(viewModel.agenticRuntime?.controls[0]?.meta).toBe("state only");
    expect(viewModel.agenticRuntime?.controls[0]?.note).toBe("Records retry intent without replaying commands.");
  });
});
