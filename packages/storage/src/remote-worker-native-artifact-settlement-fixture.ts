import assert from "node:assert/strict";
import { createRemoteWorkerNativeArtifactManifest, remoteWorkerArtifactManifestSha256, remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactWorkspaceShard, REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  type RemoteWorkerVerificationEvidence } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import type { RemoteWorkerNativeFileReceiptRecord } from "./remote-worker-native-file-receipt-repo.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

/** Real immutable artifact/verification rows. CAS bytes are covered separately
 * by the Gateway file-store tests; this fixture supplies controlled blob refs. */
export function verifyNativeArtifactSettlement(db: DatabaseClient, retained: RemoteWorkerNativeFileReceiptRecord) {
  const repo = new RemoteWorkerArtifactRepository(db), receipt = retained.receipt, scope = receipt.disclosure;
  const key = { registryWorkspaceId: scope.registryWorkspaceId, assignmentId: scope.assignmentId, assignmentGeneration: scope.assignmentGeneration };
  const expiresAt = new Date(Date.parse(new DurableRunRepository(db).readDatabaseNow()) + 300_000).toISOString();
  const command = { ...key, uploadAttempt: 1, declaredFileCount: receipt.files.length, declaredTotalBytes: receipt.totalBytes,
    stagingRootSha256: retained.receiptSha256, expiresAt, idempotencyKey: "native-artifact-open" };
  const upload = repo.openUpload(command), manifest = createRemoteWorkerNativeArtifactManifest({ receipt, identity: upload.identity });
  assert.deepEqual(repo.openUpload(command), upload);
  const manifestSha256 = remoteWorkerArtifactManifestSha256(manifest);
  const commit = { ...key, uploadId: upload.uploadId, manifest, idempotencyKey: "native-artifact-commit", blobs: receipt.files.map(file => ({
    blobSha256: file.contentSha256, byteCount: file.selection.logicalFileBytes,
    physicalRelPath: remoteWorkerArtifactBlobRelPath(remoteWorkerArtifactWorkspaceShard(scope.executionWorkspaceId), file.contentSha256) })) };
  assert.equal(repo.commitArtifact(commit).verificationGateState, "pending");
  assert.equal(repo.getVerifiedManifest(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration), undefined);
  const evidence = (attemptState: "queued" | "running" | "passed"): RemoteWorkerVerificationEvidence => ({
    schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION, kind: "gateway_attempt", attemptState,
    verifierProfileSha256: manifest.requiredVerifierProfileSha256, preExecutionManifestSha256: manifestSha256,
    postExecutionManifestSha256: manifestSha256, capturedOutputBytes: 0, summary: "native_receipt_cas_integrity" });
  const verify = () => {
    const attempt = repo.openGatewayVerification({ ...key, attemptIndex: 1, verifierProfileSha256: manifest.requiredVerifierProfileSha256!,
      wallDeadlineAt: expiresAt, evidence: evidence("queued"), idempotencyKey: "native-artifact-verify" });
    repo.advanceGatewayVerification({ ...key, verificationId: attempt.verificationId, expectedAttemptRevision: 1,
      nextState: "running", evidence: evidence("running") });
    repo.advanceGatewayVerification({ ...key, verificationId: attempt.verificationId, expectedAttemptRevision: 2,
      nextState: "passed", evidence: evidence("passed") });
  };
  const interrupted = new Error("controlled verification interruption");
  assert.throws(() => db.transaction("immediate", () => { verify(); throw interrupted; }), error => error === interrupted);
  assert.equal(repo.getUpload(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration, upload.uploadId).verificationGateState, "pending");
  assert.equal(repo.getVerifiedManifest(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration), undefined);
  db.transaction("immediate", verify);
  assert.deepEqual(new RemoteWorkerArtifactRepository(db).getVerifiedManifest(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration), manifest);
  assert.equal(repo.commitArtifact(commit).committedManifestSha256, manifestSha256, "exact committed replay survives owner reconstruction");
}
