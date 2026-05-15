import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoworkCanvasPanel } from "./CoworkCanvasPanel";
import type { CoworkRunViewModel } from "./cowork-view-model";

vi.mock("./AgenticRuntimeVisibilityPanel", () => ({
  AgenticRuntimeVisibilityPanel: ({ surface, className }: { surface: string; className?: string }) => (
    <section className={className}>runtime visibility for {surface}</section>
  ),
}));

function buildSparseViewModel(): CoworkRunViewModel {
  return {
    empty: false,
    activeTurnId: "turn-1",
    selectedTurnId: "turn-1",
    hasHistoricalSelection: false,
    headerTitle: "Cowork sparse run",
    headerSummary: "Sparse optional state.",
    sourceLabel: "Source: local",
    freshnessLabel: "Freshness: cached",
    completenessLabel: "Completeness: partial",
    stageCards: [{ label: "Run", value: "idle" }],
    now: {
      label: "Now",
      title: "Waiting for work",
      summary: "No live facts have arrived.",
      facts: [],
    },
    nextAction: undefined,
    blockers: [{ id: "blocker-1", title: "Needs input", summary: "No raw detail attached." }],
    operatorActionItems: { items: [], overflow: 0 },
    planItems: { items: [], overflow: 0 },
    roleItems: { items: [], overflow: 0 },
    timelineItems: { items: [], overflow: 0 },
    outputItems: { items: [], overflow: 0 },
    continuationGate: null,
    runMap: null,
    stateGaps: [],
    evidenceSummary: {
      label: "Evidence: none",
      detail: "No trace evidence yet.",
      toolCallCount: 0,
      checkpointCount: 0,
      evidenceGapCount: 0,
    },
    agenticRuntime: {
      runId: "agentic-run-sparse",
      generatedAt: "2026-05-15T00:00:00.000Z",
      nodeCount: 0,
      edgeCount: 0,
      treeNodes: [],
      diagnostics: [],
      controls: [
        {
          id: "pause",
          title: "Pause runtime",
          action: "pause",
          enabled: true,
          status: "available",
        },
      ],
    },
    raw: {
      activeTurn: null,
      selectedTurn: null,
      orchestration: null,
      orchestrationRun: null,
      orchestrationCheckpoints: [],
      executionPlan: undefined,
      delegationRun: null,
      workbenchState: null,
      orchestrationError: null,
    },
  };
}

describe("CoworkCanvasPanel loop 23 optional branches", () => {
  it("keeps sparse optional sections quiet when data and handlers are absent", () => {
    const markup = renderToStaticMarkup(<CoworkCanvasPanel viewModel={buildSparseViewModel()} />);

    expect(markup).toContain("No live facts have arrived.");
    expect(markup).toContain("Needs input");
    expect(markup).toContain("No raw detail attached.");
    expect(markup).toContain("0 nodes");
    expect(markup).toContain("0 links");
    expect(markup).toContain("No control note.");
    expect(markup).toContain("runtime visibility for cowork");
    expect(markup).not.toContain("Next operator action");
    expect(markup).not.toContain("Raw details");
    expect(markup).not.toContain("Diagnostics");
    expect(markup).not.toContain("Pause runtime</button>");
  });
});
