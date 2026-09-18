import { normalizeRemoteWorkerCellCapacityExchange, normalizeRemoteWorkerCellCapacitySubmission,
  type RemoteWorkerCellCapacityExchange } from "@goatcitadel/contracts";
import type { RemoteWorkerCellCapacityAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export interface RemoteWorkerCellCapacityExchangePort {
  exchange(input: RemoteWorkerCellCapacityAssignmentInput & { readonly signal?: AbortSignal }):
    RemoteWorkerCellCapacityExchange | Promise<RemoteWorkerCellCapacityExchange>;
}

export async function exchangeRemoteWorkerCellCapacity(owner: RemoteWorkerCellCapacityExchangePort | undefined,
  input: RemoteWorkerCellCapacityAssignmentInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerCellCapacityExchange> {
  if (!owner) throw rejected("Worker cell capacity observation is unavailable.");
  const binding = Object.freeze({ ...input, submission: normalizeRemoteWorkerCellCapacitySubmission(input.submission),
    protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
      meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }) });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerCellCapacityExchange(await owner.exchange(binding));
  binding.signal?.throwIfAborted();
  const { history, record } = result;
  if (history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision ||
      (binding.submission.kind === "cell.capacity.observation" && (!record || record.revision !== binding.submission.expectedRevision + 1 ||
        record.observationHex !== binding.submission.observationHex || record.nativeReceiptHex !== binding.submission.nativeReceiptHex)))
    throw rejected("Worker capacity result does not bind this assignment observation.");
  return result;
}
