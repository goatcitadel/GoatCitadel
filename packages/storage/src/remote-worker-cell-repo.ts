import {
  REMOTE_WORKER_CELL_EVIDENCE_GENESIS_SHA256,
  REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
  canonicalJsonString,
  normalizeRemoteWorkerCellEvidencePayload,
  normalizeRemoteWorkerCellPlatformIdentity,
  normalizeRemoteWorkerCellProfile,
  remoteWorkerCellBackupCanTransition,
  remoteWorkerCellCanonicalSha256,
  remoteWorkerCellCapacityFootprintSha256,
  remoteWorkerCellCleanupCanTransition,
  remoteWorkerCellEvidencePayloadSha256,
  remoteWorkerCellEvidenceSha256,
  remoteWorkerCellExecutionCanTransition,
  remoteWorkerCellPlatformIdentitySha256,
  remoteWorkerCellProfileSha256,
  type RemoteWorkerCellBackupState,
  type RemoteWorkerCellCapacityFootprint,
  type RemoteWorkerCellCleanupState,
  type RemoteWorkerCellEvidenceDomain,
  type RemoteWorkerCellExecutionState,
  type RemoteWorkerCellPlatformIdentity,
  type RemoteWorkerCellProfile,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

/**
 * HX-505 remote-worker execution-cell owner (production-dark).
 *
 * Persists the immutable server-owned cell profile, worst-case capacity
 * reservation, three CAS-fenced state machines (execution/cleanup/backup),
 * high-water and retained-byte truth, planned platform identity, bounded
 * diagnostics receipt hashes, and an append-only hash-chained transition
 * evidence log for ONE active assignment generation. It never stores a
 * transcript, artifact payload, raw terminal output, or credential.
 *
 * Every mutation runs in an immediate transaction and appends its transition
 * evidence in the same transaction. The database independently enforces the
 * immutable profile, monotonic revision CAS, monotonic high-water/retained
 * accounting, verified-clean-only removal, and the append-only evidence chain.
 */

export interface RemoteWorkerCellProfileInput {
  readonly profile: RemoteWorkerCellProfile;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export type RemoteWorkerCellProfileDisposition = "created" | "replayed";

export interface RemoteWorkerCellProfileOutcome {
  readonly disposition: RemoteWorkerCellProfileDisposition;
  readonly cell: RemoteWorkerCellRecord;
}

export interface RemoteWorkerCellKey {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
}

export interface RemoteWorkerCellProvisioningClaimInput extends RemoteWorkerCellKey {
  readonly provisioningOwner: string;
  readonly leaseExpiresAt: string;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellPlatformInput extends RemoteWorkerCellKey {
  readonly provisioningOwner: string;
  readonly platformIdentity: RemoteWorkerCellPlatformIdentity;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellExecutionTransitionInput extends RemoteWorkerCellKey {
  readonly expectedRevision: number;
  readonly toState: RemoteWorkerCellExecutionState;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellReattachInput extends RemoteWorkerCellKey {
  readonly observedPlatformIdentitySha256: string;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellDiagnosticsInput extends RemoteWorkerCellKey {
  readonly expectedRevision: number;
  readonly toState: "exited" | "cancelled" | "limit_exceeded" | "failed";
  readonly exitCode: number | null;
  readonly terminatedBySignal: string | null;
  readonly diagnosticCaptureSha256: string;
  readonly rawOutputBytes: number;
  readonly retainedDiagnosticBytes: number;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellCapacityHighWaterInput extends RemoteWorkerCellKey {
  readonly footprint: RemoteWorkerCellCapacityFootprint;
  readonly peakDiskBytes: number;
  readonly peakMemoryBytes: number;
  readonly peakFileCount: number;
  readonly peakProcessCount: number;
  readonly rawOutputBytes: number;
  readonly failedCleanupRetainedBytes: number;
  readonly quarantineRetainedBytes: number;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellCleanupTransitionInput extends RemoteWorkerCellKey {
  readonly expectedRevision: number;
  readonly toState: RemoteWorkerCellCleanupState;
  readonly failedCleanupRetainedBytes?: number;
  readonly quarantineRetainedBytes?: number;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellBackupTransitionInput extends RemoteWorkerCellKey {
  readonly expectedRevision: number;
  readonly toState: RemoteWorkerCellBackupState;
  readonly detailSha256: string;
  readonly now: string;
}

export interface RemoteWorkerCellRecord {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly cellId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly backend: "container";
  readonly idempotencyKey: string;
  readonly profileSha256: string;
  readonly requestSha256: string;
  readonly egressPosture: "deny_all" | "allowlisted";
  readonly egressDnsRevision: number;
  readonly executionState: RemoteWorkerCellExecutionState;
  readonly executionRevision: number;
  readonly cleanupState: RemoteWorkerCellCleanupState;
  readonly cleanupRevision: number;
  readonly backupState: RemoteWorkerCellBackupState;
  readonly backupRevision: number;
  readonly provisioningOwner?: string;
  readonly provisioningLeaseExpiresAt?: string;
  readonly platformIdentitySha256?: string;
  readonly containerName?: string;
  readonly imageDigest?: string;
  readonly networkName?: string;
  readonly logicalDiskBytes: number;
  readonly allocatedDiskBytes: number;
  readonly peakDiskBytes: number;
  readonly peakMemoryBytes: number;
  readonly peakFileCount: number;
  readonly peakProcessCount: number;
  readonly rawOutputBytes: number;
  readonly retainedDiagnosticBytes: number;
  readonly failedCleanupRetainedBytes: number;
  readonly quarantineRetainedBytes: number;
  readonly capacityRevision: number;
  readonly lastFootprintSha256?: string;
  readonly exitCode?: number;
  readonly terminatedBySignal?: string;
  readonly diagnosticCaptureSha256?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteWorkerCellEvidenceRecord {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly cellId: string;
  readonly evidenceSequence: number;
  readonly domain: RemoteWorkerCellEvidenceDomain;
  readonly payloadJson: string;
  readonly payloadSha256: string;
  readonly previousEvidenceSha256: string;
  readonly evidenceSha256: string;
  readonly recordedAt: string;
}

export class RemoteWorkerCellConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerCellConflictError";
  }
}

export class RemoteWorkerCellRepository {
  public constructor(private readonly db: DatabaseClient) {}

  /** Boundary 2: insert the immutable cell + worst-case reservation, or exactly replay it. */
  public profileOrReplay(input: RemoteWorkerCellProfileInput): RemoteWorkerCellProfileOutcome {
    const profile = normalizeRemoteWorkerCellProfile(input.profile);
    const profileSha256 = remoteWorkerCellProfileSha256(input.profile);
    const idempotencyKey = assertBounded(input.idempotencyKey, "idempotencyKey", 512);
    const requestSha256 = remoteWorkerCellCanonicalSha256({ profileSha256, idempotencyKey });
    const createdAt = assertTimestamp(input.createdAt, "createdAt");
    return this.db.transaction("immediate", () => {
      const replay = this.findByIdempotency(profile.registryWorkspaceId, idempotencyKey);
      if (replay) {
        if (replay.request_sha256 !== requestSha256) {
          throw new RemoteWorkerCellConflictError(
            "Remote worker cell profile replay does not match the stored canonical bytes.",
          );
        }
        return { disposition: "replayed", cell: mapCell(replay) };
      }
      this.insertStmt().run({
        registryWorkspaceId: profile.registryWorkspaceId,
        assignmentId: profile.assignmentId,
        assignmentGeneration: profile.assignmentGeneration,
        cellId: profile.cellId,
        workerId: profile.workerId,
        workerGeneration: profile.workerGeneration,
        backend: profile.backend,
        idempotencyKey,
        profileSha256,
        requestSha256,
        logicalRootSha256: profile.logicalRootSha256,
        assignmentManifestSha256: profile.assignmentManifestSha256,
        pathJailSha256: profile.pathJailSha256,
        capabilityProfileSha256: profile.capabilityProfileSha256,
        contextSnapshotSha256: profile.contextSnapshotSha256,
        toolEffectPostureSha256: profile.toolEffectPostureSha256,
        runtimeAttestationSha256: profile.runtimeAttestationSha256,
        launcherAttestationSha256: profile.launcherAttestationSha256,
        logicalDiskBytes: profile.capacity.logicalDiskBytes,
        allocatedDiskBytes: profile.capacity.allocatedDiskBytes,
        fileLimit: profile.capacity.fileLimit,
        inodeLimit: profile.capacity.inodeLimit,
        processLimit: profile.capacity.processLimit,
        cpuLimitMilli: profile.capacity.cpuLimitMilli,
        wallLimitMs: profile.capacity.wallLimitMs,
        memoryLimitBytes: profile.capacity.memoryLimitBytes,
        rawOutputLimitBytes: profile.capacity.rawOutputLimitBytes,
        diagnosticLimitBytes: profile.capacity.diagnosticLimitBytes,
        artifactCeilingBytes: profile.capacity.artifactCeilingBytes,
        backupStagingBytes: profile.capacity.backupStagingBytes,
        backupPublicationBytes: profile.capacity.backupPublicationBytes,
        egressPosture: profile.egressPosture,
        egressPolicySha256: profile.egressPolicySha256,
        egressDnsRevision: profile.egressDnsRevision,
        envAllowlistSha256: profile.envAllowlistSha256,
        createdAt,
      });
      return { disposition: "created", cell: this.getCellRow(keyOf(profile)) };
    });
  }

  /** Boundary 3: claim provisioning with a database-clock lease (one winner); reclaims an expired lease. */
  public claimProvisioning(input: RemoteWorkerCellProvisioningClaimInput): RemoteWorkerCellRecord | undefined {
    const owner = assertBounded(input.provisioningOwner, "provisioningOwner");
    const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
    const now = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      if (current.executionState === "profiled") {
        const changed = this.db
          .prepare(
            `UPDATE remote_worker_cells
               SET execution_state = 'provisioning', execution_revision = execution_revision + 1,
                   provisioning_owner = @owner, provisioning_lease_expires_at = @lease, updated_at = @now
             WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
               AND assignment_generation = @assignmentGeneration
               AND execution_state = 'profiled' AND provisioning_owner IS NULL`,
          )
          .run({ owner, lease: leaseExpiresAt, now, ...keyOf(input) }).changes;
        if (changed !== 1) return undefined;
        this.appendEvidence(current, executionEvidence("profiled", "provisioning", input.detailSha256), now);
        return this.getCellRow(input);
      }
      if (
        current.executionState === "provisioning" &&
        current.provisioningLeaseExpiresAt !== undefined &&
        current.provisioningLeaseExpiresAt <= now
      ) {
        const changed = this.db
          .prepare(
            `UPDATE remote_worker_cells
               SET provisioning_owner = @owner, provisioning_lease_expires_at = @lease, updated_at = @now
             WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
               AND assignment_generation = @assignmentGeneration
               AND execution_state = 'provisioning' AND provisioning_lease_expires_at = @expectedLease`,
          )
          .run({
            owner,
            lease: leaseExpiresAt,
            now,
            expectedLease: current.provisioningLeaseExpiresAt,
            ...keyOf(input),
          }).changes;
        return changed === 1 ? this.getCellRow(input) : undefined;
      }
      return undefined;
    });
  }

  /** Boundary 4: persist the planned platform identity before launch (provisioning -> ready). */
  public persistPlatformIdentity(input: RemoteWorkerCellPlatformInput): RemoteWorkerCellRecord {
    const platform = normalizeRemoteWorkerCellPlatformIdentity(input.platformIdentity);
    const platformIdentitySha256 = remoteWorkerCellPlatformIdentitySha256(input.platformIdentity);
    const owner = assertBounded(input.provisioningOwner, "provisioningOwner");
    const now = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      if (current.executionState !== "provisioning") {
        throw new RemoteWorkerCellConflictError(
          `Remote worker cell cannot persist a platform identity in state ${current.executionState}.`,
        );
      }
      if (current.provisioningOwner !== owner) {
        throw new RemoteWorkerCellConflictError("Remote worker cell provisioning owner mismatch.");
      }
      const changed = this.db
        .prepare(
          `UPDATE remote_worker_cells
             SET execution_state = 'ready', execution_revision = execution_revision + 1,
                 platform_identity_sha256 = @platformIdentitySha256, container_name = @containerName,
                 image_digest = @imageDigest, network_name = @networkName, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration AND execution_state = 'provisioning'`,
        )
        .run({
          platformIdentitySha256,
          containerName: platform.containerName,
          imageDigest: platform.imageDigest,
          networkName: platform.networkName,
          now,
          ...keyOf(input),
        }).changes;
      if (changed !== 1)
        throw new RemoteWorkerCellConflictError("Remote worker cell platform persist lost the CAS race.");
      this.appendEvidence(current, executionEvidence("provisioning", "ready", input.detailSha256), now);
      return this.getCellRow(input);
    });
  }

  /** Boundaries 5-6: a guarded execution transition (ready->starting, starting->running, etc.). */
  public transitionExecution(input: RemoteWorkerCellExecutionTransitionInput): RemoteWorkerCellRecord {
    const now = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      this.assertExecutionTransition(current, input.expectedRevision, input.toState);
      this.db
        .prepare(
          `UPDATE remote_worker_cells
             SET execution_state = @toState, execution_revision = execution_revision + 1, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND execution_state = @expectedState AND execution_revision = @expectedRevision`,
        )
        .run({
          toState: input.toState,
          expectedState: current.executionState,
          expectedRevision: input.expectedRevision,
          now,
          ...keyOf(input),
        });
      this.appendEvidence(current, executionEvidence(current.executionState, input.toState, input.detailSha256), now);
      return this.getCellRow(input);
    });
  }

  /**
   * Boundary 6: reattach only to exact matching live identity. A mismatched or
   * unverifiable identity becomes `liveness_unknown`. Returns the cell and
   * whether the identity was confirmed.
   */
  public reattachOrMarkUnknown(input: RemoteWorkerCellReattachInput): {
    cell: RemoteWorkerCellRecord;
    confirmed: boolean;
  } {
    const observed = assertDigest(input.observedPlatformIdentitySha256, "observedPlatformIdentitySha256");
    const now = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      if (current.executionState !== "starting" && current.executionState !== "running") {
        throw new RemoteWorkerCellConflictError(
          `Remote worker cell cannot reattach from state ${current.executionState}.`,
        );
      }
      if (current.platformIdentitySha256 === observed) {
        if (current.executionState === "running") return { cell: current, confirmed: true };
        this.db
          .prepare(
            `UPDATE remote_worker_cells
               SET execution_state = 'running', execution_revision = execution_revision + 1, updated_at = @now
             WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
               AND assignment_generation = @assignmentGeneration AND execution_state = 'starting'`,
          )
          .run({ now, ...keyOf(input) });
        this.appendEvidence(current, executionEvidence("starting", "running", input.detailSha256), now);
        return { cell: this.getCellRow(input), confirmed: true };
      }
      this.db
        .prepare(
          `UPDATE remote_worker_cells
             SET execution_state = 'liveness_unknown', execution_revision = execution_revision + 1, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration AND execution_state = @expectedState`,
        )
        .run({ now, expectedState: current.executionState, ...keyOf(input) });
      this.appendEvidence(
        current,
        executionEvidence(current.executionState, "liveness_unknown", input.detailSha256),
        now,
      );
      return { cell: this.getCellRow(input), confirmed: false };
    });
  }

  /** Boundary 8: after confirmed exit, finalize diagnostics/high-water and the terminal execution state. */
  public finalizeDiagnostics(input: RemoteWorkerCellDiagnosticsInput): RemoteWorkerCellRecord {
    const now = assertTimestamp(input.now, "now");
    const rawOutputBytes = assertNonNegative(input.rawOutputBytes, "rawOutputBytes");
    const retainedDiagnosticBytes = assertNonNegative(input.retainedDiagnosticBytes, "retainedDiagnosticBytes");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      this.assertExecutionTransition(current, input.expectedRevision, input.toState);
      this.db
        .prepare(
          `UPDATE remote_worker_cells
             SET execution_state = @toState, execution_revision = execution_revision + 1,
                 exit_code = @exitCode, terminated_by_signal = @terminatedBySignal,
                 diagnostic_capture_sha256 = @diagnosticCaptureSha256,
                 raw_output_bytes = @rawOutputBytes, retained_diagnostic_bytes = @retainedDiagnosticBytes,
                 updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND execution_state = @expectedState AND execution_revision = @expectedRevision`,
        )
        .run({
          toState: input.toState,
          expectedState: current.executionState,
          expectedRevision: input.expectedRevision,
          exitCode: input.exitCode === null ? null : assertExitCode(input.exitCode),
          terminatedBySignal:
            input.terminatedBySignal === null
              ? null
              : assertBounded(input.terminatedBySignal, "terminatedBySignal", 32),
          diagnosticCaptureSha256: assertDigest(input.diagnosticCaptureSha256, "diagnosticCaptureSha256"),
          rawOutputBytes: Math.max(current.rawOutputBytes, rawOutputBytes),
          retainedDiagnosticBytes: Math.max(current.retainedDiagnosticBytes, retainedDiagnosticBytes),
          now,
          ...keyOf(input),
        });
      this.appendEvidence(current, executionEvidence(current.executionState, input.toState, input.detailSha256), now);
      return this.getCellRow(input);
    });
  }

  /** Boundary 7: advance monotonic capacity high-water and retained-byte truth, appending capacity evidence. */
  public recordCapacityHighWater(input: RemoteWorkerCellCapacityHighWaterInput): RemoteWorkerCellRecord {
    // `remoteWorkerCellCapacityFootprintSha256` normalizes and validates the footprint.
    const footprintSha256 = remoteWorkerCellCapacityFootprintSha256(input.footprint);
    const now = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      const nextCapacityRevision = current.capacityRevision + 1;
      this.db
        .prepare(
          `UPDATE remote_worker_cells
             SET peak_disk_bytes = @peakDiskBytes, peak_memory_bytes = @peakMemoryBytes,
                 peak_file_count = @peakFileCount, peak_process_count = @peakProcessCount,
                 raw_output_bytes = @rawOutputBytes, failed_cleanup_retained_bytes = @failedCleanupRetainedBytes,
                 quarantine_retained_bytes = @quarantineRetainedBytes,
                 capacity_revision = @capacityRevision, last_footprint_sha256 = @footprintSha256, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration`,
        )
        .run({
          peakDiskBytes: Math.max(current.peakDiskBytes, assertNonNegative(input.peakDiskBytes, "peakDiskBytes")),
          peakMemoryBytes: Math.max(
            current.peakMemoryBytes,
            assertNonNegative(input.peakMemoryBytes, "peakMemoryBytes"),
          ),
          peakFileCount: Math.max(current.peakFileCount, assertNonNegative(input.peakFileCount, "peakFileCount")),
          peakProcessCount: Math.max(
            current.peakProcessCount,
            assertNonNegative(input.peakProcessCount, "peakProcessCount"),
          ),
          rawOutputBytes: Math.max(current.rawOutputBytes, assertNonNegative(input.rawOutputBytes, "rawOutputBytes")),
          failedCleanupRetainedBytes: Math.max(
            current.failedCleanupRetainedBytes,
            assertNonNegative(input.failedCleanupRetainedBytes, "failedCleanupRetainedBytes"),
          ),
          quarantineRetainedBytes: Math.max(
            current.quarantineRetainedBytes,
            assertNonNegative(input.quarantineRetainedBytes, "quarantineRetainedBytes"),
          ),
          capacityRevision: nextCapacityRevision,
          footprintSha256,
          now,
          ...keyOf(input),
        });
      this.appendEvidence(
        current,
        {
          schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
          domain: "capacity",
          capacityRevision: nextCapacityRevision,
          footprintSha256,
          detailSha256: assertDigest(input.detailSha256, "detailSha256"),
        },
        now,
      );
      return this.getCellRow(input);
    });
  }

  /** A guarded cleanup transition; retained bytes may only be counted, never cleared. */
  public transitionCleanup(input: RemoteWorkerCellCleanupTransitionInput): RemoteWorkerCellRecord {
    const now = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      if (current.cleanupRevision !== input.expectedRevision) {
        throw new RemoteWorkerCellConflictError("Remote worker cell cleanup revision mismatch.");
      }
      if (!remoteWorkerCellCleanupCanTransition(current.cleanupState, input.toState)) {
        throw new RemoteWorkerCellConflictError(
          `Remote worker cell cleanup transition ${current.cleanupState} -> ${input.toState} is not permitted.`,
        );
      }
      // Cleanup succeeds (verified_clean) only from OS-authoritative zero-process
      // evidence; liveness_unknown must never reach verified_clean.
      if (input.toState === "verified_clean" && current.executionState === "liveness_unknown") {
        throw new RemoteWorkerCellConflictError("Remote worker cell with unknown liveness cannot be verified clean.");
      }
      const failedBytes = Math.max(
        current.failedCleanupRetainedBytes,
        input.failedCleanupRetainedBytes === undefined
          ? current.failedCleanupRetainedBytes
          : assertNonNegative(input.failedCleanupRetainedBytes, "failedCleanupRetainedBytes"),
      );
      const quarantineBytes = Math.max(
        current.quarantineRetainedBytes,
        input.quarantineRetainedBytes === undefined
          ? current.quarantineRetainedBytes
          : assertNonNegative(input.quarantineRetainedBytes, "quarantineRetainedBytes"),
      );
      this.db
        .prepare(
          `UPDATE remote_worker_cells
             SET cleanup_state = @toState, cleanup_revision = cleanup_revision + 1,
                 failed_cleanup_retained_bytes = @failedBytes,
                 quarantine_retained_bytes = @quarantineBytes, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND cleanup_state = @expectedState AND cleanup_revision = @expectedRevision`,
        )
        .run({
          toState: input.toState,
          expectedState: current.cleanupState,
          expectedRevision: input.expectedRevision,
          failedBytes,
          quarantineBytes,
          now,
          ...keyOf(input),
        });
      this.appendEvidence(current, cleanupEvidence(current.cleanupState, input.toState, input.detailSha256), now);
      return this.getCellRow(input);
    });
  }

  /** A guarded backup transition; restore/publication is blocked while liveness is unknown. */
  public transitionBackup(input: RemoteWorkerCellBackupTransitionInput): RemoteWorkerCellRecord {
    const now = assertTimestamp(input.now, "now");
    return this.db.transaction("immediate", () => {
      const current = this.getCellRow(input);
      if (current.backupRevision !== input.expectedRevision) {
        throw new RemoteWorkerCellConflictError("Remote worker cell backup revision mismatch.");
      }
      if (!remoteWorkerCellBackupCanTransition(current.backupState, input.toState)) {
        throw new RemoteWorkerCellConflictError(
          `Remote worker cell backup transition ${current.backupState} -> ${input.toState} is not permitted.`,
        );
      }
      if (
        current.executionState === "liveness_unknown" &&
        (input.toState === "staged" || input.toState === "verified" || input.toState === "restore_pending")
      ) {
        throw new RemoteWorkerCellConflictError(
          "Remote worker cell with unknown liveness cannot publish or restore a backup.",
        );
      }
      this.db
        .prepare(
          `UPDATE remote_worker_cells
             SET backup_state = @toState, backup_revision = backup_revision + 1, updated_at = @now
           WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
             AND assignment_generation = @assignmentGeneration
             AND backup_state = @expectedState AND backup_revision = @expectedRevision`,
        )
        .run({
          toState: input.toState,
          expectedState: current.backupState,
          expectedRevision: input.expectedRevision,
          now,
          ...keyOf(input),
        });
      this.appendEvidence(current, backupEvidence(current.backupState, input.toState, input.detailSha256), now);
      return this.getCellRow(input);
    });
  }

  public getCell(key: RemoteWorkerCellKey): RemoteWorkerCellRecord | undefined {
    const row = this.selectStmt().get({ ...keyOf(key) }) as CellRow | undefined;
    return row ? mapCell(row) : undefined;
  }

  public getCellByIdempotency(registryWorkspaceId: string, idempotencyKey: string): RemoteWorkerCellRecord | undefined {
    const row = this.findByIdempotency(registryWorkspaceId, idempotencyKey);
    return row ? mapCell(row) : undefined;
  }

  public listEvidenceAfter(key: RemoteWorkerCellKey, afterSequence: number): RemoteWorkerCellEvidenceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_worker_cell_evidence
          WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
            AND assignment_generation = @assignmentGeneration AND evidence_sequence > @afterSequence
          ORDER BY evidence_sequence ASC`,
      )
      .all({ ...keyOf(key), afterSequence: assertNonNegative(afterSequence, "afterSequence") }) as EvidenceRow[];
    return rows.map(mapEvidence);
  }

  // --- internals ------------------------------------------------------------

  private assertExecutionTransition(
    current: RemoteWorkerCellRecord,
    expectedRevision: number,
    toState: RemoteWorkerCellExecutionState,
  ): void {
    if (current.executionRevision !== expectedRevision) {
      throw new RemoteWorkerCellConflictError("Remote worker cell execution revision mismatch.");
    }
    if (!remoteWorkerCellExecutionCanTransition(current.executionState, toState)) {
      throw new RemoteWorkerCellConflictError(
        `Remote worker cell execution transition ${current.executionState} -> ${toState} is not permitted.`,
      );
    }
  }

  private appendEvidence(
    cell: RemoteWorkerCellRecord,
    payloadInput: Parameters<typeof normalizeRemoteWorkerCellEvidencePayload>[0],
    now: string,
  ): RemoteWorkerCellEvidenceRecord {
    const payload = normalizeRemoteWorkerCellEvidencePayload(payloadInput);
    const payloadSha256 = remoteWorkerCellEvidencePayloadSha256(payload);
    const payloadJson = canonicalJsonString(payload);
    const last = this.db
      .prepare(
        `SELECT evidence_sequence, evidence_sha256 FROM remote_worker_cell_evidence
          WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
            AND assignment_generation = @assignmentGeneration
          ORDER BY evidence_sequence DESC LIMIT 1`,
      )
      .get(keyOf(cell)) as { evidence_sequence: number | bigint; evidence_sha256: string } | undefined;
    const evidenceSequence = last ? asInt(last.evidence_sequence) + 1 : 1;
    const previousEvidenceSha256 = last ? last.evidence_sha256 : REMOTE_WORKER_CELL_EVIDENCE_GENESIS_SHA256;
    const evidenceSha256 = remoteWorkerCellEvidenceSha256({
      registryWorkspaceId: cell.registryWorkspaceId,
      assignmentId: cell.assignmentId,
      assignmentGeneration: cell.assignmentGeneration,
      cellId: cell.cellId,
      evidenceSequence,
      domain: payload.domain,
      payloadSha256,
      previousEvidenceSha256,
    });
    this.db
      .prepare(
        `INSERT INTO remote_worker_cell_evidence (
           registry_workspace_id, assignment_id, assignment_generation, cell_id, evidence_sequence,
           domain, payload_json, payload_sha256, previous_evidence_sha256, evidence_sha256, recorded_at
         ) VALUES (
           @registryWorkspaceId, @assignmentId, @assignmentGeneration, @cellId, @evidenceSequence,
           @domain, @payloadJson, @payloadSha256, @previousEvidenceSha256, @evidenceSha256, @recordedAt
         )`,
      )
      .run({
        registryWorkspaceId: cell.registryWorkspaceId,
        assignmentId: cell.assignmentId,
        assignmentGeneration: cell.assignmentGeneration,
        cellId: cell.cellId,
        evidenceSequence,
        domain: payload.domain,
        payloadJson,
        payloadSha256,
        previousEvidenceSha256,
        evidenceSha256,
        recordedAt: now,
      });
    return {
      registryWorkspaceId: cell.registryWorkspaceId,
      assignmentId: cell.assignmentId,
      assignmentGeneration: cell.assignmentGeneration,
      cellId: cell.cellId,
      evidenceSequence,
      domain: payload.domain,
      payloadJson,
      payloadSha256,
      previousEvidenceSha256,
      evidenceSha256,
      recordedAt: now,
    };
  }

  private getCellRow(key: RemoteWorkerCellKey): RemoteWorkerCellRecord {
    const record = this.getCell(key);
    if (!record) throw new RemoteWorkerCellConflictError("Remote worker cell not found.");
    return record;
  }

  private findByIdempotency(registryWorkspaceId: string, idempotencyKey: string): CellRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM remote_worker_cells
          WHERE registry_workspace_id = @registryWorkspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ registryWorkspaceId, idempotencyKey }) as CellRow | undefined;
  }

  private selectStmt() {
    return this.db.prepare(
      `SELECT * FROM remote_worker_cells
        WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId
          AND assignment_generation = @assignmentGeneration`,
    );
  }

  private insertStmt() {
    return this.db.prepare(
      `INSERT INTO remote_worker_cells (
         registry_workspace_id, assignment_id, assignment_generation, cell_id, worker_id, worker_generation,
         backend, idempotency_key, profile_sha256, request_sha256, logical_root_sha256, assignment_manifest_sha256,
         path_jail_sha256, capability_profile_sha256, context_snapshot_sha256, tool_effect_posture_sha256,
         runtime_attestation_sha256, launcher_attestation_sha256, logical_disk_bytes, allocated_disk_bytes,
         file_limit, inode_limit, process_limit, cpu_limit_milli, wall_limit_ms, memory_limit_bytes,
         raw_output_limit_bytes, diagnostic_limit_bytes, artifact_ceiling_bytes, backup_staging_bytes,
         backup_publication_bytes, egress_posture, egress_policy_sha256, egress_dns_revision, env_allowlist_sha256,
         execution_state, execution_revision, cleanup_state, cleanup_revision, backup_state, backup_revision,
         created_at, updated_at
       ) VALUES (
         @registryWorkspaceId, @assignmentId, @assignmentGeneration, @cellId, @workerId, @workerGeneration,
         @backend, @idempotencyKey, @profileSha256, @requestSha256, @logicalRootSha256, @assignmentManifestSha256,
         @pathJailSha256, @capabilityProfileSha256, @contextSnapshotSha256, @toolEffectPostureSha256,
         @runtimeAttestationSha256, @launcherAttestationSha256, @logicalDiskBytes, @allocatedDiskBytes,
         @fileLimit, @inodeLimit, @processLimit, @cpuLimitMilli, @wallLimitMs, @memoryLimitBytes,
         @rawOutputLimitBytes, @diagnosticLimitBytes, @artifactCeilingBytes, @backupStagingBytes,
         @backupPublicationBytes, @egressPosture, @egressPolicySha256, @egressDnsRevision, @envAllowlistSha256,
         'profiled', 1, 'not_started', 1, 'disabled', 1,
         @createdAt, @createdAt
       )`,
    );
  }
}

interface CellRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  cell_id: string;
  worker_id: string;
  worker_generation: number | bigint | string;
  backend: string;
  idempotency_key: string;
  profile_sha256: string;
  request_sha256: string;
  egress_posture: string;
  egress_dns_revision: number | bigint | string;
  execution_state: string;
  execution_revision: number | bigint | string;
  cleanup_state: string;
  cleanup_revision: number | bigint | string;
  backup_state: string;
  backup_revision: number | bigint | string;
  provisioning_owner: string | null;
  provisioning_lease_expires_at: string | null;
  platform_identity_sha256: string | null;
  container_name: string | null;
  image_digest: string | null;
  network_name: string | null;
  logical_disk_bytes: number | bigint | string;
  allocated_disk_bytes: number | bigint | string;
  peak_disk_bytes: number | bigint | string;
  peak_memory_bytes: number | bigint | string;
  peak_file_count: number | bigint | string;
  peak_process_count: number | bigint | string;
  raw_output_bytes: number | bigint | string;
  retained_diagnostic_bytes: number | bigint | string;
  failed_cleanup_retained_bytes: number | bigint | string;
  quarantine_retained_bytes: number | bigint | string;
  capacity_revision: number | bigint | string;
  last_footprint_sha256: string | null;
  exit_code: number | bigint | string | null;
  terminated_by_signal: string | null;
  diagnostic_capture_sha256: string | null;
  created_at: string;
  updated_at: string;
}

interface EvidenceRow {
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number | bigint | string;
  cell_id: string;
  evidence_sequence: number | bigint | string;
  domain: string;
  payload_json: string;
  payload_sha256: string;
  previous_evidence_sha256: string;
  evidence_sha256: string;
  recorded_at: string;
}

function mapCell(row: CellRow): RemoteWorkerCellRecord {
  return {
    registryWorkspaceId: row.registry_workspace_id,
    assignmentId: row.assignment_id,
    assignmentGeneration: asInt(row.assignment_generation),
    cellId: row.cell_id,
    workerId: row.worker_id,
    workerGeneration: asInt(row.worker_generation),
    backend: row.backend as "container",
    idempotencyKey: row.idempotency_key,
    profileSha256: row.profile_sha256,
    requestSha256: row.request_sha256,
    egressPosture: row.egress_posture as "deny_all" | "allowlisted",
    egressDnsRevision: asInt(row.egress_dns_revision),
    executionState: row.execution_state as RemoteWorkerCellExecutionState,
    executionRevision: asInt(row.execution_revision),
    cleanupState: row.cleanup_state as RemoteWorkerCellCleanupState,
    cleanupRevision: asInt(row.cleanup_revision),
    backupState: row.backup_state as RemoteWorkerCellBackupState,
    backupRevision: asInt(row.backup_revision),
    ...(row.provisioning_owner === null ? {} : { provisioningOwner: row.provisioning_owner }),
    ...(row.provisioning_lease_expires_at === null
      ? {}
      : { provisioningLeaseExpiresAt: row.provisioning_lease_expires_at }),
    ...(row.platform_identity_sha256 === null ? {} : { platformIdentitySha256: row.platform_identity_sha256 }),
    ...(row.container_name === null ? {} : { containerName: row.container_name }),
    ...(row.image_digest === null ? {} : { imageDigest: row.image_digest }),
    ...(row.network_name === null ? {} : { networkName: row.network_name }),
    logicalDiskBytes: asInt(row.logical_disk_bytes),
    allocatedDiskBytes: asInt(row.allocated_disk_bytes),
    peakDiskBytes: asInt(row.peak_disk_bytes),
    peakMemoryBytes: asInt(row.peak_memory_bytes),
    peakFileCount: asInt(row.peak_file_count),
    peakProcessCount: asInt(row.peak_process_count),
    rawOutputBytes: asInt(row.raw_output_bytes),
    retainedDiagnosticBytes: asInt(row.retained_diagnostic_bytes),
    failedCleanupRetainedBytes: asInt(row.failed_cleanup_retained_bytes),
    quarantineRetainedBytes: asInt(row.quarantine_retained_bytes),
    capacityRevision: asInt(row.capacity_revision),
    ...(row.last_footprint_sha256 === null ? {} : { lastFootprintSha256: row.last_footprint_sha256 }),
    ...(row.exit_code === null ? {} : { exitCode: asInt(row.exit_code) }),
    ...(row.terminated_by_signal === null ? {} : { terminatedBySignal: row.terminated_by_signal }),
    ...(row.diagnostic_capture_sha256 === null ? {} : { diagnosticCaptureSha256: row.diagnostic_capture_sha256 }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvidence(row: EvidenceRow): RemoteWorkerCellEvidenceRecord {
  return {
    registryWorkspaceId: row.registry_workspace_id,
    assignmentId: row.assignment_id,
    assignmentGeneration: asInt(row.assignment_generation),
    cellId: row.cell_id,
    evidenceSequence: asInt(row.evidence_sequence),
    domain: row.domain as RemoteWorkerCellEvidenceDomain,
    payloadJson: row.payload_json,
    payloadSha256: row.payload_sha256,
    previousEvidenceSha256: row.previous_evidence_sha256,
    evidenceSha256: row.evidence_sha256,
    recordedAt: row.recorded_at,
  };
}

function executionEvidence(fromState: string, toState: string, detailSha256: string) {
  return {
    schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
    domain: "execution" as const,
    fromState,
    toState,
    detailSha256: assertDigest(detailSha256, "detailSha256"),
  };
}

function cleanupEvidence(fromState: string, toState: string, detailSha256: string) {
  return {
    schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
    domain: "cleanup" as const,
    fromState,
    toState,
    detailSha256: assertDigest(detailSha256, "detailSha256"),
  };
}

function backupEvidence(fromState: string, toState: string, detailSha256: string) {
  return {
    schemaVersion: REMOTE_WORKER_CELL_EVIDENCE_SCHEMA_VERSION,
    domain: "backup" as const,
    fromState,
    toState,
    detailSha256: assertDigest(detailSha256, "detailSha256"),
  };
}

function keyOf(value: RemoteWorkerCellKey): RemoteWorkerCellKey {
  return {
    registryWorkspaceId: value.registryWorkspaceId,
    assignmentId: value.assignmentId,
    assignmentGeneration: value.assignmentGeneration,
  };
}

function asInt(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("Remote worker cell stored integer is out of safe range.");
  }
  return parsed;
}

function assertBounded(value: string, field: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new TypeError(`Remote worker cell ${field} is invalid.`);
  }
  return value;
}

function assertDigest(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker cell ${field} must be a lower-case SHA-256 digest.`);
  }
  return value;
}

function assertNonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Remote worker cell ${field} must be a non-negative integer.`);
  }
  return value;
}

function assertExitCode(value: number): number {
  if (!Number.isSafeInteger(value) || value < -1 || value > 255) {
    throw new TypeError("Remote worker cell exit code must be between -1 and 255.");
  }
  return value;
}

function assertTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Remote worker cell ${field} must be a canonical UTC timestamp.`);
  }
  return value;
}
