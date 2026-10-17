import type { CostSummaryResponse } from "../api/types.js";
import { formatMoney, formatMoneyLowerBound } from "./format.js";

/**
 * Operator-facing USD: always two decimals, "<$0.01" for positive amounts under a cent, and "Unknown" (never $0.00)
 * when the value is missing. Kept as a named export for existing callers; it is the shared formatMoney.
 */
export function formatCostUsd(value: number | null | undefined): string {
  return formatMoney(value);
}

/** How many summary groups reported a complete token total, and how many were missing or partial. */
export interface TokenCoverage {
  knownGroups: number;
  missingGroups: number;
  /** True only when every group (or the Gateway's canonical coverage) reports complete input and output tokens. */
  complete: boolean;
}

export interface UsageCostProjection {
  /** The sum of the finite token values. A lower bound unless `tokenCoverage.complete`; kept for Classic callers. */
  tokens: number;
  /** "1,234" when complete, "at least 1,234" when partial, "Unknown" when nothing is known. Never a fake zero. */
  tokenLabel: string;
  tokenCoverage: TokenCoverage;
  costLabel: string;
  coverageDescription: string;
}

type CostItem = CostSummaryResponse["items"][number];

function itemTokensKnown(item: CostItem): boolean {
  if (!Number.isFinite(item.tokenTotal) || item.tokenTotal < 0) return false;
  const flags = item.metricAvailability;
  return !flags || (flags.inputTokensComplete && flags.outputTokensComplete);
}

export function projectTokenCoverage(summary: CostSummaryResponse): TokenCoverage {
  const knownGroups = summary.items.filter(itemTokensKnown).length;
  const missingGroups = summary.items.length - knownGroups;
  const canonical = summary.usageAvailability?.metricAvailability;
  const canonicalComplete =
    canonical?.inputTokens && canonical.outputTokens
      ? canonical.inputTokens.complete && canonical.outputTokens.complete
      : undefined;
  return { knownGroups, missingGroups, complete: missingGroups === 0 && canonicalComplete !== false };
}

function formatTokenLabel(tokens: number, coverage: TokenCoverage): string {
  const count = new Intl.NumberFormat().format(tokens);
  if (coverage.complete) return count;
  return tokens > 0 ? `at least ${count}` : "Unknown";
}

/** Cost is an exact total only when the Gateway reports complete coverage; tokens follow their own coverage. */
export function projectUsageCostSummary(summary: CostSummaryResponse): UsageCostProjection {
  const cost = projectCostTotals(summary);
  const tokenCoverage = projectTokenCoverage(summary);
  return { ...cost, tokenCoverage, tokenLabel: formatTokenLabel(cost.tokens, tokenCoverage) };
}

function projectCostTotals(summary: CostSummaryResponse): {
  tokens: number;
  costLabel: string;
  coverageDescription: string;
} {
  const totals = summary.items.reduce(
    (result, item) => ({
      tokens: result.tokens + (Number.isFinite(item.tokenTotal) && item.tokenTotal >= 0 ? item.tokenTotal : 0),
      costUsd: result.costUsd + (Number.isFinite(item.costUsd) && item.costUsd >= 0 ? item.costUsd : 0),
    }),
    { tokens: 0, costUsd: 0 },
  );
  const canonicalCoverage = summary.usageAvailability?.metricAvailability?.costUsd;
  const itemCoverage = summary.items.map((item) => item.metricAvailability?.costUsdComplete);
  const complete =
    canonicalCoverage?.complete ??
    (itemCoverage.some((value) => value === false)
      ? false
      : itemCoverage.length > 0 && itemCoverage.every((value) => value === true)
        ? true
        : undefined);

  if (complete === true) {
    return {
      tokens: totals.tokens,
      costLabel: formatCostUsd(totals.costUsd),
      coverageDescription: "Grouped by day (UTC) with complete cost coverage.",
    };
  }

  const knownCostLabel = totals.costUsd > 0 ? formatMoneyLowerBound(totals.costUsd) : "Unknown";
  if (complete === false) {
    const unknownAttempts = canonicalCoverage?.unknownAttemptCount;
    return {
      tokens: totals.tokens,
      costLabel: knownCostLabel,
      coverageDescription:
        unknownAttempts && unknownAttempts > 0
          ? `Known spend is a lower bound because ${unknownAttempts} provider ${unknownAttempts === 1 ? "attempt has" : "attempts have"} unknown cost.`
          : "Known spend is a lower bound because cost coverage is incomplete.",
    };
  }

  return {
    tokens: totals.tokens,
    costLabel: knownCostLabel,
    coverageDescription: "Cost coverage was not reported, so this summary does not claim an exact total.",
  };
}

