/* eslint-disable max-lines -- HX-506 cross-dialect artifact fencing, replay, and mapping stay in one audited boundary. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  ValidationError,
  canonicalJsonString,
  normalizeRemoteWorkerArtifactManifest,
  normalizeRemoteWorkerArtifactPart,
  normalizeRemoteWorkerSettlementIdentity,
  normalizeRemoteWorkerVerificationEvidence,
  remoteWorkerArtifactManifestJson,
  remoteWorkerArtifactManifestSha256,
  remoteWorkerArtifactPartReplayMaterial,
  remoteWorkerVerificationAttemptCanTransition,
  remoteWorkerVerificationAttemptSatisfiesGate,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerArtifactPartDescriptor,
  type RemoteWorkerSettlementIdentity,
  type RemoteWorkerUploadState,
  type RemoteWorkerVerificationAttemptState,
  type RemoteWorkerVerificationEvidence,
  type RemoteWorkerVerificationKind,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface RemoteWorkerArtifactUploadRecord {
  identity: RemoteWorkerSettlementIdentity;
  uploadId: string;
  uploadAttempt: number;
  uploadState: RemoteWorkerUploadState;
  uploadRevision: number;
  declaredFileCount: number;
  declaredTotalBytes: number;
  maxArtifactBytes: number;
  stagingRootSha256: string;
  committedManifestSha256: string | null;
  verificationGateState: "not_required" | "pending" | "satisfied" | null;
  verificationGateRevision: number;
  cleanupState: "not_due" | "pending" | "cleaned" | "manual_reconciliation";
  cleanupRevision: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenRemoteWorkerUploadCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  uploadAttempt: number;
  declaredFileCount: number;
  declaredTotalBytes: number;
  stagingRootSha256: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface AppendRemoteWorkerPartCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  uploadId: string;
  part: RemoteWorkerArtifactPartDescriptor;
  idempotencyKey: string;
}

export interface RemoteWorkerBlobInput {
  blobSha256: string;
  byteCount: number;
  physicalRelPath: string;
}

export interface CommitRemoteWorkerArtifactCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  uploadId: string;
  manifest: RemoteWorkerArtifactManifest;
  blobs: readonly RemoteWorkerBlobInput[];
  idempotencyKey: string;
}

export interface TerminateRemoteWorkerUploadCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  uploadId: string;
  expectedUploadRevision: number;
  reason: "abandoned" | "quarantined";
}

export interface RecordRemoteWorkerVerificationClaimCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  attemptIndex: number;
  evidence: RemoteWorkerVerificationEvidence;
  idempotencyKey: string;
}

export interface OpenRemoteWorkerVerificationAttemptCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  attemptIndex: number;
  verifierProfileSha256: string;
  wallDeadlineAt: string;
  evidence: RemoteWorkerVerificationEvidence;
  idempotencyKey: string;
}

export interface AdvanceRemoteWorkerVerificationAttemptCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  verificationId: string;
  expectedAttemptRevision: number;
  nextState: RemoteWorkerVerificationAttemptState;
  evidence: RemoteWorkerVerificationEvidence;
}

export interface ClaimRemoteWorkerCleanupCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  uploadId: string;
  expectedCleanupRevision: number;
  claimOwner: string;
}

export interface ResolveRemoteWorkerCleanupCommand {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  uploadId: string;
  expectedCleanupRevision: number;
  claimOwner: string;
  resolution: "cleaned" | "manual_reconciliation";
}

interface UploadRow {
  registry_workspace_id: string;
  execution_workspace_id: string;
  assignment_id: string;
  assignment_generation: number;
  worker_id: string;
  worker_generation: number;
  runtime_manifest_sha256: string;
  workspace_ceiling_sha256: string;
  capability_ceiling_sha256: string;
  assignment_manifest_sha256: string;
  upload_id: string;
  upload_attempt: number;
  upload_state: RemoteWorkerUploadState;
  upload_revision: number;
  declared_file_count: number;
  declared_total_bytes: number;
  max_artifact_bytes: number;
  staging_root_sha256: string;
  committed_manifest_sha256: string | null;
  verification_gate_state: "not_required" | "pending" | "satisfied" | null;
  verification_gate_revision: number;
  cleanup_state: "not_due" | "pending" | "cleaned" | "manual_reconciliation";
  cleanup_revision: number;
  cleanup_claim_owner: string | null;
  cleanup_claim_expires_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface GenerationIdentityRow {
  registry_workspace_id: string;
  execution_workspace_id: string;
  assignment_id: string;
  assignment_generation: number;
  worker_id: string;
  worker_generation: number;
  runtime_manifest_sha256: string;
  workspace_ceiling_sha256: string;
  capability_ceiling_sha256: string;
  assignment_manifest_sha256: string;
}

export class RemoteWorkerArtifactRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public openUpload(input: OpenRemoteWorkerUploadCommand): RemoteWorkerArtifactUploadRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const uploadAttempt = boundedInteger(
      input.uploadAttempt,
      "uploadAttempt",
      1,
      REMOTE_WORKER_SETTLEMENT_BOUNDS.maxUploadAttempts,
    );
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const identity = this.resolveIdentity(registryWorkspaceId, assignmentId, assignmentGeneration);
      const uploadId = deriveServerId(
        "rw-artifact-upload",
        registryWorkspaceId,
        assignmentId,
        String(assignmentGeneration),
        String(uploadAttempt),
      );
      const requestSha256 = sha256({
        kind: "open-upload",
        identity,
        uploadAttempt,
        stagingRootSha256: input.stagingRootSha256,
        expiresAt: input.expiresAt,
        idempotencyKey,
      });
      const replay = this.findUploadByIdempotency(registryWorkspaceId, idempotencyKey);
      if (replay) {
        assertExactReplay(
          replay.staging_root_sha256,
          digest(input.stagingRootSha256, "stagingRootSha256"),
          "remote worker upload",
        );
        return this.mapUpload(replay);
      }
      const maxArtifactBytes = this.resolveArtifactCeiling(registryWorkspaceId, assignmentId);
      const declaredTotalBytes = nonNegativeInteger(
        input.declaredTotalBytes,
        "declaredTotalBytes",
        REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes,
      );
      if (declaredTotalBytes > maxArtifactBytes) throw conflict("remote worker upload ceiling");
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_artifact_uploads (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, upload_id, upload_attempt, upload_state, upload_revision,
              declared_file_count, declared_total_bytes, max_artifact_bytes, staging_root_sha256,
              committed_manifest_sha256, verification_gate_state, verification_gate_revision, cleanup_state,
              cleanup_revision, cleanup_claim_owner, cleanup_claim_expires_at, expires_at, idempotency_key,
              request_sha256, created_at, updated_at
            ) VALUES (
              @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
              @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @assignmentManifestSha256, @uploadId, @uploadAttempt, 'open', 1,
              @declaredFileCount, @declaredTotalBytes, @maxArtifactBytes, @stagingRootSha256,
              NULL, NULL, 0, 'not_due', 1, NULL, NULL, @expiresAt, @idempotencyKey, @requestSha256, @now, @now
            )`,
          )
          .run({
            ...identityParams(identity),
            uploadId,
            uploadAttempt,
            declaredFileCount: nonNegativeInteger(
              input.declaredFileCount,
              "declaredFileCount",
              REMOTE_WORKER_SETTLEMENT_BOUNDS.maxFiles,
            ),
            declaredTotalBytes,
            maxArtifactBytes,
            stagingRootSha256: digest(input.stagingRootSha256, "stagingRootSha256"),
            expiresAt: timestamp(input.expiresAt, "expiresAt"),
            idempotencyKey,
            requestSha256,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker upload");
      }
      return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
    });
  }

  public appendPart(input: AppendRemoteWorkerPartCommand): RemoteWorkerArtifactUploadRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const uploadId = identifier(input.uploadId, "uploadId");
    const part = normalizeRemoteWorkerArtifactPart(input.part);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const upload = this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId);
      const identity = this.identityFromUpload(upload);
      const requestSha256 = sha256(remoteWorkerArtifactPartReplayMaterial({ identity, uploadId, part }));
      const replay = this.findPartByIdempotency(registryWorkspaceId, idempotencyKey);
      if (replay) {
        assertExactReplay(replay.part_sha256, part.partSha256, "remote worker part");
        return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
      }
      if (upload.upload_state !== "open" && upload.upload_state !== "assembling") {
        throw conflict("remote worker part upload state");
      }
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_artifact_parts (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, upload_id, global_sequence, logical_path_sha256, file_part_index,
              is_final_part, part_bytes, part_sha256, idempotency_key, request_sha256, received_at
            ) VALUES (
              @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
              @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @assignmentManifestSha256, @uploadId, @globalSequence, @logicalPathSha256, @filePartIndex,
              @isFinalPart, @partBytes, @partSha256, @idempotencyKey, @requestSha256, @now
            )`,
          )
          .run({
            ...identityParams(identity),
            uploadId,
            globalSequence: part.globalSequence,
            logicalPathSha256: part.logicalPathSha256,
            filePartIndex: part.filePartIndex,
            isFinalPart: part.isFinalPart ? 1 : 0,
            partBytes: part.partBytes,
            partSha256: part.partSha256,
            idempotencyKey,
            requestSha256,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker part");
      }
      if (upload.upload_state === "open") {
        this.advanceUploadState(upload, "assembling", now);
      }
      return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
    });
  }

  public commitArtifact(input: CommitRemoteWorkerArtifactCommand): RemoteWorkerArtifactUploadRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const uploadId = identifier(input.uploadId, "uploadId");
    const manifest = normalizeRemoteWorkerArtifactManifest(input.manifest);
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    const manifestSha256 = remoteWorkerArtifactManifestSha256(manifest);
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const upload = this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId);
      const identity = this.identityFromUpload(upload);
      // The manifest must bind the exact generation identity the upload proved.
      if (canonicalJsonString(manifest.identity) !== canonicalJsonString(identity)) {
        throw conflict("remote worker commit identity");
      }
      const existing = this.findManifestByGeneration(registryWorkspaceId, assignmentId, assignmentGeneration);
      if (existing) {
        assertExactReplay(existing.manifest_sha256, manifestSha256, "remote worker commit");
        return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
      }
      if (upload.upload_state !== "assembling" && upload.upload_state !== "open") {
        throw conflict("remote worker commit upload state");
      }
      if (manifest.totalBytes > upload.max_artifact_bytes) throw conflict("remote worker commit ceiling");
      const now = this.databaseNow();
      const manifestId = deriveServerId(
        "rw-artifact-manifest",
        registryWorkspaceId,
        assignmentId,
        String(assignmentGeneration),
      );
      const gateState = manifest.requiredVerifierProfileSha256 === null ? "not_required" : "pending";
      try {
        for (const blob of input.blobs) {
          this.db
            .prepare(
              `INSERT INTO remote_worker_artifact_blobs (
                registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
                worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
                assignment_manifest_sha256, upload_id, blob_sha256, byte_count, physical_rel_path, installed_at
              ) VALUES (
                @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
                @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
                @assignmentManifestSha256, @uploadId, @blobSha256, @byteCount, @physicalRelPath, @now
              )`,
            )
            .run({
              ...identityParams(identity),
              uploadId,
              blobSha256: digest(blob.blobSha256, "blobSha256"),
              byteCount: nonNegativeInteger(blob.byteCount, "byteCount", REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes),
              physicalRelPath: relPath(blob.physicalRelPath),
              now,
            });
        }
        this.db
          .prepare(
            `INSERT INTO remote_worker_artifact_manifests (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, upload_id, manifest_id, manifest_sha256, manifest_json, file_count,
              total_bytes, path_jail_sha256, worker_claim_sha256, required_verifier_profile_sha256,
              idempotency_key, request_sha256, committed_at
            ) VALUES (
              @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
              @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @assignmentManifestSha256, @uploadId, @manifestId, @manifestSha256, @manifestJson, @fileCount,
              @totalBytes, @pathJailSha256, @workerClaimSha256, @requiredVerifierProfileSha256,
              @idempotencyKey, @requestSha256, @now
            )`,
          )
          .run({
            ...identityParams(identity),
            uploadId,
            manifestId,
            manifestSha256,
            manifestJson: remoteWorkerArtifactManifestJson(manifest),
            fileCount: manifest.fileCount,
            totalBytes: manifest.totalBytes,
            pathJailSha256: manifest.pathJailSha256,
            workerClaimSha256: manifest.workerClaimSha256,
            requiredVerifierProfileSha256: manifest.requiredVerifierProfileSha256,
            idempotencyKey,
            requestSha256: manifestSha256,
            now,
          });
        for (const entry of manifest.entries) {
          this.db
            .prepare(
              `INSERT INTO remote_worker_artifact_manifest_entries (
                registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
                worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
                assignment_manifest_sha256, manifest_id, entry_index, logical_path, logical_path_sha256,
                blob_sha256, byte_count, mime_type
              ) VALUES (
                @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
                @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
                @assignmentManifestSha256, @manifestId, @entryIndex, @logicalPath, @logicalPathSha256,
                @blobSha256, @byteCount, @mimeType
              )`,
            )
            .run({
              ...identityParams(identity),
              manifestId,
              entryIndex: entry.entryIndex,
              logicalPath: entry.logicalPath,
              logicalPathSha256: entry.logicalPathSha256,
              blobSha256: entry.blobSha256,
              byteCount: entry.byteCount,
              mimeType: entry.mimeType,
            });
        }
        this.db
          .prepare(
            `UPDATE remote_worker_artifact_uploads
             SET upload_state = 'committed', upload_revision = upload_revision + 1,
                 committed_manifest_sha256 = @manifestSha256, verification_gate_state = @gateState,
                 verification_gate_revision = 1, updated_at = @now
             WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
               AND assignment_generation = @assignmentGeneration AND upload_id = @uploadId`,
          )
          .run({ registryWorkspaceId, assignmentId, assignmentGeneration, uploadId, manifestSha256, gateState, now });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker commit");
      }
      return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
    });
  }

  public terminateUpload(input: TerminateRemoteWorkerUploadCommand): RemoteWorkerArtifactUploadRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const uploadId = identifier(input.uploadId, "uploadId");
    const expectedUploadRevision = positiveInteger(input.expectedUploadRevision, "expectedUploadRevision");
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const upload = this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId);
      if (upload.upload_revision !== expectedUploadRevision) throw conflict("remote worker upload revision");
      if (upload.upload_state !== "open" && upload.upload_state !== "assembling") {
        throw conflict("remote worker upload termination state");
      }
      const now = this.databaseNow();
      this.advanceUploadState(upload, input.reason, now);
      return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
    });
  }

  public recordWorkerClaim(input: RecordRemoteWorkerVerificationClaimCommand): { verificationId: string } {
    const evidence = normalizeRemoteWorkerVerificationEvidence(input.evidence);
    if (evidence.kind !== "worker_claim")
      throw new ValidationError({ field: "kind", message: "Worker claim required." });
    return this.insertVerification({
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      attemptIndex: input.attemptIndex,
      kind: "worker_claim",
      attemptState: "worker_reported",
      verifierProfileSha256: null,
      wallDeadlineAt: null,
      evidence,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public openGatewayVerification(input: OpenRemoteWorkerVerificationAttemptCommand): { verificationId: string } {
    const evidence = normalizeRemoteWorkerVerificationEvidence(input.evidence);
    if (evidence.kind !== "gateway_attempt") {
      throw new ValidationError({ field: "kind", message: "Gateway attempt required." });
    }
    return this.insertVerification({
      registryWorkspaceId: input.registryWorkspaceId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      attemptIndex: input.attemptIndex,
      kind: "gateway_attempt",
      attemptState: "queued",
      verifierProfileSha256: digest(input.verifierProfileSha256, "verifierProfileSha256"),
      wallDeadlineAt: timestamp(input.wallDeadlineAt, "wallDeadlineAt"),
      evidence,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public advanceGatewayVerification(input: AdvanceRemoteWorkerVerificationAttemptCommand): {
    verificationId: string;
    gateState: "not_required" | "pending" | "satisfied" | null;
  } {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const verificationId = identifier(input.verificationId, "verificationId");
    const expectedAttemptRevision = positiveInteger(input.expectedAttemptRevision, "expectedAttemptRevision");
    const evidence = normalizeRemoteWorkerVerificationEvidence(input.evidence);
    const nextState = input.nextState;
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const row = this.getVerificationRow(registryWorkspaceId, verificationId);
      if (row.kind !== "gateway_attempt") throw conflict("remote worker verification kind");
      if (row.attempt_revision !== expectedAttemptRevision) throw conflict("remote worker verification revision");
      if (!remoteWorkerVerificationAttemptCanTransition(row.attempt_state, nextState)) {
        throw conflict("remote worker verification transition");
      }
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `UPDATE remote_worker_artifact_verifications
             SET attempt_state = @nextState, attempt_revision = attempt_revision + 1,
                 evidence_json = @evidenceJson, evidence_sha256 = @evidenceSha256, updated_at = @now,
                 claim_owner = NULL, claim_expires_at = NULL
             WHERE registry_workspace_id = @registryWorkspaceId AND verification_id = @verificationId`,
          )
          .run({
            registryWorkspaceId,
            verificationId,
            nextState,
            evidenceJson: canonicalJsonString(evidence),
            evidenceSha256: sha256(evidence),
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker verification");
      }
      let gateState = this.getUploadRow(
        registryWorkspaceId,
        assignmentId,
        assignmentGeneration,
        this.manifestUploadId(row.manifest_id, registryWorkspaceId, assignmentId, assignmentGeneration),
      ).verification_gate_state;
      if (remoteWorkerVerificationAttemptSatisfiesGate("gateway_attempt", nextState)) {
        gateState = this.satisfyGate(registryWorkspaceId, assignmentId, assignmentGeneration, now);
      }
      return { verificationId, gateState };
    });
  }

  public claimCleanup(input: ClaimRemoteWorkerCleanupCommand): RemoteWorkerArtifactUploadRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const uploadId = identifier(input.uploadId, "uploadId");
    const expectedCleanupRevision = positiveInteger(input.expectedCleanupRevision, "expectedCleanupRevision");
    const claimOwner = identifier(input.claimOwner, "claimOwner");
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const upload = this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId);
      if (upload.cleanup_revision !== expectedCleanupRevision) throw conflict("remote worker cleanup revision");
      if (upload.cleanup_state !== "not_due") throw conflict("remote worker cleanup state");
      const clock = this.databaseClockWithTtl(REMOTE_WORKER_SETTLEMENT_BOUNDS.cleanupClaimSeconds);
      this.db
        .prepare(
          `UPDATE remote_worker_artifact_uploads
           SET cleanup_state = 'pending', cleanup_revision = cleanup_revision + 1,
               cleanup_claim_owner = @claimOwner, cleanup_claim_expires_at = @expiresAt, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration AND upload_id = @uploadId`,
        )
        .run({
          registryWorkspaceId,
          assignmentId,
          assignmentGeneration,
          uploadId,
          claimOwner,
          expiresAt: clock.expiresAt,
          now: clock.now,
        });
      return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
    });
  }

  public resolveCleanup(input: ResolveRemoteWorkerCleanupCommand): RemoteWorkerArtifactUploadRecord {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const uploadId = identifier(input.uploadId, "uploadId");
    const expectedCleanupRevision = positiveInteger(input.expectedCleanupRevision, "expectedCleanupRevision");
    const claimOwner = identifier(input.claimOwner, "claimOwner");
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const upload = this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId);
      if (upload.cleanup_revision !== expectedCleanupRevision) throw conflict("remote worker cleanup revision");
      if (upload.cleanup_state !== "pending" || upload.cleanup_claim_owner !== claimOwner) {
        throw conflict("remote worker cleanup claim");
      }
      const now = this.databaseNow();
      this.db
        .prepare(
          `UPDATE remote_worker_artifact_uploads
           SET cleanup_state = @resolution, cleanup_revision = cleanup_revision + 1,
               cleanup_claim_owner = NULL, cleanup_claim_expires_at = NULL, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration AND upload_id = @uploadId`,
        )
        .run({ registryWorkspaceId, assignmentId, assignmentGeneration, uploadId, resolution: input.resolution, now });
      return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
    });
  }

  public getUpload(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    uploadId: string,
  ): RemoteWorkerArtifactUploadRecord {
    return this.mapUpload(this.getUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration, uploadId));
  }

  public getManifestSha256(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): string | undefined {
    return this.findManifestByGeneration(registryWorkspaceId, assignmentId, assignmentGeneration)?.manifest_sha256;
  }

  // --- internals ------------------------------------------------------------

  private insertVerification(input: {
    registryWorkspaceId: string;
    assignmentId: string;
    assignmentGeneration: number;
    attemptIndex: number;
    kind: RemoteWorkerVerificationKind;
    attemptState: RemoteWorkerVerificationAttemptState;
    verifierProfileSha256: string | null;
    wallDeadlineAt: string | null;
    evidence: RemoteWorkerVerificationEvidence;
    idempotencyKey: string;
  }): { verificationId: string } {
    const registryWorkspaceId = identifier(input.registryWorkspaceId, "registryWorkspaceId");
    const assignmentId = identifier(input.assignmentId, "assignmentId");
    const assignmentGeneration = positiveInteger(input.assignmentGeneration, "assignmentGeneration");
    const attemptIndex = boundedInteger(
      input.attemptIndex,
      "attemptIndex",
      1,
      input.kind === "worker_claim"
        ? REMOTE_WORKER_SETTLEMENT_BOUNDS.maxWorkerClaims
        : REMOTE_WORKER_SETTLEMENT_BOUNDS.maxGatewayVerificationAttempts,
    );
    const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey", 512);
    return this.db.transaction("immediate", () => {
      this.acquireGenerationLocks(registryWorkspaceId, assignmentId, assignmentGeneration);
      const manifest = this.findManifestByGeneration(registryWorkspaceId, assignmentId, assignmentGeneration);
      if (!manifest) throw conflict("remote worker verification manifest");
      const identity = this.identityFromManifest(manifest);
      const evidenceSha256 = sha256(input.evidence);
      const replay = this.findVerificationByIdempotency(registryWorkspaceId, idempotencyKey);
      if (replay) {
        assertExactReplay(replay.evidence_sha256, evidenceSha256, "remote worker verification");
        return { verificationId: replay.verification_id };
      }
      const verificationId = deriveServerId(
        "rw-verification",
        registryWorkspaceId,
        assignmentId,
        String(assignmentGeneration),
        input.kind,
        String(attemptIndex),
      );
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `INSERT INTO remote_worker_artifact_verifications (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, manifest_id, verification_id, kind, attempt_index, attempt_state,
              attempt_revision, verifier_profile_sha256, evidence_json, evidence_sha256, claim_owner,
              claim_expires_at, wall_deadline_at, idempotency_key, request_sha256, created_at, updated_at
            ) VALUES (
              @registryWorkspaceId, @executionWorkspaceId, @assignmentId, @assignmentGeneration, @workerId,
              @workerGeneration, @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
              @assignmentManifestSha256, @manifestId, @verificationId, @kind, @attemptIndex, @attemptState,
              1, @verifierProfileSha256, @evidenceJson, @evidenceSha256, NULL, NULL, @wallDeadlineAt,
              @idempotencyKey, @requestSha256, @now, @now
            )`,
          )
          .run({
            ...identityParams(identity),
            manifestId: manifest.manifest_id,
            verificationId,
            kind: input.kind,
            attemptIndex,
            attemptState: input.attemptState,
            verifierProfileSha256: input.verifierProfileSha256,
            evidenceJson: canonicalJsonString(input.evidence),
            evidenceSha256,
            wallDeadlineAt: input.wallDeadlineAt,
            idempotencyKey,
            requestSha256: evidenceSha256,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "remote worker verification");
      }
      return { verificationId };
    });
  }

  private satisfyGate(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    now: string,
  ): "satisfied" {
    const upload = this.getCommittedUploadRow(registryWorkspaceId, assignmentId, assignmentGeneration);
    if (upload.verification_gate_state === "satisfied") return "satisfied";
    if (upload.verification_gate_state !== "pending") throw conflict("remote worker verification gate");
    this.db
      .prepare(
        `UPDATE remote_worker_artifact_uploads
         SET verification_gate_state = 'satisfied', verification_gate_revision = verification_gate_revision + 1,
             updated_at = @now
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND upload_id = @uploadId`,
      )
      .run({ registryWorkspaceId, assignmentId, assignmentGeneration, uploadId: upload.upload_id, now });
    return "satisfied";
  }

  private advanceUploadState(upload: UploadRow, next: RemoteWorkerUploadState, now: string): void {
    this.db
      .prepare(
        `UPDATE remote_worker_artifact_uploads
         SET upload_state = @next, upload_revision = upload_revision + 1, updated_at = @now
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND upload_id = @uploadId`,
      )
      .run({
        next,
        now,
        registryWorkspaceId: upload.registry_workspace_id,
        assignmentId: upload.assignment_id,
        assignmentGeneration: upload.assignment_generation,
        uploadId: upload.upload_id,
      });
  }

  private resolveIdentity(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): RemoteWorkerSettlementIdentity {
    const row = this.db
      .prepare(
        `SELECT g.registry_workspace_id, g.execution_workspace_id, g.assignment_id, g.assignment_generation,
                g.worker_id, g.worker_generation, g.runtime_manifest_sha256, g.workspace_ceiling_sha256,
                g.capability_ceiling_sha256, a.manifest_sha256 AS assignment_manifest_sha256
         FROM remote_worker_assignment_generations g
         JOIN remote_worker_assignments a
           ON a.registry_workspace_id = g.registry_workspace_id AND a.assignment_id = g.assignment_id
         WHERE g.registry_workspace_id = @registryWorkspaceId AND g.assignment_id = @assignmentId
           AND g.assignment_generation = @assignmentGeneration`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration }) as GenerationIdentityRow | undefined;
    if (!row) throw unavailable("remote worker assignment generation");
    return this.identityFromRow(row);
  }

  private resolveArtifactCeiling(registryWorkspaceId: string, assignmentId: string): number {
    const row = this.db
      .prepare(
        `SELECT ${this.jsonExtract("manifest_json", "$.maxArtifactBytes")} AS ceiling
         FROM remote_worker_assignments
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId`,
      )
      .get({ registryWorkspaceId, assignmentId }) as { ceiling?: unknown } | undefined;
    const ceiling = Number(row?.ceiling);
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw unavailable("remote worker assignment ceiling");
    return Math.min(ceiling, REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes);
  }

  private jsonExtract(column: string, path: string): string {
    return this.db.dialect === "postgres"
      ? `(${column}::jsonb #>> '{${path.slice(2)}}')::bigint`
      : `json_extract(${column}, '${path}')`;
  }

  private identityFromRow(row: GenerationIdentityRow): RemoteWorkerSettlementIdentity {
    return normalizeRemoteWorkerSettlementIdentity({
      registryWorkspaceId: row.registry_workspace_id,
      executionWorkspaceId: row.execution_workspace_id,
      assignmentId: row.assignment_id,
      assignmentGeneration: asPositiveInteger(row.assignment_generation),
      workerId: row.worker_id,
      workerGeneration: asPositiveInteger(row.worker_generation),
      runtimeManifestSha256: row.runtime_manifest_sha256,
      workspaceCeilingSha256: row.workspace_ceiling_sha256,
      capabilityCeilingSha256: row.capability_ceiling_sha256,
      assignmentManifestSha256: row.assignment_manifest_sha256,
    });
  }

  private identityFromUpload(row: UploadRow): RemoteWorkerSettlementIdentity {
    return this.identityFromRow(row);
  }

  private identityFromManifest(row: ManifestRow): RemoteWorkerSettlementIdentity {
    return this.identityFromRow(row);
  }

  private manifestUploadId(
    manifestId: string,
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): string {
    const row = this.db
      .prepare(
        `SELECT upload_id FROM remote_worker_artifact_manifests
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND manifest_id = @manifestId`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration, manifestId }) as
      | { upload_id?: string }
      | undefined;
    if (!row?.upload_id) throw unavailable("remote worker manifest upload");
    return row.upload_id;
  }

  private getUploadRow(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
    uploadId: string,
  ): UploadRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_artifact_uploads
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND upload_id = @uploadId`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration, uploadId }) as UploadRow | undefined;
    if (!row) throw unavailable("remote worker upload");
    return row;
  }

  private getCommittedUploadRow(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): UploadRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_artifact_uploads
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration AND upload_state = 'committed'`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration }) as UploadRow | undefined;
    if (!row) throw unavailable("remote worker committed upload");
    return row;
  }

  private getVerificationRow(registryWorkspaceId: string, verificationId: string): VerificationRow {
    const row = this.db
      .prepare(
        `SELECT * FROM remote_worker_artifact_verifications
         WHERE registry_workspace_id = @registryWorkspaceId AND verification_id = @verificationId`,
      )
      .get({ registryWorkspaceId, verificationId }) as VerificationRow | undefined;
    if (!row) throw unavailable("remote worker verification");
    return row;
  }

  private findManifestByGeneration(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): ManifestRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_artifact_manifests
         WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
           AND assignment_generation = @assignmentGeneration`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration }) as ManifestRow | undefined;
  }

  private findUploadByIdempotency(registryWorkspaceId: string, idempotencyKey: string): UploadRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_artifact_uploads WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as UploadRow | undefined;
  }

  private findPartByIdempotency(
    registryWorkspaceId: string,
    idempotencyKey: string,
  ): { part_sha256: string } | undefined {
    return this.db
      .prepare(
        `SELECT part_sha256 FROM remote_worker_artifact_parts WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as { part_sha256: string } | undefined;
  }

  private findVerificationByIdempotency(
    registryWorkspaceId: string,
    idempotencyKey: string,
  ): VerificationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_artifact_verifications WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as VerificationRow | undefined;
  }

  private mapUpload(row: UploadRow): RemoteWorkerArtifactUploadRecord {
    return {
      identity: this.identityFromRow(row),
      uploadId: row.upload_id,
      uploadAttempt: asPositiveInteger(row.upload_attempt),
      uploadState: row.upload_state,
      uploadRevision: asPositiveInteger(row.upload_revision),
      declaredFileCount: asNonNegativeInteger(row.declared_file_count),
      declaredTotalBytes: asNonNegativeInteger(row.declared_total_bytes),
      maxArtifactBytes: asPositiveInteger(row.max_artifact_bytes),
      stagingRootSha256: row.staging_root_sha256,
      committedManifestSha256: row.committed_manifest_sha256,
      verificationGateState: row.verification_gate_state,
      verificationGateRevision: asNonNegativeInteger(row.verification_gate_revision),
      cleanupState: row.cleanup_state,
      cleanupRevision: asPositiveInteger(row.cleanup_revision),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private databaseNow(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get() as { now?: unknown } | undefined;
    if (typeof row?.now !== "string") throw invalidState();
    return row.now;
  }

  private databaseClockWithTtl(seconds: number): { now: string; expiresAt: string } {
    const sql =
      this.db.dialect === "postgres"
        ? `WITH captured AS (SELECT clock_timestamp() AS now)
           SELECT to_char(captured.now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
             to_char((captured.now + (@seconds * interval '1 second')) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at FROM captured`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', @seconds)) AS expires_at`;
    const row = this.db.prepare(sql).get({ seconds }) as { now?: unknown; expires_at?: unknown } | undefined;
    if (typeof row?.now !== "string" || typeof row.expires_at !== "string") throw invalidState();
    return { now: row.now, expiresAt: row.expires_at };
  }

  private acquireGenerationLocks(
    registryWorkspaceId: string,
    assignmentId: string,
    assignmentGeneration: number,
  ): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId, 501)) AS locked")
      .get({ registryWorkspaceId });
    this.db
      .prepare(
        "SELECT pg_advisory_xact_lock(hashtextextended(@registryWorkspaceId || ':' || @assignmentId, 503)) AS locked",
      )
      .get({ registryWorkspaceId, assignmentId });
    this.db
      .prepare(
        `SELECT pg_advisory_xact_lock(hashtextextended(
          @registryWorkspaceId || ':' || @assignmentId || ':' || CAST(@assignmentGeneration AS TEXT), 504
        )) AS locked`,
      )
      .get({ registryWorkspaceId, assignmentId, assignmentGeneration });
  }
}

interface ManifestRow extends GenerationIdentityRow {
  upload_id: string;
  manifest_id: string;
  manifest_sha256: string;
}

interface VerificationRow extends GenerationIdentityRow {
  manifest_id: string;
  verification_id: string;
  kind: RemoteWorkerVerificationKind;
  attempt_index: number;
  attempt_state: RemoteWorkerVerificationAttemptState;
  attempt_revision: number;
  evidence_sha256: string;
}

function identityParams(identity: RemoteWorkerSettlementIdentity): Record<string, unknown> {
  return {
    registryWorkspaceId: identity.registryWorkspaceId,
    executionWorkspaceId: identity.executionWorkspaceId,
    assignmentId: identity.assignmentId,
    assignmentGeneration: identity.assignmentGeneration,
    workerId: identity.workerId,
    workerGeneration: identity.workerGeneration,
    runtimeManifestSha256: identity.runtimeManifestSha256,
    workspaceCeilingSha256: identity.workspaceCeilingSha256,
    capabilityCeilingSha256: identity.capabilityCeilingSha256,
    assignmentManifestSha256: identity.assignmentManifestSha256,
  };
}

function deriveServerId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${sha256(parts).slice(0, 48)}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function assertExactReplay(storedSha256: string, requestSha256: string, label: string): void {
  if (storedSha256 !== requestSha256) throw conflict(label);
}

function identifier(value: string, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ field, message: `Remote worker settlement ${field} is invalid.` });
  }
  return value;
}

function digest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ValidationError({
      field,
      message: `Remote worker settlement ${field} must be a lower-case SHA-256 digest.`,
    });
  }
  return value;
}

function relPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    !value.startsWith("remote-workers/artifacts/")
  ) {
    throw new ValidationError({ field: "physicalRelPath", message: "Remote worker physical path is invalid." });
  }
  return value;
}

function positiveInteger(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ValidationError({ field, message: `Remote worker settlement ${field} is invalid.` });
  }
  return value;
}

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError({ field, message: `Remote worker settlement ${field} is invalid.` });
  }
  return value;
}

function nonNegativeInteger(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ValidationError({ field, message: `Remote worker settlement ${field} is invalid.` });
  }
  return value;
}

function timestamp(value: string, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new ValidationError({
      field,
      message: `Remote worker settlement ${field} must be an ISO-8601 UTC millisecond timestamp.`,
    });
  }
  return value;
}

function asPositiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalidState();
  return parsed;
}

function asNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidState();
  return parsed;
}

function unavailable(entity: string): NotFoundError {
  return new NotFoundError({ entity, id: "unavailable" });
}

function conflict(label: string): ConflictError {
  return new ConflictError({
    code: "STATE_CONFLICT",
    message: `${label} conflicts with durable settlement authority.`,
    details: { reason: "remote_worker_settlement_conflict" },
  });
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ConflictError)
    return error;
  return conflict(label);
}

function invalidState(): Error {
  return new Error("Remote worker settlement state is invalid.");
}
