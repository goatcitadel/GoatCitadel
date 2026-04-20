import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
});
