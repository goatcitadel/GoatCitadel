import { normalizeRemoteWorkerRuntimeCleanupSubmission, normalizeRemoteWorkerRuntimeCleanupExchange, REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA,
  type RemoteWorkerRuntimeCleanupSubmission, type RemoteWorkerRuntimeCleanupExchange } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";
import { createRemoteWorkerRuntimeOutcomeReader, readRemoteWorkerRuntimeOutcome, type RemoteWorkerRuntimeOutcomePort } from "./remote-worker-runtime-outcome.js";
import type { RemoteWorkerRuntimeOutcomeSubmission } from "@goatcitadel/contracts";
type Input = Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission"> & { submission: RemoteWorkerRuntimeCleanupSubmission; signal?: AbortSignal };
export interface RemoteWorkerRuntimeCleanupPort { read(input: Input): Promise<RemoteWorkerRuntimeCleanupExchange> }
/** Compose the historical read owners separately from execution admission. */
export function createRemoteWorkerRuntimeReadOwners(storage: Pick<AsyncStorage, "remoteWorkerRuntimeResults">) {
  return { runtimeOutcomes: createRemoteWorkerRuntimeOutcomeReader(storage), runtimeCleanup: createRemoteWorkerRuntimeCleanupReader(storage) };
}
export async function dispatchRemoteWorkerRuntimeRead(owners: { runtimeCleanup?: RemoteWorkerRuntimeCleanupPort; runtimeOutcomes?: RemoteWorkerRuntimeOutcomePort },
  input: Omit<Input, "submission"> & { submission: RemoteWorkerRuntimeCleanupSubmission | RemoteWorkerRuntimeOutcomeSubmission }) {
  if (input.submission.kind === "runtime.cleanup.read") {
    return { disposition: "runtime_cleanup" as const, runtimeCleanup: await readRemoteWorkerRuntimeCleanup(owners.runtimeCleanup, { ...input, submission: input.submission }) };
  }
  return { disposition: "runtime_outcome" as const, runtimeOutcome: await readRemoteWorkerRuntimeOutcome(owners.runtimeOutcomes, { ...input, submission: input.submission }) };
}
export function createRemoteWorkerRuntimeCleanupReader(storage: Pick<AsyncStorage, "remoteWorkerRuntimeResults">): RemoteWorkerRuntimeCleanupPort {
  return { read: async input => {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerRuntimeCleanupSubmission(input.submission), signal = input.signal;
    signal?.throwIfAborted();
    const retained = await storage.remoteWorkerRuntimeResults.readCleanupExpectationsForAssignment(authority);
    signal?.throwIfAborted();
    return normalizeRemoteWorkerRuntimeCleanupExchange({ schemaVersion: REMOTE_WORKER_RUNTIME_CLEANUP_SCHEMA, challenge: submission.challenge, ...retained });
  } };
}
export async function readRemoteWorkerRuntimeCleanup(owner: RemoteWorkerRuntimeCleanupPort | undefined, input: Input) {
  if (!owner) throw rejected("Native cleanup lookup is unavailable.");
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerRuntimeCleanupSubmission(input.submission), signal = input.signal;
  signal?.throwIfAborted();
  const response = normalizeRemoteWorkerRuntimeCleanupExchange(await owner.read({ ...authority, submission, signal }));
  signal?.throwIfAborted();
  const history = response.history;
  if (response.challenge !== submission.challenge || history.registryWorkspaceId !== authority.registryWorkspaceId || history.assignmentId !== authority.assignmentId ||
      history.assignmentGeneration !== authority.assignmentGeneration || history.leaseRevision !== authority.leaseRevision) throw rejected("Native cleanup history does not bind this lease.");
  return response;
}
