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
});
