import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoworkCanvasPanel } from "./CoworkCanvasPanel";
import type { CoworkRunViewModel } from "./cowork-view-model";

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

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => instanceText(button).includes(label));
}

function viewModel(overrides: Partial<CoworkRunViewModel> = {}): CoworkRunViewModel {
  return {
    ...baseViewModel,
    stageCards: [...baseViewModel.stageCards],
    now: { ...baseViewModel.now, facts: [...baseViewModel.now.facts] },
    operatorActionItems: { ...baseViewModel.operatorActionItems, items: [...baseViewModel.operatorActionItems.items] },
    planItems: { ...baseViewModel.planItems, items: [...baseViewModel.planItems.items] },
    roleItems: { ...baseViewModel.roleItems, items: [...baseViewModel.roleItems.items] },
    timelineItems: { ...baseViewModel.timelineItems, items: [...baseViewModel.timelineItems.items] },
    outputItems: { ...baseViewModel.outputItems, items: [...baseViewModel.outputItems.items] },
    blockers: [...baseViewModel.blockers],
    raw: { ...baseViewModel.raw },
    ...overrides,
  };
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

  it("renders empty board copy when Cowork has not produced visible run state yet", () => {
    const renderer = create(
      <CoworkCanvasPanel
        viewModel={viewModel({
          empty: true,
          selectionLabel: "Historical selection",
          now: {
            label: "Waiting",
            title: "No run selected",
            summary: "Choose a run to inspect.",
            facts: [],
          },
          nextAction: null,
          planItems: { items: [], overflow: 0 },
          roleItems: { items: [], overflow: 0 },
          timelineItems: { items: [], overflow: 0 },
          operatorActionItems: { items: [], overflow: 0 },
          outputItems: { items: [], overflow: 0 },
        })}
      />,
    );

    const text = rendererText(renderer);
    expect(text).toContain("Historical selection");
    expect(text).toContain("Cowork has not attached a visible plan yet.");
    expect(text).toContain("Role activity will land here when the run fans out.");
    expect(text).toContain("Recent checkpoints will appear here once the run starts moving.");
    expect(text).toContain("Operator actions will collect here when Cowork needs follow-up work.");
    expect(text).toContain("Outputs and attached tasks will appear here as the run produces them.");
    expect(text).not.toContain("Next operator action");

    renderer.unmount();
  });

  it("renders overflow and blocker details without exposing raw run identifiers", () => {
    const markup = renderToStaticMarkup(
      <CoworkCanvasPanel
        viewModel={viewModel({
          blockers: [
            {
              id: "blocker-1",
              title: "Approval paused",
              summary: "Shell write needs approval.",
              raw: "approval_effect_id=approval-1",
            },
          ],
          planItems: { items: baseViewModel.planItems.items, overflow: 2 },
          roleItems: { items: baseViewModel.roleItems.items, overflow: 3 },
          timelineItems: { items: baseViewModel.timelineItems.items, overflow: 4 },
          operatorActionItems: { items: baseViewModel.operatorActionItems.items, overflow: 5 },
          outputItems: { items: baseViewModel.outputItems.items, overflow: 6 },
        })}
        onOpenDetails={() => undefined}
      />,
    );

    expect(markup).toContain("+2 more");
    expect(markup).toContain("+3 more");
    expect(markup).toContain("+4 earlier timeline item(s)");
    expect(markup).toContain("+5 more operator action(s)");
    expect(markup).toContain("+6 more output item(s)");
    expect(markup).toContain("Approval paused");
    expect(markup).toContain("Raw details");
    expect(markup).toContain("approval_effect_id=approval-1");
    expect(markup).not.toContain("run-123");
  });

  it.each([
    ["retry_turn", "Retry turn", "onRetryTurn"],
    ["refresh_run_state", "Refresh run state", "onRefreshRunState"],
    ["open_tasks", "Open tasks", "onOpenTasks"],
    ["focus_composer", "Focus composer", "onFocusComposer"],
    ["review_run_details", "Open run details", "onOpenDetails"],
  ] as const)("routes %s next action to the matching handler", (kind, label, handlerName) => {
    const handlers = {
      onRetryTurn: vi.fn(),
      onStopTurn: vi.fn(),
      onOpenTasks: vi.fn(),
      onOpenDetails: vi.fn(),
      onFocusComposer: vi.fn(),
      onRefreshRunState: vi.fn(),
    };
    const renderer = create(
      <CoworkCanvasPanel
        viewModel={viewModel({
          nextAction: {
            kind,
            label,
            note: "Operator should use the routed action.",
          },
        })}
        {...handlers}
      />,
    );

    act(() => {
      findButton(renderer, label)?.props.onClick();
    });

    expect(handlers[handlerName]).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("keeps toolbar and blocker detail actions wired to operator controls", () => {
    const onOpenDetails = vi.fn();
    const onStopTurn = vi.fn();
    const renderer = create(
      <CoworkCanvasPanel
        viewModel={viewModel({
          nextAction: {
            kind: "retry_turn",
            label: "Retry turn",
            note: "Retry the selected turn.",
          },
          blockers: [
            {
              id: "blocker-1",
              title: "Approval paused",
              summary: "Shell write needs approval.",
            },
          ],
        })}
        onRetryTurn={() => undefined}
        onOpenDetails={onOpenDetails}
        onStopTurn={onStopTurn}
      />,
    );

    act(() => {
      findButton(renderer, "Run details")?.props.onClick();
      findButton(renderer, "Stop run")?.props.onClick();
      findButton(renderer, "Open details")?.props.onClick();
      findButton(renderer, "Details")?.props.onClick();
    });

    expect(onOpenDetails).toHaveBeenCalledTimes(3);
    expect(onStopTurn).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