/**
 * exact: complete cost (a true $0 day included). lower_bound: some cost known, coverage incomplete.
 * unknown: usage was recorded but no cost is known. no_data: the Gateway recorded no usage for the day.
 * Only exact and lower_bound days have a measured amount; the others never count as $0 in the scale.
 */
export type DailyCostBarState = "exact" | "lower_bound" | "unknown" | "no_data";

export interface DailyCostBar {
  key: string;
  label: string;
  costLabel: string;
  percent: number;
  state: DailyCostBarState;
  /** The known amount in USD; 0 for unknown and no-data days, which are excluded from the scale maximum. */
  amount: number;
}

type DailySeriesDay = NonNullable<CostSummaryResponse["dailySeries"]>[number];

function dailyBarState(day: DailySeriesDay): { state: DailyCostBarState; amount: number } {
  const raw = day.costUsd;
  const finite = typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
  const amount = finite ? raw : 0;
  const complete = day.metricAvailability?.costUsdComplete;
  // The Gateway emits every day of the window; a day with no provider segments and no cost had no recorded usage.
  if (day.segments.length === 0 && amount === 0 && complete !== false) return { state: "no_data", amount: 0 };
  if (!finite) return { state: "unknown", amount: 0 };
  if (complete === true) return { state: "exact", amount };
  return amount > 0 ? { state: "lower_bound", amount } : { state: "unknown", amount: 0 };
}

const DAILY_STATE_LABEL: Record<"unknown" | "no_data", string> = { unknown: "Unknown", no_data: "No usage" };

export function projectDailyCostBars(summary: CostSummaryResponse): DailyCostBar[] {
  const days = (summary.dailySeries ?? []).slice(-7);
  const states = days.map(dailyBarState);
  const maxAmount = Math.max(0, ...states.map((entry) => entry.amount));
  return days.map((day, index) => {
    const { state, amount } = states[index] ?? { state: "unknown" as const, amount: 0 };
    return {
      key: day.isoDate,
      // Daily ledger buckets are UTC; do not relabel aggregates as local days.
      label: `${day.isoDate} UTC`,
      costLabel:
        state === "exact"
          ? formatCostUsd(amount)
          : state === "lower_bound"
            ? formatMoneyLowerBound(amount)
            : DAILY_STATE_LABEL[state],
      percent: maxAmount > 0 ? Math.round((amount / maxAmount) * 100) : 0,
      state,
      amount,
    };
  });
}

export interface ProviderCostRow {
  providerKey: string;
  label: string;
  tokenTotal: number;
  knownCostUsd: number;
  costLabel: string;
  models: string[];
}

/** The day-scope item keys are dates; provider attribution lives in the daily segments. */
export function projectProviderCostRows(summary: CostSummaryResponse): ProviderCostRow[] {
  const providers = new Map<string, Omit<ProviderCostRow, "costLabel">>();
  for (const day of (summary.dailySeries ?? []).slice(-7)) {
    for (const segment of day.segments) {
      const providerKey = segment.providerKey?.trim();
      if (!providerKey) continue;
      const prior = providers.get(providerKey);
      providers.set(providerKey, {
        providerKey,
        label: segment.label?.trim() || prior?.label || providerKey,
        tokenTotal: (prior?.tokenTotal ?? 0) + finiteNonNegative(segment.tokenTotal),
        knownCostUsd: (prior?.knownCostUsd ?? 0) + finiteNonNegative(segment.costUsd),
        models: [...new Set([...(prior?.models ?? []), ...(segment.models ?? []).filter(Boolean)])],
      });
    }
  }
  const complete = summary.usageAvailability?.metricAvailability?.costUsd?.complete === true;
  return [...providers.values()]
    .map((row) => ({
      ...row,
      costLabel: complete
        ? formatCostUsd(row.knownCostUsd)
        : row.knownCostUsd > 0
          ? formatMoneyLowerBound(row.knownCostUsd)
          : "Unknown",
    }))
    .sort(
      (left, right) =>
        right.knownCostUsd - left.knownCostUsd ||
        right.tokenTotal - left.tokenTotal ||
        left.providerKey.localeCompare(right.providerKey),
    );
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
