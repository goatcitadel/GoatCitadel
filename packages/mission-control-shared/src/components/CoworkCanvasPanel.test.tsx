import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { CoworkCanvasPanel } from "./CoworkCanvasPanel";
import type { CoworkRunViewModel } from "./cowork-view-model";

vi.mock("./AgenticRuntimeVisibilityPanel", () => ({
  AgenticRuntimeVisibilityPanel: ({ surface, className }: { surface: string; className?: string }) => (
    <section className={className}>mock {surface} runtime visibility</section>
  ),
}));

const baseViewModel: CoworkRunViewModel = {
  empty: false,
  activeTurnId: "turn-live",
  selectedTurnId: "turn-live",
  hasHistoricalSelection: false,
  headerTitle: "Cowork run",
  headerSummary: "Source: canonical run · Freshness: live · Completeness: full",
  sourceLabel: "Source: canonical run",
  freshnessLabel: "Freshness: live",
  completenessLabel: "Completeness: full",
  stageCards: [
    { label: "Workflow", value: "running" },
    { label: "Execution", value: "worktree ready" },
    { label: "Approval", value: "clear" },
    { label: "Worktree", value: "ready" },
    { label: "Tools", value: "2" },
  ],
  now: {
    label: "Now",
    title: "Live run state loaded",
    summary: "Cowork is executing the active run.",
    facts: [{ label: "Workflow", value: "research" }],
  },
  nextAction: {
    kind: "review_run_details",
    label: "Open run details",
    note: "Inspect routing, tools, and raw state without displacing the board.",
  },
  blockers: [],
  operatorActionItems: {
    items: [{ id: "action-1", title: "Review blocker queue", note: "One operator action is waiting." }],
    overflow: 0,
  },
  planItems: {
    items: [{ id: "plan-1", title: "Draft the answer", status: "running", note: "Summarize the latest research." }],
    overflow: 0,
  },
  roleItems: {
    items: [{ id: "role-1", title: "Researcher delegation", status: "completed", note: "Findings ready." }],
    overflow: 0,
  },
  timelineItems: {
    items: [{ id: "checkpoint-1", title: "Run started", note: "Execution running." }],
    overflow: 0,
  },
  outputItems: {
    items: [{ id: "output-1", title: "Stitched result available", note: "Open details to inspect it." }],
    overflow: 0,
  },
  continuationGate: {
    decision: "continue",
    reasonCodes: [],
    summary: "Continue gate clear.",
    metrics: {
      stepsSinceCheckpoint: 0,
      toolRunCount: 0,
      failedToolRunCount: 0,
      retryFailureStreak: 0,
      approvalWait: false,
      userInputWait: false,
      evidenceGapCount: 0,
    },
    recommendedAction: "Continue the run.",
    createdAt: "2026-03-08T00:00:00.000Z",
  },
  runMap: {
    objective: "Finish the task",
    currentState: "Running",
    nextAction: "Open run details",
    planNodes: [],
    checkpoints: [],
  },
  stateGaps: [],
  evidenceSummary: {
    label: "Evidence: current",
    detail: "0 tool calls · 0 checkpoints · no state gaps",
    toolCallCount: 0,
    checkpointCount: 0,
    evidenceGapCount: 0,
  },
  raw: {
    activeTurn: { turnId: "turn-live" } as any,
    selectedTurn: { turnId: "turn-live" } as any,
    orchestration: { runId: "run-123" } as any,
    orchestrationRun: { runId: "run-123", planId: "plan-456" } as any,
    orchestrationCheckpoints: [],
    executionPlan: undefined,
    delegationRun: { steps: [{ durableRunId: "durable-789" }] } as any,
    workbenchState: null,
    orchestrationError: null,
  },
};

function withViewModel(overrides: Partial<CoworkRunViewModel> = {}): CoworkRunViewModel {
  return {
    ...baseViewModel,
    ...overrides,
  };
}

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => textOf(button.children) === label);
}

