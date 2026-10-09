import { SystemOwnerLink } from "./SystemOwnerLink";
import { HealthBackupAction } from "./HealthBackupAction";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getGatewayAccessRevision, subscribeGatewayAccessChange } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  Archive,
  Cable,
  Cpu,
  Database,
  Download,
  Plug,
  RefreshCw,
  Server,
  Waypoints,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useDesktopUpdates } from "../../../features/desktop-updates/desktop-update-bridge";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import { healthOverviewState, type HealthCheck } from "./health-overview";
import { deriveSystemHealthChecks } from "./system-health";
import { backupTrustFromInbox } from "./backup-trust";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { inboxMatchesWorkspace } from "../inbox/inbox-presentation";
import { loadSystemHealthSources, type SystemHealthSources } from "./system-health-sources";
import { HealthLocalRuntimeActions } from "./HealthLocalRuntimeActions";
import { healthQueryScope } from "../../data/health-query-scope";

const ICONS: Readonly<Record<HealthCheck["id"], LucideIcon>> = {
  gateway: Waypoints,
  database: Database,
  service: Server,
  backups: Archive,
  models: Cpu,
  channels: Cable,
  integrations: Plug,
  updates: Download,
  remote_workers: Workflow,
};

function HealthCard({
  check,
  workspaceId,
  onRefresh,
  backupReadAvailable,
}: {
  check: HealthCheck;
  workspaceId: string;
  onRefresh: () => Promise<unknown>;
  backupReadAvailable: boolean;
}) {
  const Icon = ICONS[check.id];
  return (
    <article className="rounded-lg border border-line bg-raised p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Icon aria-hidden="true" className="size-4 text-accent" />
          {check.title}
        </h3>
        <StatusBadge status={check.status} />
      </div>
      <p className="mt-2 text-sm leading-relaxed text-fg-secondary">{check.detail}</p>
      <SystemOwnerLink href={check.id === "remote_workers" ? "/system/diagnostics" : check.inspectPath} scope={[workspaceId, check.id]}>
        Review {check.title.toLowerCase()}
      </SystemOwnerLink>
      {check.id === "remote_workers" ? <p className="mt-2 text-xs text-fg-muted">Diagnostics show available worker evidence; worker management is not supplied here.</p> : null}
      {check.id === "backups" ? <HealthBackupAction readAvailable={backupReadAvailable} onRefresh={onRefresh} /> : null}
      {check.id === "models" ? <HealthLocalRuntimeActions workspaceId={workspaceId} onRefresh={onRefresh} /> : null}
    </article>
  );
}

export function HealthOverview() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const desktopUpdates = useDesktopUpdates();
  const client = useQueryClient();
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const health = useQuery({
    queryKey: [...queryKeys.health(workspaceId), ...healthQueryScope(client, workspaceId, accessRevision)],
    queryFn: ({ queryKey }) => loadSystemHealthSources(workspaceId, client.getQueryData<SystemHealthSources>(queryKey)),
    refetchInterval: 60_000,
  });
  const inbox = useOperatorInbox(workspaceId);
  const sources = health.isError ? undefined : health.data;
  const backupTrust = backupTrustFromInbox(
    !inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined,
    sources?.summary.state === "current" ? sources.summary.value.backups.latest : undefined,
  );
  const error = describeApiError(health.error);
  const checks = sources ? deriveSystemHealthChecks(sources, desktopUpdates, backupTrust) : [];
  const { problems, unknown, heading } = healthOverviewState(checks);
  const generatedAt = sources?.summary.state === "current" ? Date.parse(sources.summary.value.generatedAt) : Number.NaN;
  const unavailable = sources ? Object.entries(sources).filter(([, source]) => source.state === "unavailable") : [];

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">System</h1>
          <p className="text-sm text-fg-secondary">
            Owner-reported service status and the evidence each check can support.
          </p>
          {Number.isFinite(generatedAt) ? (
            <p className="mt-1 text-xs text-fg-muted">
              Gateway snapshot{" "}
              {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(generatedAt)}
            </p>
          ) : null}
        </div>
        <Button size="sm" onClick={() => void health.refetch()} disabled={health.isFetching || (health.isError && error.retryable === false)}>
          <RefreshCw aria-hidden="true" className="size-4" /> Refresh
        </Button>
      </header>

      {health.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading system health…
        </p>
      ) : null}
      {health.isError ? (
        <EmptyState
          title="Health unavailable"
          description={describeApiError(health.error).summary}
          action={error.retryable === false ? null : <Button onClick={() => void health.refetch()}>Try again</Button>}
        />
      ) : null}
      {sources ? (
        <>
          {unavailable.length ? (
            <details className="rounded-md border border-status-waiting/40 p-3 text-sm text-fg-secondary">
              <summary className="cursor-pointer font-medium">
                {unavailable.length} health {unavailable.length === 1 ? "source is" : "sources are"} unavailable
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {unavailable.map(([name, source]) => (
                  <li key={name}>
                    {name.replaceAll("_", " ")}: {source.state === "unavailable" ? source.detail : "Unknown"}
                    {source.state === "unavailable" && source.lastKnown ? ` Retained observation is stale; last observed ${source.lastKnown.observedAt ? new Date(source.lastKnown.observedAt).toLocaleString() : "at an unavailable time"}.` : ""}
                    {source.state === "unavailable" && source.retryable === false ? " This source will be checked again after Gateway access or workspace scope changes; other sources continue refreshing." : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <section aria-labelledby="system-attention-title" className="rounded-lg border border-line bg-sunken p-4">
            <h2 id="system-attention-title" className="font-display text-lg font-semibold text-fg">
              {heading}
            </h2>
            {problems.length ? (
              <ul className="mt-3 space-y-3">
                {problems.map((check) => (
                  <li
                    key={check.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised p-3"
                  >
                    <span className="text-sm text-fg">
                      <strong>{check.title}:</strong> {check.detail}
                    </span>
                    <SystemOwnerLink href={check.id === "remote_workers" ? "/system/diagnostics" : check.inspectPath} scope={[workspaceId, check.id]}>Review {check.title.toLowerCase()}</SystemOwnerLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-fg-secondary">
                No problem was reported by the available checks
                {unknown.length
                  ? `; ${unknown.length} ${unknown.length === 1 ? "check lacks" : "checks lack"} live proof`
                  : ""}
                .
              </p>
            )}
          </section>

          {unknown.length ? <section aria-label="Checks awaiting evidence" className="rounded-lg border border-line bg-sunken p-4">
            <h2 className="font-display text-lg font-semibold text-fg">Checks awaiting evidence</h2>
            <ul className="mt-3 space-y-2">{unknown.map((check) => <li key={check.id} className="text-sm text-fg-secondary"><strong>{check.title}:</strong> {check.detail}</li>)}</ul>
          </section> : null}

          <section aria-labelledby="system-checks-title">
            <h2 id="system-checks-title" className="mb-3 font-display text-lg font-semibold text-fg">
              Current checks
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {checks.map((check) => (
                <HealthCard key={check.id} check={check} workspaceId={workspaceId} backupReadAvailable={sources.summary.state === "current" && !health.isFetching} onRefresh={() => Promise.all([
                  client.invalidateQueries({ queryKey: queryKeys.healthAll() }),
                  client.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
                ])} />
              ))}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
