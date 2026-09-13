import {
  assertRemoteWorkerCellProvisioningSuccessor, canonicalJsonString, normalizeRemoteWorkerCellProvisioningPlan,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerCellProvisioningBindingSha256,
  remoteWorkerCellProvisioningPlanSha256, REMOTE_WORKER_CELL_PROVISIONING_JOURNAL_RESERVED_BYTES,
  normalizeRemoteWorkerCellProvisioningSubmission, normalizeRemoteWorkerCellProvisioningExchange,
  REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
  normalizeRemoteWorkerCellPreparation, normalizeRemoteWorkerCellPreparationSubmission, remoteWorkerCellProfileSha256,
  createRemoteWorkerCellDiskLayoutPlan, normalizeRemoteWorkerCellVolumeAnchor, normalizeRemoteWorkerCellVolumeSubmission,
  readRemoteWorkerCellVolumeCheckpoint, assertRemoteWorkerCellVolumeSuccessor, REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
  type RemoteWorkerCellVolumeCheckpoint,
  normalizeRemoteWorkerCellFormatAnchor, normalizeRemoteWorkerCellFormatSubmission, readRemoteWorkerCellFormatCheckpoint,
  assertRemoteWorkerCellFormatSuccessor, REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION, type RemoteWorkerCellFormatCheckpoint,
  normalizeRemoteWorkerCellProtectionAnchor, normalizeRemoteWorkerCellProtectionSubmission, readRemoteWorkerCellProtectionCheckpoint,
  assertRemoteWorkerCellProtectionSuccessor, REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION, type RemoteWorkerCellProtectionCheckpoint,
  normalizeRemoteWorkerCellMountAnchor, normalizeRemoteWorkerCellMountSubmission, readRemoteWorkerCellMountCheckpoint,
  assertRemoteWorkerCellMountSuccessor, REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION, type RemoteWorkerCellMountCheckpoint,
  normalizeRemoteWorkerCellMountedWorkspaceAnchor, normalizeRemoteWorkerCellMountedWorkspaceSubmission, readRemoteWorkerCellMountedWorkspaceCheckpoint,
  assertRemoteWorkerCellMountedWorkspaceSuccessor, REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION, type RemoteWorkerCellMountedWorkspaceCheckpoint,
  type RemoteWorkerCellPreparation, type RemoteWorkerCellPreparationSubmission,
  type RemoteWorkerCellProvisioningCheckpoint, type RemoteWorkerCellProvisioningPlan,
  type RemoteWorkerCellProvisioningSubmission, type RemoteWorkerCellProvisioningExchange,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { buildRemoteWorkerNativeCellProfile, snapshotRemoteWorkerNativeCellPolicy,
  type RemoteWorkerNativeCellPolicy } from "./remote-worker-cell-native-profile.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellConflictError, RemoteWorkerCellRepository, type RemoteWorkerCellKey } from "./remote-worker-cell-repo.js";

export interface RemoteWorkerCellProvisioningAuthority extends RemoteWorkerCellKey {
  readonly provisioningOwner: string;
  readonly provisioningLeaseExpiresAt: string;
}
export interface RemoteWorkerCellProvisioningPlanRecord extends RemoteWorkerCellProvisioningAuthority {
  readonly plan: RemoteWorkerCellProvisioningPlan;
  readonly planSha256: string;
  readonly capacityRevision: number;
  readonly createdAt: string;
}
export interface RemoteWorkerCellProvisioningSnapshot {
  readonly plan: RemoteWorkerCellProvisioningPlanRecord;
  readonly checkpoints: readonly RemoteWorkerCellProvisioningCheckpoint[];
  readonly volumeCheckpoints: readonly RemoteWorkerCellVolumeCheckpoint[];
  readonly formatCheckpoints: readonly RemoteWorkerCellFormatCheckpoint[];
  readonly protectionCheckpoints: readonly RemoteWorkerCellProtectionCheckpoint[];
  readonly mountCheckpoints: readonly RemoteWorkerCellMountCheckpoint[];
  readonly mountedWorkspaceCheckpoints: readonly RemoteWorkerCellMountedWorkspaceCheckpoint[];
}
export interface RemoteWorkerCellProvisioningAssignmentInput extends RemoteWorkerCellKey {
  readonly leaseRevision: number;
  readonly leaseTokenSha256: string;
  readonly protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence;
  readonly submission: RemoteWorkerCellProvisioningSubmission;
}
export interface RemoteWorkerCellPreparationAssignmentInput extends Omit<RemoteWorkerCellProvisioningAssignmentInput, "submission"> {
  readonly submission: RemoteWorkerCellPreparationSubmission;
}
export type { RemoteWorkerNativeCellPolicy } from "./remote-worker-cell-native-profile.js";
type PlanRow = {
  registry_workspace_id: string; assignment_id: string; assignment_generation: number;
  provisioning_owner: string; provisioning_lease_expires_at: string;
  profile_sha256: string; plan_sha256: string; plan_json: string; capacity_revision: number; created_at: string;
};
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const keyOf = (input: RemoteWorkerCellKey) => ({ registryWorkspaceId: input.registryWorkspaceId,
  assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration });
const conflict = (message: string) => new RemoteWorkerCellConflictError(message);

/** Canonical, append-only resource facts. These records do not authorize workload
 * execution or cleanup. The native owner independently verifies actual OS state. */
export class RemoteWorkerCellProvisioningRepository {
  private readonly cells: RemoteWorkerCellRepository;
  private readonly clock: DurableRunRepository;
  private readonly assignments: RemoteWorkerAssignmentRepository;
  private readonly admissions: RemoteWorkerAdmissionRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.cells = new RemoteWorkerCellRepository(db);
    this.clock = new DurableRunRepository(db);
    this.assignments = new RemoteWorkerAssignmentRepository(db);
    this.admissions = new RemoteWorkerAdmissionRepository(db);
  }

  /** The profile, capacity, claim and first plan commit together. The insert is
   * the single creation decision: a lost response or retry returns reconcile,
   * never another create_once, even when no native checkpoint was received. */
  public prepareForAssignment(input: RemoteWorkerCellPreparationAssignmentInput & {
    readonly policy: RemoteWorkerNativeCellPolicy;
  }): RemoteWorkerCellPreparation {
    if (!input.protectedAuthority) throw conflict("Cell preparation requires protected assignment authority.");
    const frozen = Object.freeze({ ...keyOf(input), leaseRevision: input.leaseRevision,
      leaseTokenSha256: input.leaseTokenSha256,
      protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
        meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }),
      submission: normalizeRemoteWorkerCellPreparationSubmission(input.submission) });
    const policy = snapshotRemoteWorkerNativeCellPolicy(input.policy);
    return this.db.transaction("immediate", () => {
      const authority = this.assertAssignment(frozen);
      const worker = this.admissions.findCurrentGeneration(frozen.registryWorkspaceId, authority.generation.workerId);
      if (!worker) throw conflict("Cell preparation requires its current admitted worker.");
      const bootstrap = this.admissions.getBootstrap(frozen.registryWorkspaceId, worker.bootstrapId);
      const native = buildRemoteWorkerNativeCellProfile(authority, worker, bootstrap, frozen.submission.parentIdentityHex, policy);
      const profileSha256 = remoteWorkerCellProfileSha256(native.profile);
      let prepared = this.getPlan(frozen);
      let decision: RemoteWorkerCellPreparation["decision"] = "reconcile";
      if (prepared) {
        const cell = this.assertAuthority(prepared);
        if (cell.profileSha256 !== profileSha256 || prepared.plan.profileSha256 !== profileSha256 ||
            prepared.plan.parentIdentityHex !== frozen.submission.parentIdentityHex ||
            prepared.plan.cellName !== native.cellName || prepared.plan.diskIdentifierHex !== native.diskIdentifierHex ||
            prepared.plan.reservedDiskBytes !== native.reservedDiskBytes ||
            prepared.plan.virtualDiskBytes !== native.profile.capacity.logicalDiskBytes) {
          throw conflict("Cell preparation differs from its retained canonical profile or plan.");
        }
      } else {
        const now = this.clock.readDatabaseNow();
        const until = Math.min(Date.parse(now) + policy.provisioningWallMs, Date.parse(authority.assignment.manifest.deadlineAt));
        if (until - Date.parse(now) < 1000) throw conflict("Cell preparation deadline is too close or expired.");
        const profiled = this.cells.profileOrReplay({ profile: native.profile,
          idempotencyKey: `native-cell:${native.cellName}`, createdAt: now });
        if (profiled.disposition !== "created") throw conflict("Existing unprepared cell requires reconciliation.");
        const claim = { ...keyOf(frozen), provisioningOwner: `native-provisioning:${native.cellName}`,
          provisioningLeaseExpiresAt: new Date(until).toISOString() };
        const cell = this.cells.claimProvisioning({ ...keyOf(frozen), provisioningOwner: claim.provisioningOwner,
          leaseExpiresAt: claim.provisioningLeaseExpiresAt, detailSha256: profileSha256, now });
        if (!cell) throw conflict("Cell preparation claim is unavailable.");
        const first = this.prepare({ ...claim, expectedCapacityRevision: cell.capacityRevision,
          plan: { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION, profileSha256,
            assignmentBindingSha256: remoteWorkerCellProvisioningBindingSha256({ ...claim, cellId: cell.cellId,
              workerId: cell.workerId, workerGeneration: cell.workerGeneration, profileSha256 }),
            parentIdentityHex: frozen.submission.parentIdentityHex, cellName: native.cellName,
            ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721",
            diskIdentifierHex: native.diskIdentifierHex, virtualDiskBytes: cell.logicalDiskBytes, reservedDiskBytes: native.reservedDiskBytes } });
        if (first.disposition !== "created") throw conflict("Cell creation decision changed during preparation.");
        prepared = first.record;
        decision = "create_once";
      }
      const exchange = this.exchangeWithAssignment({ ...frozen, submission: { kind: "cell.provisioning.snapshot" } });
      return normalizeRemoteWorkerCellPreparation({ schemaVersion: REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION,
        decision, provisioningExpiresAt: prepared.provisioningLeaseExpiresAt, exchange });
    });
  }

  /** A wire request's initial authentication is advisory. Lock the current
   * protected assignment before the cell, retain those locks through the write,
   * and recheck its authority and both expiries before committing or replaying. */
  public exchangeWithAssignment(input: RemoteWorkerCellProvisioningAssignmentInput): RemoteWorkerCellProvisioningExchange {
    if (!input.protectedAuthority) throw conflict("Cell provisioning requires protected assignment authority.");
    const frozen = Object.freeze({ ...keyOf(input), leaseRevision: input.leaseRevision,
      leaseTokenSha256: input.leaseTokenSha256,
      protectedAuthority: Object.freeze({
        credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
        meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }),
      }), submission: normalizeRemoteWorkerCellProvisioningSubmission(input.submission) });
    return this.db.transaction("immediate", () => {
      const authority = this.assertAssignment(frozen);
      const prepared = this.getPlan(frozen);
      if (!prepared) throw conflict("Cell provisioning requires a canonical prepared plan.");
      const cell = this.assertAuthority(prepared);
      if (cell.workerId !== authority.generation.workerId || cell.workerGeneration !== authority.generation.workerGeneration) {
        throw conflict("Cell provisioning does not belong to the active worker generation.");
      }
      if (frozen.submission.kind === "cell.provisioning.checkpoint") {
        this.appendCheckpoint({ ...prepared, expectedSequence: frozen.submission.expectedSequence,
          recordHex: frozen.submission.recordHex });
      } else if (frozen.submission.kind === "cell.volume.checkpoint") {
        this.appendVolumeCheckpoint({ ...prepared, expectedSequence: frozen.submission.expectedSequence,
          recordHex: frozen.submission.recordHex });
      } else if (frozen.submission.kind === "cell.format.checkpoint") {
        this.appendFormatCheckpoint({ ...prepared, expectedSequence: frozen.submission.expectedSequence,
          recordHex: frozen.submission.recordHex });
      } else if (frozen.submission.kind === "cell.protection.checkpoint") {
        this.appendProtectionCheckpoint({ ...prepared, expectedSequence: frozen.submission.expectedSequence,
          recordHex: frozen.submission.recordHex });
      } else if (frozen.submission.kind === "cell.mount.checkpoint") {
        this.appendMountCheckpoint({ ...prepared, expectedSequence: frozen.submission.expectedSequence,
          recordHex: frozen.submission.recordHex });
      } else if (frozen.submission.kind === "cell.mounted-workspace.checkpoint") {
        this.appendMountedWorkspaceCheckpoint({ ...prepared, expectedSequence: frozen.submission.expectedSequence,
          recordHex: frozen.submission.recordHex });
      }
      const snapshot = this.getSnapshot(frozen)!;
      const result = normalizeRemoteWorkerCellProvisioningExchange({
        schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION, ...keyOf(frozen),
        leaseRevision: frozen.leaseRevision, plan: snapshot.plan.plan, planSha256: snapshot.plan.planSha256,
        records: snapshot.checkpoints.map((checkpoint) => checkpoint.recordHex),
        volumeRecords: snapshot.volumeCheckpoints.map((checkpoint) => checkpoint.recordHex),
        formatRecords: snapshot.formatCheckpoints.map((checkpoint) => checkpoint.recordHex),
        protectionRecords: snapshot.protectionCheckpoints.map((checkpoint) => checkpoint.recordHex),
        mountRecords: snapshot.mountCheckpoints.map((checkpoint) => checkpoint.recordHex),
        mountedWorkspaceRecords: snapshot.mountedWorkspaceCheckpoints.map((checkpoint) => checkpoint.recordHex),
      });
      this.assertAssignment(frozen);
      this.assertAuthority(prepared);
      return result;
    });
  }

  private assertAssignment(input: Omit<RemoteWorkerCellProvisioningAssignmentInput, "submission">) {
    const authority = this.assignments.resolveActiveAuthorityByLeaseTokenHash(input.leaseTokenSha256, input.protectedAuthority);
    if (!authority || authority.assignment.registryWorkspaceId !== input.registryWorkspaceId ||
        authority.assignment.assignmentId !== input.assignmentId ||
        authority.generation.assignmentGeneration !== input.assignmentGeneration ||
        authority.lease.leaseRevision !== input.leaseRevision) {
      throw conflict("Cell provisioning requires the exact active assignment lease.");
    }
    return authority;
  }

  public prepare(input: RemoteWorkerCellProvisioningAuthority & {
    readonly plan: RemoteWorkerCellProvisioningPlan; readonly expectedCapacityRevision: number;
  }): { disposition: "created" | "replayed"; record: RemoteWorkerCellProvisioningPlanRecord } {
    const plan = normalizeRemoteWorkerCellProvisioningPlan(input.plan);
    const planSha256 = remoteWorkerCellProvisioningPlanSha256(plan);
    return this.db.transaction("immediate", () => {
      const cell = this.assertAuthority(input);
      const prior = this.getPlan(input);
      if (prior) {
        if (prior.planSha256 !== planSha256 || prior.provisioningOwner !== input.provisioningOwner ||
            prior.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt ||
            prior.capacityRevision !== input.expectedCapacityRevision) throw conflict("Cell provisioning plan is immutable.");
        return { disposition: "replayed", record: prior };
      }
      if (cell.capacityRevision !== input.expectedCapacityRevision) throw conflict("Cell provisioning capacity revision changed.");
      const binding = remoteWorkerCellProvisioningBindingSha256({ ...keyOf(cell), cellId: cell.cellId,
        workerId: cell.workerId, workerGeneration: cell.workerGeneration, profileSha256: cell.profileSha256,
        provisioningOwner: input.provisioningOwner, provisioningLeaseExpiresAt: input.provisioningLeaseExpiresAt });
      if (plan.profileSha256 !== cell.profileSha256 || plan.assignmentBindingSha256 !== binding ||
          plan.virtualDiskBytes > cell.logicalDiskBytes ||
          plan.reservedDiskBytes + REMOTE_WORKER_CELL_PROVISIONING_JOURNAL_RESERVED_BYTES > cell.allocatedDiskBytes) {
        throw conflict("Cell provisioning plan differs from its canonical profile, claim or capacity reservation.");
      }
      this.db.prepare(`INSERT INTO remote_worker_cell_provisioning (${columns}) VALUES
        (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @profileSha256, @planSha256, @planJson,
          @owner, @lease, @capacityRevision, @now)`).run({ ...keyOf(input), profileSha256: plan.profileSha256,
        planSha256, planJson: canonicalJsonString(plan), owner: input.provisioningOwner, lease: input.provisioningLeaseExpiresAt,
        capacityRevision: input.expectedCapacityRevision, now: this.clock.readDatabaseNow() });
      return { disposition: "created", record: this.getPlan(input)! };
    });
  }

  public appendCheckpoint(input: RemoteWorkerCellProvisioningAuthority & {
    readonly expectedSequence: number; readonly recordHex: string;
  }): RemoteWorkerCellProvisioningCheckpoint {
    const next = readRemoteWorkerCellProvisioningCheckpoint(input.recordHex);
    if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence !== next.sequence - 1) {
      throw conflict("Cell provisioning checkpoint expected sequence is invalid.");
    }
    return this.db.transaction("immediate", () => {
      this.assertAuthority(input);
      const snapshot = this.getSnapshot(input);
      if (!snapshot || snapshot.plan.provisioningOwner !== input.provisioningOwner ||
          snapshot.plan.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt) {
        throw conflict("Cell provisioning plan does not belong to this claim.");
      }
      const existing = snapshot.checkpoints[next.sequence - 1];
      if (existing) {
        if (existing.recordHex !== next.recordHex) throw conflict("Cell provisioning checkpoint cannot be replaced.");
        return existing;
      }
      if (snapshot.checkpoints.length !== input.expectedSequence) throw conflict("Cell provisioning checkpoint sequence changed.");
      assertRemoteWorkerCellProvisioningSuccessor(snapshot.plan.plan, snapshot.checkpoints.at(-1), next);
      this.db.prepare(`INSERT INTO remote_worker_cell_provisioning_checkpoints
        (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex,
          record_sha256, previous_record_sha256, recorded_at) VALUES
        (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @sequence, @phase, @recordHex,
          @recordSha256, @previousRecordSha256, @now)`).run({ ...keyOf(input), sequence: next.sequence, phase: next.phase,
        recordHex: next.recordHex, recordSha256: next.recordSha256, previousRecordSha256: next.previousRecordSha256,
        now: this.clock.readDatabaseNow() });
      return next;
    });
  }

  public appendVolumeCheckpoint(input: RemoteWorkerCellProvisioningAuthority & {
    readonly expectedSequence: number; readonly recordHex: string;
  }): RemoteWorkerCellVolumeCheckpoint {
    const submission = normalizeRemoteWorkerCellVolumeSubmission({ kind: "cell.volume.checkpoint",
      expectedSequence: input.expectedSequence, recordHex: input.recordHex });
    return this.db.transaction("immediate", () => {
      this.assertAuthority(input);
      const snapshot = this.getSnapshot(input);
      if (!snapshot || snapshot.plan.provisioningOwner !== input.provisioningOwner ||
          snapshot.plan.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt) {
        throw conflict("Cell volume plan does not belong to this claim.");
      }
      const anchor = volumeAnchor(snapshot.plan, snapshot.checkpoints);
      const next = readRemoteWorkerCellVolumeCheckpoint(anchor, submission.recordHex);
      const existing = snapshot.volumeCheckpoints[next.sequence - 1];
      if (existing) {
        if (existing.recordHex !== next.recordHex) throw conflict("Cell volume checkpoint cannot be replaced.");
        return existing;
      }
      if (snapshot.volumeCheckpoints.length !== submission.expectedSequence) throw conflict("Cell volume checkpoint sequence changed.");
      assertRemoteWorkerCellVolumeSuccessor(anchor, snapshot.volumeCheckpoints.at(-1), next);
      this.db.prepare(`INSERT INTO remote_worker_cell_volume_checkpoints
        (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex,
          record_sha256, previous_record_sha256, disk_recorded_sha256, recorded_at) VALUES
        (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @sequence, @phase, @recordHex,
          @recordSha256, @previousRecordSha256, @diskRecordedSha256, @now)`).run({ ...keyOf(input),
        sequence: next.sequence, phase: next.phase, recordHex: next.recordHex, recordSha256: next.recordSha256,
        previousRecordSha256: next.previousRecordSha256, diskRecordedSha256: anchor.diskRecordedSha256,
        now: this.clock.readDatabaseNow() });
      this.assertAuthority(input);
      return next;
    });
  }

  public appendFormatCheckpoint(input: RemoteWorkerCellProvisioningAuthority & {
    readonly expectedSequence: number; readonly recordHex: string;
  }): RemoteWorkerCellFormatCheckpoint {
    const submission = normalizeRemoteWorkerCellFormatSubmission({ kind: "cell.format.checkpoint",
      expectedSequence: input.expectedSequence, recordHex: input.recordHex });
    return this.db.transaction("immediate", () => {
      this.assertAuthority(input);
      const snapshot = this.getSnapshot(input);
      if (!snapshot || snapshot.plan.provisioningOwner !== input.provisioningOwner ||
          snapshot.plan.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt) {
        throw conflict("Cell formatting plan does not belong to this claim.");
      }
      const anchor = formatAnchor(snapshot.plan, snapshot.checkpoints, snapshot.volumeCheckpoints);
      const next = readRemoteWorkerCellFormatCheckpoint(anchor, submission.recordHex);
      const existing = snapshot.formatCheckpoints[next.sequence - 1];
      if (existing) {
        if (existing.recordHex !== next.recordHex) throw conflict("Cell format checkpoint cannot be replaced.");
        this.assertAuthority(input);
        return existing;
      }
      if (snapshot.formatCheckpoints.length !== submission.expectedSequence) throw conflict("Cell format checkpoint sequence changed.");
      assertRemoteWorkerCellFormatSuccessor(anchor, snapshot.formatCheckpoints.at(-1), next);
      this.db.prepare(`INSERT INTO remote_worker_cell_format_checkpoints
        (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex,
          record_sha256, previous_record_sha256, volume_recorded_sha256, recorded_at) VALUES
        (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @sequence, @phase, @recordHex,
          @recordSha256, @previousRecordSha256, @volumeRecordedSha256, @now)`).run({ ...keyOf(input),
        sequence: next.sequence, phase: next.phase, recordHex: next.recordHex, recordSha256: next.recordSha256,
        previousRecordSha256: next.previousRecordSha256, volumeRecordedSha256: next.volumeRecordedSha256,
        now: this.clock.readDatabaseNow() });
      this.assertAuthority(input);
      return next;
    });
  }

  public appendProtectionCheckpoint(input: RemoteWorkerCellProvisioningAuthority & {
    readonly expectedSequence: number; readonly recordHex: string;
  }): RemoteWorkerCellProtectionCheckpoint {
    const submission = normalizeRemoteWorkerCellProtectionSubmission({ kind: "cell.protection.checkpoint",
      expectedSequence: input.expectedSequence, recordHex: input.recordHex });
    return this.db.transaction("immediate", () => {
      this.assertAuthority(input);
      const snapshot = this.getSnapshot(input);
      if (!snapshot || snapshot.plan.provisioningOwner !== input.provisioningOwner ||
          snapshot.plan.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt) {
        throw conflict("Cell protection plan does not belong to this claim.");
      }
      const anchor = protectionAnchor(snapshot.plan, snapshot.checkpoints, snapshot.volumeCheckpoints, snapshot.formatCheckpoints);
      const next = readRemoteWorkerCellProtectionCheckpoint(anchor, submission.recordHex);
      const existing = snapshot.protectionCheckpoints[next.sequence - 1];
      if (existing) {
        if (existing.recordHex !== next.recordHex) throw conflict("Cell protection checkpoint cannot be replaced.");
        this.assertAuthority(input);
        return existing;
      }
      if (snapshot.protectionCheckpoints.length !== submission.expectedSequence) throw conflict("Cell protection checkpoint sequence changed.");
      assertRemoteWorkerCellProtectionSuccessor(anchor, snapshot.protectionCheckpoints.at(-1), next);
      this.db.prepare(`INSERT INTO remote_worker_cell_protection_checkpoints
        (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex,
          record_sha256, previous_record_sha256, format_recorded_sha256, recorded_at) VALUES
        (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @sequence, @phase, @recordHex,
          @recordSha256, @previousRecordSha256, @formatRecordedSha256, @now)`).run({ ...keyOf(input),
        sequence: next.sequence, phase: next.phase, recordHex: next.recordHex, recordSha256: next.recordSha256,
        previousRecordSha256: next.previousRecordSha256, formatRecordedSha256: next.formatRecordedSha256,
        now: this.clock.readDatabaseNow() });
      this.assertAuthority(input);
      return next;
    });
  }

  public appendMountCheckpoint(input: RemoteWorkerCellProvisioningAuthority & {
    readonly expectedSequence: number; readonly recordHex: string;
  }): RemoteWorkerCellMountCheckpoint {
    const submission = normalizeRemoteWorkerCellMountSubmission({ kind: "cell.mount.checkpoint",
      expectedSequence: input.expectedSequence, recordHex: input.recordHex });
    return this.db.transaction("immediate", () => {
      this.assertAuthority(input);
      const snapshot = this.getSnapshot(input);
      if (!snapshot || snapshot.plan.provisioningOwner !== input.provisioningOwner ||
          snapshot.plan.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt) {
        throw conflict("Cell mount plan does not belong to this claim.");
      }
      const anchor = mountAnchor(snapshot.plan, snapshot.checkpoints, snapshot.volumeCheckpoints, snapshot.formatCheckpoints, snapshot.protectionCheckpoints);
      const next = readRemoteWorkerCellMountCheckpoint(anchor, submission.recordHex);
      const existing = snapshot.mountCheckpoints[next.sequence - 1];
      if (existing) {
        if (existing.recordHex !== next.recordHex) throw conflict("Cell mount checkpoint cannot be replaced.");
        this.assertAuthority(input);
        return existing;
      }
      if (snapshot.mountCheckpoints.length !== submission.expectedSequence) throw conflict("Cell mount checkpoint sequence changed.");
      assertRemoteWorkerCellMountSuccessor(anchor, snapshot.mountCheckpoints.at(-1), next);
      this.db.prepare(`INSERT INTO remote_worker_cell_mount_checkpoints
        (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex,
          record_sha256, previous_record_sha256, protection_recorded_sha256, recorded_at) VALUES
        (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @sequence, @phase, @recordHex,
          @recordSha256, @previousRecordSha256, @protectionRecordedSha256, @now)`).run({ ...keyOf(input),
        sequence: next.sequence, phase: next.phase, recordHex: next.recordHex, recordSha256: next.recordSha256,
        previousRecordSha256: next.previousRecordSha256, protectionRecordedSha256: next.protectionRecordedSha256,
        now: this.clock.readDatabaseNow() });
      this.assertAuthority(input);
      return next;
    });
  }

  public appendMountedWorkspaceCheckpoint(input: RemoteWorkerCellProvisioningAuthority & {
    readonly expectedSequence: number; readonly recordHex: string;
  }): RemoteWorkerCellMountedWorkspaceCheckpoint {
    const submission = normalizeRemoteWorkerCellMountedWorkspaceSubmission({ kind: "cell.mounted-workspace.checkpoint",
      expectedSequence: input.expectedSequence, recordHex: input.recordHex });
    return this.db.transaction("immediate", () => {
      this.assertAuthority(input);
      const snapshot = this.getSnapshot(input);
      if (!snapshot || snapshot.plan.provisioningOwner !== input.provisioningOwner ||
          snapshot.plan.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt) {
        throw conflict("Cell mounted workspace plan does not belong to this claim.");
      }
      const anchor = mountedWorkspaceAnchor(snapshot.plan, snapshot.checkpoints, snapshot.volumeCheckpoints, snapshot.formatCheckpoints, snapshot.protectionCheckpoints, snapshot.mountCheckpoints);
      const next = readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, submission.recordHex);
      const existing = snapshot.mountedWorkspaceCheckpoints[next.sequence - 1];
      if (existing) {
        if (existing.recordHex !== next.recordHex) throw conflict("Cell mounted workspace checkpoint cannot be replaced.");
        this.assertAuthority(input);
        return existing;
      }
      if (snapshot.mountedWorkspaceCheckpoints.length !== submission.expectedSequence) throw conflict("Cell mounted workspace checkpoint sequence changed.");
      assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, snapshot.mountedWorkspaceCheckpoints.at(-1), next);
      this.db.prepare(`INSERT INTO remote_worker_cell_mounted_workspace_checkpoints
        (registry_workspace_id, assignment_id, assignment_generation, sequence, phase, record_hex,
          record_sha256, previous_record_sha256, mount_recorded_sha256, recorded_at) VALUES
        (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @sequence, @phase, @recordHex,
          @recordSha256, @previousRecordSha256, @mountRecordedSha256, @now)`).run({ ...keyOf(input),
        sequence: next.sequence, phase: next.phase, recordHex: next.recordHex, recordSha256: next.recordSha256,
        previousRecordSha256: next.previousRecordSha256, mountRecordedSha256: next.mountRecordedSha256,
        now: this.clock.readDatabaseNow() });
      this.assertAuthority(input);
      return next;
    });
  }

  public getSnapshot(key: RemoteWorkerCellKey): RemoteWorkerCellProvisioningSnapshot | undefined {
    return this.db.transaction("deferred", () => {
      const plan = this.getPlan(key);
      if (!plan) return undefined;
      const rows = this.db.prepare(`SELECT sequence, phase, record_hex, record_sha256, previous_record_sha256
        FROM remote_worker_cell_provisioning_checkpoints WHERE ${WHERE} ORDER BY sequence LIMIT 6`)
        .all<{ sequence: number; phase: string; record_hex: string; record_sha256: string; previous_record_sha256: string }>(keyOf(key));
      if (rows.length > 5) throw conflict("Cell provisioning checkpoint inventory is invalid.");
      const checkpoints: RemoteWorkerCellProvisioningCheckpoint[] = [];
      for (const row of rows) {
        const checkpoint = readRemoteWorkerCellProvisioningCheckpoint(row.record_hex);
        if (checkpoint.sequence !== row.sequence || checkpoint.phase !== row.phase ||
            checkpoint.recordSha256 !== row.record_sha256 || checkpoint.previousRecordSha256 !== row.previous_record_sha256) {
          throw conflict("Cell provisioning checkpoint metadata differs from its retained record.");
        }
        assertRemoteWorkerCellProvisioningSuccessor(plan.plan, checkpoints.at(-1), checkpoint);
        checkpoints.push(checkpoint);
      }
      const volumeRows = this.db.prepare(`SELECT sequence, phase, record_hex, record_sha256, previous_record_sha256, disk_recorded_sha256
        FROM remote_worker_cell_volume_checkpoints WHERE ${WHERE} ORDER BY sequence LIMIT 7`)
        .all<{ sequence: number; phase: string; record_hex: string; record_sha256: string;
          previous_record_sha256: string; disk_recorded_sha256: string }>(keyOf(key));
      if (volumeRows.length > 6) throw conflict("Cell volume checkpoint inventory is invalid.");
      const volumeCheckpoints: RemoteWorkerCellVolumeCheckpoint[] = [];
      if (volumeRows.length) {
        const anchor = volumeAnchor(plan, checkpoints);
        for (const row of volumeRows) {
          const checkpoint = readRemoteWorkerCellVolumeCheckpoint(anchor, row.record_hex);
          if (checkpoint.sequence !== row.sequence || checkpoint.phase !== row.phase ||
              checkpoint.recordSha256 !== row.record_sha256 || checkpoint.previousRecordSha256 !== row.previous_record_sha256 ||
              row.disk_recorded_sha256 !== anchor.diskRecordedSha256) {
            throw conflict("Cell volume checkpoint metadata differs from its retained record.");
          }
          assertRemoteWorkerCellVolumeSuccessor(anchor, volumeCheckpoints.at(-1), checkpoint);
          volumeCheckpoints.push(checkpoint);
        }
      }
      const formatRows = this.db.prepare(`SELECT sequence, phase, record_hex, record_sha256, previous_record_sha256, volume_recorded_sha256
        FROM remote_worker_cell_format_checkpoints WHERE ${WHERE} ORDER BY sequence LIMIT 3`)
        .all<{ sequence: number; phase: string; record_hex: string; record_sha256: string;
          previous_record_sha256: string; volume_recorded_sha256: string }>(keyOf(key));
      if (formatRows.length > 2) throw conflict("Cell format checkpoint inventory is invalid.");
      const formatCheckpoints: RemoteWorkerCellFormatCheckpoint[] = [];
      if (formatRows.length) {
        const anchor = formatAnchor(plan, checkpoints, volumeCheckpoints);
        for (const row of formatRows) {
          const checkpoint = readRemoteWorkerCellFormatCheckpoint(anchor, row.record_hex);
          if (checkpoint.sequence !== row.sequence || checkpoint.phase !== row.phase ||
              checkpoint.recordSha256 !== row.record_sha256 || checkpoint.previousRecordSha256 !== row.previous_record_sha256 ||
              checkpoint.volumeRecordedSha256 !== row.volume_recorded_sha256) {
            throw conflict("Cell format checkpoint metadata differs from its retained record.");
          }
          assertRemoteWorkerCellFormatSuccessor(anchor, formatCheckpoints.at(-1), checkpoint);
          formatCheckpoints.push(checkpoint);
        }
      }
      const protectionRows = this.db.prepare(`SELECT sequence, phase, record_hex, record_sha256, previous_record_sha256, format_recorded_sha256
        FROM remote_worker_cell_protection_checkpoints WHERE ${WHERE} ORDER BY sequence LIMIT 3`)
        .all<{ sequence: number; phase: string; record_hex: string; record_sha256: string;
          previous_record_sha256: string; format_recorded_sha256: string }>(keyOf(key));
      if (protectionRows.length > 2) throw conflict("Cell protection checkpoint inventory is invalid.");
      const protectionCheckpoints: RemoteWorkerCellProtectionCheckpoint[] = [];
      if (protectionRows.length) {
        const anchor = protectionAnchor(plan, checkpoints, volumeCheckpoints, formatCheckpoints);
        for (const row of protectionRows) {
          const checkpoint = readRemoteWorkerCellProtectionCheckpoint(anchor, row.record_hex);
          if (checkpoint.sequence !== row.sequence || checkpoint.phase !== row.phase ||
              checkpoint.recordSha256 !== row.record_sha256 || checkpoint.previousRecordSha256 !== row.previous_record_sha256 ||
              checkpoint.formatRecordedSha256 !== row.format_recorded_sha256) {
            throw conflict("Cell protection checkpoint metadata differs from its retained record.");
          }
          assertRemoteWorkerCellProtectionSuccessor(anchor, protectionCheckpoints.at(-1), checkpoint);
          protectionCheckpoints.push(checkpoint);
        }
      }
      const mountRows = this.db.prepare(`SELECT sequence, phase, record_hex, record_sha256, previous_record_sha256, protection_recorded_sha256
        FROM remote_worker_cell_mount_checkpoints WHERE ${WHERE} ORDER BY sequence LIMIT 5`)
        .all<{ sequence: number; phase: string; record_hex: string; record_sha256: string;
          previous_record_sha256: string; protection_recorded_sha256: string }>(keyOf(key));
      if (mountRows.length > 4) throw conflict("Cell mount checkpoint inventory is invalid.");
      const mountCheckpoints: RemoteWorkerCellMountCheckpoint[] = [];
      if (mountRows.length) {
        const anchor = mountAnchor(plan, checkpoints, volumeCheckpoints, formatCheckpoints, protectionCheckpoints);
        for (const row of mountRows) {
          const checkpoint = readRemoteWorkerCellMountCheckpoint(anchor, row.record_hex);
          if (checkpoint.sequence !== row.sequence || checkpoint.phase !== row.phase ||
              checkpoint.recordSha256 !== row.record_sha256 || checkpoint.previousRecordSha256 !== row.previous_record_sha256 ||
              checkpoint.protectionRecordedSha256 !== row.protection_recorded_sha256) {
            throw conflict("Cell mount checkpoint metadata differs from its retained record.");
          }
          assertRemoteWorkerCellMountSuccessor(anchor, mountCheckpoints.at(-1), checkpoint);
          mountCheckpoints.push(checkpoint);
        }
      }
      const mountedWorkspaceRows = this.db.prepare(`SELECT sequence, phase, record_hex, record_sha256, previous_record_sha256, mount_recorded_sha256
        FROM remote_worker_cell_mounted_workspace_checkpoints WHERE ${WHERE} ORDER BY sequence LIMIT 3`)
        .all<{ sequence: number; phase: string; record_hex: string; record_sha256: string;
          previous_record_sha256: string; mount_recorded_sha256: string }>(keyOf(key));
      if (mountedWorkspaceRows.length > 2) throw conflict("Cell mounted workspace checkpoint inventory is invalid.");
      const mountedWorkspaceCheckpoints: RemoteWorkerCellMountedWorkspaceCheckpoint[] = [];
      if (mountedWorkspaceRows.length) {
        const anchor = mountedWorkspaceAnchor(plan, checkpoints, volumeCheckpoints, formatCheckpoints, protectionCheckpoints, mountCheckpoints);
        for (const row of mountedWorkspaceRows) {
          const checkpoint = readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, row.record_hex);
          if (checkpoint.sequence !== row.sequence || checkpoint.phase !== row.phase ||
              checkpoint.recordSha256 !== row.record_sha256 || checkpoint.previousRecordSha256 !== row.previous_record_sha256 ||
              checkpoint.mountRecordedSha256 !== row.mount_recorded_sha256) {
            throw conflict("Cell mounted workspace checkpoint metadata differs from its retained record.");
          }
          assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, mountedWorkspaceCheckpoints.at(-1), checkpoint);
          mountedWorkspaceCheckpoints.push(checkpoint);
        }
      }
      return Object.freeze({ plan, checkpoints: Object.freeze(checkpoints), volumeCheckpoints: Object.freeze(volumeCheckpoints),
        formatCheckpoints: Object.freeze(formatCheckpoints), protectionCheckpoints: Object.freeze(protectionCheckpoints),
        mountCheckpoints: Object.freeze(mountCheckpoints), mountedWorkspaceCheckpoints: Object.freeze(mountedWorkspaceCheckpoints) });
    });
  }

  private assertAuthority(input: RemoteWorkerCellProvisioningAuthority) {
    // Lock the canonical cell first on PostgreSQL, as for other cell transitions.
    this.db.prepare(`SELECT assignment_id FROM remote_worker_cells WHERE ${WHERE}${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`).get(keyOf(input));
    const cell = this.cells.getCell(input);
    const now = this.clock.readDatabaseNow();
    if (!cell || cell.backend !== "windows_native" || cell.executionState !== "provisioning" ||
        cell.cleanupState !== "not_started" || cell.provisioningOwner !== input.provisioningOwner ||
        cell.provisioningLeaseExpiresAt !== input.provisioningLeaseExpiresAt || input.provisioningLeaseExpiresAt <= now) {
      throw conflict("Cell provisioning requires its current native cell and unexpired claim.");
    }
    return cell;
  }

  private getPlan(key: RemoteWorkerCellKey): RemoteWorkerCellProvisioningPlanRecord | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM remote_worker_cell_provisioning WHERE ${WHERE}`).get<PlanRow>(keyOf(key));
    if (!row) return undefined;
    const plan = normalizeRemoteWorkerCellProvisioningPlan(JSON.parse(row.plan_json) as unknown);
    if (remoteWorkerCellProvisioningPlanSha256(plan) !== row.plan_sha256 || plan.profileSha256 !== row.profile_sha256) {
      throw conflict("Cell provisioning plan differs from its retained identity.");
    }
    return Object.freeze({ ...keyOf(key), plan, planSha256: row.plan_sha256, provisioningOwner: row.provisioning_owner,
      provisioningLeaseExpiresAt: row.provisioning_lease_expires_at, capacityRevision: row.capacity_revision, createdAt: row.created_at });
  }
}

const columns = `registry_workspace_id, assignment_id, assignment_generation, profile_sha256, plan_sha256, plan_json,
  provisioning_owner, provisioning_lease_expires_at, capacity_revision, created_at`;

function volumeAnchor(record: RemoteWorkerCellProvisioningPlanRecord, checkpoints: readonly RemoteWorkerCellProvisioningCheckpoint[]) {
  const disk = checkpoints.at(-1), plan = record.plan;
  if (checkpoints.length !== 5 || disk?.phase !== "disk_recorded") throw conflict("Cell volume requires all five canonical creation checkpoints.");
  return normalizeRemoteWorkerCellVolumeAnchor({ schemaVersion: REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
    diskRecordedSha256: disk.recordSha256, journalIdentityHex: disk.journalIdentityHex,
    layoutPlan: createRemoteWorkerCellDiskLayoutPlan({ provisioningPlanSha256: record.planSha256,
      assignmentBindingSha256: plan.assignmentBindingSha256, profileSha256: plan.profileSha256,
      diskIdentifierHex: plan.diskIdentifierHex, virtualDiskBytes: plan.virtualDiskBytes, reservedDiskBytes: plan.reservedDiskBytes,
      controlIdentityHex: disk.workspaceIdentityHex[1], backingIdentityHex: disk.backingIdentityHex }) });
}
function formatAnchor(record: RemoteWorkerCellProvisioningPlanRecord, checkpoints: readonly RemoteWorkerCellProvisioningCheckpoint[],
  volume: readonly RemoteWorkerCellVolumeCheckpoint[]) {
  if (volume.length !== 6) throw conflict("Cell formatting requires all six canonical volume checkpoints.");
  return normalizeRemoteWorkerCellFormatAnchor({ schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
    volumeAnchor: volumeAnchor(record, checkpoints), volumeRecords: volume.map((checkpoint) => checkpoint.recordHex) });
}
function protectionAnchor(record: RemoteWorkerCellProvisioningPlanRecord, checkpoints: readonly RemoteWorkerCellProvisioningCheckpoint[],
  volume: readonly RemoteWorkerCellVolumeCheckpoint[], format: readonly RemoteWorkerCellFormatCheckpoint[]) {
  if (format.length !== 2) throw conflict("Cell protection requires both canonical format checkpoints.");
  return normalizeRemoteWorkerCellProtectionAnchor({ schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
    formatAnchor: formatAnchor(record, checkpoints, volume), formatRecords: format.map((checkpoint) => checkpoint.recordHex),
    ownerSid: record.plan.ownerSid, controllerSid: record.plan.controllerSid });
}

function mountAnchor(record: RemoteWorkerCellProvisioningPlanRecord, checkpoints: readonly RemoteWorkerCellProvisioningCheckpoint[],
  volume: readonly RemoteWorkerCellVolumeCheckpoint[], format: readonly RemoteWorkerCellFormatCheckpoint[],
  protection: readonly RemoteWorkerCellProtectionCheckpoint[]) {
  if (protection.length !== 2) throw conflict("Cell mounting requires both canonical protection checkpoints.");
  return normalizeRemoteWorkerCellMountAnchor({ schemaVersion: REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION,
    protectionAnchor: protectionAnchor(record, checkpoints, volume, format),
    protectionRecords: protection.map((checkpoint) => checkpoint.recordHex),
    parentIdentityHex: record.plan.parentIdentityHex, workspaceIdentityHex: checkpoints[4]?.workspaceIdentityHex });
}

function mountedWorkspaceAnchor(record: RemoteWorkerCellProvisioningPlanRecord, checkpoints: readonly RemoteWorkerCellProvisioningCheckpoint[],
  volume: readonly RemoteWorkerCellVolumeCheckpoint[], format: readonly RemoteWorkerCellFormatCheckpoint[],
  protection: readonly RemoteWorkerCellProtectionCheckpoint[], mount: readonly RemoteWorkerCellMountCheckpoint[]) {
  if (mount.length !== 4) throw conflict("Cell mounted workspace requires all four canonical mount checkpoints.");
  return normalizeRemoteWorkerCellMountedWorkspaceAnchor({ schemaVersion: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION,
    mountAnchor: mountAnchor(record, checkpoints, volume, format, protection),
    mountRecords: mount.map((checkpoint) => checkpoint.recordHex), cellName: record.plan.cellName });
}
