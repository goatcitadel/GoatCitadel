import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchCostSummary } from "@goatcitadel/mission-control-shared/api/system";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { projectDailyCostBars, projectProviderCostRows, projectUsageCostSummary } from "@goatcitadel/mission-control-shared/content/cost-summary";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";

export function SpendOverview() {
  const costs = useQuery({ queryKey: queryKeys.costs(), queryFn: () => fetchCostSummary("day"), refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ["system", "settings-budget-mode"], queryFn: fetchSettings, refetchInterval: 60_000 });
  const summary = costs.data;
  const projection = summary ? projectUsageCostSummary(summary) : null;
  const bars = summary ? projectDailyCostBars(summary) : [];
  const providers = summary ? projectProviderCostRows(summary) : [];
  const dates = summary ? [Date.parse(summary.from), Date.parse(summary.to)] : [];
  const period = dates.length === 2 && dates.every(Number.isFinite)
    ? `${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(dates[0])} – ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(dates[1])}`
    : "Latest seven days";

  return <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-semibold text-fg">Spend</h1>
        <p className="text-sm text-fg-secondary">Gateway usage and known cost for the latest seven days.</p>
        {summary ? <p className="mt-1 text-xs text-fg-muted">{period}</p> : null}
      </div>
      <Button size="sm" onClick={() => void costs.refetch()} disabled={costs.isFetching}><RefreshCw aria-hidden="true" className="size-4" /> Refresh</Button>
    </header>

    {costs.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading usage and cost…</p> : null}
    {costs.isError ? <EmptyState title="Spend unavailable" description={describeApiError(costs.error).summary} action={<Button onClick={() => void costs.refetch()}>Try again</Button>} /> : null}
    {summary && projection && !costs.isError ? <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Known cost" value={projection.costLabel} />
        <Metric label="Recorded tokens" value={new Intl.NumberFormat().format(projection.tokens)} />
        <Metric label="Recorded groups" value={new Intl.NumberFormat().format(summary.items.length)} />
      </div>
      <p className="rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">{projection.coverageDescription}</p>

      <section aria-labelledby="daily-cost-title" className="rounded-lg border border-line bg-raised p-4">
        <h2 id="daily-cost-title" className="font-display text-lg font-semibold text-fg">Known cost by day</h2>
        <p className="mt-1 text-sm text-fg-secondary">Bars show only cost recorded by the Gateway. A plus sign marks a lower bound.</p>
        {bars.length ? <ol className="mt-4 grid gap-3">{bars.map((bar) => <li key={bar.key} className="flex items-center gap-2 text-xs sm:text-sm">
          <span className="w-12 shrink-0 truncate text-fg-secondary sm:w-20" title={bar.label}>{bar.label}</span>
          <span className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken"><span aria-hidden="true" className="block h-full rounded-full bg-accent" style={{ width: `${bar.percent}%` }} /></span>
          <span className="w-16 shrink-0 text-right tabular-nums text-fg sm:w-20">{bar.costLabel}</span>
        </li>)}</ol> : <p className="mt-4 text-sm text-fg-muted">No daily usage is recorded for this period.</p>}
      </section>

      <section aria-labelledby="provider-cost-title" className="rounded-lg border border-line bg-raised p-4">
        <h2 id="provider-cost-title" className="font-display text-lg font-semibold text-fg">Provider attribution</h2>
        <p className="mt-1 text-sm text-fg-secondary">Gateway day segments identify providers and observed models. The API does not supply per-model cost totals.</p>
        {providers.length ? <ul className="mt-3 grid gap-2">{providers.map((provider) => <li key={provider.providerKey} className="rounded-md border border-line-subtle bg-sunken p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><h3 className="break-words text-sm font-semibold text-fg">{provider.label}</h3>
              <p className="text-xs text-fg-muted">{new Intl.NumberFormat().format(provider.tokenTotal)} recorded tokens</p></div>
            <strong className="text-sm tabular-nums text-fg">{provider.costLabel}</strong>
          </div>
          <p className="mt-2 break-words text-xs text-fg-muted">Models observed: {provider.models.length ? provider.models.slice(0, 3).join(", ") : "Not reported"}{provider.models.length > 3 ? `, +${provider.models.length - 3} more` : ""}</p>
        </li>)}</ul> : <p className="mt-3 text-sm text-fg-muted">No provider segments were returned for this period.</p>}
      </section>

      <section aria-labelledby="spend-budget-title" className="rounded-lg border border-line bg-raised p-4">
        <h2 id="spend-budget-title" className="font-display text-lg font-semibold text-fg">Budget posture</h2>
        <p className="mt-1 text-sm text-fg-secondary">Gateway budget preference: <strong className="text-fg">{settings.data && !settings.isError ? humanizeToken(settings.data.budgetMode) : "Unavailable"}</strong></p>
        {settings.isError ? <p role="alert" className="mt-2 text-xs text-status-failed">{describeApiError(settings.error).summary}</p> : null}
        <p className="mt-2 text-xs text-fg-muted">This settings response does not report a daily dollar warning or hard cap. The mode is not a spend limit.</p>
        <NativeOwnerLink scope="installation-budget" className="mt-2 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline" href="/settings/safety#budget-mode">Review budget preference</NativeOwnerLink>
      </section>

      <section className="rounded-lg border border-line p-4">
        <h2 className="text-sm font-semibold text-fg">More cost evidence</h2>
        <p className="mt-1 text-sm text-fg-secondary">Review detailed coverage and provider evidence in the current Costs view.</p>
        <ClassicOwnerLink className="mt-2 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline" href="/ops/costs?shell=classic" scope="installation-costs" label="Open costs in the classic view" />
      </section>
    </> : null}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-line bg-raised p-4">
    <p className="text-xs text-fg-muted">{label}</p>
    <p className="mt-1 font-display text-xl font-semibold tabular-nums text-fg">{value}</p>
  </div>;
}
