import { normalizeRemoteWorkerCellBackingCapacityExchange, normalizeRemoteWorkerCellBackingCapacitySubmission,
  type RemoteWorkerCellBackingCapacityExchange } from "@goatcitadel/contracts";
import type { RemoteWorkerCellBackingCapacityAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export interface RemoteWorkerCellBackingCapacityExchangePort {
  exchange(input: RemoteWorkerCellBackingCapacityAssignmentInput & { readonly signal?: AbortSignal }):
    RemoteWorkerCellBackingCapacityExchange | Promise<RemoteWorkerCellBackingCapacityExchange>;
}

export async function exchangeRemoteWorkerCellBackingCapacity(owner: RemoteWorkerCellBackingCapacityExchangePort | undefined,
  input: RemoteWorkerCellBackingCapacityAssignmentInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerCellBackingCapacityExchange> {
  if (!owner) throw rejected("Worker cell backing capacity observation is unavailable.");
  const binding = Object.freeze({ ...input, submission: normalizeRemoteWorkerCellBackingCapacitySubmission(input.submission),
    protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
      meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }) });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerCellBackingCapacityExchange(await owner.exchange(binding));
  binding.signal?.throwIfAborted();
  const { history, record } = result;
  if (history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision ||
      (binding.submission.kind === "cell.backing_capacity.observation" && (!record || record.revision !== binding.submission.expectedRevision + 1 ||
        record.observationHex !== binding.submission.observationHex || record.nativeReceiptHex !== binding.submission.nativeReceiptHex)))
    throw rejected("Worker backing capacity result does not bind this assignment observation.");
  return result;
}
