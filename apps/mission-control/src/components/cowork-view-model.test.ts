import { describe, expect, it } from "vitest";
import { deriveCoworkRunViewModel, resolveActiveWorkflowTurn } from "./cowork-view-model";

function makeTurn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: "turn-active",
    userMessage: { content: "Build the operator launch plan with proof." },
    trace: {
      status: "running",
      toolRuns: [],
      routing: {},
      ...overrides,
    },
  } as any;
}

function checkpoint(kind: string, details: Record<string, unknown> = {}, phaseId = "phase-2", waveId = "wave-3") {
  return {
    checkpointId: `checkpoint-${kind}`,
    checkpointKind: kind,
    runId: "run-1",
    planId: "plan-1",
    phaseId,
    waveId,
    details,
    createdAt: "2026-05-04T00:00:00.000Z",
  } as any;
}

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

  it("renders the empty pre-run state and resolves active workflow turns", () => {
    const viewModel = deriveCoworkRunViewModel({ items: [] });

    expect(viewModel.empty).toBe(true);
    expect(viewModel.sourceLabel).toBe("Source: pre-run");
    expect(viewModel.freshnessLabel).toBe("Freshness: pre-run");
    expect(viewModel.completenessLabel).toBe("Completeness: pre-run");
    expect(viewModel.nextAction).toMatchObject({ kind: "focus_composer", label: "Start Cowork run" });
    expect(viewModel.now.title).toBe("No Cowork run is active yet");
    expect(viewModel.now.summary).toContain("Cowork will attach a visible plan");
    expect(resolveActiveWorkflowTurn(null)).toBeNull();
    expect(
      resolveActiveWorkflowTurn({
        activeLeafTurnId: "turn-2",
        turns: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
      } as any),
    ).toEqual({ turnId: "turn-2" });
    expect(
      resolveActiveWorkflowTurn({
        activeLeafTurnId: "missing",
        turns: [{ turnId: "turn-1" }, { turnId: "turn-last" }],
      } as any),
    ).toEqual({ turnId: "turn-last" });
  });

  it("summarizes canonical run state, plan overflow, role metadata, checkpoints, and outputs", () => {
    const viewModel = deriveCoworkRunViewModel({
      items: [
        { id: "task-1", title: "Review task 1", note: "one" },
        { id: "task-2", title: "Review task 2", note: "two" },
        { id: "task-3", title: "Review task 3", note: "three" },
        { id: "task-4", title: "Review task 4", note: "four" },
      ],
      orchestration: {
        runId: "run-1",
        status: "running",
        workflowTemplate: "cowork.release",
        finalSummary: "Launch plan completed.",
        routeDecision: { selectedRoles: ["planner", "worker"] },
        steps: [
          {
            stepId: "role-1",
            role: "Planner",
            status: "running",
            providerId: "openai",
            model: "gpt-5.5",
            summary: "Create a plan.",
          },
          {
            stepId: "role-2",
            role: "Worker",
            status: undefined,
            model: undefined,
            error: " ".repeat(2),
          },
        ],
      } as any,
      orchestrationRun: {
        runId: "run-1",
        status: "completed",
        executionState: "worktree_ready",
        currentPhaseId: "phase-2",
        currentWaveId: "wave-3",
        worktreeStatus: "ready",
      } as any,
      orchestrationCheckpoints: [
        checkpoint("run_started", { lifecycleState: "running" }),
        checkpoint("phase_executed", { error: "Phase output was incomplete and needs review." }),
        checkpoint("run_resumed", {}, undefined as any, undefined as any),
        checkpoint("unknown_kind", {}, "review_phase", "wave_alpha"),
      ],
      executionPlan: {
        steps: [
          {
            stepId: "plan-1",
            objective: "Plan the work",
            status: "completed",
            delegatedRole: "Architect",
            dependsOnStepIds: ["seed"],
            summary: "Planning complete.",
          },
          {
            stepId: "plan-2",
            objective: "Patch the work",
            status: "running",
            successCriteria: "Tests pass.",
          },
          {
            stepId: "plan-3",
            objective: "Review the work",
            status: "pending",
            error: "Waiting on patches.",
          },
          {
            stepId: "plan-4",
            objective: "Ship the work",
            status: "pending",
            summary: "word ".repeat(80),
          },
        ],
      } as any,
      activeTurn: makeTurn({ toolRuns: [{ status: "completed" }] }),
      workbenchState: { worktreeStatus: "dirty" } as any,
      delegationRun: {
        runId: "run-1",
        label: "Delegated work",
        objective: "Delegate",
        mode: "parallel",
        status: "running",
        stitchedOutput: "Combined output",
        steps: [
          {
            stepId: "delegate-1",
            index: 0,
            role: "Reviewer",
            status: "completed",
            output: "Partial output",
          },
        ],
      },
    });

    expect(viewModel.sourceLabel).toBe("Source: canonical run");
    expect(viewModel.completenessLabel).toBe("Completeness: full");
    expect(viewModel.now.summary).toBe("Launch plan completed.");
    expect(viewModel.now.facts).toEqual(
      expect.arrayContaining([
        { label: "Workflow", value: "cowork.release" },
        { label: "Roles", value: "planner -> worker" },
        { label: "Current phase", value: "Phase 2" },
        { label: "Current wave", value: "Wave 3" },
      ]),
    );
    expect(viewModel.operatorActionItems.overflow).toBe(1);
    expect(viewModel.planItems.overflow).toBe(1);
    expect(viewModel.planItems.items[0]).toMatchObject({
      id: "plan-1",
      title: "Plan the work",
      status: "completed",
      meta: "Role Architect · Depends on seed",
      note: "Planning complete.",
    });
    expect(viewModel.roleItems.items[0]).toMatchObject({
      id: "role-role-1",
      title: "Planner",
      meta: "openai · gpt-5.5",
    });
    expect(viewModel.roleItems.items[1]).toMatchObject({
      id: "role-role-2",
      title: "Worker",
      status: "unknown",
      meta: "provider auto",
    });
    expect(viewModel.roleItems.items.some((item) => item.id === "delegation-delegate-1")).toBe(true);
    expect(viewModel.timelineItems.items[0]).toMatchObject({
      title: "unknown kind",
      meta: "Phase review phase · Wave wave alpha",
      note: "2026-05-04T00:00:00.000Z",
    });
    expect(viewModel.timelineItems.overflow).toBe(1);
    expect(viewModel.outputItems.items.map((item) => item.id)).toEqual(["stitched-output", "worktree-state"]);
    expect(viewModel.stageCards).toEqual(
      expect.arrayContaining([
        { label: "Execution", value: "worktree ready" },
        { label: "Worktree", value: "ready" },
        { label: "Tools", value: "1" },
      ]),
    );
  });

  it("prioritizes input waits, refresh failures, run failures, delegation failures, and task actions", () => {
    const blocked = deriveCoworkRunViewModel({
      items: [],
      orchestration: {
        runId: "run-trace",
        status: "running",
        workflowTemplate: "cowork.trace",
        routeDecision: { selectedRoles: [] },
        steps: [],
      } as any,
      orchestrationError: "Could not refresh run state",
      orchestrationRun: {
        runId: "run-trace",
        status: "failed",
        executionState: "paused_for_approval",
        lastError: "Provider failed",
      } as any,
      activeTurn: makeTurn({
        status: "waiting_for_user_input",
        failure: { message: "Provider failed" },
        toolRuns: [{ status: "failed" }],
      }),
      delegationRun: {
        runId: "run-trace",
        label: "Delegated work",
        objective: "Delegate",
        mode: "parallel",
        status: "running",
        steps: [
          {
            stepId: "delegate-1",
            index: 0,
            role: "Reviewer",
            status: "failed",
            error: "Reviewer failed.",
          },
        ],
      },
    });

    expect(blocked.now.title).toBe("Cowork is waiting for your answer");
    expect(blocked.nextAction?.kind).toBe("review_run_details");
    expect(blocked.blockers.map((blocker) => blocker.id)).toEqual(
      expect.arrayContaining(["answer-required", "refresh-failed", "run-failed", "delegation-failed"]),
    );
    expect(blocked.freshnessLabel).toBe("Freshness: partially refreshed");
    expect(blocked.completenessLabel).toBe("Completeness: partial");

    const refresh = deriveCoworkRunViewModel({
      items: [],
      orchestrationError: "Gateway unavailable",
      orchestrationLoading: true,
    });
    expect(refresh.nextAction?.kind).toBe("refresh_run_state");
    expect(refresh.freshnessLabel).toBe("Freshness: loading live run state");

    const failed = deriveCoworkRunViewModel({
      items: [],
      orchestrationRun: { runId: "run-1", status: "failed", lastError: "Provider failed" } as any,
      activeTurn: makeTurn({ status: "failed", failure: { message: "Provider failed" } }),
    });
    expect(failed.nextAction?.kind).toBe("retry_turn");

    const tasks = deriveCoworkRunViewModel({
      items: [{ id: "task-1", title: "Follow up" }],
    });
    expect(tasks.nextAction?.kind).toBe("open_tasks");
  });

  it("uses trace-backed and active-turn fallback summaries plus execution state labels", () => {
    const traceBacked = deriveCoworkRunViewModel({
      items: [],
      orchestration: {
        runId: "run-trace",
        status: "running",
        workflowTemplate: "cowork.trace",
        routeDecision: { selectedRoles: [] },
        steps: [],
      } as any,
      activeTurn: makeTurn({ status: "running" }),
    });
    expect(traceBacked.sourceLabel).toBe("Source: trace fallback");
    expect(traceBacked.now.title).toBe("Cowork is working from routed trace state");
    expect(traceBacked.completenessLabel).toBe("Completeness: trace-backed");
    expect(traceBacked.nextAction?.kind).toBe("review_run_details");

    const activeOnly = deriveCoworkRunViewModel({
      items: [],
      activeTurn: makeTurn({ status: "waiting_for_tool" }),
    });
    expect(activeOnly.sourceLabel).toBe("Source: active turn");
    expect(activeOnly.now.summary).toContain("waiting for tool");

    const contextOnly = deriveCoworkRunViewModel({
      items: [],
      activeTurn: { turnId: "turn-without-trace" } as any,
    });
    expect(contextOnly.now.summary).toContain("no canonical run data");

    const executionStates = [
      ["worktree_allocating", "allocating worktree"],
      ["paused_for_approval", "paused for approval"],
      ["resume_requested", "resume queued"],
      ["stopped_by_limit", "stopped by limit"],
      ["custom_state", "custom state"],
    ] as const;

    for (const [executionState, expectedLabel] of executionStates) {
      const viewModel = deriveCoworkRunViewModel({
        items: [],
        orchestrationRun: {
          runId: `run-${executionState}`,
          status: "running",
          executionState,
          currentPhaseId: "review_phase",
          currentWaveId: "wave_alpha",
        } as any,
      });

      expect(viewModel.now.summary).toContain(expectedLabel);
      expect(viewModel.timelineItems.items).toEqual([]);
      expect(viewModel.now.facts).toEqual(
        expect.arrayContaining([
          { label: "Current phase", value: "Phase review phase" },
          { label: "Current wave", value: "Wave wave alpha" },
        ]),
      );
    }
  });
});
