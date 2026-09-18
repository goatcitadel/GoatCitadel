import { canonicalJsonString, normalizeRemoteWorkerRuntimeResultExchange, normalizeRemoteWorkerNativeFileReconciliationSubmission, normalizeRemoteWorkerNativeFileReconciliationExchange,
  REMOTE_WORKER_NATIVE_FILE_RECONCILIATION_SCHEMA, type RemoteWorkerNativeFileReconciliationSubmission,
  type RemoteWorkerNativeFileReconciliationExchange } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerRuntimeResultPageAssignmentInput } from "@goatcitadel/storage";
import type { RemoteWorkerNativeArtifactSettlement } from "./remote-worker-native-artifact-settlement.js";
import type { RemoteWorkerNativeFileTransferService } from "./remote-worker-native-file-transfer.js";
import { rejected } from "./remote-worker-assignment-execution-validators.js";

type Input = Omit<RemoteWorkerRuntimeResultPageAssignmentInput, "submission"> & { submission: RemoteWorkerNativeFileReconciliationSubmission; signal?: AbortSignal };
export interface RemoteWorkerNativeFileReconciliationPort { reconcile(input: Input): Promise<RemoteWorkerNativeFileReconciliationExchange> }
export function createRemoteWorkerNativeFileReconciler(storage: Pick<AsyncStorage, "remoteWorkerRuntimeResults" | "remoteWorkerNativeFileReceipts">,
  artifacts: Pick<RemoteWorkerNativeArtifactSettlement, "settle">, transfers?: Pick<RemoteWorkerNativeFileTransferService, "complete">): RemoteWorkerNativeFileReconciliationPort {
  return { reconcile: async input => {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerNativeFileReconciliationSubmission(input.submission);
    const signal = input.signal ?? new AbortController().signal; signal.throwIfAborted();
    const lookupInput = { ...authority, submission: { kind: "runtime.result.lookup" as const, nonce: submission.nonce, requestSha256: submission.requestSha256 } };
    const lookup = normalizeRemoteWorkerRuntimeResultExchange(await storage.remoteWorkerRuntimeResults.exchangePageForAssignment(lookupInput));
    signal.throwIfAborted(); let settlement = null;
    if (lookup.record) {
      const query = { ...authority, nonce: submission.nonce, requestSha256: submission.requestSha256 };
      const completed = transfers ? await transfers.complete({ ...query, signal }) : null;
      signal.throwIfAborted();
      const receipt = await storage.remoteWorkerNativeFileReceipts.findForAssignment(query);
      signal.throwIfAborted();
      if (completed && !receipt) throw rejected("Native transfer completion lost its canonical receipt.");
      if (receipt) {
        if (receipt.receipt.resultSha256 !== lookup.record.resultSha256) throw rejected("Native file receipt differs from the retained result.");
        const settled = completed ?? await artifacts.settle({ ...query, signal });
        signal.throwIfAborted();
        if (settled.receiptSha256 !== receipt.receiptSha256) throw rejected("Native file settlement receipt changed.");
        const current = await storage.remoteWorkerRuntimeResults.exchangePageForAssignment(lookupInput);
        signal.throwIfAborted();
        if (canonicalJsonString(current) !== canonicalJsonString(lookup)) throw rejected("Native result changed during file reconciliation.");
        settlement = { receiptSha256: settled.receiptSha256, manifestSha256: settled.manifestSha256, uploadId: settled.uploadId };
      }
    }
    return normalizeRemoteWorkerNativeFileReconciliationExchange({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECONCILIATION_SCHEMA,
      challenge: submission.challenge, lookup, settlement });
  } };
}
export async function reconcileRemoteWorkerNativeFiles(owner: RemoteWorkerNativeFileReconciliationPort | undefined, input: Input) {
  if (!owner) throw rejected("Native file reconciliation is unavailable.");
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = normalizeRemoteWorkerNativeFileReconciliationSubmission(input.submission), signal = input.signal;
  signal?.throwIfAborted();
  const response = normalizeRemoteWorkerNativeFileReconciliationExchange(await owner.reconcile({ ...authority, submission, signal }));
  signal?.throwIfAborted(); const lookup = response.lookup;
  if (response.challenge !== submission.challenge || lookup.registryWorkspaceId !== authority.registryWorkspaceId || lookup.assignmentId !== authority.assignmentId ||
      lookup.assignmentGeneration !== authority.assignmentGeneration || lookup.leaseRevision !== authority.leaseRevision ||
      lookup.nonce !== submission.nonce || lookup.requestSha256 !== submission.requestSha256) throw rejected("Native file reconciliation differs from its protected request.");
  return response;
}
