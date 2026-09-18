import { canonicalJsonString, normalizeRemoteWorkerNativeCapacityPageSubmission, normalizeRemoteWorkerNativeCapacityPageExchange,
  type RemoteWorkerNativeCapacityPageExchange } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerNativeCapacityPageAssignmentInput as StoredPageInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export interface RemoteWorkerNativeCapacityPageAssignmentInput extends StoredPageInput {
  readonly signal?: AbortSignal;
}
export interface RemoteWorkerNativeCapacityPageExchangePort {
  /** The canonical owner stages bounded pages durably. It returns a record only
   * after independently verifying and committing the complete source bundle. */
  exchange(input: RemoteWorkerNativeCapacityPageAssignmentInput): RemoteWorkerNativeCapacityPageExchange | Promise<RemoteWorkerNativeCapacityPageExchange>;
}
export async function exchangeRemoteWorkerNativeCapacityPage(owner: RemoteWorkerNativeCapacityPageExchangePort | undefined,
  input: RemoteWorkerNativeCapacityPageAssignmentInput): Promise<RemoteWorkerNativeCapacityPageExchange> {
  if (!owner) throw rejected("Worker native capacity delivery is unavailable.");
  const binding = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
    submission: normalizeRemoteWorkerNativeCapacityPageSubmission(input.submission), signal: input.signal });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerNativeCapacityPageExchange(await owner.exchange(binding));
  binding.signal?.throwIfAborted();
  if (result.registryWorkspaceId !== binding.registryWorkspaceId || result.assignmentId !== binding.assignmentId ||
      result.assignmentGeneration !== binding.assignmentGeneration || result.leaseRevision !== binding.leaseRevision ||
      result.nonce !== binding.submission.nonce || result.bundleSha256 !== binding.submission.bundleSha256 ||
      (binding.submission.kind === "cell.native_capacity.lookup" ? result.accepted !== null :
        !result.accepted || canonicalJsonString(result.accepted.page) !== canonicalJsonString(binding.submission)))
    throw rejected("Worker native capacity result does not bind this assignment request.");
  return result;
}
