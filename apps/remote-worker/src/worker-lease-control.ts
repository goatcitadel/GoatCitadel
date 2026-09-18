import { randomUUID } from "node:crypto";
import { readControl, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { WorkerProtectedRouteError } from "./worker-protected-route-client.js";

interface WorkerLeaseControlInput {
  context: RouteContext;
  owner: Pick<WorkerAssignmentLeaseOwner, "renew">;
  lease: LeaseBinding;
  workerSentThrough: number;
  observed: Record<string, unknown>;
  readControl?: typeof readControl;
}

/** Read current authority without rotating or persisting a lease. The caller
 * must retain the exact lease for the complete read/operation window. */
export async function readWorkerLeaseControl(context: RouteContext, lease: LeaseBinding,
  read: typeof readControl = readControl) {
  const control = await read(context, lease, `control:${randomUUID()}`);
  const held = control.body.lease as Record<string, unknown> | undefined;
  if (control.body.assignmentId !== lease.assignmentId || control.body.assignmentGeneration !== lease.assignmentGeneration ||
      held?.registryWorkspaceId !== lease.registryWorkspaceId || held.assignmentId !== lease.assignmentId ||
      held.assignmentGeneration !== lease.assignmentGeneration || held.leaseRevision !== lease.leaseRevision)
    throw new Error("Worker control receipt does not match current lease authority.");
  if (control.body.disposition !== "active" && control.body.disposition !== "cancel_requested")
    throw new Error("Worker control receipt has no current execution or cancellation authority.");
  return control;
}

/** A parent heartbeat can race the two authenticated RPCs. Refresh only the
 * retained lease and read-only control check, at most twice. Every renewal
 * re-enters current Gateway authority; no execution or ambiguous mutation is
 * retried here, and persistent rejection still stops the worker. */
export async function renewWorkerLeaseControl(input: WorkerLeaseControlInput) {
  let lease = input.lease;
  for (let refresh = 0; ; refresh += 1) {
    lease = await input.owner.renew(lease, input.workerSentThrough, input.observed);
    let control: Awaited<ReturnType<typeof readControl>>;
    try {
      control = await readWorkerLeaseControl(input.context, lease, input.readControl);
    } catch (error) {
      if (refresh >= 2 || !(error instanceof WorkerProtectedRouteError) || error.status !== 403 ||
        Object.keys(error.responseBody).length !== 1 || error.responseBody.error !== "REMOTE_WORKER_ASSIGNMENT_REJECTED")
        throw error;
      input.observed.leaseControlRefreshes = Number(input.observed.leaseControlRefreshes ?? 0) + 1;
      continue;
    }
    return { lease, control };
  }
}
