import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { StatusChip } from "../native-routes/primitives";
import { DurableBackgroundTaskRail } from "./DurableBackgroundTaskRail";
import { resolveChatRouteReadiness } from "./chat-route-readiness";

export function pluralApprovals(count: number): string {
  return `${count} approval${count === 1 ? " is" : "s are"}`;
}

/**
 * Activity's single approval entry point. Canonical session status is scoped to
 * this chat but only loads on request; until then the shell's pending count is
 * shown for what it is: a workspace-wide figure.
 */
export function UtilityApprovalState({ activeProps }: { activeProps: MissionThreadedActiveSessionSurfaceProps }) {
  const panel = activeProps.sessionStatusPanel;
  const attention = panel?.status?.attention;
  const chatCount = attention?.availability === "available" ? attention.value.pendingApprovals.length : null;
  const reviewCount = chatCount ?? activeProps.approvalsCount;
  const message =
    chatCount !== null
      ? chatCount > 0
        ? `${pluralApprovals(chatCount)} waiting for your review.`
        : "No approval is waiting for this chat."
      : attention?.availability === "unavailable"
        ? `Canonical approval status is unavailable: ${attention.reason}`
        : panel?.error
          ? `Canonical approval status is unavailable: ${panel.error}`
          : panel?.loading
            ? "Checking canonical approval status…"
            : activeProps.approvalsCount > 0
              ? `${pluralApprovals(activeProps.approvalsCount)} waiting in this workspace.`
              : "No approvals are waiting in this workspace.";

  return (
    <section className="mc-next-utility-card" aria-label="Approval state">
      <h4>Approval state</h4>
      <p role="status">{message}</p>
      {reviewCount > 0 ? (
        <button type="button" className="mc-next-panel-button" onClick={() => activeProps.onOpenApprovals()}>
          Review approvals
        </button>
      ) : null}
    </section>
  );
}

export function UtilityBackgroundTasksPanel({
  activeProps,
  onOpenUniversalRunDetail,
  onOpenTasks,
  onSelectSession,
}: {
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  onOpenUniversalRunDetail?: (runId: string) => void;
  onOpenTasks?: () => void;
  onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
}) {
  return (
    <DurableBackgroundTaskRail
      parentRunId={activeProps.selectedTurn?.trace.durable?.runId}
      workspaceId={activeProps.workspaceId}
      sessionId={activeProps.selectedSessionId}
      turnId={activeProps.selectedTurn?.turnId}
      queuedCount={activeProps.queuedCount}
      streamStatus={activeProps.streamStatus}
      queueLabels={activeProps.queueItems.map((item) => item.label)}
      onContinueInBackground={(task) => {
        const parentRunId = activeProps.selectedTurn?.trace.durable?.runId;
        if (parentRunId) {
          activeProps.onContinueExplorerInBackground?.({ parentRunId, watcherId: task.watcherId });
        }
      }}
      onBackgroundTaskSettled={(task) => {
        const parentRunId = activeProps.selectedTurn?.trace.durable?.runId;
        if (
          !parentRunId ||
          !task.delegationRunId ||
          !task.delegationStepId ||
          activeProps.delegationRun?.runId !== task.delegationRunId
        ) {
          return false;
        }
        return (
          activeProps.onBackgroundExplorerSettled?.({
            parentRunId,
            delegationRunId: task.delegationRunId,
            delegationStepId: task.delegationStepId,
            childRunId: task.childRunId,
          }) ?? false
        );
      }}
      onOpenApprovals={activeProps.onOpenApprovals}
      onOpenTasks={onOpenTasks}
      onOpenSemanticLink={(link, relatedLinks) => {
        if (link.kind === "durable_run") {
          onOpenUniversalRunDetail?.(link.id);
          return;
        }
        if (link.kind === "chat_session") {
          onSelectSession(link.id);
          return;
        }
        if (link.kind === "chat_turn") {
          const childSession = relatedLinks.find((candidate) => candidate.kind === "chat_session");
          if (childSession) onSelectSession(childSession.id, { turnId: link.id });
          else activeProps.onOpenRunDetails(link.id);
          return;
        }
        if (link.kind === "approval") activeProps.onOpenApprovals();
        if (link.kind === "task") onOpenTasks?.();
      }}
    />
  );
}

export function UtilityPlanPanel({
  activeProps,
  contextDockProps,
}: {
  activeProps: MissionThreadedActiveSessionSurfaceProps;
  contextDockProps: MissionThreadedRenderSurfaceInput["contextDockProps"];
}) {
  const planningEnabled = activeProps.planningMode === "advisory";
  const route = resolveChatRouteReadiness(activeProps);
  const routeBlocked = route.state === "no_provider" || route.state === "blocked";

  return (
    <section className="mc-next-utility-card">
      <div className="mc-next-utility-chip-row">
        <StatusChip tone={planningEnabled ? "success" : "muted"}>
          {planningEnabled ? "Planning on" : "Planning off"}
        </StatusChip>
        <span className="mc-next-technical-detail">
          <StatusChip tone="muted">{contextDockProps?.routePreflight?.selectionSource ?? "route pending"}</StatusChip>
        </span>
        <StatusChip tone={routeBlocked ? "critical" : activeProps.routeBoundaryAckRequired ? "warning" : "muted"}>
          {routeBlocked
            ? "Sending blocked"
            : activeProps.routeBoundaryAckRequired
              ? "boundary acknowledgement needed"
              : route.state === "checking"
                ? "Checking route"
                : "Route ready"}
        </StatusChip>
      </div>
      <h4>{activeProps.pinnedGoal ?? "Current plan"}</h4>
      <p>{routeBlocked ? route.message : (activeProps.routePreflight?.degradedReason ?? activeProps.summary)}</p>
      <div className="mc-next-utility-actions">
        <button type="button" className="mc-next-panel-button" onClick={activeProps.onTogglePlanningMode}>
          {planningEnabled ? "Turn planning off" : "Turn planning on"}
        </button>
        <button type="button" className="mc-next-panel-button" onClick={activeProps.onReviewRunDetails}>
          Review run details
        </button>
      </div>
    </section>
  );
}
