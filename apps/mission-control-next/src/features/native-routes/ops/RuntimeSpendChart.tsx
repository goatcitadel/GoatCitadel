/**
 * Runtime spend chart — a 7-day stacked-bar SVG, one column per day, each
 * column stacked by provider contribution. The day that exceeds
 * {@link DEFAULT_ANOMALY_THRESHOLD}x the 7-day median is recoloured with the
 * canonical `--gc-risk-caution` token and announced in the chart's
 * descriptive `aria-label`.
 *
 * EMPTY STATE: when the live `CostSummaryResponse.dailySeries` is missing or
 * all-zero, the chart renders an explicit empty state so operators see the
 * absence of spend evidence rather than a fabricated trend.
 */
import type { ReactNode } from "react";

export const DEFAULT_ANOMALY_THRESHOLD = 1.5;
export const SPEND_CHART_DAY_COUNT = 7;

export type SpendProviderSegment = {
  /** Stable provider key — used as a React key + for series colour lookup. */
  providerKey: string;
  /** Display label rendered in the legend + sr-only table. */
  label: string;
  /** Non-negative dollar contribution for this provider on this day. */
  costUsd: number;
};

export type SpendDay = {
  /** Stable identifier for the day (ISO date or yyyy-mm-dd). */
  isoDate: string;
  /** Short display label rendered under each bar (e.g. "Mon" or "May 12"). */
  shortLabel: string;
  /** Provider segments composing the bar, ordered bottom-to-top. */
  segments: SpendProviderSegment[];
};

export type RuntimeSpendChartProps = {
  /** Seven-day spend series, oldest first. Pass an empty array for empty state. */
  days?: readonly SpendDay[];
  /**
   * Multiplier on the seven-day median used to flag an anomaly column.
   * Defaults to {@link DEFAULT_ANOMALY_THRESHOLD}.
   */
  anomalyThreshold?: number;
  /** Override the heading announced as `aria-label`. */
  ariaLabelOverride?: string;
  /** Empty-state copy rendered when `days` is empty or all-zero. */
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
};

type ComputedDay = SpendDay & {
  total: number;
  isAnomaly: boolean;
};

type ChartViewModel = {
  days: ComputedDay[];
  total: number;
  median: number;
  anomalyDay: ComputedDay | null;
  yAxisTicks: number[];
  yAxisMax: number;
  providerOrder: string[];
};

const SVG_VIEW_WIDTH = 700;
const SVG_VIEW_HEIGHT = 200;
const CHART_TOP_PADDING = 16;
const CHART_BOTTOM_PADDING = 32;
const CHART_LEFT_PADDING = 44;
const CHART_RIGHT_PADDING = 12;
const PLOT_TOP = CHART_TOP_PADDING;
const PLOT_BOTTOM = SVG_VIEW_HEIGHT - CHART_BOTTOM_PADDING;
const PLOT_LEFT = CHART_LEFT_PADDING;
const PLOT_RIGHT = SVG_VIEW_WIDTH - CHART_RIGHT_PADDING;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const GRIDLINE_COUNT = 4;

/**
 * Distinct CSS custom properties to colour each stacked segment. The chart
 * cycles through these in order so the chart never depends on hex literals —
 * only canonical area tokens. Six tokens accommodate the common provider
 * mix (chat / cowork / code / library / ops / accent fallback).
 */
const SEGMENT_TOKENS = [
  "var(--area-ops)",
  "var(--area-chat)",
  "var(--area-cowork)",
  "var(--area-code)",
  "var(--area-library)",
  "var(--brand-deep)",
] as const;

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function safePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function computeSpendChartModel(days: readonly SpendDay[], anomalyThreshold: number): ChartViewModel {
  const sanitized: ComputedDay[] = days.map((day) => {
    const total = day.segments.reduce((sum, segment) => sum + safePositive(segment.costUsd), 0);
    return { ...day, total, isAnomaly: false };
  });

  const totals = sanitized.map((day) => day.total);
  const median = computeMedian(totals);
  const anomalyThresholdValue = median * anomalyThreshold;
  let anomalyDay: ComputedDay | null = null;
  for (const day of sanitized) {
    if (median > 0 && day.total >= anomalyThresholdValue) {
      day.isAnomaly = true;
      if (!anomalyDay || day.total > anomalyDay.total) {
        anomalyDay = day;
      }
    }
  }

  const yAxisMax = computeYAxisMax(totals);
  const yAxisTicks = computeAxisTicks(yAxisMax);
  const providerOrder = computeProviderOrder(sanitized);
  const total = totals.reduce((sum, value) => sum + value, 0);

  return {
    days: sanitized,
    total,
    median,
    anomalyDay,
    yAxisTicks,
    yAxisMax,
    providerOrder,
  };
}

