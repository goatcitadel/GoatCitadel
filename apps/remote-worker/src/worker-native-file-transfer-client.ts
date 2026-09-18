import { createHash } from "node:crypto";
import { canonicalJsonString, normalizeRemoteWorkerNativeFileStaging, normalizeRemoteWorkerNativeFileExportSelection,
  readRemoteWorkerNativeFileContent, normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256,
  REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA, REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES,
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, normalizeRemoteWorkerNativeFileTransferExchange,
  type RemoteWorkerNativeFileStaging, type RemoteWorkerRuntimeResultExpectation,
  type RemoteWorkerNativeFileTransferBegin, type RemoteWorkerNativeFileTransferPage } from "@goatcitadel/contracts";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { requestWorkerNativeFileGrant } from "./worker-native-file-grant-client.js";
import { reconcileWorkerNativeFiles } from "./worker-native-file-reconciliation-client.js";
import type { WindowsRuntimeReceivedFile } from "./worker-windows-runtime-files.js";
import type { WindowsWorkerAssignmentAuthority } from "./worker-windows-assignment-authority.js";
const refused = () => new Error("Native file transfer differs from its admitted batch or current Gateway acknowledgement.");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Copies the bounded complete batch before any asynchronous local callback.
 * Every request holds its current lease; stored pages alone never mean success. */
export async function transferWorkerNativeFiles(context: RouteContext, leaseOwner: Pick<WindowsWorkerAssignmentAuthority, "withCurrentLease">,
  expected: Pick<RemoteWorkerRuntimeResultExpectation, "nonce" | "requestSha256">, fileStaging: RemoteWorkerNativeFileStaging,
  received: readonly WindowsRuntimeReceivedFile[], signal: AbortSignal,
  beforeTransfer?: () => Promise<void>) {
  const captured = Object.freeze({ ...context, credential: Object.freeze({ ...context.credential }) });
  const plan = normalizeRemoteWorkerNativeFileStaging(fileStaging), key = Object.freeze({ nonce: expected.nonce, requestSha256: expected.requestSha256 });
  const files: WindowsRuntimeReceivedFile[] = [];
  try {
    signal.throwIfAborted();
    if (!Array.isArray(received) || received.length !== plan.paths.length) throw refused();
    let totalBytes = 0;
    for (let index = 0; index < received.length; index++) {
      const file = received[index]!, selection = normalizeRemoteWorkerNativeFileExportSelection(file.selection);
      totalBytes += selection.logicalFileBytes;
      if (selection.logicalPath !== plan.paths[index] || selection.maximumBytes !== plan.maximumFileBytes || totalBytes > plan.maximumTotalBytes ||
          selection.nonce !== key.nonce || selection.requestSha256 !== key.requestSha256 || !Buffer.isBuffer(file.record) ||
          file.record.length !== 200 + selection.logicalFileBytes) throw refused();
      files.push({ selection, record: Buffer.from(file.record) });
    }
    const verified = files.map(file => {
      const content = readRemoteWorkerNativeFileContent(file.record.toString("hex"), file.selection);
      return { selection: file.selection, recordSha256: content.recordSha256, contentSha256: content.contentSha256 };
    });
    if (verified.some(file => file.selection.resultSha256 !== verified[0]!.selection.resultSha256)) throw refused();
    await beforeTransfer?.(); signal.throwIfAborted();
    const grants: Awaited<ReturnType<typeof requestWorkerNativeFileGrant>>[] = [];
    for (const file of files) grants.push(await leaseOwner.withCurrentLease(lease => requestWorkerNativeFileGrant(captured, lease, file.selection, plan, signal)));
    if (grants.some(grant => canonicalJsonString(grant.disclosure) !== canonicalJsonString(grants[0]!.disclosure))) throw refused();
    const declaration = normalizeRemoteWorkerNativeFileReceipt({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA,
      disclosure: grants[0]!.disclosure, fileStaging: plan, resultSha256: verified[0]!.selection.resultSha256, totalBytes,
      files: verified.map(file => ({ selection: file.selection, recordSha256: file.recordSha256, contentSha256: file.contentSha256 })) });
    const transferSha256 = remoteWorkerNativeFileReceiptSha256(declaration);
    const send = async (lease: LeaseBinding, submission: RemoteWorkerNativeFileTransferBegin | RemoteWorkerNativeFileTransferPage) => {
      const binding = Object.freeze({ ...lease }), disclosure = declaration.disclosure;
      if (binding.registryWorkspaceId !== disclosure.registryWorkspaceId || binding.assignmentId !== disclosure.assignmentId ||
          binding.assignmentGeneration !== disclosure.assignmentGeneration) throw refused();
      const stop = AbortSignal.any([signal, AbortSignal.timeout(10000)]); stop.throwIfAborted();
      const response = await callProtectedRoute({ ...captured, rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
        operation: "assignment.settlement.submit", idempotencyKey: `native-file-transfer:${sha256Utf8(canonicalJsonString({ ...binding, submission }))}`,
        signal: stop, payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION, ...binding, submission } });
      stop.throwIfAborted();
      const body = response.body, ack = normalizeRemoteWorkerNativeFileTransferExchange(body.nativeFileTransfer);
      const acceptedPage = submission.kind === "runtime.files.begin" ? null : { fileIndex: submission.fileIndex,
        pageIndex: submission.pageIndex, pageSha256: hash(Buffer.from(submission.bytesHex, "hex")) };
      if (body.schemaVersion !== "goatcitadel.remote-worker-assignment-execution-response.v1" || body.operation !== "assignment.settlement.submit" ||
          body.disposition !== "native_file_transfer" || body.registryWorkspaceId !== binding.registryWorkspaceId || ack.registryWorkspaceId !== binding.registryWorkspaceId ||
          ack.assignmentId !== binding.assignmentId || ack.assignmentGeneration !== binding.assignmentGeneration || ack.leaseRevision !== binding.leaseRevision ||
          ack.nonce !== key.nonce || ack.requestSha256 !== key.requestSha256 || ack.transferSha256 !== transferSha256 ||
          canonicalJsonString(ack.acceptedPage) !== canonicalJsonString(acceptedPage)) throw refused();
    };
    await leaseOwner.withCurrentLease(lease => send(lease, { kind: "runtime.files.begin", declaration }));
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const record = files[fileIndex]!.record;
      for (let offset = 0, pageIndex = 0; offset < record.length; offset += REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES, pageIndex++) {
        signal.throwIfAborted();
        const submission: RemoteWorkerNativeFileTransferPage = { kind: "runtime.files.page", ...key, transferSha256, fileIndex, pageIndex,
          bytesHex: record.subarray(offset, offset + REMOTE_WORKER_NATIVE_FILE_PAGE_BYTES).toString("hex") };
        await leaseOwner.withCurrentLease(lease => send(lease, submission));
      }
    }
    const result = await leaseOwner.withCurrentLease(lease => reconcileWorkerNativeFiles(captured, lease, key, signal));
    signal.throwIfAborted();
    if (result.settlement?.receiptSha256 !== transferSha256 || result.lookup.record?.resultSha256 !== declaration.resultSha256) throw refused();
    return result;
  } finally { for (const file of files) file.record.fill(0); }
}
