import { canonicalJsonString, normalizeRemoteWorkerNativeFileStaging, normalizeRemoteWorkerNativeFileExportSelection,
  normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256, REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage, type RemoteWorkerNativeFileReceiptRecord } from "@goatcitadel/storage";
import type { RemoteWorkerNativeFileValidationPort } from "./remote-worker-native-file-validation.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { createHash } from "node:crypto";

type Storage = Pick<AsyncStorage, "remoteWorkerNativeFileReceipts" | "remoteWorkerAssignments">;
type StageInput = Parameters<AsyncStorage["remoteWorkerNativeFileReceipts"]["retainForAssignment"]>[0] & { signal: AbortSignal };
type RecoveryInput = Parameters<AsyncStorage["remoteWorkerNativeFileReceipts"]["findForAssignment"]>[0] & { signal: AbortSignal };
type Authority = ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority>;

/** Protected native receiver with a separately exposed metadata authorization
 * check, not a raw-byte RPC or implicit model publication. CAS is installed before the durable complete-batch receipt.
 * Recovery reads that receipt and every blob; it never dispatches execution. */
export class RemoteWorkerNativeArtifactStore {
  constructor(private readonly storage: Storage, private readonly nativeFiles: RemoteWorkerNativeFileValidationPort,
    private readonly store: Pick<RemoteWorkerArtifactStore, "installBlob" | "readBlob">) {}

  /** Authorizes one immediate transfer boundary, without accepting any bytes or
   * issuing a reusable grant. Complete-batch limits are enforced again at stage. */
  public async authorizeFile(input: Parameters<RemoteWorkerNativeFileValidationPort["authorize"]>[0] & { signal: AbortSignal }) {
    const signal = input.signal, authority = snapshotRemoteWorkerCellCapacityAuthority(input);
    const selection = normalizeRemoteWorkerNativeFileExportSelection(input.selection), fileStaging = normalizeRemoteWorkerNativeFileStaging(input.fileStaging);
    await this.assertCapability(authority, signal);
    const authorized = await this.nativeFiles.authorize({ ...authority, selection, fileStaging, signal });
    await this.assertCapability(authority, signal, { disclosure: authorized.disclosure, totalBytes: authorized.selection.logicalFileBytes });
    return authorized;
  }

