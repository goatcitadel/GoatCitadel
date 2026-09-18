import { normalizeRemoteWorkerCellCapacityExchange, normalizeRemoteWorkerCellCapacitySubmission,
  type RemoteWorkerCellCapacityExchange, type RemoteWorkerCellCapacitySubmission,
  type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import type { LeaseBinding } from "./connected-worker-routes.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import type { WindowsWorkerCellCapacityResult } from "./worker-windows-cell-capacity.js";
import { deliverWorkerCellCapacity } from "./worker-cell-capacity-delivery.js";

export interface WorkerCellCapacityCoordinatorInput {
  readonly scope: Pick<LeaseBinding, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">;
  readonly state: WorkerDurableStatePort;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  readonly exchange: (submission: RemoteWorkerCellCapacitySubmission, signal: AbortSignal) => Promise<RemoteWorkerCellCapacityExchange>;
  readonly observe: (history: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>) => Promise<WindowsWorkerCellCapacityResult>;
}

/** Retain the exact native result before protected submission. Both measurement
 * streams share one active assignment owner but have independent durable keys. */
export async function observeAndRecordWorkerCellCapacity(supplied: WorkerCellCapacityCoordinatorInput): Promise<RemoteWorkerCellCapacityExchange> {
  const input = Object.freeze({ ...supplied });
  return normalizeRemoteWorkerCellCapacityExchange(await deliverWorkerCellCapacity({ ...input, kind: "mounted",
    exchange: (submission, signal) => input.exchange(normalizeRemoteWorkerCellCapacitySubmission(submission), signal) }));
}
