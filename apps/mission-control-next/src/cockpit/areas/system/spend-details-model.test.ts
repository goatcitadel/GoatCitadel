import { describe, expect, it } from "vitest";
import type { CostSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import { filterCostSummary, providerDayRows, readSpendFilters } from "./spend-details-model";

const complete = {
  inputTokensComplete: true,
  outputTokensComplete: true,
  cachedInputTokensComplete: true,
  costUsdComplete: true,
};
const day = (isoDate: string, segments: NonNullable<CostSummaryResponse["dailySeries"]>[number]["segments"]) => ({
  isoDate,
  tokenTotal: segments.reduce((sum, item) => sum + (item.tokenTotal ?? 0), 0),
  costUsd: segments.reduce((sum, item) => sum + item.costUsd, 0),
  metricAvailability: complete,
  segments,
});
const openai = (cost: number) => ({
  providerKey: "openai",
  label: "OpenAI",
  tokenInput: 10,
  tokenOutput: 5,
  tokenCachedInput: 0,
  tokenTotal: 15,
  costUsd: cost,
  metricAvailability: complete,
});
const anthropic = (cost: number) => ({ ...openai(cost), providerKey: "anthropic", label: "Anthropic" });
const dates = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"];
function summary(): CostSummaryResponse {
  const series = dates.map((iso, index) => day(iso, index % 2 ? [openai(1)] : [openai(1), anthropic(2)]));
  return {
    scope: "day",
    from: "2026-10-16T00:00:00.000Z",
    to: "2026-10-22T23:59:59.999Z",
    usageAvailability: {
      trackedEvents: 20,
      unknownEvents: 2,
      totalAgentEvents: 22,
      metricAvailability: {
        inputTokens: { knownAttemptCount: 20, unknownAttemptCount: 0, complete: true },
        outputTokens: { knownAttemptCount: 20, unknownAttemptCount: 0, complete: true },
        cachedInputTokens: { knownAttemptCount: 20, unknownAttemptCount: 0, complete: true },
        costUsd: { knownAttemptCount: 18, unknownAttemptCount: 2, complete: false },
      },
    },
    items: series.map((entry) => ({
      key: entry.isoDate,
      tokenInput: 0,
      tokenOutput: 0,
      tokenCachedInput: 0,
      tokenTotal: entry.tokenTotal,
      costUsd: entry.costUsd,
      metricAvailability: complete,
    })),
    dailySeries: series,
  };
}

describe("readSpendFilters", () => {
  it("reads a valid window and provider", () => {
    expect(readSpendFilters("?window=3&provider=openai")).toEqual({ days: 3, provider: "openai" });
  });

  it("falls back to seven days and every provider for invalid or repeated values", () => {
    expect(readSpendFilters("?window=9")).toEqual({ days: 7, provider: "all" });
    expect(readSpendFilters("?window=1&window=3&provider=a&provider=b")).toEqual({ days: 7, provider: "all" });
    expect(readSpendFilters("")).toEqual({ days: 7, provider: "all" });
  });
});

describe("filterCostSummary", () => {
  it("keeps the latest days of the window and starts the period at the first kept day", () => {
    const result = filterCostSummary(summary(), { days: 3, provider: "all" });
    expect(result.dailySeries?.map((entry) => entry.isoDate)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(result.items.map((item) => item.key)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(result.from).toBe("2026-10-20T00:00:00.000Z");
  });

  it("never turns a missing day cost into zero", () => {
    const source = summary();
    source.dailySeries![6] = { ...source.dailySeries![6]!, costUsd: undefined };
    const result = filterCostSummary(source, { days: 3, provider: "all" });
    expect(result.dailySeries?.[2]?.costUsd).toBeUndefined();
  });

  it("narrows days and totals to one provider and drops the window-wide unknown-call count", () => {
    const result = filterCostSummary(summary(), { days: 7, provider: "anthropic" });
    expect(result.dailySeries?.every((entry) => entry.segments.every((item) => item.providerKey === "anthropic"))).toBe(
      true,
    );
    expect(result.items.reduce((sum, item) => sum + item.costUsd, 0)).toBe(8);
    expect(result.usageAvailability?.metricAvailability?.costUsd.unknownAttemptCount).toBe(0);
    expect(result.usageAvailability?.metricAvailability?.costUsd.complete).toBe(false);
  });
});

describe("providerDayRows", () => {
  it("lists one provider's daily tokens and marks partial days", () => {
    const source = summary();
    source.dailySeries![0]!.segments[0] = {
      ...openai(1),
      tokenCachedInput: undefined,
      metricAvailability: { ...complete, outputTokensComplete: false },
    };
    const rows = providerDayRows(source, "openai");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ date: "2026-10-16", input: 10, output: 5, cached: null, partial: true });
    expect(rows[1]?.partial).toBe(false);
  });
});
