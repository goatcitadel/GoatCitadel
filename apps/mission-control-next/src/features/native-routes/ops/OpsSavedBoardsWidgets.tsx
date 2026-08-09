import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsSavedBoardPlacement } from "@goatcitadel/contracts";
import { fetchAgenticRuns } from "@goatcitadel/mission-control-shared/api/agentic";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import { fetchCostSummary, fetchHealthSummary } from "@goatcitadel/mission-control-shared/api/system";
import { fetchTasksByView } from "@goatcitadel/mission-control-shared/api/tasks";
import type { AppRoute } from "@next/app/route-model";
import { NativeButton } from "../primitives";
import type { NativeRoutePagesProps } from "../types";

interface OpsSavedBoardsWidgetProps {
  placement: OpsSavedBoardPlacement;
  workspaceId: string;
  boardGeneration: number;
  theme?: string;
  navigate: NativeRoutePagesProps["navigate"];
}

type WidgetLoadState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: null; error: string };

export function OpsSavedBoardsWidget(props: OpsSavedBoardsWidgetProps) {
  switch (props.placement.kind) {
    case "agentic_run_kanban":
      return <AgenticRunKanbanWidget {...props} />;
    case "approval_queue_summary":
      return <ApprovalQueueSummaryWidget {...props} />;
    case "runtime_truth_summary":
      return <RuntimeTruthSummaryWidget {...props} />;
    case "task_status_summary":
      return <TaskStatusSummaryWidget {...props} />;
    case "usage_cost_summary":
      return <UsageCostSummaryWidget {...props} />;
    default:
      return (
        <WidgetChrome
          label="Unsupported widget"
          sourceLabel="Blocked"
          sourceRoute={{ area: "ops", section: "boards", theme: props.theme }}
          navigate={props.navigate}
        >
          <p className="mc-next-ops-board-widget-empty" role="alert">
            This saved placement is not in the trusted built-in widget registry.
          </p>
        </WidgetChrome>
      );
  }
}

function AgenticRunKanbanWidget(props: OpsSavedBoardsWidgetProps) {
  const load = useWidgetData(
    props.workspaceId,
    props.boardGeneration,
    async () => (await fetchAgenticRuns({ workspaceId: props.workspaceId, limit: 200 })).items,
  );
  const runs = load.state.status === "ready" ? load.state.data : [];
  const active = runs.filter((run) =>
    ["queued", "planning", "running", "checkpointing"].includes(run.status ?? ""),
  ).length;
  const attention = runs.filter((run) =>
    ["approval_required", "paused", "blocked", "failed", "stopped_by_limit"].includes(run.status ?? ""),
  ).length;
  return (
    <WidgetChrome
      label="Agentic run Kanban"
      sourceLabel="Canonical agentic runs"
      sourceRoute={{ area: "ops", section: "kanban", theme: props.theme }}
      navigate={props.navigate}
      state={load.state}
      onRetry={load.retry}
    >
      {runs.length === 0 ? (
        <WidgetEmpty>No agentic runs are active in this workspace.</WidgetEmpty>
      ) : (
        <>
          <WidgetMetrics
            items={[
              ["Runs", String(runs.length)],
              ["Active", String(active)],
              ["Attention", String(attention)],
            ]}
          />
          <WidgetSignalList items={runs.slice(0, 3).map((run) => `${run.title} · ${run.status ?? run.taskStatus}`)} />
        </>
      )}
    </WidgetChrome>
  );
}

function ApprovalQueueSummaryWidget(props: OpsSavedBoardsWidgetProps) {
  const load = useWidgetData(props.workspaceId, props.boardGeneration, async () => {
    const response = await fetchApprovals({ status: "pending", limit: 200 });
    return response.items.filter((approval) => approval.linkage?.workspaceId === props.workspaceId);
  });
  const approvals = load.state.status === "ready" ? load.state.data : [];
  const highRisk = approvals.filter((approval) => approval.riskLevel === "danger" || approval.riskLevel === "nuclear");
  return (
    <WidgetChrome
      label="Approval queue"
      sourceLabel="Canonical approvals"
      sourceRoute={{ area: "ops", section: "approvals", theme: props.theme }}
      navigate={props.navigate}
      state={load.state}
      onRetry={load.retry}
    >
      {approvals.length === 0 ? (
        <WidgetEmpty>No pending approvals are linked to this workspace.</WidgetEmpty>
      ) : (
        <>
          <WidgetMetrics
            items={[
              ["Pending", String(approvals.length)],
              ["High risk", String(highRisk.length)],
              ["Caution", String(approvals.filter((approval) => approval.riskLevel === "caution").length)],
            ]}
          />
          <WidgetSignalList
            items={approvals.slice(0, 3).map((approval) => `${approval.kind} · ${approval.riskLevel}`)}
          />
        </>
      )}
    </WidgetChrome>
  );
}

