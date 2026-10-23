import type { CostSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";

export type SpendWindow = 1 | 3 | 7;
export interface SpendFilters {
  days: SpendWindow;
  provider: string;
}

const WINDOWS: readonly SpendWindow[] = [7, 3, 1];

/** `?window=` and `?provider=` from the URL; anything missing, repeated or unknown falls back to 7 days, all providers. */
export function readSpendFilters(search: string): SpendFilters {
  const params = new URLSearchParams(search);
  const windows = params.getAll("window"),
    providers = params.getAll("provider");
  const days = windows.length === 1 ? WINDOWS.find((value) => String(value) === windows[0]) : undefined;
  const provider = providers.length === 1 && providers[0]!.trim() ? providers[0]!.trim() : "all";
  return { days: days ?? 7, provider: windows.length > 1 || providers.length > 1 ? "all" : provider };
}

type Day = NonNullable<CostSummaryResponse["dailySeries"]>[number];

function providerDay(day: Day, provider: string): Day {
  const segments = day.segments.filter((segment) => segment.providerKey === provider);
  const segment = segments[0];
  return {
    ...day,
    tokenInput: segment?.tokenInput,
    tokenOutput: segment?.tokenOutput,
    tokenCachedInput: segment?.tokenCachedInput,
    tokenTotal: segment ? segment.tokenTotal : 0,
    costUsd: segment ? segment.costUsd : 0,
    metricAvailability: segment?.metricAvailability ?? day.metricAvailability,
    segments,
  };
}

/**
 * The summary narrowed to the latest `days` days and, optionally, one provider, so the shared Spend projections and
 * chart can render it unchanged. A missing cost stays missing; the window-wide count of calls without a cost is
 * dropped for a single provider or a shorter window, because it cannot be split by provider or by day.
 */
export function filterCostSummary(summary: CostSummaryResponse, filters: SpendFilters): CostSummaryResponse {
  const kept = (summary.dailySeries ?? []).slice(-filters.days);
  const keptDates = new Set(kept.map((day) => day.isoDate));
  const byProvider = filters.provider !== "all";
  // Call coverage is counted for the whole seven days; it cannot be split by provider or by day.
  const narrowed = byProvider || filters.days < 7;
  const dailySeries = byProvider ? kept.map((day) => providerDay(day, filters.provider)) : kept;
  const items = byProvider
    ? dailySeries.map((day) => ({
        key: day.isoDate,
        tokenInput: day.tokenInput ?? Number.NaN,
        tokenOutput: day.tokenOutput ?? Number.NaN,
        tokenCachedInput: day.tokenCachedInput ?? Number.NaN,
        tokenTotal: day.tokenTotal ?? Number.NaN,
        costUsd: day.costUsd ?? Number.NaN,
        metricAvailability: day.metricAvailability,
      }))
    : summary.items.filter((item) => keptDates.has(item.key));
  const availability = summary.usageAvailability;
  const metrics = availability?.metricAvailability;
  return {
    ...summary,
    from: kept[0] && filters.days < 7 ? `${kept[0].isoDate}T00:00:00.000Z` : summary.from,
    items,
    dailySeries,
    usageAvailability:
      narrowed && availability && metrics
        ? {
            ...availability,
            metricAvailability: { ...metrics, costUsd: { ...metrics.costUsd, unknownAttemptCount: 0 } },
          }
        : availability,
  };
}

/** One provider's tokens per day, with partial days marked; days without that provider are left out. */
export function providerDayRows(
  summary: CostSummaryResponse,
  providerKey: string,
): { date: string; input: number | null; output: number | null; cached: number | null; partial: boolean }[] {
  return (summary.dailySeries ?? []).flatMap((day) => {
    const segment = day.segments.find((item) => item.providerKey === providerKey);
    if (!segment) return [];
    const flags = segment.metricAvailability;
    return [
      {
        date: day.isoDate,
        input: segment.tokenInput ?? null,
        output: segment.tokenOutput ?? null,
        cached: segment.tokenCachedInput ?? null,
        partial: flags ? !(flags.inputTokensComplete && flags.outputTokensComplete) : false,
      },
    ];
  });
}
