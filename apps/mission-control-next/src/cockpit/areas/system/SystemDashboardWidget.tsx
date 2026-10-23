import { SystemOwnerLink } from "./SystemOwnerLink";
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
import { MetricList } from "../../ui/MetricList";
import { describeRuntimeService } from "./health-overview";

/** Dashboard widgets are summaries; realtime events refresh their sources, so a minute is enough. */
export const DASHBOARD_REFRESH_MS = 60_000;

interface WidgetFrameProps {
  title: string;
  source: string;
  ownerHref: string;
  /** Names the destination page, never a generic "source". */
  ownerLabel: string;
  scope?: string;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  refresh: () => void;
  children: ReactNode;
}

function WidgetFrame({
  title,
  source,
  ownerHref,
  ownerLabel,
  scope = "installation",
  loading,
  refreshing,
  error,
  refresh,
  children,
}: WidgetFrameProps) {
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <p className="mt-0.5 text-xs text-fg-muted">{source}</p>
        </div>
        <Button size="sm" disabled={refreshing} onClick={refresh}>
          Refresh<span className="sr-only"> {title}</span>
        </Button>
      </div>
      {loading ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          Loading current widget data…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {describeApiError(error).summary}
        </p>
      ) : null}
      {!loading && !error ? <div className="mt-3">{children}</div> : null}
      <SystemOwnerLink
        href={ownerHref}
        scope={scope}
        className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
      >
        {ownerLabel}
      </SystemOwnerLink>
    </section>
  );
}

/** A widget leads with a sentence that says what its numbers count, then the numbers as an inline list. */
function Metrics({ summary, items }: { summary: ReactNode; items: Array<[string, string]> }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm text-fg-secondary">{summary}</p>
      <MetricList items={items.map(([term, value]) => ({ term, value }))} />
    </div>
  );
}

