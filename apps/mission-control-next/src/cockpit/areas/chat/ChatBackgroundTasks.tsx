import { useState } from "react";
import type { DurableBackgroundTaskItem } from "@goatcitadel/contracts";
import { humanizeToken, presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { useBackgroundTaskSettledRefresh } from "../../../features/threaded-surface/useBackgroundTaskSettledRefresh";
import {
  useDurableBackgroundTaskRail,
  type BackgroundTaskControlReview,
} from "../../../features/threaded-surface/useDurableBackgroundTaskRail";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";

function taskStatus(task: DurableBackgroundTaskItem) {
  if (task.canonicalStatus === "missing" || task.canonicalStatus === "unknown") {
    return { label: humanizeToken(task.canonicalStatus), tone: "waiting" as const };
  }
  return presentRunStatus(task.canonicalStatus, {
    waitingOnOperator: task.blockers.some((item) => item.kind === "approval_required"),
  });
}

export function ChatBackgroundTasks({ input, turnId }: { input: MissionThreadedRenderSurfaceInput; turnId?: string }) {
  const active = input.activeSessionSurfaceProps;
  const turn = active?.thread?.turns.find((item) => item.turnId === turnId) ?? active?.selectedTurn;
  const parentRunId = turn?.trace.durable?.runId;
  const rail = useDurableBackgroundTaskRail({
    parentRunId,
    workspaceId: active?.workspaceId ?? "",
    sessionId: active?.selectedSessionId,
  });
  const [cancelReview, setCancelReview] = useState<{
    task: DurableBackgroundTaskItem;
    review: BackgroundTaskControlReview;
  } | null>(null);
  useBackgroundTaskSettledRefresh(
    rail.snapshot,
    `${parentRunId ?? ""}\u0000${active?.selectedSessionId ?? ""}`,
    (task) => {
      if (
        !active ||
        !parentRunId ||
        !task.delegationRunId ||
        !task.delegationStepId ||
        active.delegationRun?.runId !== task.delegationRunId
      )
        return false;
      return (
        active.onBackgroundExplorerSettled?.({
          parentRunId,
          delegationRunId: task.delegationRunId,
          delegationStepId: task.delegationStepId,
          childRunId: task.childRunId,
        }) ?? false
      );
    },
  );
  if (!active || !parentRunId)
    return <p className="text-sm text-fg-muted">No durable background run is recorded for this turn.</p>;
  const cancelTask = cancelReview?.task;
  const reviewScopeCurrent = Boolean(cancelReview && rail.isReviewCurrent(cancelReview.review));
  const reviewError = rail.controlFailure && rail.controlFailure.review !== cancelReview?.review ? null : rail.error;
  const dismissCancel = () => {
    if (cancelReview) rail.dismissReview(cancelReview.review);
    setCancelReview((current) => (current === cancelReview ? null : current));
  };
  const control = async (
    task: DurableBackgroundTaskItem,
    action: "detach" | "reattach" | "cancel",
    review?: BackgroundTaskControlReview,
  ) => {
    const applied = await rail.control(
      task.watcherId,
      action,
      action === "cancel" ? "Operator cancelled from cockpit Chat" : undefined,
      review,
    );
    if (applied && action === "detach")
      active.onContinueExplorerInBackground?.({ parentRunId, watcherId: task.watcherId });
    if (applied) setCancelReview((current) => (current?.review === review ? null : current));
  };
  return (
    <section aria-label="Background work" className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-fg-secondary">Durable child work attached to this turn.</p>
        <Button size="sm" onClick={() => void rail.refresh()} disabled={rail.refreshing}>
          Refresh
        </Button>
      </div>
      {rail.loading && !rail.snapshot ? (
        <p role="status" className="text-fg-muted">
          Loading background work…
        </p>
      ) : null}
      {rail.error ? (
        <p role="alert" className="rounded-md border border-status-failed p-2 text-fg-secondary">
          {rail.error}
        </p>
      ) : null}
      {rail.snapshot ? (
        <>
          {rail.snapshot.tasks.length ? (
            <ol className="space-y-2">
              {rail.snapshot.tasks.map((task) => (
                <li key={task.watcherId} className="rounded-md border border-line bg-raised p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-medium text-fg">{task.label}</h3>
                      <p className="text-xs text-fg-muted">
                        {task.role ?? "Delegated child"} · {humanizeToken(task.attention.state)}
                      </p>
                    </div>
                    <StatusBadge status={taskStatus(task)} />
                  </div>
                  {task.blockers.length ? (
                    <ul className="mt-2 space-y-1 text-status-waiting">
                      {task.blockers.map((blocker, index) => (
                        <li key={`${blocker.kind}-${index}`}>{blocker.message}</li>
                      ))}
                    </ul>
                  ) : null}
                  {task.output.availability === "available" ? (
                    <p className="mt-2 text-fg-secondary">{task.output.summary}</p>
                  ) : null}
                  {!task.toolCoverage.complete ? (
                    <p className="mt-2 text-xs text-fg-muted">
                      Tool history is incomplete after {task.toolCoverage.observedCount} records.
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    <NativeOwnerLink
                      href={`/work/runs/${encodeURIComponent(task.childRunId)}?shell=cockpit`}
                      scope={[
                        active.workspaceId,
                        active.selectedSessionId,
                        parentRunId,
                        task.watcherId,
                        task.childRunId,
                      ]}
                      className="font-medium text-accent hover:underline"
                    >
                      Open run evidence
                    </NativeOwnerLink>
                    {task.controls.detach.enabled ? (
                      <button
                        type="button"
                        disabled={rail.pendingWatcherId === task.watcherId}
                        onClick={() => void control(task, "detach")}
                        className="font-medium text-accent hover:underline disabled:opacity-50"
                      >
                        Continue in background
                      </button>
                    ) : null}
                    {task.controls.reattach.enabled ? (
                      <button
                        type="button"
                        disabled={rail.pendingWatcherId === task.watcherId}
                        onClick={() => void control(task, "reattach")}
                        className="font-medium text-accent hover:underline disabled:opacity-50"
                      >
                        Bring to foreground
                      </button>
                    ) : null}
                    {task.controls.cancel.enabled ? (
                      <button
                        type="button"
                        disabled={rail.pendingWatcherId === task.watcherId}
                        onClick={() => {
                          const review = rail.review(task.watcherId);
                          if (review) setCancelReview({ task, review });
                        }}
                        className="font-medium text-status-failed hover:underline disabled:opacity-50"
                      >
                        Cancel child
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-fg-muted">No durable child runs are attached to this turn.</p>
          )}
          {rail.snapshot.synthesis.summary ? (
            <p className="rounded-md border border-line p-3 text-fg-secondary">
              Parent synthesis: {rail.snapshot.synthesis.summary}
            </p>
          ) : null}
          {!rail.snapshot.coverage.watchers.complete || !rail.snapshot.coverage.parentSignals.complete ? (
            <p className="text-xs text-fg-muted">Background work coverage is incomplete; more records may exist.</p>
          ) : null}
          {rail.snapshot.unknowns.length ? (
            <p className="text-xs text-fg-muted">
              {rail.snapshot.unknowns.length} runtime unknown{rail.snapshot.unknowns.length === 1 ? "" : "s"} remain.
              Open the classic view for full diagnostics.
            </p>
          ) : null}
        </>
      ) : null}
      <Dialog
        open={Boolean(cancelTask && reviewScopeCurrent)}
        onOpenChange={(open) => {
          if (!open) dismissCancel();
        }}
        title="Cancel this child run?"
        description="Completed work stays in its evidence record. The live executor must honor the cancellation."
      >
        <p className="mb-3 break-words text-sm text-fg-secondary">
          {cancelTask?.label} · Child version {cancelReview?.review.childVersion ?? "unavailable"} · Watcher revision{" "}
          {cancelReview?.review.watcherRevision}
        </p>
        {reviewError ? (
          <p role="alert" className="mb-3 rounded-md border border-status-failed p-2 text-sm text-fg-secondary">
            {reviewError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={dismissCancel}>Keep running</Button>
          <Button
            disabled={
              !cancelReview ||
              !reviewScopeCurrent ||
              rail.controlFailure?.review === cancelReview.review ||
              rail.pendingWatcherId === cancelTask?.watcherId
            }
            onClick={() => {
              if (cancelReview) void control(cancelReview.task, "cancel", cancelReview.review);
            }}
          >
            Cancel child
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
