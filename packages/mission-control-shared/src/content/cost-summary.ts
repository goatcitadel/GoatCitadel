import type { CostSummaryResponse } from "../api/types.js";

export function formatCostUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 6 : 2,
  }).format(value);
}

/** Cost is an exact total only when the Gateway reports complete coverage. */
export function projectUsageCostSummary(summary: CostSummaryResponse): {
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
      coverageDescription: "Gateway day scope with complete cost coverage.",
    };
  }

  const knownCostLabel = totals.costUsd > 0 ? `${formatCostUsd(totals.costUsd)}+` : "Unknown";
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

export interface DailyCostBar {
  key: string;
  label: string;
  costLabel: string;
  percent: number;
}

export function projectDailyCostBars(summary: CostSummaryResponse): DailyCostBar[] {
  const days = (summary.dailySeries ?? []).slice(-7);
  const amounts = days.map((day) => {
    const amount = day.costUsd ?? Number.NaN;
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  });
  const maxAmount = Math.max(0, ...amounts);
  return days.map((day, index) => {
    const known = amounts[index] ?? 0;
    const complete = day.metricAvailability?.costUsdComplete === true;
    return {
      key: day.isoDate,
      // Daily ledger buckets are UTC; do not relabel aggregates as local days.
      label: `${day.isoDate} UTC`,
      costLabel: complete ? formatCostUsd(known) : known > 0 ? `${formatCostUsd(known)}+` : "Unknown",
      percent: maxAmount > 0 ? Math.round((known / maxAmount) * 100) : 0,
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
  return [...providers.values()].map((row) => ({
    ...row,
    costLabel: complete ? formatCostUsd(row.knownCostUsd)
      : row.knownCostUsd > 0 ? `${formatCostUsd(row.knownCostUsd)}+` : "Unknown",
  })).sort((left, right) => right.knownCostUsd - left.knownCostUsd
    || right.tokenTotal - left.tokenTotal || left.providerKey.localeCompare(right.providerKey));
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
