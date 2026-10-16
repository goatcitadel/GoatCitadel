import type { CostSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import { formatCostUsd, projectDailyCostBars } from "@goatcitadel/mission-control-shared/content/cost-summary";

/** A day of a few cents must not fill the track: the scale never drops below one dollar. */
const MINIMUM_SCALE_USD = 1;

/** The smallest 1, 2 or 5 step at or above the value, so the scale reads as a round number. */
export function niceScaleMax(value: number): number {
  const floor = Math.max(value, MINIMUM_SCALE_USD);
  const magnitude = 10 ** Math.floor(Math.log10(floor));
  for (const step of [1, 2, 5, 10]) if (floor <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Gateway day buckets are UTC dates; label them as "Wed 8 Oct" without moving them into local time. */
export function formatUtcDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return isoDate;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function SpendDailyChart({ summary }: { summary: CostSummaryResponse }) {
  const bars = projectDailyCostBars(summary);
  const amounts = (summary.dailySeries ?? []).slice(-7).map((day) => {
    const amount = day.costUsd ?? Number.NaN;
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  });
  const periodMax = Math.max(0, ...amounts);
  const scaleMax = niceScaleMax(periodMax);
  if (!bars.length) return <p className="text-sm text-fg-muted">No daily usage is recorded for this period.</p>;
  return (
    <>
      <ol className="grid gap-3">
        {bars.map((bar, index) => {
          const amount = amounts[index] ?? 0;
          const width = amount > 0 ? Math.max(1, Math.round((amount / scaleMax) * 100)) : 0;
          return (
            <li key={bar.key} className="flex items-center gap-2 text-xs sm:text-sm">
              <time dateTime={bar.key} title={bar.label} className="w-24 shrink-0 text-fg-secondary">
                {formatUtcDay(bar.key)}
              </time>
              <span className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken">
                <span
                  aria-hidden="true"
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${width}%` }}
                />
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-fg sm:w-20">{bar.costLabel}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-fg-muted">
        Scale $0 to {formatCostUsd(scaleMax)} · highest day {formatCostUsd(periodMax)}
      </p>
    </>
  );
}