function RuntimeTruthSummaryWidget(props: OpsSavedBoardsWidgetProps) {
  const load = useWidgetData(props.workspaceId, props.boardGeneration, fetchHealthSummary);
  const health = load.state.status === "ready" ? load.state.data : null;
  const memoryPercent = health
    ? Math.round((health.systemVitals.memoryUsedBytes / Math.max(1, health.systemVitals.memoryTotalBytes)) * 100)
    : 0;
  return (
    <WidgetChrome
      label="Runtime truth"
      sourceLabel="Canonical host truth"
      sourceRoute={{ area: "ops", section: "runtime", theme: props.theme }}
      navigate={props.navigate}
      state={load.state}
      onRetry={load.retry}
    >
      {health ? (
        <>
          <WidgetMetrics
            items={[
              ["Gateway host", health.systemVitals.hostname],
              ["Daemon", health.daemonStatus.running ? "Running" : "Stopped"],
              ["Memory", `${memoryPercent}% used`],
            ]}
          />
          <p className="mc-next-ops-board-widget-note">
            Host-wide canonical truth shown in the context of the active workspace.
          </p>
        </>
      ) : null}
    </WidgetChrome>
  );
}

function TaskStatusSummaryWidget(props: OpsSavedBoardsWidgetProps) {
  const load = useWidgetData(
    props.workspaceId,
    props.boardGeneration,
    async () => (await fetchTasksByView("active", undefined, props.workspaceId, { limit: 200 })).items,
  );
  const tasks = load.state.status === "ready" ? load.state.data : [];
  const inFlight = tasks.filter((task) => ["assigned", "in_progress", "testing", "review"].includes(task.status));
  const blocked = tasks.filter((task) => task.status === "blocked");
  return (
    <WidgetChrome
      label="Task status"
      sourceLabel="Canonical task lifecycle"
      sourceRoute={{ area: "ops", section: "kanban", theme: props.theme }}
      navigate={props.navigate}
      state={load.state}
      onRetry={load.retry}
    >
      {tasks.length === 0 ? (
        <WidgetEmpty>No active tasks are recorded for this workspace.</WidgetEmpty>
      ) : (
        <>
          <WidgetMetrics
            items={[
              ["Tasks", String(tasks.length)],
              ["In flight", String(inFlight.length)],
              ["Blocked", String(blocked.length)],
            ]}
          />
          <WidgetSignalList items={tasks.slice(0, 3).map((task) => `${task.title} · ${task.status}`)} />
        </>
      )}
    </WidgetChrome>
  );
}

function UsageCostSummaryWidget(props: OpsSavedBoardsWidgetProps) {
  const load = useWidgetData(props.workspaceId, props.boardGeneration, async () => fetchCostSummary("day"));
  const summary = load.state.status === "ready" ? load.state.data : null;
  const projection = summary ? projectUsageCostSummary(summary) : null;
  return (
    <WidgetChrome
      label="Usage and cost"
      sourceLabel="Canonical Gateway aggregate"
      sourceRoute={{ area: "ops", section: "costs", theme: props.theme }}
      navigate={props.navigate}
      state={load.state}
      onRetry={load.retry}
    >
      {!summary || summary.items.length === 0 ? (
        <WidgetEmpty>No day-scope usage has been recorded.</WidgetEmpty>
      ) : (
        <>
          <WidgetMetrics
            items={[
              ["Tokens", formatCompactNumber(projection?.tokens ?? 0)],
              ["Cost", projection?.costLabel ?? "Unknown"],
              ["Sources", String(summary.items.length)],
            ]}
          />
          <p className="mc-next-ops-board-widget-note">{projection?.coverageDescription}</p>
        </>
      )}
    </WidgetChrome>
  );
}