describe("CoworkCanvasPanel", () => {
  it("keeps raw identifiers out of the default board view", () => {
    const markup = renderToStaticMarkup(<CoworkCanvasPanel viewModel={baseViewModel} />);

    expect(markup).toContain("Next operator action");
    expect(markup).toContain("Operator actions");
    expect(markup).toContain("Outputs / tasks");
    expect(markup).not.toContain("run-123");
    expect(markup).not.toContain("plan-456");
    expect(markup).not.toContain("durable-789");
  });

  it("routes primary actions and exposes secondary run controls", () => {
    const handlers = {
      retry: vi.fn(),
      stop: vi.fn(),
      tasks: vi.fn(),
      details: vi.fn(),
      composer: vi.fn(),
      refresh: vi.fn(),
    };
    const renderer = create(
      <CoworkCanvasPanel
        viewModel={withViewModel({
          nextAction: {
            kind: "retry_turn",
            label: "Retry run step",
            note: "Try the last worker step again.",
          },
        })}
        onRetryTurn={handlers.retry}
        onStopTurn={handlers.stop}
        onOpenTasks={handlers.tasks}
        onOpenDetails={handlers.details}
        onFocusComposer={handlers.composer}
        onRefreshRunState={handlers.refresh}
      />,
    );

    act(() => {
      findButton(renderer, "Retry run step")!.props.onClick();
      findButton(renderer, "Open details")!.props.onClick();
      findButton(renderer, "Run details")!.props.onClick();
      findButton(renderer, "Stop run")!.props.onClick();
    });
    expect(handlers.retry).toHaveBeenCalledTimes(1);
    expect(handlers.details).toHaveBeenCalledTimes(2);
    expect(handlers.stop).toHaveBeenCalledTimes(1);

    const actionCases: Array<[CoworkRunViewModel["nextAction"], keyof typeof handlers]> = [
      [{ kind: "refresh_run_state", label: "Refresh run state", note: "Reload canonical state." }, "refresh"],
      [{ kind: "open_tasks", label: "Open tasks", note: "Review follow-up work." }, "tasks"],
      [{ kind: "focus_composer", label: "Start Cowork run", note: "Describe the objective." }, "composer"],
      [{ kind: "review_run_details", label: "Open run details", note: "Inspect raw state." }, "details"],
    ];
    for (const [nextAction, handlerName] of actionCases) {
      renderer.update(
        <CoworkCanvasPanel
          viewModel={withViewModel({ nextAction })}
          onRetryTurn={handlers.retry}
          onOpenTasks={handlers.tasks}
          onOpenDetails={handlers.details}
          onFocusComposer={handlers.composer}
          onRefreshRunState={handlers.refresh}
        />,
      );
      act(() => {
        findButton(renderer, nextAction!.label)!.props.onClick();
      });
      expect(handlers[handlerName]).toHaveBeenCalled();
    }
  });

  it("renders empty sections, blockers, overflow notes, and runtime controls", () => {
    const onOpenDetails = vi.fn();
    const onAgenticControl = vi.fn();
    const control = {
      id: "pause",
      title: "Pause runtime",
      action: "pause",
      enabled: true,
      status: "available",
      meta: "pauses safely",
      note: "Stop after the current checkpoint.",
    } as const;
    const renderer = create(
      <CoworkCanvasPanel
        viewModel={withViewModel({
          empty: true,
          selectionLabel: "Historical turn selected.",
          planItems: { items: [], overflow: 0 },
          roleItems: { items: [], overflow: 0 },
          timelineItems: { items: [], overflow: 0 },
          operatorActionItems: { items: [], overflow: 0 },
          outputItems: { items: [], overflow: 0 },
          blockers: [
            {
              id: "blocked",
              title: "Approval required",
              summary: "Human approval is required.",
              raw: "approval_id=approval-1",
            },
          ],
          agenticRuntime: {
            runId: "agentic-run-1",
            generatedAt: "2026-03-08T00:00:00.000Z",
            nodeCount: 2,
            edgeCount: 1,
            treeNodes: [
              { id: "node-1", label: "Planner", status: "running", meta: "role" },
              { id: "node-2", label: "Reviewer", status: "waiting" },
            ],
            diagnostics: [{ id: "diag-1", title: "One tool stale", status: "warning", note: "Refresh needed." }],
            controls: [
              control,
              {
                id: "resume",
                title: "Resume runtime",
                action: "retry",
                enabled: false,
                status: "disabled",
              } as const,
            ],
          },
        })}
        onOpenDetails={onOpenDetails}
        onAgenticControl={onAgenticControl}
        agenticControlPending="retry"
        agenticControlStatus="Runtime control recorded."
      />,
    );

    const text = textOf(renderer.toJSON()).replace(/\s+/g, " ");
    expect(text).toContain("Historical turn selected.");
    expect(text).toContain("Chat has not attached a visible plan yet.");
    expect(text).toContain("Role activity will land here when the run fans out.");
    expect(text).toContain("Recent checkpoints will appear here once the run starts moving.");
    expect(text).toContain("Operator actions will collect here when Chat needs follow-up work.");
    expect(text).toContain("Outputs and attached tasks will appear here as the run produces them.");
    expect(text).toContain("Human approval is required.");
    expect(text).toContain("Raw details");
    expect(text).toContain("approval_id=approval-1");
    expect(text).toContain("2 nodes");
    expect(text).toContain("1 links");
    expect(text).toContain("Run agentic-run-1");
    expect(text).toContain("Planner");
    expect(text).toContain("Diagnostics");
    expect(text).toContain("Runtime control recorded.");
    expect(text).toContain("pauses safely · Stop after the current checkpoint.");
    expect(text).toContain("No control note.");
    expect(text).toContain("Recording...");
    expect(text).toContain("mock cowork runtime visibility");

    act(() => {
      findButton(renderer, "Details")!.props.onClick();
      findButton(renderer, "Pause runtime")!.props.onClick();
    });
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
    expect(onAgenticControl).toHaveBeenCalledWith(control);
    expect(findButton(renderer, "Recording...")!.props.disabled).toBe(true);
  });

  it("renders item metadata and overflow counters across visible lists", () => {
    const viewModel = withViewModel({
      planItems: {
        items: [{ id: "plan-meta", title: "Write patch", status: "running", meta: "Role Coder", note: "Use tests." }],
        overflow: 2,
      },
      roleItems: {
        items: [{ id: "role-meta", title: "QA delegation", status: "completed", meta: "glm", note: "Looks good." }],
        overflow: 1,
      },
      timelineItems: {
        items: [
          { id: "timeline-meta", title: "Phase completed", status: "done", meta: "Phase 1", note: "Checkpointed." },
        ],
        overflow: 3,
      },
      operatorActionItems: {
        items: [{ id: "operator-meta", title: "Review queue", note: "One decision pending." }],
        overflow: 4,
      },
      outputItems: {
        items: [{ id: "output-meta", title: "Patch ready", note: "Diff attached." }],
        overflow: 5,
      },
    });
    const markup = renderToStaticMarkup(<CoworkCanvasPanel viewModel={viewModel} />);

    expect(markup).toContain("Role Coder");
    expect(markup).toContain("+2 more");
    expect(markup).toContain("QA delegation");
    expect(markup).toContain("+1 more");
    expect(markup).toContain("+3 earlier timeline item(s)");
    expect(markup).toContain("+4 more operator action(s)");
    expect(markup).toContain("+5 more output item(s)");
  });
});
