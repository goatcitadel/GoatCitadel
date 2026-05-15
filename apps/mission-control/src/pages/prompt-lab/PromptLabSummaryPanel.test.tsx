import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PromptLabSummaryPanel } from "./PromptLabSummaryPanel";

vi.mock("../../components/ActionButton", () => ({
  ActionButton: ({
    label,
    onClick,
    pending,
    disabled,
  }: {
    label: string;
    onClick: () => void;
    pending?: boolean;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled || pending} onClick={onClick}>
      {label}
    </button>
  ),
}));

function textContent(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return node.children.map((child) => textContent(child as ReactTestInstance | string | number)).join("");
}

function findButton(root: ReactTestInstance, text: string) {
  const match = root.findAllByType("button").find((node) => textContent(node).includes(text));
  if (!match) {
    throw new Error(`Button not found: ${text}`);
  }
  return match;
}

describe("PromptLabSummaryPanel", () => {
  it("keeps the benchmark/export/reset controls visible and respects disabled states", async () => {
    const callbacks = {
      onRunNext: vi.fn(),
      onRunAll: vi.fn(),
      onRunBenchmark: vi.fn(),
      onRefreshData: vi.fn(),
      onAutoScoreUnscored: vi.fn(),
      onExportNow: vi.fn(),
      onResetPack: vi.fn(),
      onCopyExportPath: vi.fn(),
      onResetClearRunsChange: vi.fn(),
      onResetClearScoresChange: vi.fn(),
    };

    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(
        <PromptLabSummaryPanel
          title="Prompt Lab"
          subtitle="Evaluation workspace"
          overviewCards={[
            { label: "Pack", value: "Pack A", detail: "2 tests loaded" },
            { label: "Coverage", value: "2/2", detail: "All run" },
            { label: "Quality", value: "80%", detail: "Average weighted score" },
            { label: "Model lane", value: "openai/gpt-5.4", detail: "Ready" },
          ]}
          activeRun={null}
          benchmarkStatus={null}
          isRefreshing={false}
          isFallbackRefreshing={false}
          error={null}
          success={null}
          resetClearRuns
          resetClearScores={false}
          hasSelectedPack={false}
          running={false}
          resetting={false}
          exporting={false}
          importing={false}
          autoScoring={false}
          autoScoreOnRun
          unscoredCompletedCount={2}
          exportInfo={{
            packId: "pack-a",
            path: "/tmp/report.json",
            exists: true,
            sizeBytes: 1024,
            updatedAt: "2026-04-10T10:00:00.000Z",
          }}
          benchmarkPending={false}
          testOutcomeSummary={{
            runFailureCount: 1,
            scoreFailureCount: 0,
            needsScoreCount: 2,
          }}
          {...callbacks}
        />,
      );
    });

    expect(findButton(renderer.root, "Run benchmark").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Export now").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Reset pack").props.disabled).toBe(true);
    expect(textContent(renderer.root)).toContain("Copy path");

    const checkboxes = renderer.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]?.props.checked).toBe(true);
    expect(checkboxes[1]?.props.checked).toBe(false);

    await act(async () => {
      findButton(renderer.root, "Refresh data").props.onClick();
      findButton(renderer.root, "Copy path").props.onClick();
    });

    expect(callbacks.onRefreshData).toHaveBeenCalledTimes(1);
    expect(callbacks.onCopyExportPath).toHaveBeenCalledTimes(1);
  });

  it("renders active/fallback statuses, not-generated exports, and reset option callbacks", async () => {
    const callbacks = {
      onRunNext: vi.fn(),
      onRunAll: vi.fn(),
      onRunBenchmark: vi.fn(),
      onRefreshData: vi.fn(),
      onAutoScoreUnscored: vi.fn(),
      onExportNow: vi.fn(),
      onResetPack: vi.fn(),
      onCopyExportPath: vi.fn(),
      onResetClearRunsChange: vi.fn(),
      onResetClearScoresChange: vi.fn(),
    };

    let renderer: ReactTestRenderer = create(<div />);
    await act(async () => {
      renderer = create(
        <PromptLabSummaryPanel
          title="Prompt Lab"
          overviewCards={[{ label: "Pack", value: "Pack B", detail: "Ready" }]}
          activeRun={{ mode: "all", testId: "test-2", testCode: "TEST-02" }}
          benchmarkStatus={
            {
              run: {
                benchmarkRunId: "bench-active",
                status: "running",
              },
              progress: {
                completedItems: 1,
                totalItems: 5,
              },
              modelSummaries: [],
            } as never
          }
          isRefreshing
          isFallbackRefreshing
          error="Prompt pack load failed"
          success="Prompt pack imported"
          resetClearRuns={false}
          resetClearScores
          hasSelectedPack
          running
          resetting={false}
          exporting={false}
          importing={false}
          autoScoring={false}
          autoScoreOnRun={false}
          unscoredCompletedCount={0}
          exportInfo={{
            packId: "pack-b",
            path: "/tmp/report-b.json",
            exists: false,
            sizeBytes: 0,
          }}
          benchmarkPending={false}
          testOutcomeSummary={{
            runFailureCount: 0,
            scoreFailureCount: 2,
            needsScoreCount: 1,
          }}
          {...callbacks}
        />,
      );
    });

    const text = textContent(renderer.root);
    expect(text).toContain("Run in progress: TEST-02 (all)");
    expect(text).toContain("Benchmark bench-active: running (1/5)");
    expect(text).toContain("Refreshing prompt-pack results in the background...");
    expect(text).toContain("Live updates degraded, checking periodically.");
    expect(text).toContain("Run status only confirms execution. Pass rate updates after scoring.");
    expect(text).toContain("Prompt pack load failed");
    expect(text).toContain("Prompt pack imported");
    expect(text).toContain("not generated yet");
    expect(findButton(renderer.root, "Run next test").props.disabled).toBe(true);
    expect(findButton(renderer.root, "Run all").props.disabled).toBe(true);

    const checkboxes = renderer.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
    expect(checkboxes[0]?.props.disabled).toBe(true);
    expect(checkboxes[1]?.props.disabled).toBe(true);

    await act(async () => {
      checkboxes[0]?.props.onChange({ target: { checked: true } });
      checkboxes[1]?.props.onChange({ target: { checked: false } });
    });

    expect(callbacks.onResetClearRunsChange).toHaveBeenCalledWith(true);
    expect(callbacks.onResetClearScoresChange).toHaveBeenCalledWith(false);
  });
});
