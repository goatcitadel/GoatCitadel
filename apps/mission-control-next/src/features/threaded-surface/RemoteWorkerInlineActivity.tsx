import type { RemoteWorkerAssignmentProjection } from "@goatcitadel/contracts";
import { useRemoteWorkerInlineActivity } from "./useRemoteWorkerInlineActivity";
import "../../styles/background-task-rail.css";

export interface RemoteWorkerInlineActivityProps {
  workspaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  onOpenOps?: (workerId: string) => void;
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 10)}…`;
}

function phaseLabel(phase: string | null): string {
  return (phase ?? "unknown").replaceAll("_", " ");
}

function AssignmentActivity({
  assignment,
  onOpenOps,
}: {
  assignment: RemoteWorkerAssignmentProjection;
  onOpenOps?: (workerId: string) => void;
}) {
  const identity = assignment.identity.value;
  const lease = assignment.lease.value;
  const freshness = assignment.leaseFreshness.value;
  const control = assignment.control.value;
  const settlement = assignment.settlement.value;
  const materialization = assignment.materialization.value;
  const workerId = identity?.workerId;
  return (
    <article className="mc-next-remote-activity__item">
      <div className="mc-next-remote-activity__head">
        <strong>{shortId(assignment.assignmentId)}</strong>
        <span data-phase={assignment.phase.value ?? "unknown"}>{phaseLabel(assignment.phase.value)}</span>
      </div>
      <div className="mc-next-remote-activity__facts">
        {identity ? (
          <span>
            worker {shortId(identity.workerId)} · gen {identity.assignmentGeneration}
          </span>
        ) : (
          <span>not yet started</span>
        )}
        {lease ? (
          <span>
            lease rev {lease.leaseRevision} · {freshness?.fresh ? "fresh" : "expired"}
          </span>
        ) : null}
        {lease ? (
          <span>
            sent {lease.workerSentThrough} · acked {lease.serverAcknowledgedThrough}
          </span>
        ) : null}
        {control ? <span>control {control.action}</span> : null}
        {settlement ? (
          <span>
            settled {settlement.outcome} · {settlement.origin}
          </span>
        ) : null}
        {materialization ? <span>materialized {materialization.count}</span> : null}
      </div>
      <p className="mc-next-remote-activity__unavailable">
        Usage/cost and artifact/effect outcomes are unavailable in this tranche — no cost is inferred.
      </p>
      {onOpenOps && workerId ? (
        <button type="button" className="mc-next-remote-activity__ops-link" onClick={() => onOpenOps(workerId)}>
          View in Ops
        </button>
      ) : null}
    </article>
  );
}

/**
 * HX-507B session/turn-bound remote-worker activity rendered INSIDE the existing
 * Chat background rail — no new surface, route, mode, or second rail. It shows
 * only the assignments whose stored lineage matches the active workspace,
 * session, and turn, and stays read-only: rotate/quarantine/revoke/recovery/
 * cleanup management remain in Ops.
 */
export function RemoteWorkerInlineActivity(props: RemoteWorkerInlineActivityProps) {
  const activity = useRemoteWorkerInlineActivity({
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    turnId: props.turnId,
  });

  if (!props.sessionId || !props.turnId) return null;
  if (!activity.loading && !activity.error && activity.assignments.length === 0) return null;

  return (
    <section
      className="mc-next-remote-activity"
      aria-label="Remote worker activity for this turn"
      aria-busy={activity.loading}
    >
      <div className="mc-next-remote-activity__header">
        <h5>Remote workers</h5>
        <span>{activity.assignments.length} bound</span>
      </div>
      {activity.error ? (
        <p className="mc-next-remote-activity__unavailable" role="alert">
          {activity.error}
        </p>
      ) : null}
      {activity.assignments.map((assignment) => (
        <AssignmentActivity key={assignment.assignmentId} assignment={assignment} onOpenOps={props.onOpenOps} />
      ))}
    </section>
  );
}
