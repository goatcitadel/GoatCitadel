import type { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import type { CostMetricCoverage } from "@goatcitadel/mission-control-shared/api/types";
import type { SpendDay } from "./RuntimeSpendChart";
import { formatUsd } from "./runtime-formatters";
type OpsRuntimeData = NonNullable<ReturnType<typeof useOpsRuntimeSnapshot>["data"]>;
type ProviderSpendRow = {
  providerKey: string;
  label: string;
  tokenTotal: number;
  costUsd: number;
  costUsdComplete?: boolean;
};

export function readCurrentDayCostCompleteness(data: OpsRuntimeData): boolean | undefined {
  const windowCoverage = data.cost?.usageAvailability?.metricAvailability?.costUsd?.complete;
  if (windowCoverage !== undefined) {
    // Canonical coverage includes dispatch-unknown attempts that do not yet
    // have a cost-ledger row, so a row-only aggregate cannot upgrade an
    // incomplete window into a trustworthy exact zero.
    return windowCoverage;
  }
  const dayKey = data.dashboard?.timestamp?.slice(0, 10);
  const item = dayKey ? data.cost?.items.find((candidate) => candidate.key === dayKey) : undefined;
  return item?.metricAvailability?.costUsdComplete;
}

export function hasIncompleteCostProjection(data: OpsRuntimeData): boolean {
  if (data.cost?.usageAvailability?.metricAvailability?.costUsd?.complete === false) {
    return true;
  }
  if (data.cost?.items.some((item) => item.metricAvailability?.costUsdComplete === false)) {
    return true;
  }
  return Boolean(
    data.cost?.dailySeries?.some(
      (day) =>
        day.metricAvailability?.costUsdComplete === false ||
        day.segments.some((segment) => segment.metricAvailability?.costUsdComplete === false),
    ),
  );
}

export function describeIncompleteSpendChart(coverage: CostMetricCoverage | undefined): string {
  const unknown = coverage?.unknownAttemptCount;
  return unknown && unknown > 0
    ? `Seven-day known spend chart. Totals are lower bounds because ${unknown} provider ${unknown === 1 ? "attempt has" : "attempts have"} unknown cost.`
    : "Seven-day known spend chart. Totals are lower bounds because cost coverage is incomplete.";
}

export function describeCostCoverageGap(coverage: CostMetricCoverage | undefined): string {
  const unknown = coverage?.unknownAttemptCount;
  return unknown && unknown > 0
    ? `Known spend is a lower bound. ${unknown} provider ${unknown === 1 ? "attempt has" : "attempts have"} token or dispatch evidence without trustworthy cost.`
    : "Known spend is a lower bound because at least one aggregate contains cost-unknown usage.";
}

export function formatCostCoverage(coverage: CostMetricCoverage | undefined): string {
  if (!coverage) {
    return "Unavailable";
  }
  return coverage.complete ? "Complete" : `${coverage.unknownAttemptCount} unknown`;
}

export function describeCostCoverage(coverage: CostMetricCoverage | undefined): string {
  if (!coverage) {
    return "Gateway did not report per-metric coverage";
  }
  const total = coverage.knownAttemptCount + coverage.unknownAttemptCount;
  return total === 0
    ? "No provider attempts in this window"
    : `${coverage.knownAttemptCount}/${total} provider attempts have trustworthy cost`;
}

export function formatAvailabilityCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(Math.floor(value)) : "Unavailable";
}

export function formatCostMetric(value: number | undefined, complete: boolean | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "Unavailable";
  }
  if (complete === false) {
    return value > 0 ? `${formatUsd(value)}+` : "Unknown";
  }
  if (complete === undefined) {
    return value > 0 ? `${formatUsd(value)} · unverified` : "Unverified";
  }
  return formatUsd(value);
}

/**
 * Returns the seven-day stacked spend series for the chart. The parser remains
 * defensive so stale gateways fail closed into the chart's empty state rather
 * than fabricating cost trends.
 */
export function readSpendDays(data: OpsRuntimeData): SpendDay[] {
  const candidate = (data.cost as { dailySeries?: unknown } | null | undefined)?.dailySeries;
  if (!Array.isArray(candidate)) {
    return [];
  }
  const series: SpendDay[] = [];
  for (const raw of candidate) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as {
      date?: unknown;
      isoDate?: unknown;
      shortLabel?: unknown;
      segments?: unknown;
    };
    const isoDate =
      typeof record.isoDate === "string" ? record.isoDate : typeof record.date === "string" ? record.date : null;
    if (!isoDate) {
      continue;
    }
    const shortLabel = typeof record.shortLabel === "string" ? record.shortLabel : isoDate.slice(5);
    const segments = Array.isArray(record.segments) ? record.segments : [];
    const parsedSegments = segments
      .map((rawSegment) => {
        if (!rawSegment || typeof rawSegment !== "object") {
          return null;
        }
        const segmentRecord = rawSegment as {
          providerKey?: unknown;
          key?: unknown;
          label?: unknown;
          costUsd?: unknown;
        };
        const providerKey =
          typeof segmentRecord.providerKey === "string"
            ? segmentRecord.providerKey
            : typeof segmentRecord.key === "string"
              ? segmentRecord.key
              : null;
        const cost = typeof segmentRecord.costUsd === "number" ? segmentRecord.costUsd : 0;
        if (!providerKey) {
          return null;
        }
        return {
          providerKey,
          label: typeof segmentRecord.label === "string" ? segmentRecord.label : providerKey,
          costUsd: cost,
        };
      })
      .filter((value): value is SpendDay["segments"][number] => value !== null);
    series.push({ isoDate, shortLabel, segments: parsedSegments });
  }
  return series.slice(-7);
}

/** Aggregate the seven-day provider series without relabeling day-scope summary keys as providers. */
export function readProviderSpendRows(data: OpsRuntimeData, dates?: ReadonlySet<string>): ProviderSpendRow[] {
  const providers = new Map<string, ProviderSpendRow>();
  for (const day of data.cost?.dailySeries ?? []) {
    if (dates && !dates.has(day.isoDate)) continue;
    for (const segment of day.segments) {
      const providerKey = segment.providerKey.trim();
      if (!providerKey) continue;
      const prior = providers.get(providerKey);
      const costUsdComplete = segment.metricAvailability?.costUsdComplete;
      providers.set(providerKey, {
        providerKey,
        label: segment.label?.trim() || prior?.label || providerKey,
        tokenTotal: (prior?.tokenTotal ?? 0) + finiteNonNegative(segment.tokenTotal),
        costUsd: (prior?.costUsd ?? 0) + finiteNonNegative(segment.costUsd),
        costUsdComplete: prior ? mergeMetricCompleteness(prior.costUsdComplete, costUsdComplete) : costUsdComplete,
      });
    }
  }
  return [...providers.values()].sort(
    (left, right) =>
      right.costUsd - left.costUsd ||
      right.tokenTotal - left.tokenTotal ||
      left.providerKey.localeCompare(right.providerKey),
  );
}

export function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function mergeMetricCompleteness(left: boolean | undefined, right: boolean | undefined): boolean | undefined {
  if (left === false || right === false) return false;
  if (left === undefined || right === undefined) return undefined;
  return true;
}
