import { normalizeRemoteWorkerCellBackingCapacityExchange, normalizeRemoteWorkerCellBackingCapacitySubmission,
  type RemoteWorkerCellBackingCapacityExchange, type RemoteWorkerCellBackingCapacitySubmission,
  type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import type { LeaseBinding } from "./connected-worker-routes.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import type { WindowsWorkerCellBackingCapacityResult } from "./worker-windows-cell-capacity.js";
import { deliverWorkerCellCapacity } from "./worker-cell-capacity-delivery.js";

export interface WorkerCellBackingCapacityCoordinatorInput {
  readonly scope: Pick<LeaseBinding, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration">;
  readonly state: WorkerDurableStatePort;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => Promise<void>;
  readonly exchange: (submission: RemoteWorkerCellBackingCapacitySubmission, signal: AbortSignal) => Promise<RemoteWorkerCellBackingCapacityExchange>;
  readonly observe: (history: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>) => Promise<WindowsWorkerCellBackingCapacityResult>;
}

/** Retain the exact native result before protected submission. Both measurement
 * streams share one active assignment owner but have independent durable keys. */
export async function observeAndRecordWorkerCellBackingCapacity(supplied: WorkerCellBackingCapacityCoordinatorInput): Promise<RemoteWorkerCellBackingCapacityExchange> {
  const input = Object.freeze({ ...supplied });
  return normalizeRemoteWorkerCellBackingCapacityExchange(await deliverWorkerCellCapacity({ ...input, kind: "backing",
    exchange: (submission, signal) => input.exchange(normalizeRemoteWorkerCellBackingCapacitySubmission(submission), signal) }));
}
