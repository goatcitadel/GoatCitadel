import { createHash } from "node:crypto";
import { canonicalJsonString, ConflictError, NotFoundError, normalizeRemoteWorkerNativeFileReceipt,
  remoteWorkerNativeFileReceiptSha256, normalizeRemoteWorkerRuntimeReadKey, createRemoteWorkerNativeArtifactManifest,
  remoteWorkerArtifactManifestSha256 } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
export interface NativeFileOperatorKey { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number; nonce: string }
const refused = () => new ConflictError({ message: "Native file artifact differs from its verified receipt." });
function key(input: NativeFileOperatorKey): NativeFileOperatorKey {
  if (!Number.isSafeInteger(input.assignmentGeneration) || input.assignmentGeneration < 1 || input.assignmentGeneration > 2147483647 ||
      typeof input.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(input.nonce) || /^0+$/u.test(input.nonce)) throw refused();
  return Object.freeze({ ...normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId }), assignmentGeneration: input.assignmentGeneration, nonce: input.nonce });
}
/** Operator-authorized historical content access. This is not a worker grant,
 * model context producer, or evidence that the contents are safe to execute. */
export class RemoteWorkerNativeFileOperator {
  constructor(private readonly receipts: Pick<AsyncStorage["remoteWorkerNativeFileReceipts"], "readVerifiedForOperator">,
    private readonly cas: Pick<RemoteWorkerArtifactStore, "readBlob">) {}
  private async read(scope: NativeFileOperatorKey, signal: AbortSignal) {
    signal.throwIfAborted();
    const saved = await this.receipts.readVerifiedForOperator(scope); signal.throwIfAborted();
    if (!saved) throw new NotFoundError({ entity: "Verified native files", id: scope.nonce });
    const receipt = normalizeRemoteWorkerNativeFileReceipt(saved.receipt), disclosure = receipt.disclosure;
    if (disclosure.registryWorkspaceId !== scope.registryWorkspaceId || disclosure.assignmentId !== scope.assignmentId ||
        disclosure.assignmentGeneration !== scope.assignmentGeneration || disclosure.nonce !== scope.nonce ||
        saved.receiptSha256 !== remoteWorkerNativeFileReceiptSha256(receipt) ||
        remoteWorkerArtifactManifestSha256(saved.manifest) !== remoteWorkerArtifactManifestSha256(createRemoteWorkerNativeArtifactManifest({ receipt, identity: saved.manifest.identity }))) throw refused();
    return { receipt, receiptSha256: saved.receiptSha256, manifestSha256: remoteWorkerArtifactManifestSha256(saved.manifest) };
  }
  public async list(input: NativeFileOperatorKey, signal: AbortSignal) {
    const scope = key(input), saved = await this.read(scope, signal);
    return { ...scope, receiptSha256: saved.receiptSha256, files: saved.receipt.files.map((file, fileIndex) => ({ fileIndex,
      logicalPath: file.selection.logicalPath, byteCount: file.selection.logicalFileBytes, sha256: file.contentSha256 })) };
  }
  public async download(input: NativeFileOperatorKey & { fileIndex: number }, signal: AbortSignal) {
    const scope = key(input), fileIndex = input.fileIndex;
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex > 63) throw refused();
    const saved = await this.read(scope, signal), file = saved.receipt.files[fileIndex];
    if (!file) throw new NotFoundError({ entity: "Native file", id: String(fileIndex) });
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.cas.readBlob({ executionWorkspaceId: saved.receipt.disclosure.executionWorkspaceId, blobSha256: file.contentSha256,
        expectedByteCount: file.selection.logicalFileBytes, signal });
      signal.throwIfAborted();
      if (bytes.byteLength !== file.selection.logicalFileBytes || createHash("sha256").update(bytes).digest("hex") !== file.contentSha256) throw refused();
      const current = await this.read(scope, signal);
      if (canonicalJsonString(current) !== canonicalJsonString(saved)) throw refused();
      // Never use worker-controlled path text in a response header.
      return { fileName: `native-${scope.nonce.slice(0, 16)}-${fileIndex}.bin`, contentType: "application/octet-stream",
        sha256: file.contentSha256, content: Buffer.from(bytes) };
    } finally { bytes?.fill(0); }
  }
}