function computeMedian(values: readonly number[]): number {
  const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (positive.length === 0) {
    return 0;
  }
  const mid = Math.floor(positive.length / 2);
  if (positive.length % 2 === 1) {
    return positive[mid] ?? 0;
  }
  const a = positive[mid - 1] ?? 0;
  const b = positive[mid] ?? 0;
  return (a + b) / 2;
}

function computeYAxisMax(values: readonly number[]): number {
  const max = values.reduce((current, value) => (value > current ? value : current), 0);
  if (max <= 0) {
    return 1;
  }
  // Round up to a friendly tick that gives ~4 gridlines of headroom.
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const normalized = max / magnitude;
  let stepped: number;
  if (normalized <= 1) {
    stepped = 1;
  } else if (normalized <= 2) {
    stepped = 2;
  } else if (normalized <= 5) {
    stepped = 5;
  } else {
    stepped = 10;
  }
  return stepped * magnitude;
}

function computeAxisTicks(yAxisMax: number): number[] {
  const step = yAxisMax / GRIDLINE_COUNT;
  const ticks: number[] = [];
  for (let i = 0; i <= GRIDLINE_COUNT; i += 1) {
    ticks.push(step * i);
  }
  return ticks;
}

function computeProviderOrder(days: readonly ComputedDay[]): string[] {
  const totalsByProvider = new Map<string, number>();
  for (const day of days) {
    for (const segment of day.segments) {
      totalsByProvider.set(
        segment.providerKey,
        (totalsByProvider.get(segment.providerKey) ?? 0) + safePositive(segment.costUsd),
      );
    }
  }
  return Array.from(totalsByProvider.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([key]) => key);
}

function describeProviders(days: readonly ComputedDay[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const day of days) {
    for (const segment of day.segments) {
      if (!labels.has(segment.providerKey)) {
        labels.set(segment.providerKey, segment.label);
      }
    }
  }
  return labels;
}

export function buildSpendChartAriaLabel(model: ChartViewModel): string {
  if (model.days.length === 0 || model.total <= 0) {
    return "Seven-day spend chart, no data available.";
  }
  const parts = [`Seven-day spend chart. Total ${formatUsdCompact(model.total)} across ${model.days.length} days.`];
  if (model.anomalyDay) {
    parts.push(
      `Anomaly on ${model.anomalyDay.shortLabel}: ${formatUsdCompact(model.anomalyDay.total)} exceeds the seven-day median of ${formatUsdCompact(model.median)}.`,
    );
  }
  return parts.join(" ");
}

