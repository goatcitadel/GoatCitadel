import { normalizeRemoteWorkerRuntimeInstallSubmission, normalizeRemoteWorkerRuntimeInstallExchange,
  normalizeRemoteWorkerRuntimeInstallSelection, normalizeRemoteWorkerRuntimeInstallSelectionSubmission,
  type RemoteWorkerRuntimeInstallSelection, type RemoteWorkerRuntimeInstallExchange } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerRuntimeInstallSelectionInput, type RemoteWorkerRuntimeInstallExchangeInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export interface RemoteWorkerRuntimeInstallExchangePort {
  select?(input: RemoteWorkerRuntimeInstallSelectionInput & { readonly signal?: AbortSignal }):
    RemoteWorkerRuntimeInstallSelection | Promise<RemoteWorkerRuntimeInstallSelection>;
  exchange(input: RemoteWorkerRuntimeInstallExchangeInput & { readonly signal?: AbortSignal }):
    RemoteWorkerRuntimeInstallExchange | Promise<RemoteWorkerRuntimeInstallExchange>;
}
export async function selectRemoteWorkerRuntimeInstall(owner: RemoteWorkerRuntimeInstallExchangePort | undefined,
  input: RemoteWorkerRuntimeInstallSelectionInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerRuntimeInstallSelection> {
  if (!owner?.select || !input.protectedAuthority) throw rejected("Worker installation selection is unavailable.");
  const binding = Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input),
    submission: normalizeRemoteWorkerRuntimeInstallSelectionSubmission(input.submission), signal: input.signal });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerRuntimeInstallSelection(await owner.select(binding)), history = result.history;
  binding.signal?.throwIfAborted();
  if (result.challenge !== binding.submission.challenge || history.registryWorkspaceId !== binding.registryWorkspaceId ||
      history.assignmentId !== binding.assignmentId || history.assignmentGeneration !== binding.assignmentGeneration || history.leaseRevision !== binding.leaseRevision)
    throw rejected("Worker installation selection does not bind this assignment request.");
  return result;
}
export async function exchangeRemoteWorkerRuntimeInstall(owner: RemoteWorkerRuntimeInstallExchangePort | undefined,
  input: RemoteWorkerRuntimeInstallExchangeInput & { readonly signal?: AbortSignal }): Promise<RemoteWorkerRuntimeInstallExchange> {
  if (!owner || !input.protectedAuthority) throw rejected("Worker installation evidence delivery is unavailable.");
  const binding = Object.freeze({ ...input, submission: normalizeRemoteWorkerRuntimeInstallSubmission(input.submission),
    protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
      meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }) });
  binding.signal?.throwIfAborted();
  const result = normalizeRemoteWorkerRuntimeInstallExchange(await owner.exchange(binding));
  binding.signal?.throwIfAborted();
  if (result.registryWorkspaceId !== binding.registryWorkspaceId || result.assignmentId !== binding.assignmentId ||
      result.assignmentGeneration !== binding.assignmentGeneration || result.leaseRevision !== binding.leaseRevision ||
      result.nonce !== binding.submission.nonce || result.requestSha256 !== binding.submission.requestSha256 ||
      (binding.submission.kind === "runtime.install.retain" && result.record?.outcomeHex !== binding.submission.outcomeHex))
    throw rejected("Worker installation receipt does not bind this assignment request.");
  return result;
}
