import {
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, canonicalJsonString,
  normalizeRemoteWorkerCellBackingCapacityExchange, normalizeRemoteWorkerCellBackingCapacitySubmission,
  type RemoteWorkerCellBackingCapacityExchange, type RemoteWorkerCellBackingCapacitySubmission,
} from "@goatcitadel/contracts";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { observeAndRecordWorkerCellBackingCapacity, type WorkerCellBackingCapacityCoordinatorInput } from "./worker-cell-backing-capacity-coordinator.js";

/** Snapshot and receipt submission both require the protected route's current
 * lease. Read-only observation never sends a provisioning acknowledgement. */
export async function exchangeWorkerCellBackingCapacity(context: RouteContext, lease: LeaseBinding,
  submission: RemoteWorkerCellBackingCapacitySubmission, signal?: AbortSignal): Promise<RemoteWorkerCellBackingCapacityExchange> {
  const binding = Object.freeze({ ...lease }), selection = normalizeRemoteWorkerCellBackingCapacitySubmission(submission);
  const response = await callProtectedRoute({ ...context,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions", operation: "assignment.settlement.submit",
    idempotencyKey: `cell-backing-capacity:${sha256Utf8(canonicalJsonString({ registryWorkspaceId: binding.registryWorkspaceId,
      assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration, leaseRevision: binding.leaseRevision, submission: selection }))}`,
    signal, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission: selection } });
  return projectWorkerCellBackingCapacityResponse(response.body, binding, selection);
}

export function projectWorkerCellBackingCapacityResponse(body: Record<string, unknown>, lease: LeaseBinding,
  submission: RemoteWorkerCellBackingCapacitySubmission): RemoteWorkerCellBackingCapacityExchange {
  const selection = normalizeRemoteWorkerCellBackingCapacitySubmission(submission);
  const result = normalizeRemoteWorkerCellBackingCapacityExchange(body.cellBackingCapacity), { history, record } = result;
  if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" ||
      body.operation !== "assignment.settlement.submit" || body.disposition !== (selection.kind === "cell.backing_capacity.snapshot" ? "cell_backing_capacity_snapshot" : "cell_backing_capacity_recorded") ||
      body.registryWorkspaceId !== lease.registryWorkspaceId || history.registryWorkspaceId !== lease.registryWorkspaceId ||
      history.assignmentId !== lease.assignmentId || history.assignmentGeneration !== lease.assignmentGeneration || history.leaseRevision !== lease.leaseRevision ||
      (selection.kind === "cell.backing_capacity.observation" && (!record || record.revision !== selection.expectedRevision + 1 ||
        record.observationHex !== selection.observationHex || record.nativeReceiptHex !== selection.nativeReceiptHex)))
    throw new Error("Worker capacity response does not bind this assignment observation.");
  return result;
}

/** Compose retained native observations with the actual protected RPC client.
 * The assignment's lease owner may renew while the native scan is in progress;
 * every request uses its then-current lease within the original scope. */
export function observeAndRecordWorkerCellBackingCapacityOnConnection(
  input: Omit<WorkerCellBackingCapacityCoordinatorInput, "exchange"> & {
    readonly context: RouteContext;
    readonly currentLease: () => LeaseBinding;
  },
): Promise<RemoteWorkerCellBackingCapacityExchange> {
  const { context, currentLease, ...coordinator } = input;
  const scope = Object.freeze({ ...coordinator.scope });
  return observeAndRecordWorkerCellBackingCapacity({ ...coordinator, scope,
    exchange: (submission, signal) => {
      const lease = Object.freeze({ ...currentLease() });
      if (lease.registryWorkspaceId !== scope.registryWorkspaceId || lease.assignmentId !== scope.assignmentId ||
          lease.assignmentGeneration !== scope.assignmentGeneration) throw new Error("Worker capacity lease changed assignment scope.");
      return exchangeWorkerCellBackingCapacity(context, lease, submission, signal);
    },
  });
}
