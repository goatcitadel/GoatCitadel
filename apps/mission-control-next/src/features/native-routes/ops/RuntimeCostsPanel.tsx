import {
  readCurrentDayCostCompleteness,
  hasIncompleteCostProjection,
  describeIncompleteSpendChart,
  describeCostCoverageGap,
  formatCostCoverage,
  describeCostCoverage,
  formatAvailabilityCount,
  formatCostMetric,
  readSpendDays,
  readProviderSpendRows,
} from "./runtime-spend-model";
import { describeQmdImpact, formatTokenDelta } from "./runtime-formatters";
import { DetailInspector } from "../../../components/DetailInspector";
import { NativeButton, NativeMetricGrid as MetricGrid, NativeTable, NoticeBanner } from "../primitives";
import { NativeCard, NativeDisclosureCard, NativeGrid } from "../NativeRoutePageLayout";
import { RuntimeSpendChart } from "./RuntimeSpendChart";
import type { NativeRoutePagesProps } from "../types";
import type { OpsRuntimeData } from "./runtime-overview-model";
import type { RuntimePanelSetter } from "./runtime-panel-types";

export function RuntimeCostsPanel({
  data,
  costWindow,
  costProviderFilter,
  setCostWindow,
  setCostProviderFilter,
  setSupportPanel,
  navigate,
  route,
  supportPanel,
}: {
  data: OpsRuntimeData;
  costWindow: number;
  costProviderFilter: string;
  setCostWindow: RuntimePanelSetter<number>;
  setCostProviderFilter: RuntimePanelSetter<string>;
  setSupportPanel: RuntimePanelSetter<string | null>;
  navigate: NativeRoutePagesProps["navigate"];
  route: NativeRoutePagesProps["route"];
  supportPanel: string | null;
}) {
  const spendDays = readSpendDays(data).slice(-costWindow);
  const shownDates = new Set(spendDays.map((day) => day.isoDate));
  const providerSpendRows = readProviderSpendRows(data, shownDates);
  const visibleProviderSpendRows =
    costProviderFilter === "all"
      ? providerSpendRows
      : providerSpendRows.filter((item) => item.providerKey === costProviderFilter);
  const costCoverage = data.cost?.usageAvailability?.metricAvailability?.costUsd;
  const costProjectionIncomplete = hasIncompleteCostProjection(data);
  const daySpendCompleteness = readCurrentDayCostCompleteness(data);
  return (
    <NativeGrid>
      <NativeCard
        title={`Spend — ${costWindow === 1 ? "latest day" : `last ${costWindow} days`}`}
        subtitle="Available provider spend, grouped by recorded day."
        className="mc-next-spend-history-card"
        stats={[
          { label: "Scope", value: data.cost?.scope ?? "day" },
          { label: "Days", value: String(spendDays.length) },
        ]}
      >
        <label className="mc-next-settings-field">
          Time range
          <select value={costWindow} onChange={(event) => setCostWindow(Number(event.target.value))}>
            <option value={7}>Last 7 available days</option>
            <option value={3}>Last 3 available days</option>
            <option value={1}>Latest available day</option>
          </select>
        </label>
        <RuntimeSpendChart
          days={
            costProviderFilter === "all"
              ? spendDays
              : spendDays.map((day) => ({
                  ...day,
                  segments: day.segments.filter((segment) => segment.providerKey === costProviderFilter),
                }))
          }
          ariaLabelOverride={costProjectionIncomplete ? describeIncompleteSpendChart(costCoverage) : undefined}
          emptyTitle={costProjectionIncomplete ? "Spend total unavailable" : undefined}
          emptyDescription={
            costProjectionIncomplete
              ? "Token usage is present, but one or more provider attempts have no trustworthy cost. Zero-valued rows are not shown as free usage."
              : undefined
          }
        />
        {costProjectionIncomplete ? (
          <NoticeBanner tone="warning" message={describeCostCoverageGap(costCoverage)} />
        ) : null}
      </NativeCard>
      <NativeCard
        title="Spend summary"
        subtitle="Tracked usage, coverage, and current spend leaders."
        stats={[
          { label: "Scope", value: data.cost?.scope ?? "day" },
          { label: "Tracked", value: formatAvailabilityCount(data.cost?.usageAvailability?.trackedEvents) },
        ]}
      >
        <div className="mc-next-settings-filter-bar" role="radiogroup" aria-label="Provider spend filter">
          <button
            type="button"
            role="radio"
            aria-checked={costProviderFilter === "all"}
            className={`mc-next-settings-filter${costProviderFilter === "all" ? " active" : ""}`}
            onClick={() => setCostProviderFilter("all")}
          >
            All providers
          </button>
          {providerSpendRows.map((item) => (
            <button
              key={item.providerKey}
              type="button"
              role="radio"
              aria-checked={costProviderFilter === item.providerKey}
              className={`mc-next-settings-filter${costProviderFilter === item.providerKey ? " active" : ""}`}
              onClick={() => setCostProviderFilter(item.providerKey)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p>{describeCostCoverage(costCoverage)}</p>
        <NativeButton variant="outline" onClick={() => setSupportPanel("cost-coverage")}>
          Coverage
        </NativeButton>
        <NativeTable
          ariaLabel="Provider spend breakdown"
          rows={visibleProviderSpendRows}
          getRowKey={(item) => item.providerKey}
          emptyLabel="No spend breakdown available."
          columns={[
            {
              key: "provider",
              header: "Provider",
              render: (item) => (
                <NativeButton variant="ghost" onClick={() => setSupportPanel("cost-provider:" + item.providerKey)}>
                  {item.label}
                </NativeButton>
              ),
            },
            {
              key: "tokens",
              header: "Tokens",
              numeric: true,
              cell: (item) => item.tokenTotal.toLocaleString(),
            },
            {
              key: "cost",
              header: "Cost",
              numeric: true,
              cell: (item) => formatCostMetric(item.costUsd, item.costUsdComplete),
            },
          ]}
        />
        <div className="mc-next-runtime-actions">
          <NativeButton
            variant="outline"
            onClick={() => navigate({ area: "settings", section: "budget", theme: route.theme })}
          >
            Open budget controls
          </NativeButton>
        </div>
      </NativeCard>
      <DetailInspector open={supportPanel === "cost-coverage"} title="Coverage" onClose={() => setSupportPanel(null)}>
        <MetricGrid
          items={[
            {
              label: "Tracked events",
              value: formatAvailabilityCount(data.cost?.usageAvailability?.trackedEvents),
              meta: "Events with at least one tracked usage metric",
            },
            {
              label: "Unknown events",
              value: formatAvailabilityCount(data.cost?.usageAvailability?.unknownEvents),
              meta: "Events with no tracked usage metrics",
            },
            {
              label: "Cost coverage",
              value: formatCostCoverage(costCoverage),
              meta: describeCostCoverage(costCoverage),
            },
            {
              label: "Day spend",
              value: formatCostMetric(data.dashboard?.dailyCostUsd, daySpendCompleteness),
              meta: "Dashboard daily total",
            },
          ]}
        />

        <NativeDisclosureCard
          id={"quality-and-qmd-signal"}
          title="Quality and QMD signal"
          subtitle="Spend only means something when paired with quality and context efficiency."
        >
          <MetricGrid
            items={[
              {
                label: "QMD posture",
                value: describeQmdImpact(data.health?.costs?.qmd?.efficiencyLabel),
                meta:
                  data.health?.costs?.qmd?.netTokenDelta === undefined
                    ? "Unavailable"
                    : formatTokenDelta(data.health.costs.qmd.netTokenDelta),
              },
              {
                label: "Compression",
                value:
                  data.health?.costs?.qmd?.compressionPercent === undefined
                    ? "Unavailable"
                    : `${data.health.costs.qmd.compressionPercent.toFixed(1)}%`,
                meta: "Context reduction",
              },
              {
                label: "Expansion",
                value:
                  data.health?.costs?.qmd?.expansionPercent === undefined
                    ? "Unavailable"
                    : `${data.health.costs.qmd.expansionPercent.toFixed(1)}%`,
                meta: "Context growth",
              },
            ]}
          />
        </NativeDisclosureCard>
        <details>
          <summary>Accounting fields</summary>
          <pre>
            {JSON.stringify(
              {
                from: data.cost?.from,
                to: data.cost?.to,
                availability: data.cost?.usageAvailability,
                items: data.cost?.items,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </DetailInspector>
      <DetailInspector
        open={Boolean(supportPanel?.startsWith("cost-provider:"))}
        title="Provider usage and attribution"
        onClose={() => setSupportPanel(null)}
      >
        {(() => {
          const providerKey = supportPanel?.slice("cost-provider:".length);
          const days = (data.cost?.dailySeries ?? []).filter((day) => shownDates.has(day.isoDate));
          return (
            <>
              <p>Provider {providerKey} · selected recorded days. Coverage is reported separately for each metric.</p>
              {days.map((day) => (
                <details key={day.isoDate} open>
                  <summary>{day.isoDate}</summary>
                  {day.segments
                    .filter((item) => item.providerKey === providerKey)
                    .map((item) => (
                      <div key={item.providerKey}>
                        <dl>
                          <dt>Input tokens</dt>
                          <dd>
                            {formatAvailabilityCount(item.tokenInput)}
                            {item.metricAvailability?.inputTokensComplete === false ? " · partial" : ""}
                          </dd>
                          <dt>Output tokens</dt>
                          <dd>
                            {formatAvailabilityCount(item.tokenOutput)}
                            {item.metricAvailability?.outputTokensComplete === false ? " · partial" : ""}
                          </dd>
                          <dt>Cached input tokens</dt>
                          <dd>
                            {formatAvailabilityCount(item.tokenCachedInput)}
                            {item.metricAvailability?.cachedInputTokensComplete === false ? " · partial" : ""}
                          </dd>
                          <dt>Cost (USD)</dt>
                          <dd>{formatCostMetric(item.costUsd, item.metricAvailability?.costUsdComplete)}</dd>
                        </dl>
                        <details>
                          <summary>Attribution and accounting fields</summary>
                          <pre>{JSON.stringify(item, null, 2)}</pre>
                        </details>
                      </div>
                    ))}
                </details>
              ))}
            </>
          );
        })()}
      </DetailInspector>
    </NativeGrid>
  );
}