export function RuntimeSpendChart({
  days = [],
  anomalyThreshold = DEFAULT_ANOMALY_THRESHOLD,
  ariaLabelOverride,
  emptyTitle = "No spend history available",
  emptyDescription = "No tracked provider spend landed in the current seven-day cost window. New usage rows will render here with anomaly detection.",
}: RuntimeSpendChartProps) {
  const hasData =
    days.length > 0 && days.some((day) => day.segments.some((segment) => safePositive(segment.costUsd) > 0));

  if (!hasData) {
    return (
      <div
        className="mc-next-runtime-spend-chart is-empty"
        role="img"
        aria-label={ariaLabelOverride ?? "Seven-day spend chart, no data available."}
      >
        <div className="mc-next-runtime-spend-chart-empty">
          <strong>{emptyTitle}</strong>
          <p>{emptyDescription}</p>
        </div>
      </div>
    );
  }

  const model = computeSpendChartModel(days, anomalyThreshold);
  const ariaLabel = ariaLabelOverride ?? buildSpendChartAriaLabel(model);
  const slotWidth = PLOT_WIDTH / SPEND_CHART_DAY_COUNT;
  const barWidth = Math.max(12, slotWidth * 0.6);
  const providerLabels = describeProviders(model.days);

  return (
    <div className="mc-next-runtime-spend-chart">
      <div className="mc-next-runtime-spend-chart-legend" aria-hidden="true">
        {model.providerOrder.map((providerKey, index) => (
          <span key={providerKey} className="mc-next-runtime-spend-chart-legend-entry">
            <span
              className="mc-next-runtime-spend-chart-legend-swatch"
              style={{ background: SEGMENT_TOKENS[index % SEGMENT_TOKENS.length] }}
            />
            {providerLabels.get(providerKey) ?? providerKey}
          </span>
        ))}
      </div>
      <svg
        className="mc-next-runtime-spend-chart-svg"
        viewBox={`0 0 ${SVG_VIEW_WIDTH} ${SVG_VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
        focusable="false"
      >
        <title>{ariaLabel}</title>
        <g className="mc-next-runtime-spend-chart-grid">
          {model.yAxisTicks.map((tick) => {
            const y = PLOT_BOTTOM - (tick / model.yAxisMax) * PLOT_HEIGHT;
            return (
              <line
                key={`grid-${tick}`}
                x1={PLOT_LEFT}
                x2={PLOT_RIGHT}
                y1={y}
                y2={y}
                className="mc-next-runtime-spend-chart-gridline"
              />
            );
          })}
        </g>
        <g className="mc-next-runtime-spend-chart-axis">
          {model.yAxisTicks.map((tick) => {
            const y = PLOT_BOTTOM - (tick / model.yAxisMax) * PLOT_HEIGHT;
            return (
              <text
                key={`y-${tick}`}
                x={PLOT_LEFT - 6}
                y={y + 3}
                textAnchor="end"
                className="mc-next-runtime-spend-chart-axis-label"
              >
                {formatUsdCompact(tick)}
              </text>
            );
          })}
        </g>
        <g className="mc-next-runtime-spend-chart-bars">
          {model.days.map((day, dayIndex) => {
            const slotX = PLOT_LEFT + slotWidth * dayIndex + (slotWidth - barWidth) / 2;
            let cursor = PLOT_BOTTOM;
            const isAnomaly = day.isAnomaly;
            return (
              <g
                key={day.isoDate}
                className={["mc-next-runtime-spend-chart-bar", isAnomaly ? "is-anomaly" : ""].filter(Boolean).join(" ")}
              >
                {day.segments.map((segment) => {
                  const cost = safePositive(segment.costUsd);
                  if (cost <= 0 || model.yAxisMax <= 0) {
                    return null;
                  }
                  const height = (cost / model.yAxisMax) * PLOT_HEIGHT;
                  cursor -= height;
                  const colorIndex = model.providerOrder.indexOf(segment.providerKey);
                  const colorToken = SEGMENT_TOKENS[colorIndex >= 0 ? colorIndex % SEGMENT_TOKENS.length : 0];
                  return (
                    <rect
                      key={`${day.isoDate}-${segment.providerKey}`}
                      x={slotX}
                      y={cursor}
                      width={barWidth}
                      height={height}
                      className={["mc-next-runtime-spend-chart-segment", isAnomaly ? "is-anomaly" : ""]
                        .filter(Boolean)
                        .join(" ")}
                      fill={isAnomaly ? "var(--gc-risk-caution)" : colorToken}
                    />
                  );
                })}
                <text
                  x={slotX + barWidth / 2}
                  y={SVG_VIEW_HEIGHT - 12}
                  textAnchor="middle"
                  className={
                    isAnomaly
                      ? "mc-next-runtime-spend-chart-axis-label is-anomaly"
                      : "mc-next-runtime-spend-chart-axis-label"
                  }
                >
                  {isAnomaly ? `${day.shortLabel} ▲` : day.shortLabel}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {model.anomalyDay ? (
        <div className="mc-next-runtime-spend-chart-callout" role="note">
          <span aria-hidden="true">{"▲"}</span>
          <span>
            {model.anomalyDay.shortLabel} spike · {formatUsdCompact(model.anomalyDay.total)} vs median{" "}
            {formatUsdCompact(model.median)}
          </span>
        </div>
      ) : null}
      <table className="mc-next-sr-only mc-next-runtime-spend-chart-table">
        <caption>Seven-day spend by provider</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {model.providerOrder.map((providerKey) => (
              <th key={providerKey} scope="col">
                {providerLabels.get(providerKey) ?? providerKey}
              </th>
            ))}
            <th scope="col">Total</th>
            <th scope="col">Anomaly</th>
          </tr>
        </thead>
        <tbody>
          {model.days.map((day) => (
            <tr key={day.isoDate}>
              <th scope="row">{day.shortLabel}</th>
              {model.providerOrder.map((providerKey) => {
                const segment = day.segments.find((item) => item.providerKey === providerKey);
                return (
                  <td key={`${day.isoDate}-${providerKey}`}>{formatUsdCompact(safePositive(segment?.costUsd ?? 0))}</td>
                );
              })}
              <td>{formatUsdCompact(day.total)}</td>
              <td>{day.isAnomaly ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