function AgenticRunsWidget({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: ["tasks", "dashboard-agentic", workspaceId],
    queryFn: () => fetchAgenticRuns({ workspaceId, limit: 200 }),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  const runs = query.data?.items ?? [];
  const active = runs.filter((run) =>
    ["queued", "planning", "running", "checkpointing"].includes(run.status ?? ""),
  ).length;
  const attention = runs.filter((run) =>
    ["approval_required", "paused", "blocked", "failed", "stopped_by_limit"].includes(run.status ?? ""),
  ).length;
  return (
    <WidgetFrame
      scope={workspaceId}
      title="Agentic runs"
      source="Workspace agentic runs · first 200"
      ownerHref={`/work?workspaceId=${encodeURIComponent(workspaceId)}`}
      ownerLabel="Open runs in Work"
      loading={query.isLoading}
      refreshing={query.isFetching}
      error={query.error}
      refresh={() => void query.refetch()}
    >
      <Metrics
        summary="Active runs are queued, planning, running or checkpointing. Runs that need review are paused, blocked, failed, stopped by a limit or waiting for approval."
        items={[
          ["Known runs", String(runs.length)],
          ["Active", String(active)],
          ["Needs review", String(attention)],
        ]}
      />
      {query.data?.nextCursor ? <p className="mt-2 text-xs text-fg-muted">More runs exist beyond this page.</p> : null}
    </WidgetFrame>
  );
}

function ApprovalsWidget({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: ["approvals", "dashboard-queue", workspaceId],
    queryFn: () => fetchApprovals({ status: "pending", workspaceId, limit: 200 }),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  const approvals = query.data?.items.filter((approval) => approval.linkage?.workspaceId === workspaceId) ?? [];
  const highRisk = approvals.filter(
    (approval) => approval.riskLevel === "danger" || approval.riskLevel === "nuclear",
  ).length;
  return (
    <WidgetFrame
      scope={workspaceId}
      title="Approval queue"
      source="Workspace-linked pending approvals · first 200"
      ownerHref={`/inbox?view=history&workspaceId=${encodeURIComponent(workspaceId)}`}
      ownerLabel="Open Inbox"
      loading={query.isLoading}
      refreshing={query.isFetching}
      error={query.error}
      refresh={() => void query.refetch()}
    >
      <Metrics
        summary="Pending approvals linked to this workspace, by risk level."
        items={[
          ["Known pending", String(approvals.length)],
          ["High risk", String(highRisk)],
          ["Caution", String(approvals.filter((approval) => approval.riskLevel === "caution").length)],
        ]}
      />
      {query.data?.nextCursor ? (
        <p className="mt-2 text-xs text-fg-muted">More approvals exist beyond this page.</p>
      ) : null}
    </WidgetFrame>
  );
}

function RuntimeWidget() {
  const query = useQuery({
    queryKey: ["system", "dashboard-runtime"],
    queryFn: fetchHealthSummary,
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  const health = query.data;
  const memoryUsed = health?.systemVitals.memoryUsedBytes;
  const memoryTotal = health?.systemVitals.memoryTotalBytes;
  const memory =
    typeof memoryUsed === "number" && typeof memoryTotal === "number" && memoryTotal > 0
      ? `${Math.round((memoryUsed / memoryTotal) * 100)}% used`
      : "Unknown";
  // The same derivation as the Health page, so an unsupported host reads "Unavailable" in both places.
  const service = health ? describeRuntimeService(health.daemonStatus).label : "Unknown";
  return (
    <WidgetFrame
      title="Runtime truth"
      source="Host-wide health"
      ownerHref="/system/diagnostics"
      ownerLabel="Open System › Diagnostics"
      loading={query.isLoading}
      refreshing={query.isFetching}
      error={query.error}
      refresh={() => void query.refetch()}
    >
      <Metrics
        summary="Host-wide status applies beyond the selected workspace."
        items={[
          ["Host", health?.systemVitals.hostname || "Unknown"],
          ["Runtime service", service],
          ["Memory", memory],
        ]}
      />
    </WidgetFrame>
  );
}

function TasksWidget({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: ["tasks", "dashboard-task-status", workspaceId],
    queryFn: () => fetchTasksByView("active", undefined, workspaceId, { limit: 200 }),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  const tasks = query.data?.items ?? [];
  const inFlight = tasks.filter((task) =>
    ["assigned", "in_progress", "testing", "review"].includes(task.status),
  ).length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  return (
    <WidgetFrame
      scope={workspaceId}
      title="Task status"
      source="Workspace active tasks · first 200"
      ownerHref={`/work?workspaceId=${encodeURIComponent(workspaceId)}`}
      ownerLabel="Open tasks in Work"
      loading={query.isLoading}
      refreshing={query.isFetching}
      error={query.error}
      refresh={() => void query.refetch()}
    >
      <Metrics
        summary="Tasks in flight are assigned, in progress, testing or in review."
        items={[
          ["Known tasks", String(tasks.length)],
          ["In flight", String(inFlight)],
          ["Blocked", String(blocked)],
        ]}
      />
      {query.data?.nextCursor ? <p className="mt-2 text-xs text-fg-muted">More tasks exist beyond this page.</p> : null}
    </WidgetFrame>
  );
}

function UsageWidget() {
  const query = useQuery({
    queryKey: ["system", "dashboard-cost", "day"],
    queryFn: () => fetchCostSummary("day"),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  const summary = query.data;
  const projection = summary ? projectUsageCostSummary(summary) : null;
  const coverage = projection ? projection.coverageDescription + " " : "";
  return (
    <WidgetFrame
      title="Usage and cost"
      source="Installation-wide daily usage"
      ownerHref="/system/spend/details"
      ownerLabel="Open spend details"
      loading={query.isLoading}
      refreshing={query.isFetching}
      error={query.error}
      refresh={() => void query.refetch()}
    >
      <Metrics
        summary={`${coverage}This aggregate is not scoped to the selected workspace.`}
        items={[
          ["Recorded tokens", projection?.tokenLabel ?? "Unknown"],
          ["Known cost", projection?.costLabel ?? "Unknown"],
        ]}
      />
    </WidgetFrame>
  );
}

export function SystemDashboardWidget({ kind, workspaceId }: { kind: OpsSavedBoardWidgetKind; workspaceId: string }) {
  switch (kind) {
    case "agentic_run_kanban":
      return <AgenticRunsWidget workspaceId={workspaceId} />;
    case "approval_queue_summary":
      return <ApprovalsWidget workspaceId={workspaceId} />;
    case "runtime_truth_summary":
      return <RuntimeWidget />;
    case "task_status_summary":
      return <TasksWidget workspaceId={workspaceId} />;
    case "usage_cost_summary":
      return <UsageWidget />;
    default:
      return (
        <p role="alert" className="text-sm text-fg">
          This saved widget kind is unavailable in the cockpit.
        </p>
      );
  }
}
