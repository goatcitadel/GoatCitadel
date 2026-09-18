import { canonicalJsonString, normalizeRemoteWorkerRuntimeOutcomeSubmission, normalizeRemoteWorkerRuntimeOutcomeExchange,
  REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA, projectRemoteWorkerRuntimeOutcome, type RemoteWorkerRuntimeOutcomeSubmission,
  type RemoteWorkerRuntimeOutcomeExchange } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";
type Input = Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission"> & { submission: RemoteWorkerRuntimeOutcomeSubmission; signal?: AbortSignal };
export interface RemoteWorkerRuntimeOutcomePort { read(input: Input): Promise<RemoteWorkerRuntimeOutcomeExchange> }

export function createRemoteWorkerRuntimeOutcomeReader(storage: Pick<AsyncStorage, "remoteWorkerRuntimeResults">): RemoteWorkerRuntimeOutcomePort {
  return { read: async input => {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), selection = normalizeRemoteWorkerRuntimeOutcomeSubmission(input.submission), signal = input.signal;
    signal?.throwIfAborted();
    const lookup = await storage.remoteWorkerRuntimeResults.exchangePageForAssignment({ ...authority,
      submission: { kind: "runtime.result.lookup", nonce: selection.nonce, requestSha256: selection.requestSha256 } });
    signal?.throwIfAborted();
    let outcome = null;
    if (lookup.record) {
      const saved = await storage.remoteWorkerRuntimeResults.findForAssignment({ ...authority, nonce: selection.nonce });
      signal?.throwIfAborted();
      if (!saved || saved.expectation.nonce !== selection.nonce || saved.expectation.requestSha256 !== selection.requestSha256 ||
          canonicalJsonString({ resultSha256: saved.result.resultSha256, byteLength: saved.result.byteLength,
            leaseRevision: saved.leaseRevision, recordedAt: saved.recordedAt }) !== canonicalJsonString(lookup.record))
        throw rejected("Native result changed during outcome lookup.");
      outcome = projectRemoteWorkerRuntimeOutcome(saved.result);
    }
    return normalizeRemoteWorkerRuntimeOutcomeExchange({ schemaVersion: REMOTE_WORKER_RUNTIME_OUTCOME_SCHEMA, challenge: selection.challenge, lookup, outcome });
  } };
}
export async function readRemoteWorkerRuntimeOutcome(owner: RemoteWorkerRuntimeOutcomePort | undefined, input: Input) {
  if (!owner) throw rejected("Native outcome lookup is unavailable.");
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), selection = normalizeRemoteWorkerRuntimeOutcomeSubmission(input.submission), signal = input.signal;
  signal?.throwIfAborted();
  const response = normalizeRemoteWorkerRuntimeOutcomeExchange(await owner.read({ ...authority, submission: selection, signal }));
  signal?.throwIfAborted();
  const lookup = response.lookup;
  if (response.challenge !== selection.challenge || lookup.registryWorkspaceId !== authority.registryWorkspaceId ||
      lookup.assignmentId !== authority.assignmentId || lookup.assignmentGeneration !== authority.assignmentGeneration || lookup.leaseRevision !== authority.leaseRevision ||
      lookup.nonce !== selection.nonce || lookup.requestSha256 !== selection.requestSha256) throw rejected("Native outcome does not bind this lookup.");
  return response;
}
