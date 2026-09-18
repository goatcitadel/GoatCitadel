import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256 } from "./remote-worker-native-file-receipt.js";
import { normalizeRemoteWorkerArtifactManifest, normalizeRemoteWorkerSettlementIdentity,
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, type RemoteWorkerSettlementIdentity } from "./remote-worker-settlement.js";

/** Server-owned, receipt-parameterized integrity verification; no uploaded code
 * execution, content-quality claim, model access or native-origin attestation. */
export function remoteWorkerNativeArtifactVerifierSha256(receipt: unknown): string {
  return sha256Hex(canonicalJsonString({ schemaVersion: "goatcitadel.native-artifact-verifier.v1",
    policy: "retained_receipt_and_cas_content_integrity", receiptSha256: remoteWorkerNativeFileReceiptSha256(receipt) }));
}
export function createRemoteWorkerNativeArtifactManifest(input: { receipt: unknown; identity: RemoteWorkerSettlementIdentity }) {
  const receipt = normalizeRemoteWorkerNativeFileReceipt(input.receipt), identity = normalizeRemoteWorkerSettlementIdentity(input.identity);
  const scope = receipt.disclosure;
  if (identity.registryWorkspaceId !== scope.registryWorkspaceId || identity.executionWorkspaceId !== scope.executionWorkspaceId ||
      identity.assignmentId !== scope.assignmentId || identity.assignmentGeneration !== scope.assignmentGeneration)
    throw new TypeError("Native artifact manifest requires the receipt's exact assignment and workspace.");
  return normalizeRemoteWorkerArtifactManifest({ schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, identity,
    pathJailSha256: scope.pathJailSha256, workerClaimIds: [], workerClaimSha256: sha256Hex(canonicalJsonString([])),
    requiredVerifierProfileSha256: remoteWorkerNativeArtifactVerifierSha256(receipt), fileCount: receipt.files.length, totalBytes: receipt.totalBytes,
    entries: receipt.files.map((file, entryIndex) => ({ entryIndex, logicalPath: file.selection.logicalPath,
      logicalPathSha256: sha256Hex(canonicalJsonString({ logicalPath: file.selection.logicalPath })), blobSha256: file.contentSha256,
      byteCount: file.selection.logicalFileBytes, mimeType: "application/octet-stream" })) });
}
