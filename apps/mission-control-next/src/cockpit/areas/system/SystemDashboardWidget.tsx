import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OpsSavedBoardWidgetKind } from "@goatcitadel/contracts";
import { fetchAgenticRuns } from "@goatcitadel/mission-control-shared/api/agentic";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchCostSummary, fetchHealthSummary } from "@goatcitadel/mission-control-shared/api/system";
import { fetchTasksByView } from "@goatcitadel/mission-control-shared/api/tasks";
import { projectUsageCostSummary } from "@goatcitadel/mission-control-shared/content/cost-summary";
import { Button } from "../../ui/Button";

interface WidgetFrameProps {
  title: string;
  source: string;
  ownerHref: string;
  scope?: string;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  refresh: () => void;
  children: ReactNode;
}

function WidgetFrame({ title, source, ownerHref, scope = "installation", loading, refreshing, error, refresh, children }: WidgetFrameProps) {
  return <section aria-label={title} className="min-w-0 rounded-lg border border-line bg-raised p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="font-display text-sm font-semibold text-fg">{title}</h3><p className="mt-0.5 text-xs text-fg-muted">{source}</p></div>
      <Button size="sm" disabled={refreshing} onClick={refresh}>Refresh</Button>
    </div>
    {loading ? <p role="status" className="mt-3 text-sm text-fg-muted">Loading current widget data…</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-status-failed">{describeApiError(error).summary}</p> : null}
    {!loading && !error ? <div className="mt-3">{children}</div> : null}
    <ClassicOwnerLink href={ownerHref} scope={scope} className="mt-3 inline-block text-sm font-medium text-accent hover:underline" label="Open source controls" />
  </section>;
}

function Metrics({ items }: { items: Array<[string, string]> }) {
  return <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">{items.map(([label, value]) => <div key={label} className="rounded-md border border-line-subtle bg-sunken p-2">
    <dt className="text-xs text-fg-muted">{label}</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-fg">{value}</dd>
  </div>)}</dl>;
}

