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
    expect(projectUsageCostSummary(summary).costLabel).toBe("At least <$0.01");
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
    expect(bars.map((bar) => bar.costLabel)).toEqual(["Unknown", "At least $1.25", "$2.50"]);
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
      {
        providerKey: "a",
        label: "Alpha",
        tokenTotal: 30,
        knownCostUsd: 3,
        costLabel: "At least $3.00",
        models: ["m1", "m2"],
      },
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

describe("token coverage (SY-02)", () => {
  const incompleteTokens = {
    inputTokensComplete: false,
    outputTokensComplete: true,
    cachedInputTokensComplete: true,
    costUsdComplete: true,
  };
  const completeFlags = { ...incompleteTokens, inputTokensComplete: true };
  const base = { scope: "day", from: "2026-09-27T00:00:00.000Z", to: "2026-09-29T00:00:00.000Z" };

  it("shows a lower bound, never an exact total, when some groups are missing token counts", () => {
    const projection = projectUsageCostSummary({
      ...base,
      items: [
        {
          key: "2026-09-27",
          tokenInput: 0,
          tokenOutput: 0,
          tokenCachedInput: 0,
          tokenTotal: 1200,
          costUsd: 1,
          metricAvailability: completeFlags,
        },
        {
          key: "2026-09-28",
          tokenInput: 0,
          tokenOutput: 0,
          tokenCachedInput: 0,
          tokenTotal: 0,
          costUsd: 0,
          metricAvailability: incompleteTokens,
        },
      ],
    });
    expect(projection.tokenCoverage).toEqual({ knownGroups: 1, missingGroups: 1, complete: false });
    expect(projection.tokenLabel).toBe(`at least ${new Intl.NumberFormat().format(1200)}`);
    expect(projection.tokens).toBe(1200);
  });

  it("says Unknown instead of 0 when every group is missing token counts", () => {
    const projection = projectUsageCostSummary({
      ...base,
      items: [
        {
          key: "2026-09-28",
          tokenInput: 0,
          tokenOutput: 0,
          tokenCachedInput: 0,
          tokenTotal: 0,
          costUsd: 0,
          metricAvailability: incompleteTokens,
        },
        { key: "2026-09-29", tokenInput: 0, tokenOutput: 0, tokenCachedInput: 0, tokenTotal: Number.NaN, costUsd: 0 },
      ],
    });
    expect(projection.tokenLabel).toBe("Unknown");
    expect(projection.tokenCoverage.missingGroups).toBe(2);
  });

  it("honours incomplete canonical token coverage even when every item looks complete", () => {
    const projection = projectUsageCostSummary({
      ...base,
      usageAvailability: {
        trackedEvents: 1,
        unknownEvents: 1,
        totalAgentEvents: 2,
        metricAvailability: {
          inputTokens: { knownAttemptCount: 1, unknownAttemptCount: 1, complete: false },
          outputTokens: { knownAttemptCount: 2, unknownAttemptCount: 0, complete: true },
          cachedInputTokens: { knownAttemptCount: 2, unknownAttemptCount: 0, complete: true },
          costUsd: { knownAttemptCount: 2, unknownAttemptCount: 0, complete: true },
        },
      },
      items: [{ key: "2026-09-28", tokenInput: 0, tokenOutput: 0, tokenCachedInput: 0, tokenTotal: 40, costUsd: 0 }],
    });
    expect(projection.tokenLabel).toBe("at least 40");
  });

  it("keeps a complete total exact, and an empty window is an honest zero", () => {
    expect(
      projectUsageCostSummary({
        ...base,
        items: [
          {
            key: "2026-09-28",
            tokenInput: 0,
            tokenOutput: 0,
            tokenCachedInput: 0,
            tokenTotal: 40,
            costUsd: 0,
            metricAvailability: completeFlags,
          },
        ],
      }).tokenLabel,
    ).toBe("40");
    expect(projectUsageCostSummary({ ...base, items: [] }).tokenLabel).toBe("0");
  });
});

describe("daily bar states (SY-02)", () => {
  it("separates no-usage and unknown days from a real $0 day and keeps them out of the scale", () => {
    const complete = {
      inputTokensComplete: true,
      outputTokensComplete: true,
      cachedInputTokensComplete: true,
      costUsdComplete: true,
    };
    const segment = { providerKey: "local", label: "Local", costUsd: 0 };
    const bars = projectDailyCostBars({
      scope: "day",
      from: "2026-09-25T00:00:00.000Z",
      to: "2026-09-28T00:00:00.000Z",
      items: [],
      dailySeries: [
        { isoDate: "2026-09-25", costUsd: 0, segments: [], metricAvailability: complete },
        { isoDate: "2026-09-26", costUsd: 0, segments: [segment], metricAvailability: complete },
        { isoDate: "2026-09-27", segments: [segment] },
        { isoDate: "2026-09-28", costUsd: 2, segments: [{ ...segment, costUsd: 2 }], metricAvailability: complete },
      ],
    });
    expect(bars.map((bar) => bar.state)).toEqual(["no_data", "exact", "unknown", "exact"]);
    expect(bars.map((bar) => bar.costLabel)).toEqual(["No usage", "$0.00", "Unknown", "$2.00"]);
    expect(bars.map((bar) => bar.amount)).toEqual([0, 0, 0, 2]);
    expect(bars.map((bar) => bar.percent)).toEqual([0, 0, 0, 100]);
  });
});
