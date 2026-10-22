import { useCockpitRoute } from "../../app/use-cockpit-route";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchCostSummary } from "@goatcitadel/mission-control-shared/api/system";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  projectProviderCostRows,
  projectUsageCostSummary,
} from "@goatcitadel/mission-control-shared/content/cost-summary";
import { formatAbsoluteTime, plural } from "@goatcitadel/mission-control-shared/content/format";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { SpendAttempts } from "./SpendAttempts";
import { BUDGET_MODE } from "./system-vocabulary";
import { SpendDailyChart } from "./SpendDailyChart";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { MetricList } from "../../ui/MetricList";
import { Section } from "../../ui/Section";

export function SpendOverview() {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const location = useCockpitRoute();
  const costParameters = new URLSearchParams(location.search);
  costParameters.set("workspaceId", activeWorkspaceId ?? "default");
  if (activeCitadelId) costParameters.set("citadelId", activeCitadelId);
  costParameters.delete("shell");
  costParameters.delete("shellScope");
  const detailsHref = "/system/spend/details?" + costParameters + location.hash;
  const costs = useQuery({
    queryKey: queryKeys.costs(),
    queryFn: () => fetchCostSummary("day"),
    refetchInterval: 60_000,
  });
  const settings = useQuery({
    queryKey: ["system", "settings-budget-mode"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  const summary = costs.data;
  const projection = summary ? projectUsageCostSummary(summary) : null;
  const providers = summary ? projectProviderCostRows(summary) : [];
  const missingTokenDays = projection?.tokenCoverage.missingGroups ?? 0;
  const dates = summary ? [Date.parse(summary.from), Date.parse(summary.to)] : [];
  const period =
    dates.length === 2 && dates.every(Number.isFinite)
      ? `${formatAbsoluteTime(dates[0])} – ${formatAbsoluteTime(dates[1])} (local time)`
      : "Latest seven days";

  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Spend"
        description="Usage and known cost for the latest seven days."
        actions={
          <Button size="sm" onClick={() => void costs.refetch()} disabled={costs.isFetching}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
        }
      >
        {summary ? <p className="mt-1 text-xs text-fg-muted">Grouped by day (UTC) · {period} · currency USD</p> : null}
      </AreaHeader>

      {costs.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading usage and cost…
        </p>
      ) : null}
      {costs.isError ? (
        <EmptyState
          title="Spend unavailable"
          description={describeApiError(costs.error).summary}
          action={<Button onClick={() => void costs.refetch()}>Try again</Button>}
        />
      ) : null}
      {summary && projection && !costs.isError ? (
        <>
          <div className="grid gap-3">
            <p className="text-sm text-fg">{projection.coverageDescription}</p>
            <MetricList
              label="Spend totals"
              items={[
                { term: "Known cost", value: projection.costLabel },
                { term: "Recorded tokens", value: projection.tokenLabel },
              ]}
            />
            {missingTokenDays > 0 ? (
              <p className="text-xs text-fg-muted">
                {`Token counts are missing or partial for ${plural(missingTokenDays, "day")}, so the token total is a lower bound.`}
              </p>
            ) : null}
            <p className="text-xs text-fg-muted">
              Accounted cost may combine provider-reported amounts and GoatCitadel pricing estimates. Complete coverage
              means all costs were accounted; it does not make an estimate a measured bill.
            </p>
          </div>

          <Section
            title="Cost by day (UTC)"
            description="Bars show cost in USD recorded in UTC day buckets. The period above uses local time; these aggregates cannot be rebucketed into local days. A plus sign marks a lower bound."
          >
            <SpendDailyChart summary={summary} />
          </Section>

          <SpendAttempts
            key={activeWorkspaceId ?? "default"}
            workspaceId={activeWorkspaceId ?? "default"}
            from={summary.from}
            to={summary.to}
          />

          <Section
            title="Provider attribution"
            description="Daily records identify providers and observed models. The API does not supply per-model cost totals."
          >
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
                    <p className="mt-1 break-words text-xs text-fg-muted">
                      {"Models observed: "}
                      {provider.models.length ? provider.models.slice(0, 3).join(", ") : "Not reported"}
                      {provider.models.length > 3 ? `, +${provider.models.length - 3} more` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No provider segments were returned for this period.</p>
            )}
          </Section>

          <Section title="Budget setting">
            <p className="text-sm text-fg-secondary">
              {"Budget preference: "}
              <strong className="text-fg">
                {settings.data && !settings.isError
                  ? (BUDGET_MODE[settings.data.budgetMode] ?? "Unrecognized mode")
                  : "Unavailable"}
              </strong>
            </p>
            {settings.isError ? (
              <p role="alert" className="mt-2 text-xs text-status-failed">
                {describeApiError(settings.error).summary}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-fg-muted">
              This settings response does not report a daily dollar warning or hard cap. The mode is not a spend limit.
            </p>
            <NativeOwnerLink
              scope="installation-budget"
              className="mt-2 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline"
              href="/settings/safety#budget-mode"
            >
              Review budget preference
            </NativeOwnerLink>
          </Section>

          <Section
            title="More cost detail"
            description="Detailed coverage and per-provider records are on the spend details page."
          >
            <NativeOwnerLink
              className="inline-block text-sm font-medium text-accent underline-offset-2 hover:underline"
              href={detailsHref}
              scope="installation-costs"
            >
              Open spend details
            </NativeOwnerLink>
          </Section>
        </>
      ) : null}
    </section>
  );
}
