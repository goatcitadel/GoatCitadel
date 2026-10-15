import { describe, expect, it } from "vitest";
import type { CostSummaryResponse } from "../api/types.js";
import {
  formatCostUsd,
  projectDailyCostBars,
  projectProviderCostRows,
  projectUsageCostSummary,
} from "./cost-summary.js";

describe("formatCostUsd", () => {
  it("uses one two-decimal precision and never prints sub-cent digits or a fake zero", () => {
    expect(formatCostUsd(12.345)).toBe("$12.35");
    expect(formatCostUsd(0.000123)).toBe("<$0.01");
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(undefined)).toBe("Unknown");
    expect(formatCostUsd(Number.NaN)).toBe("Unknown");
  });

  it("keeps tiny lower bounds short in the narrow cost column", () => {
    const summary: CostSummaryResponse = {
      scope: "day",
      from: "2026-09-27T00:00:00.000Z",
      to: "2026-09-28T00:00:00.000Z",
      items: [
        { key: "2026-09-27", tokenInput: 0, tokenOutput: 0, tokenCachedInput: 0, tokenTotal: 5, costUsd: 0.000123 },
      ],
    };
    expect(projectUsageCostSummary(summary).costLabel).toBe("$0.00012+");
  });
});

describe("projectDailyCostBars", () => {
  it("keeps incomplete zero unknown and known incomplete cost as a lower bound", () => {
    const summary: CostSummaryResponse = {
      scope: "day",
      from: "2026-09-26T00:00:00.000Z",
      to: "2026-09-28T00:00:00.000Z",
      items: [],
      dailySeries: [
        {
          isoDate: "2026-09-26",
          costUsd: 0,
          segments: [],
          metricAvailability: {
            inputTokensComplete: false,
            outputTokensComplete: false,
            cachedInputTokensComplete: false,
            costUsdComplete: false,
          },
        },
        {
          isoDate: "2026-09-27",
          costUsd: 1.25,
          segments: [],
          metricAvailability: {
            inputTokensComplete: true,
            outputTokensComplete: true,
            cachedInputTokensComplete: true,
            costUsdComplete: false,
          },
        },
        {
          isoDate: "2026-09-28",
          costUsd: 2.5,
          segments: [],
          metricAvailability: {
            inputTokensComplete: true,
            outputTokensComplete: true,
            cachedInputTokensComplete: true,
            costUsdComplete: true,
          },
        },
      ],
    };

    const bars = projectDailyCostBars(summary);
    expect(bars.map((bar) => bar.costLabel)).toEqual(["Unknown", "$1.25+", "$2.50"]);
    expect(bars.map((bar) => bar.percent)).toEqual([0, 50, 100]);
  });
});

describe("projectProviderCostRows", () => {
  it("uses provider segments, carries model names, and preserves unknown cost", () => {
    const summary: CostSummaryResponse = {
      scope: "day",
      from: "2026-09-27T00:00:00.000Z",
      to: "2026-09-29T00:00:00.000Z",
      items: [{ key: "2026-09-28", tokenInput: 0, tokenOutput: 0, tokenCachedInput: 0, tokenTotal: 50, costUsd: 3 }],
      dailySeries: [
        {
          isoDate: "2026-09-27",
          segments: [{ providerKey: "a", label: "Alpha", tokenTotal: 10, costUsd: 1, models: ["m1"] }],
        },
        {
          isoDate: "2026-09-28",
          segments: [
            { providerKey: "a", label: "Alpha", tokenTotal: 20, costUsd: 2, models: ["m1", "m2"] },
            { providerKey: "b", label: "Beta", tokenTotal: 20, costUsd: 0, models: ["m3"] },
          ],
        },
      ],
    };
    expect(projectProviderCostRows(summary)).toEqual([
      { providerKey: "a", label: "Alpha", tokenTotal: 30, knownCostUsd: 3, costLabel: "$3.00+", models: ["m1", "m2"] },
      { providerKey: "b", label: "Beta", tokenTotal: 20, knownCostUsd: 0, costLabel: "Unknown", models: ["m3"] },
    ]);
    const complete = {
      ...summary,
      usageAvailability: {
        trackedEvents: 3,
        unknownEvents: 0,
        totalAgentEvents: 3,
        metricAvailability: { costUsd: { complete: true, unknownAttemptCount: 0 } },
      },
    } as CostSummaryResponse;
    expect(projectProviderCostRows(complete)[0]?.costLabel).toBe("$3.00");
  });
});
