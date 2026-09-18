import { normalizeRemoteWorkerCellObjectInventoryExchange, normalizeRemoteWorkerCellObjectInventorySubmission,
  type RemoteWorkerCellObjectInventoryExchange } from "@goatcitadel/contracts";
import type { RemoteWorkerCellObjectInventoryAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";
import { normalizeRemoteWorkerCellObjectInventoryPageSubmission, normalizeRemoteWorkerCellObjectInventoryPageExchange,
  type RemoteWorkerCellObjectInventoryPageExchange } from "@goatcitadel/contracts";
import type { RemoteWorkerCellObjectInventoryPageAssignmentInput } from "@goatcitadel/storage";

export interface RemoteWorkerCellObjectInventoryPageExchangePort {
  exchange(input: RemoteWorkerCellObjectInventoryPageAssignmentInput & { readonly signal?: AbortSignal }):
    RemoteWorkerCellObjectInventoryPageExchange | Promise<RemoteWorkerCellObjectInventoryPageExchange>;
}
export async function exchangeRemoteWorkerCellObjectInventoryPage(owner: RemoteWorkerCellObjectInventoryPageExchangePort | undefined,
  input: RemoteWorkerCellObjectInventoryPageAssignmentInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerCellObjectInventoryPageExchange> {
  if (!owner) throw rejected("Worker inventory page delivery is unavailable.");
  const binding = Object.freeze({ ...input, submission: normalizeRemoteWorkerCellObjectInventoryPageSubmission(input.submission),
    protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
      meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }) });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerCellObjectInventoryPageExchange(await owner.exchange(binding));
  binding.signal?.throwIfAborted();
  const { history, accepted } = result, submission = binding.submission;
  if (history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision ||
      (submission.kind === "cell.object_inventory.page_snapshot" ? accepted !== null : (!accepted ||
        accepted.page.expectedRevision !== submission.expectedRevision || accepted.page.startChunk !== submission.startChunk ||
        accepted.page.observationHex !== submission.observationHex || accepted.page.nativeReceiptHex !== submission.nativeReceiptHex ||
        accepted.page.chunkHex.length !== submission.chunkHex.length || accepted.page.chunkHex.some((chunk, index) => chunk !== submission.chunkHex[index]))))
    throw rejected("Worker inventory page result does not bind this assignment request.");
  return result;
}

export interface RemoteWorkerCellObjectInventoryExchangePort {
  exchange(input: RemoteWorkerCellObjectInventoryAssignmentInput & { readonly signal?: AbortSignal }):
    RemoteWorkerCellObjectInventoryExchange | Promise<RemoteWorkerCellObjectInventoryExchange>;
}

/** Internal complete-inventory owner. The bounded remote page protocol must
 * assemble its capture before calling this port; do not lift RPC body limits. */
export async function exchangeRemoteWorkerCellObjectInventory(owner: RemoteWorkerCellObjectInventoryExchangePort | undefined,
  input: RemoteWorkerCellObjectInventoryAssignmentInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerCellObjectInventoryExchange> {
  if (!owner) throw rejected("Worker cell object inventory is unavailable.");
  const binding = Object.freeze({ ...input, submission: normalizeRemoteWorkerCellObjectInventorySubmission(input.submission),
    protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
      meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }) });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerCellObjectInventoryExchange(await owner.exchange(binding));
  binding.signal?.throwIfAborted();
  const { history, record } = result;
  const submission = binding.submission;
  if (history.registryWorkspaceId !== binding.registryWorkspaceId || history.assignmentId !== binding.assignmentId ||
      history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision ||
      (submission.kind === "cell.object_inventory.observation" && (!record || record.revision !== submission.expectedRevision + 1 ||
        record.observationHex !== submission.observationHex || record.nativeReceiptHex !== submission.nativeReceiptHex ||
        record.chunkHex.length !== submission.chunkHex.length || record.chunkHex.some((chunk, index) => chunk !== submission.chunkHex[index]))))
    throw rejected("Worker object inventory result does not bind this assignment observation.");
  return result;
}
