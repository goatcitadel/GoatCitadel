import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchCostSummary } from "@goatcitadel/mission-control-shared/api/system";
import {
  projectProviderCostRows,
  projectUsageCostSummary,
} from "@goatcitadel/mission-control-shared/content/cost-summary";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { queryKeys } from "../../data/query-keys";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { MetricList } from "../../ui/MetricList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Section } from "../../ui/Section";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { SpendAttempts } from "./SpendAttempts";
import { formatUtcDay, SpendDailyChart } from "./SpendDailyChart";
import { SpendObservedModels } from "./SpendObservedModels";
import { filterCostSummary, providerDayRows, readSpendFilters, type SpendWindow } from "./spend-details-model";

// Segmented control: the pressed option uses a neutral fill and strong border, as on Diagnostics.
const TOGGLE = "aria-[pressed=true]:border-fg aria-[pressed=true]:bg-sunken";
const WINDOW_OPTIONS: readonly { days: SpendWindow; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 3, label: "3 days" },
  { days: 1, label: "1 day" },
];
const tokens = (value: number | null) => (value === null ? "Not reported" : new Intl.NumberFormat().format(value));

/** Spend by day and provider, narrowed by a time window and a provider that live in the URL. */
export function SpendDetails() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const location = useCockpitRoute();
  const filters = readSpendFilters(location.search);
  const costs = useQuery({
    queryKey: queryKeys.costs(),
    queryFn: () => fetchCostSummary("day"),
    refetchInterval: 60_000,
  });
  const setFilter = (key: "window" | "provider", value: string | null) => {
    const params = new URLSearchParams(location.search);
    if (value === null) params.delete(key);
    else params.set(key, value);
    location.navigate(`/system/spend/details?${params}${location.hash}`, { replace: true });
  };
  const backParams = new URLSearchParams(location.search);
  backParams.delete("window");
  backParams.delete("provider");
  const summary = costs.isError ? undefined : costs.data;
  const allProviders = summary
    ? projectProviderCostRows(filterCostSummary(summary, { ...filters, provider: "all" }))
    : [];
  const filtered = summary ? filterCostSummary(summary, filters) : undefined;
  const projection = filtered ? projectUsageCostSummary(filtered) : undefined;
  const providers = filtered ? projectProviderCostRows(filtered) : [];
  const availability = summary?.usageAvailability;
  const callCoverage = availability?.metricAvailability?.costUsd;
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Spend details"
        description="Cost and token records by day and provider."
        actions={
          <Button size="sm" onClick={() => void costs.refetch()} disabled={costs.isFetching}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh<span className="sr-only"> spend details</span>
          </Button>
        }
      />
      {costs.isLoading ? <p className="text-sm text-fg-muted">Loading usage and cost…</p> : null}
      {costs.isError ? (
        <EmptyState
          title="Spend unavailable"
          description={describeApiError(costs.error).summary}
          action={<Button onClick={() => void costs.refetch()}>Try again</Button>}
        />
      ) : null}
      {summary && filtered && projection ? (
        <>
          <div className="flex flex-wrap gap-4">
            <div role="group" aria-label="Time window" className="flex flex-wrap gap-2">
              {WINDOW_OPTIONS.map((option) => (
                <Button
                  key={option.days}
                  size="sm"
                  className={TOGGLE}
                  aria-pressed={filters.days === option.days}
                  onClick={() => setFilter("window", option.days === 7 ? null : String(option.days))}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <div role="group" aria-label="Provider" className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className={TOGGLE}
                aria-pressed={filters.provider === "all"}
                onClick={() => setFilter("provider", null)}
              >
                All providers
              </Button>
              {allProviders.map((provider) => (
                <Button
                  key={provider.providerKey}
                  size="sm"
                  className={TOGGLE}
                  aria-pressed={filters.provider === provider.providerKey}
                  onClick={() => setFilter("provider", provider.providerKey)}
                >
                  {provider.label}
                </Button>
              ))}
            </div>
          </div>

          <Section title="Coverage" description={projection.coverageDescription}>
            <p className="mb-2 text-sm text-fg-secondary">
              {filters.provider === "all"
                ? "How much of the recorded usage has a known cost, for every provider together."
                : "Call coverage is reported for all providers together, so it is not split by provider here."}
            </p>
            <MetricList
              label="Spend coverage"
              items={[
                { term: "Known cost", value: projection.costLabel },
                { term: "Recorded tokens", value: projection.tokenLabel },
                ...(filters.provider === "all"
                  ? [
                      {
                        term: "Calls with a known cost",
                        value: callCoverage
                          ? `${callCoverage.knownAttemptCount} of ${callCoverage.knownAttemptCount + callCoverage.unknownAttemptCount}`
                          : "Unknown",
                      },
                      { term: "Tracked events", value: availability ? String(availability.trackedEvents) : "Unknown" },
                      {
                        term: "Events without cost",
                        value: availability ? String(availability.unknownEvents) : "Unknown",
                      },
                    ]
                  : []),
              ]}
            />
          </Section>

          <Section title="By day (UTC)" description="Cost in USD per UTC day. “At least” marks a lower bound.">
            <SpendDailyChart summary={filtered} />
          </Section>

          <Section title="Providers" description="Known cost and tokens per provider, with each day's tokens.">
            {providers.length ? (
              <ul className="divide-y divide-line-subtle">
                {providers.map((provider) => (
                  <li key={provider.providerKey} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-semibold text-fg">{provider.label}</h3>
                        <p className="text-xs text-fg-muted">{plural(provider.tokenTotal, "recorded token")}</p>
                      </div>
                      <strong className="text-sm tabular-nums text-fg">{provider.costLabel}</strong>
                    </div>
                    <SpendObservedModels providerKey={provider.providerKey} models={provider.models} />
                    <details className="mt-2 text-sm text-fg-secondary">
                      <summary className="cursor-pointer font-medium text-fg">Daily tokens</summary>
                      <ul className="mt-1 divide-y divide-line-subtle">
                        {providerDayRows(filtered, provider.providerKey).map((row) => (
                          <li key={row.date} className="py-1.5 tabular-nums">
                            {formatUtcDay(row.date)} · input {tokens(row.input)} · output {tokens(row.output)} · cached{" "}
                            {tokens(row.cached)}
                            {row.partial ? " · partial" : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No provider usage was recorded in this window.</p>
            )}
          </Section>

          <SpendAttempts key={workspaceId} workspaceId={workspaceId} from={filtered.from} to={filtered.to} />

          <TechnicalDetails label="Accounting window and totals">
            <pre className="max-h-64 overflow-auto font-mono text-xs">
              {JSON.stringify(
                { from: filtered.from, to: filtered.to, filters, usageAvailability: filtered.usageAvailability },
                null,
                2,
              )}
            </pre>
          </TechnicalDetails>
          <NativeOwnerLink
            href={`/system/spend?${backParams}${location.hash}`}
            scope="installation-costs"
            className="inline-block text-sm font-medium text-accent hover:underline"
          >
            Back to Spend
          </NativeOwnerLink>
        </>
      ) : null}
    </section>
  );
}