  public async stage(input: StageInput): Promise<RemoteWorkerNativeFileReceiptRecord> {
    const signal = input.signal; signal.throwIfAborted();
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), fileStaging = normalizeRemoteWorkerNativeFileStaging(input.fileStaging);
    if (!Array.isArray(input.files) || input.files.length !== fileStaging.paths.length) throw new Error("Native artifact batch is incomplete.");
    const files = Array.from(input.files, (file, index) => {
      const selection = normalizeRemoteWorkerNativeFileExportSelection(file?.selection), recordHex = file?.recordHex;
      if (selection.logicalPath !== fileStaging.paths[index] || typeof recordHex !== "string" || recordHex.length > 2 * (fileStaging.maximumFileBytes + 200))
        throw new Error("Native artifact batch differs from its approved file plan.");
      return { selection, recordHex };
    });
    await this.assertCapability(authority, signal);
    const verified: Awaited<ReturnType<RemoteWorkerNativeFileValidationPort["validateDisclosed"]>>[] = [];
    for (const file of files) verified.push(await this.nativeFiles.validateDisclosed({ ...authority, ...file, fileStaging, signal }));
    if (verified.some(file => canonicalJsonString(file.disclosure) !== canonicalJsonString(verified[0]!.disclosure)))
      throw new Error("Native artifact batch has inconsistent disclosure scope.");
    const receipt = normalizeRemoteWorkerNativeFileReceipt({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA,
      disclosure: verified[0]!.disclosure, fileStaging, resultSha256: verified[0]!.selection.resultSha256,
      totalBytes: verified.reduce((sum, file) => sum + file.content.byteLength, 0), files: verified.map(file => ({ selection: file.selection,
        contentSha256: file.content.contentSha256, recordSha256: file.content.recordSha256 })) });
    for (const file of verified) {
      const guard = { ...authority, selection: file.selection, fileStaging, signal };
      await this.assertCapability(authority, signal, receipt);
      await this.nativeFiles.authorize(guard);
      const bytes = Buffer.from(file.content.contentHex, "hex");
      try {
        const installed = await this.store.installBlob({ executionWorkspaceId: receipt.disclosure.executionWorkspaceId,
          blobSha256: file.content.contentSha256, bytes, signal });
        if (installed.blobSha256 !== file.content.contentSha256 || installed.byteCount !== file.content.byteLength)
          throw new Error("Native artifact installation differs from retained content.");
      } finally { bytes.fill(0); }
      await this.nativeFiles.authorize(guard);
    }
    await this.assertCapability(authority, signal, receipt);
    const retained = await this.storage.remoteWorkerNativeFileReceipts.retainForAssignment({ ...authority, fileStaging, files });
    signal.throwIfAborted();
    const checked = this.checked(retained);
    if (checked.receiptSha256 !== remoteWorkerNativeFileReceiptSha256(receipt)) throw new Error("Native artifact receipt changed during retention.");
    return checked;
  }

  /** Returned buffers belong to the internal settlement caller and must be wiped
   * after use. No partial batch is returned on failure, cancellation or revocation. */
  public async recover(input: RecoveryInput) {
    const signal = input.signal; signal.throwIfAborted();
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = input.nonce, requestSha256 = input.requestSha256;
    await this.assertCapability(authority, signal);
    const lookup = { ...authority, nonce, requestSha256 };
    const saved = await this.storage.remoteWorkerNativeFileReceipts.findForAssignment(lookup);
    signal.throwIfAborted(); if (!saved) return null;
    const retained = this.checked(saved), receipt = retained.receipt;
    if (receipt.disclosure.nonce !== nonce || receipt.disclosure.requestSha256 !== requestSha256) throw new Error("Native artifact recovery scope changed.");
    const files: { selection: typeof receipt.files[number]["selection"]; bytes: Uint8Array }[] = [];
    try {
      for (const file of receipt.files) {
        await this.assertCapability(authority, signal, receipt);
        await this.nativeFiles.authorize({ ...authority, fileStaging: receipt.fileStaging, selection: file.selection, signal });
        const bytes = await this.store.readBlob({ executionWorkspaceId: receipt.disclosure.executionWorkspaceId,
          blobSha256: file.contentSha256, expectedByteCount: file.selection.logicalFileBytes, signal });
        files.push({ selection: file.selection, bytes });
        if (bytes.byteLength !== file.selection.logicalFileBytes || createHash("sha256").update(bytes).digest("hex") !== file.contentSha256)
          throw new Error("Native artifact content differs from its receipt.");
      }
      const current = await this.storage.remoteWorkerNativeFileReceipts.findForAssignment(lookup);
      signal.throwIfAborted();
      if (!current || this.checked(current).receiptSha256 !== retained.receiptSha256) throw new Error("Native artifact receipt is no longer current.");
      await this.assertCapability(authority, signal, receipt);
      return Object.freeze({ retained, files: Object.freeze(files.map(file => Object.freeze(file))) });
    } catch (error) { for (const file of files) file.bytes.fill(0); throw error; }
  }

  private checked(value: RemoteWorkerNativeFileReceiptRecord): RemoteWorkerNativeFileReceiptRecord {
    const receipt = normalizeRemoteWorkerNativeFileReceipt(value.receipt);
    if (remoteWorkerNativeFileReceiptSha256(receipt) !== value.receiptSha256) throw new Error("Native artifact receipt integrity failed.");
    return Object.freeze({ ...value, receipt });
  }
  public async authorizeReceipt(input: RecoveryInput) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), signal = input.signal;
    const nonce = input.nonce, requestSha256 = input.requestSha256;
    signal.throwIfAborted();
    const saved = await this.storage.remoteWorkerNativeFileReceipts.findForAssignment({ ...authority, nonce, requestSha256 });
    signal.throwIfAborted();
    if (!saved) throw new Error("Native artifact receipt is not retained.");
    const retained = this.checked(saved);
    if (retained.receipt.disclosure.nonce !== nonce || retained.receipt.disclosure.requestSha256 !== requestSha256)
      throw new Error("Native artifact receipt differs from the requested execution.");
    const active = await this.assertCapability(authority, signal, retained.receipt);
    return { retained, active };
  }
  private async assertCapability(authority: Authority, signal: AbortSignal, receipt?: Pick<ReturnType<typeof normalizeRemoteWorkerNativeFileReceipt>, "disclosure" | "totalBytes">) {
    signal.throwIfAborted();
    const active = await this.storage.remoteWorkerAssignments.resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, authority.protectedAuthority);
    signal.throwIfAborted();
    if (!active || active.assignment.registryWorkspaceId !== authority.registryWorkspaceId || active.assignment.assignmentId !== authority.assignmentId ||
        active.generation.assignmentGeneration !== authority.assignmentGeneration || active.lease.leaseRevision !== authority.leaseRevision ||
        !active.assignment.manifest.requiredCapabilityClasses.includes("artifact_stage") ||
        (receipt && (receipt.disclosure.registryWorkspaceId !== authority.registryWorkspaceId || receipt.disclosure.assignmentId !== authority.assignmentId ||
          receipt.disclosure.assignmentGeneration !== authority.assignmentGeneration ||
          active.assignment.manifest.executionWorkspaceId !== receipt.disclosure.executionWorkspaceId ||
          active.assignment.manifest.pathJailSha256 !== receipt.disclosure.pathJailSha256 ||
          !Number.isSafeInteger(active.assignment.manifest.maxArtifactBytes) || receipt.totalBytes > active.assignment.manifest.maxArtifactBytes)))
      throw new Error("Native artifact staging requires current assignment and artifact capability authority.");
    return active;
  }
}
