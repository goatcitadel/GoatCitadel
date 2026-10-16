import { SystemOwnerLink } from "./SystemOwnerLink";
import { HealthBackupAction } from "./HealthBackupAction";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/client-core";
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
import { deriveSystemHealthChecks, HEALTH_SOURCE_LABELS } from "./system-health";
import { formatAbsoluteTime } from "@goatcitadel/mission-control-shared/content/format";
import { TimeText } from "../../ui/TimeText";
import { backupTrustFromInbox } from "./backup-trust";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { inboxMatchesWorkspace } from "../inbox/inbox-presentation";
import { loadSystemHealthSources, type SystemHealthSources } from "./system-health-sources";
import { HealthLocalRuntimeActions } from "./HealthLocalRuntimeActions";
import { healthQueryScope } from "../../data/health-query-scope";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Section } from "../../ui/Section";

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

/** Failed, then waiting, then unconfirmed, then not set up, then clear; the derived order breaks ties. */
function severity(check: HealthCheck): number {
  if (check.status.tone === "failed") return 0;
  if (check.status.tone === "waiting") return 1;
  if (check.status.tone === "neutral") return check.notSetUp ? 3 : 2;
  return 4;
}

function sortBySeverity(checks: readonly HealthCheck[]): HealthCheck[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => severity(a.check) - severity(b.check) || a.index - b.index)
    .map(({ check }) => check);
}

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
    <article className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Icon aria-hidden="true" className="size-4 text-fg-muted" />
          {check.title}
        </h3>
        <StatusBadge status={check.status} />
      </div>
      <p className="mt-1 text-sm leading-relaxed text-fg-secondary">{check.detail}</p>
      {check.lastKnown ? <p className="mt-1 text-xs text-fg-muted">{check.lastKnown}</p> : null}
      <SystemOwnerLink
        href={check.id === "remote_workers" ? "/system/runtime/workers" : check.inspectPath}
        scope={[workspaceId, check.id]}
      >
        Review {check.title.toLowerCase()}
      </SystemOwnerLink>
      {check.id === "remote_workers" ? (
        <p className="mt-2 text-xs text-fg-muted">
          The workers page shows worker records, assignments and spending budgets. Enrollment and containment recovery
          keep their existing runtime controls.
        </p>
      ) : null}
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
  const accessRevision = useSyncExternalStore(
    subscribeGatewayAccessChange,
    getGatewayAccessRevision,
    getGatewayAccessRevision,
  );
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
  const { heading } = healthOverviewState(checks);
  const generatedAt = sources?.summary.state === "current" ? Date.parse(sources.summary.value.generatedAt) : Number.NaN;
  const unavailable = sources ? Object.entries(sources).filter(([, source]) => source.state === "unavailable") : [];

  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="System"
        description="Service status as each part of the system reports it, and what each check can confirm."
        actions={
          <Button
            size="sm"
            onClick={() => void health.refetch()}
            disabled={health.isFetching || (health.isError && error.retryable === false)}
          >
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh<span className="sr-only"> system health</span>
          </Button>
        }
      >
        {Number.isFinite(generatedAt) ? (
          <p className="mt-1 text-xs text-fg-muted">
            <TimeText value={generatedAt} prefix="Gateway snapshot" />
          </p>
        ) : null}
        {sources ? <p className="mt-2 text-sm font-medium text-fg">{heading}</p> : null}
      </AreaHeader>

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
                    {HEALTH_SOURCE_LABELS[name as keyof typeof HEALTH_SOURCE_LABELS] ?? "Health source"}:{" "}
                    {source.state === "unavailable" ? source.detail : "Unknown"}
                    {source.state === "unavailable" && source.lastKnown ? (
                      <span className="block text-xs text-fg-muted">
                        Last known: checked{" "}
                        {source.lastKnown.observedAt
                          ? formatAbsoluteTime(source.lastKnown.observedAt)
                          : "at an unknown time"}
                        .
                      </span>
                    ) : null}
                    {source.state === "unavailable" && source.retryable === false
                      ? " This source will be checked again after Gateway access or workspace scope changes; other sources continue refreshing."
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <Section title="Checks" description="Most severe first; checks that could not be confirmed follow problems.">
            <ul className="divide-y divide-line-subtle">
              {sortBySeverity(checks).map((check) => (
                <li key={check.id}>
                  <HealthCard
                    check={check}
                    workspaceId={workspaceId}
                    backupReadAvailable={sources.summary.state === "current" && !health.isFetching}
                    onRefresh={() =>
                      Promise.all([
                        client.invalidateQueries({ queryKey: queryKeys.healthAll() }),
                        client.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
                      ])
                    }
                  />
                </li>
              ))}
            </ul>
          </Section>
        </>
      ) : null}
    </section>
  );
}