export function projectUsageCostSummary(summary: Awaited<ReturnType<typeof fetchCostSummary>>): {
  tokens: number;
  costLabel: string;
  coverageDescription: string;
} {
  const totals = summary.items.reduce(
    (result, item) => ({
      tokens: result.tokens + (Number.isFinite(item.tokenTotal) && item.tokenTotal >= 0 ? item.tokenTotal : 0),
      costUsd: result.costUsd + (Number.isFinite(item.costUsd) && item.costUsd >= 0 ? item.costUsd : 0),
    }),
    { tokens: 0, costUsd: 0 },
  );
  const canonicalCoverage = summary.usageAvailability?.metricAvailability?.costUsd;
  const itemCoverage = summary.items.map((item) => item.metricAvailability?.costUsdComplete);
  const complete =
    canonicalCoverage?.complete ??
    (itemCoverage.some((value) => value === false)
      ? false
      : itemCoverage.length > 0 && itemCoverage.every((value) => value === true)
        ? true
        : undefined);

  if (complete === true) {
    return {
      tokens: totals.tokens,
      costLabel: formatCurrency(totals.costUsd),
      coverageDescription: "Gateway day scope with complete cost coverage; open Costs for provider attribution.",
    };
  }

  const knownCostLabel = totals.costUsd > 0 ? `${formatCurrency(totals.costUsd)}+` : "Unknown";
  if (complete === false) {
    const unknownAttempts = canonicalCoverage?.unknownAttemptCount;
    return {
      tokens: totals.tokens,
      costLabel: knownCostLabel,
      coverageDescription:
        unknownAttempts && unknownAttempts > 0
          ? `Known spend is a lower bound because ${unknownAttempts} provider ${unknownAttempts === 1 ? "attempt has" : "attempts have"} unknown cost.`
          : "Known spend is a lower bound because cost coverage is incomplete; open Costs for evidence.",
    };
  }

  return {
    tokens: totals.tokens,
    costLabel: knownCostLabel,
    coverageDescription: "Cost coverage was not reported, so this widget does not claim an exact total.",
  };
}

function WidgetChrome({
  label,
  sourceLabel,
  sourceRoute,
  navigate,
  state,
  onRetry,
  children,
}: {
  label: string;
  sourceLabel: string;
  sourceRoute: AppRoute;
  navigate: NativeRoutePagesProps["navigate"];
  state?: WidgetLoadState<unknown>;
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <article className="mc-next-ops-board-widget" aria-label={label} aria-busy={state?.status === "loading"}>
      <header className="mc-next-ops-board-widget-header">
        <div>
          <span className="mc-next-ops-board-widget-kicker">Projected summary</span>
          <h3>{label}</h3>
        </div>
        <span className="mc-next-ops-board-widget-source">{sourceLabel}</span>
      </header>
      <div className="mc-next-ops-board-widget-body" aria-live="polite">
        {state?.status === "loading" ? (
          <p className="mc-next-ops-board-widget-empty">Loading this source…</p>
        ) : state?.status === "error" ? (
          <div className="mc-next-ops-board-widget-error" role="alert">
            <p>{state.error}</p>
            {onRetry ? (
              <NativeButton variant="outline" onClick={onRetry}>
                Retry source
              </NativeButton>
            ) : null}
          </div>
        ) : (
          children
        )}
      </div>
      <footer className="mc-next-ops-board-widget-footer">
        <NativeButton variant="ghost" onClick={() => navigate(sourceRoute)}>
          Open source
        </NativeButton>
      </footer>
    </article>
  );
}

function WidgetMetrics({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="mc-next-ops-board-widget-metrics">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WidgetSignalList({ items }: { items: string[] }) {
  return (
    <ul className="mc-next-ops-board-widget-signals">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function WidgetEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="mc-next-ops-board-widget-empty" role="status">
      {children}
    </p>
  );
}

function useWidgetData<T>(workspaceId: string, boardGeneration: number, loader: () => Promise<T>) {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const requestRef = useRef(0);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<WidgetLoadState<T>>({ status: "loading", data: null, error: null });

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    let active = true;
    setState({ status: "loading", data: null, error: null });
    void loaderRef
      .current()
      .then((data) => {
        if (active && requestRef.current === requestId) setState({ status: "ready", data, error: null });
      })
      .catch((error: unknown) => {
        if (active && requestRef.current === requestId) {
          setState({
            status: "error",
            data: null,
            error: error instanceof Error ? error.message : "This canonical source could not be loaded.",
          });
        }
      });
    return () => {
      active = false;
      requestRef.current += 1;
    };
  }, [boardGeneration, retryGeneration, workspaceId]);

  return { state, retry: () => setRetryGeneration((generation) => generation + 1) };
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}