function AgenticRunsWidget({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({ queryKey: ["tasks", "dashboard-agentic", workspaceId], queryFn: () => fetchAgenticRuns({ workspaceId, limit: 200 }), refetchInterval: 30_000 });
  const runs = query.data?.items ?? [];
  const active = runs.filter((run) => ["queued", "planning", "running", "checkpointing"].includes(run.status ?? "")).length;
  const attention = runs.filter((run) => ["approval_required", "paused", "blocked", "failed", "stopped_by_limit"].includes(run.status ?? "")).length;
  return <WidgetFrame scope={workspaceId} title="Agentic runs" source="Workspace agentic runs · first 200" ownerHref="/ops/kanban?shell=classic"
    loading={query.isLoading} refreshing={query.isFetching} error={query.error} refresh={() => void query.refetch()}>
    <Metrics items={[["Known runs", String(runs.length)], ["Active", String(active)], ["Needs review", String(attention)]]} />
    {query.data?.nextCursor ? <p className="mt-2 text-xs text-fg-muted">More runs exist beyond this page.</p> : null}
  </WidgetFrame>;
}

function ApprovalsWidget({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({ queryKey: ["approvals", "dashboard-queue", workspaceId],
    queryFn: () => fetchApprovals({ status: "pending", workspaceId, limit: 200 }), refetchInterval: 30_000 });
  const approvals = query.data?.items.filter((approval) => approval.linkage?.workspaceId === workspaceId) ?? [];
  const highRisk = approvals.filter((approval) => approval.riskLevel === "danger" || approval.riskLevel === "nuclear").length;
  return <WidgetFrame scope={workspaceId} title="Approval queue" source="Workspace-linked pending approvals · first 200" ownerHref="/ops/approvals?shell=classic"
    loading={query.isLoading} refreshing={query.isFetching} error={query.error} refresh={() => void query.refetch()}>
    <Metrics items={[["Known pending", String(approvals.length)], ["High risk", String(highRisk)], ["Caution", String(approvals.filter((approval) => approval.riskLevel === "caution").length)]]} />
    {query.data?.nextCursor ? <p className="mt-2 text-xs text-fg-muted">More approvals exist beyond this page.</p> : null}
  </WidgetFrame>;
}

function RuntimeWidget() {
  const query = useQuery({ queryKey: ["system", "dashboard-runtime"], queryFn: fetchHealthSummary, refetchInterval: 30_000 });
  const health = query.data;
  const memoryUsed = health?.systemVitals.memoryUsedBytes;
  const memoryTotal = health?.systemVitals.memoryTotalBytes;
  const memory = typeof memoryUsed === "number" && typeof memoryTotal === "number" && memoryTotal > 0
    ? `${Math.round((memoryUsed / memoryTotal) * 100)}% used` : "Unknown";
  const daemon = health ? health.daemonStatus.running ? "Running" : "Stopped" : "Unknown";
  return <WidgetFrame title="Runtime truth" source="Gateway host-wide health snapshot" ownerHref="/ops/runtime?shell=classic"
    loading={query.isLoading} refreshing={query.isFetching} error={query.error} refresh={() => void query.refetch()}>
    <Metrics items={[["Gateway host", health?.systemVitals.hostname || "Unknown"], ["Daemon", daemon], ["Memory", memory]]} />
    <p className="mt-2 text-xs text-fg-muted">Host-wide status applies beyond the selected workspace.</p>
  </WidgetFrame>;
}

function TasksWidget({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({ queryKey: ["tasks", "dashboard-task-status", workspaceId],
    queryFn: () => fetchTasksByView("active", undefined, workspaceId, { limit: 200 }), refetchInterval: 30_000 });
  const tasks = query.data?.items ?? [];
  const inFlight = tasks.filter((task) => ["assigned", "in_progress", "testing", "review"].includes(task.status)).length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  return <WidgetFrame scope={workspaceId} title="Task status" source="Workspace active tasks · first 200" ownerHref="/ops/kanban?shell=classic"
    loading={query.isLoading} refreshing={query.isFetching} error={query.error} refresh={() => void query.refetch()}>
    <Metrics items={[["Known tasks", String(tasks.length)], ["In flight", String(inFlight)], ["Blocked", String(blocked)]]} />
    {query.data?.nextCursor ? <p className="mt-2 text-xs text-fg-muted">More tasks exist beyond this page.</p> : null}
  </WidgetFrame>;
}

function UsageWidget() {
  const query = useQuery({ queryKey: ["system", "dashboard-cost", "day"], queryFn: () => fetchCostSummary("day"), refetchInterval: 60_000 });
  const summary = query.data;
  const projection = summary ? projectUsageCostSummary(summary) : null;
  return <WidgetFrame title="Usage and cost" source="Gateway-wide day-scope usage" ownerHref="/ops/costs?shell=classic"
    loading={query.isLoading} refreshing={query.isFetching} error={query.error} refresh={() => void query.refetch()}>
    <Metrics items={[["Recorded tokens", projection ? new Intl.NumberFormat().format(projection.tokens) : "Unknown"],
      ["Known cost", projection?.costLabel ?? "Unknown"], ["Groups", summary ? String(summary.items.length) : "Unknown"]]} />
    {projection ? <p className="mt-2 text-xs text-fg-muted">{projection.coverageDescription}</p> : null}
    <p className="mt-1 text-xs text-fg-muted">This aggregate is not scoped to the selected workspace.</p>
  </WidgetFrame>;
}

export function SystemDashboardWidget({ kind, workspaceId }: { kind: OpsSavedBoardWidgetKind; workspaceId: string }) {
  switch (kind) {
    case "agentic_run_kanban": return <AgenticRunsWidget workspaceId={workspaceId} />;
    case "approval_queue_summary": return <ApprovalsWidget workspaceId={workspaceId} />;
    case "runtime_truth_summary": return <RuntimeWidget />;
    case "task_status_summary": return <TasksWidget workspaceId={workspaceId} />;
    case "usage_cost_summary": return <UsageWidget />;
    default: return <p role="alert" className="rounded-lg border border-line p-4 text-sm text-fg">This saved widget kind is unavailable in the cockpit.</p>;
  }
}
