import { describe, expect, it } from "vitest";
import { deriveCoworkRunViewModel } from "./cowork-view-model";

describe("deriveCoworkRunViewModel", () => {
  it("keeps the board pinned to the active run when a historical turn is selected", () => {
    const activeTurn = {
      turnId: "turn-active",
      trace: {
        status: "completed",
        model: "gpt-5.4",
        toolRuns: [],
        routing: {},
        orchestration: {
          runId: "run-live",
          status: "running",
          workflowTemplate: "research",
          visibility: "team",
          finalSummary: "Cowork is moving through the active run.",
          routeDecision: {
            selectedRoles: ["Researcher"],
            specialistCandidates: [],
          },
          steps: [],
        },
      },
    } as any;
    const selectedTurn = {
      turnId: "turn-historical",
      trace: {
        status: "failed",
        toolRuns: [],
        routing: {},
      },
    } as any;

    const viewModel = deriveCoworkRunViewModel({
      items: [],
      orchestration: activeTurn.trace.orchestration,
      activeTurn,
      selectedTurn,
    });

    expect(viewModel.activeTurnId).toBe("turn-active");
    expect(viewModel.selectedTurnId).toBe("turn-historical");
    expect(viewModel.hasHistoricalSelection).toBe(true);
    expect(viewModel.selectionLabel).toContain("historical turn details");
    expect(viewModel.sourceLabel).toBe("Source: trace fallback");
  });

  it("promotes approval blockers into the next operator action", () => {
    const activeTurn = {
      turnId: "turn-active",
      trace: {
        status: "waiting_for_approval",
        toolRuns: [],
        routing: {},
      },
    } as any;

    const viewModel = deriveCoworkRunViewModel({
      items: [],
      activeTurn,
      orchestrationRun: {
        status: "running",
        executionState: "paused_for_approval",
        worktreeStatus: "ready",
      } as any,
    });

    expect(viewModel.blockers).toHaveLength(1);
    expect(viewModel.blockers[0]?.title).toBe("Approval required");
    expect(viewModel.nextAction?.label).toBe("Resolve blocker");
  });
});
