import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, Unplug } from "lucide-react";
import type {
  DurableBackgroundTaskControlAction,
  DurableBackgroundTaskItem,
  DurableBackgroundTaskRailResponse,
  DurableBackgroundTaskSemanticLink,
} from "@goatcitadel/contracts";
import { useDurableBackgroundTaskRail } from "./useDurableBackgroundTaskRail";
import { RemoteWorkerInlineActivity } from "./RemoteWorkerInlineActivity";

export interface DurableBackgroundTaskRailProps {
  parentRunId?: string;
  workspaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  queuedCount: number;
  streamStatus: string;
  queueLabels: string[];
  onOpenApprovals?: () => void;
  onOpenTasks?: () => void;
  onOpenSemanticLink?: (
    link: DurableBackgroundTaskSemanticLink,
    relatedLinks: DurableBackgroundTaskSemanticLink[],
  ) => void;
}

export function DurableBackgroundTaskRail(props: DurableBackgroundTaskRailProps) {
  const rail = useDurableBackgroundTaskRail(props);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  if (!props.parentRunId || !props.sessionId) {
    return <FallbackQueueState {...props} />;
  }

  return (
    <section
      className="mc-next-background-rail"
      aria-labelledby="background-task-rail-title"
      aria-busy={rail.loading || rail.refreshing}
    >
      <header className="mc-next-background-rail__header">
        <div>
          <p className="mc-next-panel-kicker">Durable child execution</p>
          <h4 id="background-task-rail-title">Background work</h4>
        </div>
        <button
          type="button"
          className="mc-next-background-rail__icon-button"
          onClick={() => void rail.refresh()}
          disabled={rail.refreshing}
          aria-label="Refresh background tasks"
        >
          <RefreshCw size={15} aria-hidden="true" className={rail.refreshing ? "spinning" : undefined} />
        </button>
      </header>

      <div className="mc-next-background-rail__summary" aria-live="polite" aria-atomic="true">
        <span>{rail.snapshot?.tasks.length ?? 0} durable tasks</span>
        <span>{rail.snapshot?.tasks.filter((task) => task.blockers.length > 0).length ?? 0} blocked</span>
        <span>{rail.snapshot?.parent.status ?? props.streamStatus}</span>
      </div>

      {rail.error ? (
        <div className="mc-next-background-rail__notice danger" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{rail.error}</span>
        </div>
      ) : null}
      {rail.loading && !rail.snapshot ? (
        <p className="mc-next-background-rail__notice" role="status">
          Loading durable child state…
        </p>
      ) : null}
      {!rail.loading && rail.snapshot?.tasks.length === 0 ? (
        <div className="mc-next-background-rail__empty">
          <CheckCircle2 size={18} aria-hidden="true" />
          <p>No durable child runs are attached to this turn.</p>
        </div>
      ) : null}

      <div className="mc-next-background-rail__tasks">
        {rail.snapshot?.tasks.map((task) => (
          <BackgroundTaskCard
            key={task.watcherId}
            task={task}
            pending={rail.pendingWatcherId === task.watcherId}
            confirmCancel={confirmCancelId === task.watcherId}
            onRequestCancel={() => setConfirmCancelId(task.watcherId)}
            onDismissCancel={() => setConfirmCancelId(null)}
            onControl={async (action) => {
              const applied = await rail.control(
                task.watcherId,
                action,
                action === "cancel" ? "Operator cancelled from Chat" : undefined,
              );
              if (applied) setConfirmCancelId(null);
            }}
            onOpenApprovals={props.onOpenApprovals}
            onOpenSemanticLink={props.onOpenSemanticLink}
          />
        ))}
      </div>

      <RemoteWorkerInlineActivity workspaceId={props.workspaceId} sessionId={props.sessionId} turnId={props.turnId} />

      {rail.snapshot ? <SynthesisLineage snapshot={rail.snapshot} /> : null}
      {rail.snapshot?.unknowns.length ? (
        <details className="mc-next-background-rail__unknowns">
          <summary>{rail.snapshot.unknowns.length} runtime unknowns</summary>
          <ul>
            {rail.snapshot.unknowns.map((unknown) => (
              <li key={unknown}>{unknown}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {props.onOpenTasks ? (
        <button type="button" className="mc-next-panel-button" onClick={props.onOpenTasks}>
          Open task board
        </button>
      ) : null}
    </section>
  );
}

function BackgroundTaskCard({
  task,
  pending,
  confirmCancel,
  onRequestCancel,
  onDismissCancel,
  onControl,
  onOpenApprovals,
  onOpenSemanticLink,
}: {
  task: DurableBackgroundTaskItem;
  pending: boolean;
  confirmCancel: boolean;
  onRequestCancel: () => void;
  onDismissCancel: () => void;
  onControl: (action: DurableBackgroundTaskControlAction) => Promise<void>;
  onOpenApprovals?: () => void;
  onOpenSemanticLink?: DurableBackgroundTaskRailProps["onOpenSemanticLink"];
}) {
  const statusTone = statusClass(task.canonicalStatus);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const keepRunningButtonRef = useRef<HTMLButtonElement | null>(null);
  const hadOpenConfirmation = useRef(false);
  const confirmationDescriptionId = useId();
  useEffect(() => {
    if (confirmCancel) {
      hadOpenConfirmation.current = true;
      keepRunningButtonRef.current?.focus();
    } else if (hadOpenConfirmation.current) {
      hadOpenConfirmation.current = false;
      cancelButtonRef.current?.focus();
    }
  }, [confirmCancel]);
  return (
    <article className="mc-next-background-task" data-status={task.canonicalStatus}>
      <div className="mc-next-background-task__title-row">
        <div>
          <h5>{task.label}</h5>
          <p>
            {task.role ?? "Delegated child"} · {shortId(task.childRunId)}
          </p>
        </div>
        <span className={`mc-next-background-task__status ${statusTone}`}>{formatStatus(task.canonicalStatus)}</span>
      </div>

      <div className="mc-next-background-task__facts">
        <span>
          {task.watcherState === "detached" ? <Unplug size={13} /> : <Link2 size={13} />} {task.watcherState}
        </span>
        <span>{task.workerHealth ?? "worker unknown"}</span>
        {task.recoveryState && task.recoveryState !== "none" ? <span>{task.recoveryState}</span> : null}
      </div>

      {task.tools.length > 0 ? (
        <section className="mc-next-background-task__section" aria-label="Live tool execution">
          <h6>Tool execution</h6>
          <ul>
            {task.tools.map((tool) => (
              <li key={tool.toolRunId}>
                <span>{tool.toolName}</span>
                <strong>{formatStatus(tool.status)}</strong>
                {tool.error ? <small>{tool.error}</small> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {task.approvals.length > 0 ? (
        <section className="mc-next-background-task__section" aria-label="Approvals">
          <h6>Approvals</h6>
          {task.approvals.map((approval) => (
            <button
              type="button"
              className="mc-next-background-task__approval"
              key={approval.approvalId}
              onClick={onOpenApprovals}
              disabled={!onOpenApprovals}
            >
              <span>{approval.status}</span>
              <small>
                {approval.riskLevel ?? "risk unknown"} · {shortId(approval.approvalId)}
              </small>
            </button>
          ))}
        </section>
      ) : null}

      {task.blockers.length > 0 ? (
        <div className="mc-next-background-task__blockers" role="status">
          {task.blockers.map((blocker, index) => (
            <p key={`${blocker.kind}-${index}`}>
              <AlertTriangle size={13} aria-hidden="true" /> {blocker.message}
            </p>
          ))}
        </div>
      ) : null}

      <section className="mc-next-background-task__section">
        <h6>Terminal output</h6>
        {task.output.availability === "available" ? (
          <>
            <p className="mc-next-background-task__output">{task.output.summary}</p>
            <small>
              {task.output.byteCount} bytes · sha256 {task.output.sha256?.slice(0, 12)}…
            </small>
          </>
        ) : (
          <p className="mc-next-background-task__muted">{outputAvailabilityCopy(task.output.availability)}</p>
        )}
      </section>

      {task.signalIntegrity.posture === "degraded" ? (
        <p className="mc-next-background-task__integrity">
          Signal integrity degraded: {task.signalIntegrity.duplicateCount} duplicate,{" "}
          {task.signalIntegrity.outOfOrderCount} out of order, {task.signalIntegrity.conflictingSequenceCount}{" "}
          conflicting.
        </p>
      ) : null}

      {!task.toolCoverage.complete ? (
        <p className="mc-next-background-task__integrity">
          Tool list is incomplete after {task.toolCoverage.observedCount} records.
        </p>
      ) : null}

      <SemanticLinks links={task.links} onOpen={onOpenSemanticLink} />
      <div className="mc-next-background-task__actions">
        {task.controls.detach.enabled ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onControl("detach")}
            aria-label={`Detach background task ${task.childRunId}`}
          >
            Detach
          </button>
        ) : null}
        {task.controls.reattach.enabled ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onControl("reattach")}
            aria-label={`Reattach background task ${task.childRunId}`}
          >
            Reattach
          </button>
        ) : null}
        {task.controls.cancel.enabled && !confirmCancel ? (
          <button ref={cancelButtonRef} type="button" className="danger" disabled={pending} onClick={onRequestCancel}>
            Cancel child
          </button>
        ) : null}
      </div>
      {confirmCancel ? (
        <div
          className="mc-next-background-task__confirm"
          role="alertdialog"
          aria-label={`Cancel ${task.label}`}
          aria-describedby={confirmationDescriptionId}
          aria-modal="false"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) {
              event.preventDefault();
              onDismissCancel();
            }
          }}
        >
          <p id={confirmationDescriptionId}>
            Cancel this durable child run? Completed work stays in its evidence record.
          </p>
          <div>
            <button ref={keepRunningButtonRef} type="button" onClick={onDismissCancel} disabled={pending}>
              Keep running
            </button>
            <button type="button" className="danger" onClick={() => void onControl("cancel")} disabled={pending}>
              {pending ? "Cancelling…" : "Confirm cancel"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function SynthesisLineage({ snapshot }: { snapshot: DurableBackgroundTaskRailResponse }) {
  return (
    <section className="mc-next-background-rail__synthesis" aria-label="Parent synthesis lineage">
      <div>
        <h5>Parent synthesis</h5>
        <span>{snapshot.synthesis.availability}</span>
      </div>
      {snapshot.synthesis.summary ? <p>{snapshot.synthesis.summary}</p> : <p>No parent synthesis is recorded yet.</p>}
      {snapshot.synthesis.lineage.length > 0 ? (
        <ul>
          {snapshot.synthesis.lineage.map((entry) => (
            <li key={entry.watcherId}>
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>{shortId(entry.childRunId)} output</span>
              <small>
                {entry.byteCount} bytes · {entry.sha256.slice(0, 12)}…
              </small>
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot.synthesis.missingTerminalChildRunIds.length > 0 ? (
        <p className="mc-next-background-task__muted">
          Missing concrete output from {snapshot.synthesis.missingTerminalChildRunIds.length} terminal child run(s).
        </p>
      ) : null}
      {snapshot.synthesis.uncoveredChildRunIds.length > 0 || snapshot.synthesis.uncoveredStepIds.length > 0 ? (
        <p className="mc-next-background-task__muted">
          Selected synthesis does not cover {snapshot.synthesis.uncoveredChildRunIds.length} watched child run(s) and{" "}
          {snapshot.synthesis.uncoveredStepIds.length} delegation step(s).
        </p>
      ) : null}
    </section>
  );
}

function SemanticLinks({
  links,
  onOpen,
}: {
  links: DurableBackgroundTaskSemanticLink[];
  onOpen?: DurableBackgroundTaskRailProps["onOpenSemanticLink"];
}) {
  return (
    <div className="mc-next-background-task__links" aria-label="Task lineage links">
      {links.map((link) => {
        const actionable =
          Boolean(onOpen) && ["durable_run", "chat_session", "chat_turn", "approval", "task"].includes(link.kind);
        return actionable ? (
          <button
            key={`${link.kind}:${link.id}`}
            type="button"
            data-link-kind={link.kind}
            onClick={() => onOpen?.(link, links)}
          >
            <Link2 size={11} aria-hidden="true" /> {link.label}
          </button>
        ) : (
          <span key={`${link.kind}:${link.id}`} data-link-kind={link.kind}>
            <Link2 size={11} aria-hidden="true" /> {link.label}
          </span>
        );
      })}
    </div>
  );
}

function FallbackQueueState(props: DurableBackgroundTaskRailProps) {
  return (
    <section className="mc-next-background-rail" aria-labelledby="background-task-fallback-title">
      <h4 id="background-task-fallback-title">Background work</h4>
      <div className="mc-next-background-rail__summary">
        <span>{props.queuedCount} queued</span>
        <span>{props.streamStatus}</span>
      </div>
      {props.queueLabels.length > 0 ? (
        <ul>
          {props.queueLabels.slice(0, 8).map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      ) : (
        <p>Select a durable turn to inspect child work.</p>
      )}
      {props.onOpenTasks ? (
        <button type="button" className="mc-next-panel-button" onClick={props.onOpenTasks}>
          Open task board
        </button>
      ) : null}
    </section>
  );
}

function formatStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function statusClass(status: DurableBackgroundTaskItem["canonicalStatus"]): string {
  if (status === "completed") return "success";
  if (status === "failed" || status === "dead_lettered" || status === "missing") return "danger";
  if (status === "waiting" || status === "paused" || status === "cancelled") return "warning";
  return "active";
}

function outputAvailabilityCopy(availability: DurableBackgroundTaskItem["output"]["availability"]): string {
  if (availability === "not_terminal") return "Output becomes citable when the child reaches a terminal state.";
  if (availability === "missing") return "No concrete terminal output is available.";
  if (availability === "unknown") return "Output cannot be trusted until scope and lineage are verified.";
  return "Output is available.";
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 10)}…`;
}
