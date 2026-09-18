import { canonicalJsonString, normalizeRemoteWorkerRuntimeResultSubmission, normalizeRemoteWorkerRuntimeResultExchange,
  type RemoteWorkerRuntimeResultExchange } from "@goatcitadel/contracts";
import type { RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export interface RemoteWorkerRuntimeResultExchangePort {
  exchange(input: RemoteWorkerRuntimeResultPageAssignmentInput & { readonly signal?: AbortSignal }):
    RemoteWorkerRuntimeResultExchange | Promise<RemoteWorkerRuntimeResultExchange>;
}
export async function exchangeRemoteWorkerRuntimeResult(owner: RemoteWorkerRuntimeResultExchangePort | undefined,
  input: RemoteWorkerRuntimeResultPageAssignmentInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerRuntimeResultExchange> {
  if (!owner || !input.protectedAuthority) throw rejected("Worker runtime result delivery is unavailable.");
  const binding = Object.freeze({ ...input, submission: normalizeRemoteWorkerRuntimeResultSubmission(input.submission),
    protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
      meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }) });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerRuntimeResultExchange(await owner.exchange(binding));
  binding.signal?.throwIfAborted();
  const selection = binding.submission;
  if (result.registryWorkspaceId !== binding.registryWorkspaceId || result.assignmentId !== binding.assignmentId ||
      result.assignmentGeneration !== binding.assignmentGeneration || result.leaseRevision !== binding.leaseRevision ||
      result.nonce !== selection.nonce || result.requestSha256 !== selection.requestSha256 ||
      (selection.kind === "runtime.result.lookup" ? result.accepted !== null : !result.accepted || canonicalJsonString(result.accepted.page) !== canonicalJsonString(selection)))
    throw rejected("Worker runtime result receipt does not bind this assignment request.");
  return result;
}
