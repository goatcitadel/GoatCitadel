import type { RemoteWorkerRegistryItem } from "@goatcitadel/contracts";
import { Button } from "../../../ui/Button";
import { Section } from "../../../ui/Section";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { AssignmentInspector } from "./AssignmentInspector";
import { useWorkerDetail } from "./use-worker-detail";
import { WorkerBudgets } from "./WorkerBudgets";
import { WorkerIdentitySection } from "./WorkerIdentitySection";
import { assignmentStatus, settlementStatus, workerStatus } from "./worker-copy";

/** One worker: identity, controls, record checks, assignments and spending budgets. */
export function WorkerDetail({
  workspaceId,
  workspaceName,
  workerId,
  assignmentId,
  listed,
  reloadRegistry,
  onBack,
  onOpenAssignment,
  onCloseAssignment,
}: {
  workspaceId: string;
  workspaceName: string;
  workerId: string;
  assignmentId?: string;
  listed?: RemoteWorkerRegistryItem;
  reloadRegistry: () => unknown;
  onBack: () => void;
  onOpenAssignment: (assignmentId: string) => void;
  onCloseAssignment: () => void;
}) {
  const worker = useWorkerDetail(workspaceId, workerId, reloadRegistry);
  const item = worker.detail?.item ?? listed;
  const assignments = worker.assignments?.items ?? null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          All workers
        </Button>
        <Button size="sm" disabled={worker.loading} onClick={() => void worker.refresh()}>
          Refresh worker
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">{item?.admission.value?.workerLabel ?? "Worker"}</h2>
        <StatusBadge status={workerStatus(item?.posture.value)} />
      </div>
      {worker.loading && !item ? <p className="text-sm text-fg-muted">Loading worker…</p> : null}
      {worker.error ? (
        <div className="text-sm text-status-failed">
          <p className="font-medium">Detail unavailable</p>
          <p>{worker.error}</p>
        </div>
      ) : null}
      {worker.stale ? <p className="text-sm text-status-waiting">{worker.stale}</p> : null}
      {item ? <WorkerIdentitySection item={item} reconciliation={worker.reconciliation} /> : null}
      <Section title="Assignments">
        {assignments === null ? (
          <p className="text-sm text-fg-muted">
            {worker.loading ? "Loading assignments…" : "Assignments are unavailable. Try Refresh worker."}
          </p>
        ) : assignments.length === 0 ? (
          <p className="text-sm text-fg-muted">No assignments use this worker.</p>
        ) : (
          <ul className="divide-y divide-line-subtle">
            {assignments.map((assignment, index) => {
              const status = assignmentStatus(assignment.phase.value);
              const settlement = assignment.settlement.value;
              return (
                <li key={assignment.assignmentId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
                    <StatusBadge status={status} />
                    {settlement ? `Finished: ${settlementStatus(settlement.outcome).label}` : "Not finished"}
                    <TechnicalDetails label="IDs">
                      <span className="break-all font-mono text-xs">
                        {assignment.assignmentId} · session {assignment.lineage.value?.sessionId ?? "not reported"}
                      </span>
                    </TechnicalDetails>
                  </span>
                  <Button
                    size="sm"
                    aria-label={`Assignment details: ${status.label}, ${index + 1} of ${assignments.length}`}
                    onClick={() => onOpenAssignment(assignment.assignmentId)}
                  >
                    Assignment details
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {worker.moreError ? <p className="text-sm text-status-failed">{worker.moreError}</p> : null}
        {worker.assignments?.nextCursor ? (
          <Button
            className="mt-2"
            size="sm"
            loading={worker.loadingMore}
            loadingLabel="Loading assignments…"
            onClick={() => void worker.loadMoreAssignments()}
          >
            Load more assignments
          </Button>
        ) : null}
      </Section>
      {item ? (
        <WorkerBudgets
          key={`${workspaceId}:${item.workerId}:${item.admission.value?.workerGeneration}`}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          worker={item}
        />
      ) : null}
      {assignmentId && assignments ? (
        <AssignmentInspector
          key={assignmentId}
          workspaceId={workspaceId}
          assignments={assignments}
          assignmentId={assignmentId}
          refreshKey={worker.assignments?.observedAt}
          onClose={onCloseAssignment}
        />
      ) : null}
    </div>
  );
}
