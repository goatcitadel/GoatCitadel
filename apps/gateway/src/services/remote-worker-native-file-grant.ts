import { canonicalJsonString, normalizeRemoteWorkerNativeFileGrantSubmission, normalizeRemoteWorkerNativeFileGrantReceipt,
  REMOTE_WORKER_NATIVE_FILE_GRANT_SCHEMA, type RemoteWorkerNativeFileGrantSubmission } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";
import type { RemoteWorkerNativeArtifactStore } from "./remote-worker-native-artifact-store.js";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

export type RemoteWorkerNativeFileGrantPort = Pick<RemoteWorkerNativeArtifactStore, "authorizeFile">;
export async function authorizeRemoteWorkerNativeFile(owner: RemoteWorkerNativeFileGrantPort | undefined,
  input: Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission"> & { submission: RemoteWorkerNativeFileGrantSubmission; signal?: AbortSignal }) {
  if (!owner) throw rejected("Native file authorization is unavailable.");
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerNativeFileGrantSubmission(input.submission);
  const selection = submission.selection, signal = input.signal ?? new AbortController().signal;
  if (selection.registryWorkspaceId !== authority.registryWorkspaceId || selection.assignmentId !== authority.assignmentId || selection.assignmentGeneration !== authority.assignmentGeneration)
    throw rejected("Native file authorization differs from its assignment.");
  signal.throwIfAborted();
  const result = await owner.authorizeFile({ ...authority, selection, fileStaging: submission.fileStaging, signal });
  signal.throwIfAborted();
  if (canonicalJsonString(result.selection) !== canonicalJsonString(selection)) throw rejected("Native file authorization changed its selection.");
  return normalizeRemoteWorkerNativeFileGrantReceipt({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_GRANT_SCHEMA,
    leaseRevision: authority.leaseRevision, submission, disclosure: result.disclosure });
}
