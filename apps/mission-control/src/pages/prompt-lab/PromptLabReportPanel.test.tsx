import React from "react";
import { create, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { PromptPackBenchmarkStatusRecord, PromptPackReportRecord } from "@goatcitadel/contracts";
import { PromptLabReportPanel } from "./PromptLabReportPanel";

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

function normalizedText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  return collectText(node).replace(/\s+/g, " ").trim();
}

function buildReport(overrides?: Partial<PromptPackReportRecord["summary"]>) {
  return {
    runs: [],
    summary: {
      totalTests: 9,
      completedRuns: 7,
      failedRuns: 2,
      invalidLatestRuns: 1,
      autoScoredRuns: 5,
      humanReviewedRuns: 3,
      judgeFallbackCount: 2,
      judgeErrorCount: 1,
      averageWeightedScore: 82.48,
      effectivePassRate: 0.666,
      degradedScoreCount: 4,
      reviewRate: 0.333,
      durableRuns: 6,
      approvalPausedRuns: 2,
      backgroundedRuns: 1,
      failingCodes: ["TEST-G203", "TEST-R100"],
      ...overrides,
    },
    latestAssessments: [
      {
        testId: "test-legacy",
        legacyScore: {
          score: 72,
        },
      },
    ],
  } as unknown as Pick<PromptPackReportRecord, "runs" | "summary" | "latestAssessments">;
}

function buildBenchmarkStatus(modelSummaries: PromptPackBenchmarkStatusRecord["modelSummaries"]) {
  return {
    run: {
      benchmarkRunId: "bench-1",
      status: "completed",
    },
    progress: {
      completedItems: 3,
      totalItems: 4,
    },
    modelSummaries,
  } as PromptPackBenchmarkStatusRecord;
}

describe("PromptLabReportPanel", () => {
  it("renders report metrics, legacy v1 notice, benchmark rows, regression rows, and trend alerts", () => {
    const regressionResults = Array.from({ length: 32 }, (_, index) => ({
      resultId: `result-${index}`,
      testCode: `TEST-${index}`,
      capability: index % 2 === 0 ? "integrity" : "latency",
      scoreDelta: index + 0.125,
      passDelta: index - 0.5,
      latencyDeltaMs: 40.4 + index,
    }));

    const renderer = create(
      <PromptLabReportPanel
        report={buildReport()}
        testOutcomeSummary={{
          runFailureCount: 2,
          scoreFailureCount: 1,
          reviewCount: 3,
          needsScoreCount: 4,
          passingCount: 6,
        }}
        passThreshold={75}
        benchmarkStatus={buildBenchmarkStatus([
          {
            providerId: "openai",
            model: "gpt-5.4",
            total: 4,
            scored: 3,
            averageTotalScore: 8.82,
            passRate: 0.75,
            reviewRate: 0.25,
            averageWeightedScore: 88.2,
            runFailures: 1,
            degradedCount: 1,
            approvalPausedCount: 1,
            noOutputCount: 0,
            topFailureSignals: [
              {
                signal: "missing_citation",
                count: 2,
              },
            ],
          },
          {
            providerId: "local",
            model: "npu-sidecar",
            total: 2,
            scored: 2,
            averageTotalScore: 9.1,
            passRate: 1,
            reviewRate: 0,
            averageWeightedScore: 91,
            runFailures: 0,
            degradedCount: 0,
            approvalPausedCount: 0,
            noOutputCount: 0,
            topFailureSignals: [],
          },
        ])}
        regressionStatus={{
          run: {
            regressionRunId: "replay-1",
            status: "failed",
            finishedAt: "2026-05-14T12:00:00.000Z",
            error: "Replay artifact missing.",
          },
          results: regressionResults,
        }}
        trendSeries={[
          {
            capability: "integrity",
            breached: true,
            points: [{ value: 0.42 }],
          },
          {
            capability: "latency",
            points: [],
          },
        ]}
      />,
    );

    const text = normalizedText(renderer.toJSON());

    expect(text).toContain("Total tests 9");
    expect(text).toContain("Average weighted 82.5/100");
    expect(text).toContain("Effective pass rate 66.6% threshold 75/100");
    expect(text).toContain("Failing tests: TEST-G203, TEST-R100");
    expect(text).toContain("Legacy v1 history is shown as read-only");
    expect(text).toContain("Run: bench-1");
    expect(text).toContain("openai / gpt-5.4");
    expect(text).toContain("missing_citation (2)");
    expect(text).toContain("local / npu-sidecar");
    expect(text).toContain("none");
    expect(text).toContain("Run: replay-1");
    expect(text).toContain("Replay artifact missing.");
    expect(text).toContain("TEST-29");
    expect(text).not.toContain("TEST-30");
    expect(text).toContain("integrity : 0.42 (threshold breached)");
    expect(text).toContain("latency : n/a");
  });

  it("renders empty benchmark and regression states without legacy-only copy", () => {
    const renderer = create(
      <PromptLabReportPanel
        report={{
          ...buildReport({
            failingCodes: [],
            durableRuns: undefined,
            approvalPausedRuns: undefined,
            backgroundedRuns: undefined,
          }),
          latestAssessments: [
            {
              testId: "test-v2",
              scoreState: "auto_valid",
              autoScore: {
                weightedScore: 90,
              } as PromptPackReportRecord["latestAssessments"][number]["autoScore"],
            },
          ],
        }}
        testOutcomeSummary={{
          runFailureCount: 0,
          scoreFailureCount: 0,
          reviewCount: 0,
          needsScoreCount: 0,
          passingCount: 9,
        }}
        passThreshold={80}
        benchmarkStatus={buildBenchmarkStatus([])}
        regressionStatus={{
          run: {
            regressionRunId: "replay-empty",
            status: "completed",
          },
          results: [],
        }}
        trendSeries={[]}
      />,
    );

    const text = normalizedText(renderer.toJSON());

    expect(text).toContain("Failing tests: none");
    expect(text).toContain("Durable-backed latest runs: 0");
    expect(text).toContain("Approval-paused latest runs: 0");
    expect(text).toContain("Backgrounded latest runs: 0");
    expect(text).toContain("No benchmark items recorded yet.");
    expect(text).toContain("Run: replay-empty");
    expect(text).toContain("No regression results recorded yet.");
    expect(text).not.toContain("Legacy v1 history");
    expect(text).not.toContain("Capability trend alerts");
  });
});
