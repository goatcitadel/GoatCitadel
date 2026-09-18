import { createHash } from "node:crypto";
import { createRemoteWorkerNativeArtifactManifest, remoteWorkerArtifactManifestSha256, REMOTE_WORKER_SETTLEMENT_BOUNDS,
  REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type RemoteWorkerVerificationEvidence } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority, type AsyncStorage } from "@goatcitadel/storage";
import { RemoteWorkerNativeArtifactStore } from "./remote-worker-native-artifact-store.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { RemoteWorkerArtifactSettlementService } from "./remote-worker-artifact-settlement-service.js";

type Storage = Pick<AsyncStorage, "remoteWorkerArtifacts" | "runImmediateTransaction">;
type Input = Parameters<RemoteWorkerNativeArtifactStore["recover"]>[0];

/** Internal native-receiver settlement. Only the Gateway derives the manifest
 * and verifier profile from a retained, currently authorized complete receipt. */
export class RemoteWorkerNativeArtifactSettlement {
  constructor(private readonly storage: Storage, private readonly nativeArtifacts: Pick<RemoteWorkerNativeArtifactStore, "authorizeReceipt" | "recover">,
    private readonly cas: RemoteWorkerArtifactStore) {}

  public async settle(input: Input) {
    const signal = input.signal, authority = snapshotRemoteWorkerCellCapacityAuthority(input);
    const lookup = { ...authority, nonce: input.nonce, requestSha256: input.requestSha256, signal };
    signal.throwIfAborted();
    const initial = await this.nativeArtifacts.authorizeReceipt(lookup), retained = initial.retained;
    const recovered = await this.nativeArtifacts.recover(lookup);
    if (!recovered) throw new Error("Native artifact bytes require recovery before settlement.");
    try {
      if (recovered.retained.receiptSha256 !== retained.receiptSha256) throw new Error("Native artifact recovery receipt changed.");
      const assertCurrent = async () => {
        const current = await this.nativeArtifacts.authorizeReceipt(lookup);
        if (current.retained.receiptSha256 !== retained.receiptSha256) throw new Error("Native artifact settlement receipt changed.");
      };
      const underFence = async <T>(work: () => Promise<T>): Promise<T> => this.storage.runImmediateTransaction(async () => {
        await assertCurrent(); const result = await work(); await assertCurrent(); return result;
      });
      const owner = new RemoteWorkerArtifactSettlementService({ store: this.cas, authority: { assertLiveAuthority: assertCurrent }, repository: {
        openUpload: command => underFence(() => this.storage.remoteWorkerArtifacts.openUpload(command)),
        appendPart: command => underFence(() => this.storage.remoteWorkerArtifacts.appendPart(command)),
        commitArtifact: command => underFence(() => this.storage.remoteWorkerArtifacts.commitArtifact(command)),
      } });
      const key = { registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration };
      const prefix = `native-files:${authority.assignmentId}:${authority.assignmentGeneration}:${lookup.nonce}`;
      const expiry = Math.min(Date.parse(retained.recordedAt) + 900_000, Date.parse(initial.active.assignment.manifest.deadlineAt));
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Native artifact settlement deadline expired.");
      const upload = await owner.openUpload({ ...authority, uploadAttempt: 1, declaredFileCount: retained.receipt.files.length,
        declaredTotalBytes: retained.receipt.totalBytes, stagingRootSha256: retained.receiptSha256,
        expiresAt: new Date(expiry).toISOString(), idempotencyKey: `${prefix}:open` });
      if (upload.stagingRootSha256 !== retained.receiptSha256 || upload.declaredFileCount !== retained.receipt.files.length ||
          upload.declaredTotalBytes !== retained.receipt.totalBytes) throw new Error("Native artifact upload differs from its receipt.");
      const manifest = createRemoteWorkerNativeArtifactManifest({ receipt: retained.receipt, identity: upload.identity });
      const manifestSha256 = remoteWorkerArtifactManifestSha256(manifest);
      if (upload.committedManifestSha256 && upload.committedManifestSha256 !== manifestSha256) throw new Error("Native artifact manifest conflicts with its receipt.");
      if (!upload.committedManifestSha256) {
        let globalSequence = 0;
        for (const [index, file] of recovered.files.entries()) {
          const entry = manifest.entries[index]!;
          for (let offset = 0, filePartIndex = 0; offset < file.bytes.byteLength; offset += REMOTE_WORKER_SETTLEMENT_BOUNDS.maxPartBytes, filePartIndex++) {
            const part = file.bytes.subarray(offset, offset + REMOTE_WORKER_SETTLEMENT_BOUNDS.maxPartBytes);
            await owner.appendPart({ ...authority, uploadId: upload.uploadId, idempotencyKey: `${prefix}:part:${++globalSequence}`, part: {
              globalSequence, logicalPathSha256: entry.logicalPathSha256, filePartIndex, isFinalPart: offset + part.length === file.bytes.length,
              partBytes: part.length, partSha256: createHash("sha256").update(part).digest("hex") } });
          }
        }
        await owner.commitArtifact({ ...authority, uploadId: upload.uploadId, manifest, idempotencyKey: `${prefix}:commit`, signal,
          files: recovered.files.map((file, index) => ({ logicalPath: manifest.entries[index]!.logicalPath,
            logicalPathSha256: manifest.entries[index]!.logicalPathSha256, mimeType: "application/octet-stream", bytes: file.bytes })) });
      }
      return await underFence(async () => {
        const current = await this.storage.remoteWorkerArtifacts.getUpload(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration, upload.uploadId);
        if (current.committedManifestSha256 !== manifestSha256) throw new Error("Native artifact commit is not retained.");
        // Verification transitions are one transaction. A crash cannot leave a
        // half-advanced native verifier that would need execution replay.
        if (current.verificationGateState !== "satisfied") {
          const evidence = (attemptState: "queued" | "running" | "passed"): RemoteWorkerVerificationEvidence => ({
            schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION, kind: "gateway_attempt", attemptState,
            verifierProfileSha256: manifest.requiredVerifierProfileSha256, preExecutionManifestSha256: manifestSha256,
            postExecutionManifestSha256: manifestSha256, capturedOutputBytes: 0, summary: "native_receipt_cas_integrity" });
          const attempt = await this.storage.remoteWorkerArtifacts.openGatewayVerification({ ...key, attemptIndex: 1,
            verifierProfileSha256: manifest.requiredVerifierProfileSha256!, wallDeadlineAt: upload.expiresAt, evidence: evidence("queued"), idempotencyKey: `${prefix}:verify` });
          await this.storage.remoteWorkerArtifacts.advanceGatewayVerification({ ...key, verificationId: attempt.verificationId,
            expectedAttemptRevision: 1, nextState: "running", evidence: evidence("running") });
          const checked = await this.nativeArtifacts.recover(lookup);
          try {
            if (!checked || checked.retained.receiptSha256 !== retained.receiptSha256) throw new Error("Native artifact verification lost its receipt.");
          } finally { checked?.files.forEach(file => file.bytes.fill(0)); }
          await assertCurrent();
          await this.storage.remoteWorkerArtifacts.advanceGatewayVerification({ ...key, verificationId: attempt.verificationId,
            expectedAttemptRevision: 2, nextState: "passed", evidence: evidence("passed") });
        }
        const verified = await this.storage.remoteWorkerArtifacts.getVerifiedManifest(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration);
        if (!verified || remoteWorkerArtifactManifestSha256(verified) !== manifestSha256) throw new Error("Native artifact verification is incomplete.");
        return Object.freeze({ uploadId: upload.uploadId, manifest: verified, manifestSha256, receiptSha256: retained.receiptSha256 });
      });
    } finally { recovered.files.forEach(file => file.bytes.fill(0)); }
  }
}
