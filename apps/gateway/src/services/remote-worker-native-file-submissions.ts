import { normalizeRemoteWorkerNativeFileGrantSubmission, normalizeRemoteWorkerNativeFileReconciliationSubmission,
  normalizeRemoteWorkerNativeFileTransferBegin, normalizeRemoteWorkerNativeFileTransferPage, normalizeRemoteWorkerNativeFileTransferExchange,
  REMOTE_WORKER_NATIVE_FILE_TRANSFER_EXCHANGE_SCHEMA, remoteWorkerNativeFileReceiptSha256,
  type RemoteWorkerNativeFileGrantSubmission, type RemoteWorkerNativeFileReconciliationSubmission, type RemoteWorkerNativeFileTransferBegin,
  type RemoteWorkerNativeFileTransferPage, type RemoteWorkerNativeFileGrantReceipt, type RemoteWorkerNativeFileReconciliationExchange, type RemoteWorkerNativeFileTransferExchange } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import { authorizeRemoteWorkerNativeFile, type RemoteWorkerNativeFileGrantPort } from "./remote-worker-native-file-grant.js";
import { reconcileRemoteWorkerNativeFiles, type RemoteWorkerNativeFileReconciliationPort } from "./remote-worker-native-file-reconciliation.js";
import type { RemoteWorkerNativeFileTransferService } from "./remote-worker-native-file-transfer.js";
import { rejected } from "./remote-worker-assignment-execution-validators.js";
export interface RemoteWorkerNativeFileSubmissionOwners {
  readonly nativeFileAuthorization?: RemoteWorkerNativeFileGrantPort;
  readonly nativeFileReconciliation?: RemoteWorkerNativeFileReconciliationPort;
  readonly nativeFileTransfers?: Pick<RemoteWorkerNativeFileTransferService, "begin" | "append">;
}
export type NativeFileSubmissionResult =
  | Readonly<{ disposition: "native_file_grant"; nativeFileGrant: RemoteWorkerNativeFileGrantReceipt }>
  | Readonly<{ disposition: "native_file_reconciliation"; nativeFileReconciliation: RemoteWorkerNativeFileReconciliationExchange }>
  | Readonly<{ disposition: "native_file_transfer"; nativeFileTransfer: RemoteWorkerNativeFileTransferExchange }>;
export type NativeFileSubmission = RemoteWorkerNativeFileGrantSubmission | RemoteWorkerNativeFileReconciliationSubmission | RemoteWorkerNativeFileTransferBegin | RemoteWorkerNativeFileTransferPage;
export function isNativeFileSubmission(value: { kind: string }): value is NativeFileSubmission {
  return ["runtime.file.authorize", "runtime.files.reconcile", "runtime.files.begin", "runtime.files.page"].includes(value.kind);
}

/** Native file operations remain within the existing signed settlement route.
 * No worker manifest, verifier choice or approval claim is accepted here. */
export async function dispatchNativeFileSubmission(owners: RemoteWorkerNativeFileSubmissionOwners,
  input: ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority> & { submission: NativeFileSubmission; signal: AbortSignal }): Promise<NativeFileSubmissionResult> {
  const kind = input.submission.kind;
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), signal = input.signal;
  signal.throwIfAborted();
  if (kind === "runtime.file.authorize") return { disposition: "native_file_grant", nativeFileGrant: await authorizeRemoteWorkerNativeFile(owners.nativeFileAuthorization,
    { ...authority, submission: normalizeRemoteWorkerNativeFileGrantSubmission(input.submission), signal }) };
  if (kind === "runtime.files.reconcile") return { disposition: "native_file_reconciliation", nativeFileReconciliation: await reconcileRemoteWorkerNativeFiles(owners.nativeFileReconciliation,
    { ...authority, submission: normalizeRemoteWorkerNativeFileReconciliationSubmission(input.submission), signal }) };
  if (!owners.nativeFileTransfers) throw rejected("Native file transfer is unavailable.");
  let nonce: string, requestSha256: string, transferSha256: string;
  let acceptedPage: RemoteWorkerNativeFileTransferExchange["acceptedPage"] = null;
  if (kind === "runtime.files.begin") {
    const submission = normalizeRemoteWorkerNativeFileTransferBegin(input.submission), declaration = submission.declaration;
    if (declaration.disclosure.registryWorkspaceId !== authority.registryWorkspaceId || declaration.disclosure.assignmentId !== authority.assignmentId || declaration.disclosure.assignmentGeneration !== authority.assignmentGeneration)
      throw rejected("Native file transfer differs from its assignment.");
    ({ nonce, requestSha256 } = declaration.disclosure); transferSha256 = remoteWorkerNativeFileReceiptSha256(declaration);
    const saved = await owners.nativeFileTransfers.begin({ ...authority, declaration, signal });
    if (saved.transferSha256 !== transferSha256 || remoteWorkerNativeFileReceiptSha256(saved.declaration) !== transferSha256) throw rejected("Native file declaration changed.");
  } else {
    const page = normalizeRemoteWorkerNativeFileTransferPage(input.submission); ({ nonce, requestSha256, transferSha256 } = page);
    const saved = await owners.nativeFileTransfers.append({ ...authority, page, signal });
    if (saved.fileIndex !== page.fileIndex || saved.pageIndex !== page.pageIndex) throw rejected("Native file page changed.");
    acceptedPage = { fileIndex: saved.fileIndex, pageIndex: saved.pageIndex, pageSha256: saved.pageSha256 };
  }
  signal.throwIfAborted();
  return { disposition: "native_file_transfer", nativeFileTransfer: normalizeRemoteWorkerNativeFileTransferExchange({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_TRANSFER_EXCHANGE_SCHEMA,
    registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration,
    leaseRevision: authority.leaseRevision, nonce, requestSha256, transferSha256, acceptedPage }) };
}
