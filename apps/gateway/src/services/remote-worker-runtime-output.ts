import { canonicalJsonString, normalizeRemoteWorkerRuntimeOutputSubmission, normalizeRemoteWorkerRuntimeOutputReceipt,
  remoteWorkerRuntimeOutputEvidenceSha256, REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA,
  type RemoteWorkerRuntimeOutputSubmission, type RemoteWorkerRuntimeOutputReceipt } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

type Input = Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission"> & { submission: RemoteWorkerRuntimeOutputSubmission; signal?: AbortSignal };
export interface RemoteWorkerRuntimeOutputPort { retain(input: Input): Promise<RemoteWorkerRuntimeOutputReceipt> }

export function createRemoteWorkerRuntimeOutputRetainer(storage: Pick<AsyncStorage, "remoteWorkerRuntimeResults">): RemoteWorkerRuntimeOutputPort {
  return { retain: async input => {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerRuntimeOutputSubmission(input.submission), signal = input.signal;
    signal?.throwIfAborted();
    const saved = await storage.remoteWorkerRuntimeResults.retainOutputForAssignment({ ...authority, evidence: submission.evidence });
    signal?.throwIfAborted();
    if (canonicalJsonString(saved.evidence) !== canonicalJsonString(submission.evidence) ||
        saved.evidenceSha256 !== remoteWorkerRuntimeOutputEvidenceSha256(submission.evidence)) throw rejected("Retained native output differs from this submission.");
    return normalizeRemoteWorkerRuntimeOutputReceipt({ schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA,
      registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration,
      leaseRevision: authority.leaseRevision, nonce: saved.evidence.nonce, requestSha256: saved.evidence.requestSha256,
      resultSha256: saved.evidence.resultSha256, evidenceSha256: saved.evidenceSha256, recordedLeaseRevision: saved.leaseRevision, recordedAt: saved.recordedAt });
  } };
}
export async function retainRemoteWorkerRuntimeOutput(owner: RemoteWorkerRuntimeOutputPort | undefined, input: Input) {
  if (!owner) throw rejected("Native output retention is unavailable.");
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerRuntimeOutputSubmission(input.submission), signal = input.signal;
  signal?.throwIfAborted();
  const result = normalizeRemoteWorkerRuntimeOutputReceipt(await owner.retain({ ...authority, submission, signal }));
  signal?.throwIfAborted();
  const evidence = submission.evidence;
  if (result.registryWorkspaceId !== authority.registryWorkspaceId || result.assignmentId !== authority.assignmentId ||
      result.assignmentGeneration !== authority.assignmentGeneration || result.leaseRevision !== authority.leaseRevision ||
      result.nonce !== evidence.nonce || result.requestSha256 !== evidence.requestSha256 || result.resultSha256 !== evidence.resultSha256 ||
      result.evidenceSha256 !== remoteWorkerRuntimeOutputEvidenceSha256(evidence)) throw rejected("Native output receipt does not bind this submission.");
  return result;
}
