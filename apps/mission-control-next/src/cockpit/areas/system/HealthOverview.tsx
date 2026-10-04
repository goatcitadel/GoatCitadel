import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useQuery } from "@tanstack/react-query";
import { Archive, Cable, Cpu, Database, Download, Plug, RefreshCw, Server, Waypoints, Workflow, type LucideIcon } from "lucide-react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useDesktopUpdates } from "../../../features/desktop-updates/desktop-update-bridge";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import type { HealthCheck } from "./health-overview";
import { deriveSystemHealthChecks } from "./system-health";
import { backupTrustFromInbox } from "./backup-trust";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { inboxMatchesWorkspace } from "../inbox/inbox-presentation";
import { loadSystemHealthSources } from "./system-health-sources";
import { HealthLocalRuntimeActions } from "./HealthLocalRuntimeActions";

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

function ownerHref(path: string): string {
  const [pathname, fragment] = path.split("#");
  return `${pathname}?shell=classic${fragment ? `#${fragment}` : ""}`;
}

function HealthCard({ check, workspaceId, onRefresh }: { check: HealthCheck; workspaceId: string; onRefresh: () => Promise<unknown> }) {
  const Icon = ICONS[check.id];
  return <article className="rounded-lg border border-line bg-raised p-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-fg"><Icon aria-hidden="true" className="size-4 text-accent" />{check.title}</h3>
      <StatusBadge status={check.status} />
    </div>
    <p className="mt-2 text-sm leading-relaxed text-fg-secondary">{check.detail}</p>
    <ClassicOwnerLink className="mt-3 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline" href={ownerHref(check.inspectPath)} scope={JSON.stringify([workspaceId, check.id])} label={`Review ${check.title.toLowerCase()} in the classic view`} />
    {check.id === "models" ? <HealthLocalRuntimeActions workspaceId={workspaceId} onRefresh={onRefresh} /> : null}
  </article>;
}

export function HealthOverview() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const desktopUpdates = useDesktopUpdates();
  const health = useQuery({ queryKey: queryKeys.health(workspaceId), queryFn: () => loadSystemHealthSources(workspaceId), refetchInterval: 60_000 });
  const inbox = useOperatorInbox(workspaceId);
  const backupTrust = backupTrustFromInbox(!inbox.isError && inboxMatchesWorkspace(inbox.data, workspaceId) ? inbox.data : undefined);
  const sources = health.isError ? undefined : health.data;
  const checks = sources ? deriveSystemHealthChecks(sources, desktopUpdates, backupTrust) : [];
  const problems = checks.filter((item) => item.status.tone === "failed" || item.status.tone === "waiting");
  const unknown = checks.filter((item) => item.status.tone === "neutral" && !item.notSetUp);
  const generatedAt = sources?.summary.state === "current" ? Date.parse(sources.summary.value.generatedAt) : Number.NaN;
  const unavailable = sources ? Object.entries(sources).filter(([, source]) => source.state === "unavailable") : [];

  return <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-semibold text-fg">System</h1>
        <p className="text-sm text-fg-secondary">Owner-reported service status and the evidence each check can support.</p>
        {Number.isFinite(generatedAt) ? <p className="mt-1 text-xs text-fg-muted">Gateway snapshot {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(generatedAt)}</p> : null}
      </div>
      <Button size="sm" onClick={() => void health.refetch()} disabled={health.isFetching}>
        <RefreshCw aria-hidden="true" className="size-4" /> Refresh
      </Button>
    </header>

    {health.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading system health…</p> : null}
    {health.isError ? <EmptyState title="Health unavailable" description={describeApiError(health.error).summary} action={<Button onClick={() => void health.refetch()}>Try again</Button>} /> : null}
    {sources ? <>
      {unavailable.length ? <details className="rounded-md border border-status-waiting/40 p-3 text-sm text-fg-secondary">
        <summary className="cursor-pointer font-medium">{unavailable.length} health {unavailable.length === 1 ? "source is" : "sources are"} unavailable</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">{unavailable.map(([name, source]) => <li key={name}>{name.replaceAll("_", " ")}: {source.state === "unavailable" ? source.detail : "Unknown"}</li>)}</ul>
      </details> : null}
      <section aria-labelledby="system-attention-title" className="rounded-lg border border-line bg-sunken p-4">
        <h2 id="system-attention-title" className="font-display text-lg font-semibold text-fg">Needs attention</h2>
        {problems.length ? <ul className="mt-3 space-y-3">{problems.map((check) => <li key={check.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised p-3">
          <span className="text-sm text-fg"><strong>{check.title}:</strong> {check.detail}</span>
          <ClassicOwnerLink className="text-sm font-medium text-accent underline-offset-2 hover:underline" href={ownerHref(check.inspectPath)} scope={JSON.stringify([workspaceId, check.id])} label={`Review ${check.title.toLowerCase()}`} />
        </li>)}</ul> : <p className="mt-2 text-sm text-fg-secondary">No problem was reported by the available checks{unknown.length ? `; ${unknown.length} ${unknown.length === 1 ? "check lacks" : "checks lack"} live proof` : ""}.</p>}
      </section>

      <section aria-labelledby="system-checks-title">
        <h2 id="system-checks-title" className="mb-3 font-display text-lg font-semibold text-fg">Current checks</h2>
        <div className="grid gap-3 sm:grid-cols-2">{checks.map((check) => <HealthCard key={check.id} check={check} workspaceId={workspaceId} onRefresh={() => health.refetch()} />)}</div>
      </section>
    </> : null}
  </section>;
}
