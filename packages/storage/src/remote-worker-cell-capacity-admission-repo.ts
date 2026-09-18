import {
  evaluateRemoteWorkerCellCapacityAdmission,
  normalizeRemoteWorkerCellCapacityAdmissionObservation,
  normalizeRemoteWorkerCellCapacityInventory,
  accountRemoteWorkerCellCapacityInventory,
  canonicalJsonString,
  type RemoteWorkerCellCapacityInventory,
  type RemoteWorkerCellCapacityInventoryBinding,
  type RemoteWorkerCellCapacityAccounting,
  type RemoteWorkerCellCapacityAdmissionObservation,
  type RemoteWorkerCellCapacityPressureDecision,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { RemoteWorkerAssignmentRepository, type RemoteWorkerAssignmentProtectedCommitFence } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellConflictError, RemoteWorkerCellRepository, type RemoteWorkerCellKey, type RemoteWorkerCellRecord } from "./remote-worker-cell-repo.js";

export interface RemoteWorkerCellCapacityAuthority extends RemoteWorkerCellKey {
  readonly leaseRevision: number;
  readonly leaseTokenSha256: string;
  readonly protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence;
}

export interface RemoteWorkerCellCapacityAdmissionInput extends RemoteWorkerCellCapacityAuthority {
  readonly expectedCapacityRevision: number;
  readonly expectedCleanupRevision: number;
  /** Diagnostics can increase raw output while advancing only execution state. */
  readonly expectedExecutionRevision: number;
  readonly observation: RemoteWorkerCellCapacityAdmissionObservation;
}

export interface RemoteWorkerCellCapacityAdmissionResult {
  readonly decision: RemoteWorkerCellCapacityPressureDecision;
  readonly reason: string;
  readonly cell: RemoteWorkerCellRecord;
}

export interface RemoteWorkerCellCapacityInventoryAdmissionInput extends Omit<RemoteWorkerCellCapacityAdmissionInput, "observation"> {
  readonly expectedBackupRevision: number;
  readonly observation: Omit<RemoteWorkerCellCapacityAdmissionObservation, "footprint">;
  readonly inventory: RemoteWorkerCellCapacityInventory;
  readonly inventoryBinding: RemoteWorkerCellCapacityInventoryBinding;
}
export interface RemoteWorkerCellCapacityInventoryRecord {
  readonly capacityRevision: number;
  readonly leaseRevision: number;
  readonly executionRevision: number;
  readonly cleanupRevision: number;
  readonly backupRevision: number;
  readonly peakLogicalBytes: number;
  readonly peakInodeCount: number;
  readonly recordedAt: string;
  readonly inventory: RemoteWorkerCellCapacityInventory;
  readonly accounting: RemoteWorkerCellCapacityAccounting;
}

export function snapshotRemoteWorkerCellCapacityInventoryAdmission(input: RemoteWorkerCellCapacityInventoryAdmissionInput) {
  const inventory = normalizeRemoteWorkerCellCapacityInventory(input.inventory);
  const accounting = accountRemoteWorkerCellCapacityInventory(inventory, input.inventoryBinding);
  if (!Number.isSafeInteger(input.expectedBackupRevision) || input.expectedBackupRevision < 0) throw conflict("Cell capacity inventory requires a non-negative backup revision.");
  const command = snapshotRemoteWorkerCellCapacityAdmission({ ...input,
    observation: { ...input.observation, footprint: accounting.footprint } });
  const observation = Object.freeze({ ...command.observation,
    peakFileCount: Math.max(command.observation.peakFileCount, accounting.hostFileCount + accounting.guestFileCount) });
  const inventoryBinding = Object.freeze({ profileSha256: accounting.profileSha256,
    captureSha256: accounting.captureSha256, inventorySha256: accounting.inventorySha256 });
  return Object.freeze({ ...command, observation, expectedBackupRevision: input.expectedBackupRevision, inventory, inventoryBinding });
}

const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const conflict = (message: string) => new RemoteWorkerCellConflictError(message);
const keyOf = (input: RemoteWorkerCellKey): RemoteWorkerCellKey => ({
  registryWorkspaceId: input.registryWorkspaceId,
  assignmentId: input.assignmentId,
  assignmentGeneration: input.assignmentGeneration,
});

export function snapshotRemoteWorkerCellCapacityAuthority(input: RemoteWorkerCellCapacityAuthority): RemoteWorkerCellCapacityAuthority {
  if (!input.protectedAuthority?.credentialAuthority || !input.protectedAuthority.meshAdmission) {
    throw conflict("Cell capacity admission requires protected assignment authority.");
  }
  if (!Number.isSafeInteger(input.leaseRevision) || input.leaseRevision < 1) {
    throw conflict("Cell capacity admission requires a positive lease revision.");
  }
  return Object.freeze({ ...keyOf(input), leaseRevision: input.leaseRevision, leaseTokenSha256: input.leaseTokenSha256,
    protectedAuthority: Object.freeze({
      credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
      meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }),
    }),
  });
}

/** Freeze before an async storage boundary, without exporting secret authority
 * in the result or accepting a caller-selected commit timestamp. */
export function snapshotRemoteWorkerCellCapacityAdmission(input: RemoteWorkerCellCapacityAdmissionInput): RemoteWorkerCellCapacityAdmissionInput {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input);
  const revisions = { expectedCapacityRevision: input.expectedCapacityRevision,
    expectedCleanupRevision: input.expectedCleanupRevision, expectedExecutionRevision: input.expectedExecutionRevision };
  for (const [name, value] of Object.entries(revisions)) {
    if (!Number.isSafeInteger(value) || value < 0) throw conflict(`Cell capacity admission requires a non-negative ${name}.`);
  }
  return Object.freeze({ ...authority, ...revisions, observation: normalizeRemoteWorkerCellCapacityAdmissionObservation(input.observation) });
}

/** The complete decision and high-water evidence commit under the canonical
 * credential -> mesh -> assignment -> cell locks. Partial native observations
 * must first be joined by a separate complete accounting owner. */
export class RemoteWorkerCellCapacityAdmissionRepository {
  private readonly assignments: RemoteWorkerAssignmentRepository;
  private readonly cells: RemoteWorkerCellRepository;
  private readonly clock: DurableRunRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.assignments = new RemoteWorkerAssignmentRepository(db);
    this.cells = new RemoteWorkerCellRepository(db);
    this.clock = new DurableRunRepository(db);
  }

  public readForAssignment(input: RemoteWorkerCellCapacityAuthority): RemoteWorkerCellRecord {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input);
    return this.db.transaction("immediate", () => {
      const cell = this.lockActiveCell(command);
      this.assertAssignment(command);
      return cell;
    });
  }

  public admit(input: RemoteWorkerCellCapacityAdmissionInput): RemoteWorkerCellCapacityAdmissionResult {
    const command = snapshotRemoteWorkerCellCapacityAdmission(input);
    return this.db.transaction("immediate", () => {
      const cell = this.lockActiveCell(command);
      return this.commitAdmission(command, cell, this.inventoryPressureReason(cell, this.readInventoryPeaks(command)));
    });
  }

  private readInventoryPeaks(key: RemoteWorkerCellKey, accounting?: RemoteWorkerCellCapacityAccounting) {
    const previous = this.db.prepare(`SELECT peak_logical_bytes, peak_inode_count FROM remote_worker_cell_capacity_inventories
      WHERE ${WHERE} ORDER BY capacity_revision DESC LIMIT 1`).get<{ peak_logical_bytes: number | string | bigint; peak_inode_count: number }>(keyOf(key));
    const priorLogical = previous ? Number(previous.peak_logical_bytes) : 0, priorInodes = previous?.peak_inode_count ?? 0;
    if (!Number.isSafeInteger(priorLogical) || priorLogical < 0 || !Number.isSafeInteger(priorInodes) || priorInodes < 0) throw conflict("Cell inventory retained peaks are invalid.");
    return {
      peakLogicalBytes: Math.max(priorLogical, accounting?.logicalReferenceBytes ?? 0),
      peakInodeCount: Math.max(priorInodes, accounting ? accounting.hostFileCount + accounting.hostDirectoryCount + accounting.guestFileCount + accounting.guestDirectoryCount : 0),
    };
  }

  private inventoryPressureReason(cell: RemoteWorkerCellRecord, peaks: { peakLogicalBytes: number; peakInodeCount: number }): string | undefined {
    const exceeded = [peaks.peakLogicalBytes > cell.capacity.logicalDiskBytes ? "logical bytes" : null,
      peaks.peakInodeCount > cell.capacity.inodeLimit ? "inode count" : null].filter((value): value is string => value !== null);
    return exceeded.length ? `Observed or retained ${exceeded.join(" and ")} exceeds the immutable reservation; quarantine new work.` : undefined;
  }

  private commitAdmission(command: RemoteWorkerCellCapacityAdmissionInput, cell: RemoteWorkerCellRecord,
    quarantineReason?: string, detailSha256?: string): RemoteWorkerCellCapacityAdmissionResult {
    if (cell.capacityRevision !== command.expectedCapacityRevision) throw conflict("Cell capacity revision changed before admission.");
    if (cell.cleanupRevision !== command.expectedCleanupRevision) throw conflict("Cell cleanup revision changed before admission.");
    if (cell.executionRevision !== command.expectedExecutionRevision) throw conflict("Cell execution revision changed before admission.");
    const measured = evaluateRemoteWorkerCellCapacityAdmission(command.observation, cell);
    const evaluation = quarantineReason ? { ...measured, decision: "quarantine" as const, reason: quarantineReason } : measured;
    if (evaluation.decision !== "reject") {
      this.cells.recordCapacityHighWater({
        ...keyOf(command), expectedCapacityRevision: cell.capacityRevision, expectedCleanupRevision: cell.cleanupRevision,
        footprint: evaluation.footprint, ...evaluation.highWater,
        failedCleanupRetainedBytes: evaluation.footprint.failedCleanupBytes,
        quarantineRetainedBytes: evaluation.footprint.quarantineEvidenceBytes,
        detailSha256: detailSha256 ?? evaluation.footprintSha256, now: this.clock.readDatabaseNow(),
      });
    }
    this.assertAssignment(command);
    const current = this.cells.getCell(command);
    const expectedRevision = cell.capacityRevision + (evaluation.decision === "reject" ? 0 : 1);
    if (!current || current.capacityRevision !== expectedRevision || current.cleanupRevision !== cell.cleanupRevision ||
        current.executionRevision !== cell.executionRevision || current.profileSha256 !== cell.profileSha256) {
      throw conflict("Cell authority changed during capacity admission.");
    }
    return { decision: evaluation.decision, reason: evaluation.reason, cell: current };
  }

  /** Exact complete declared inventory is retained only with a committed capacity
   * decision. The collector's independent binding is still required; this does
   * not manufacture native collection, quiescence or whole-pool coverage. */
  public admitInventory(input: RemoteWorkerCellCapacityInventoryAdmissionInput): RemoteWorkerCellCapacityAdmissionResult {
    const command = snapshotRemoteWorkerCellCapacityInventoryAdmission(input);
    const accounting = accountRemoteWorkerCellCapacityInventory(command.inventory, command.inventoryBinding);
    const inventoryJson = canonicalJsonString(command.inventory);
    if (Buffer.byteLength(inventoryJson, "utf8") > 12 * 1024 * 1024) throw conflict("Cell capacity inventory exceeds its retained bound.");
    return this.db.transaction("immediate", () => {
      const before = this.lockActiveCell(command);
      if (before.profileSha256 !== command.inventoryBinding.profileSha256 || before.backupRevision !== command.expectedBackupRevision) throw conflict("Cell capacity inventory profile or backup revision changed.");
      this.assertNativeLayout(command, command.inventory);
      const previous = this.db.prepare(`SELECT inventory_json, inventory_sha256, profile_sha256, capture_sha256
        FROM remote_worker_cell_capacity_inventories WHERE ${WHERE} ORDER BY capacity_revision DESC LIMIT 1`)
        .get<{ inventory_json: string; inventory_sha256: string; profile_sha256: string; capture_sha256: string }>(keyOf(command));
      if (previous) {
        const retained = normalizeRemoteWorkerCellCapacityInventory(JSON.parse(previous.inventory_json));
        accountRemoteWorkerCellCapacityInventory(retained, { profileSha256: previous.profile_sha256,
          captureSha256: previous.capture_sha256, inventorySha256: previous.inventory_sha256 });
        if (retained.nativeLayout && canonicalJsonString(retained.nativeLayout) !== canonicalJsonString(command.inventory.nativeLayout ?? null))
          throw conflict("Cell native capacity layout cannot change or be omitted after retention.");
      }
      const peaks = this.readInventoryPeaks(command, accounting);
      const { peakLogicalBytes, peakInodeCount } = peaks;
      const result = this.commitAdmission(command, before, this.inventoryPressureReason(before, peaks), command.inventoryBinding.inventorySha256);
      if (result.decision !== "reject") {
        this.db.prepare(`INSERT INTO remote_worker_cell_capacity_inventories (
          registry_workspace_id, assignment_id, assignment_generation, capacity_revision, lease_revision,
          execution_revision, cleanup_revision, backup_revision, peak_logical_bytes, peak_inode_count, inventory_sha256, profile_sha256, capture_sha256,
          inventory_json, recorded_at) VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration,
          @capacityRevision, @leaseRevision, @executionRevision, @cleanupRevision, @backupRevision, @peakLogicalBytes, @peakInodeCount,
          @inventorySha256, @profileSha256, @captureSha256, @inventoryJson, @recordedAt)`).run({
          ...keyOf(command), capacityRevision: result.cell.capacityRevision, leaseRevision: command.leaseRevision,
          executionRevision: before.executionRevision, cleanupRevision: before.cleanupRevision, backupRevision: before.backupRevision,
          peakLogicalBytes, peakInodeCount,
          ...command.inventoryBinding, inventoryJson, recordedAt: result.cell.updatedAt,
        });
      }
      this.assertAssignment(command);
      const current = this.cells.getCell(command);
      if (!current || current.capacityRevision !== result.cell.capacityRevision || current.cleanupRevision !== before.cleanupRevision ||
          current.executionRevision !== before.executionRevision || current.backupRevision !== before.backupRevision || current.profileSha256 !== before.profileSha256) {
        throw conflict("Cell authority changed during inventory admission.");
      }
      return { ...result, cell: current };
    });
  }

  public readInventory(input: RemoteWorkerCellCapacityAuthority & { readonly capacityRevision: number }): RemoteWorkerCellCapacityInventoryRecord | null {
    const command = snapshotRemoteWorkerCellCapacityAuthority(input), revision = input.capacityRevision;
    if (!Number.isSafeInteger(revision) || revision < 1) throw conflict("Cell capacity inventory requires a positive capacity revision.");
    return this.db.transaction("immediate", () => {
      const cell = this.lockActiveCell(command);
      const row = this.db.prepare(`SELECT capacity_revision, lease_revision, execution_revision, cleanup_revision, backup_revision, peak_logical_bytes, peak_inode_count,
        inventory_json, inventory_sha256, profile_sha256, capture_sha256, recorded_at FROM remote_worker_cell_capacity_inventories
        WHERE ${WHERE} AND capacity_revision = @revision`).get<{
          capacity_revision: number; lease_revision: number; execution_revision: number; cleanup_revision: number; backup_revision: number;
          peak_logical_bytes: number | string | bigint; peak_inode_count: number;
          inventory_json: string; inventory_sha256: string; profile_sha256: string; capture_sha256: string; recorded_at: string;
        }>({ ...keyOf(command), revision });
      if (!row) { this.assertAssignment(command); return null; }
      if (row.profile_sha256 !== cell.profileSha256 || Buffer.byteLength(row.inventory_json, "utf8") > 12 * 1024 * 1024) throw conflict("Cell capacity inventory does not match its canonical profile.");
      const inventory = normalizeRemoteWorkerCellCapacityInventory(JSON.parse(row.inventory_json) as unknown);
      this.assertNativeLayout(command, inventory);
      const accounting = accountRemoteWorkerCellCapacityInventory(inventory, { profileSha256: row.profile_sha256,
        captureSha256: row.capture_sha256, inventorySha256: row.inventory_sha256 });
      const peakLogicalBytes = Number(row.peak_logical_bytes), peakInodeCount = row.peak_inode_count;
      if (!Number.isSafeInteger(peakLogicalBytes) || peakLogicalBytes < accounting.logicalReferenceBytes || !Number.isSafeInteger(peakInodeCount) ||
          peakInodeCount < accounting.hostFileCount + accounting.hostDirectoryCount + accounting.guestFileCount + accounting.guestDirectoryCount) throw conflict("Cell inventory retained peaks are invalid.");
      this.assertAssignment(command);
      return Object.freeze({ capacityRevision: row.capacity_revision, leaseRevision: row.lease_revision,
        executionRevision: row.execution_revision, cleanupRevision: row.cleanup_revision, backupRevision: row.backup_revision,
        peakLogicalBytes, peakInodeCount,
        recordedAt: row.recorded_at, inventory, accounting });
    });
  }

  private assertNativeLayout(key: RemoteWorkerCellKey, inventory: RemoteWorkerCellCapacityInventory): void {
    if (!inventory.nativeLayout) return;
    const plan = new RemoteWorkerCellProvisioningRepository(this.db).getSnapshot(key)?.plan.plan;
    if (!plan || plan.assignmentBindingSha256 !== inventory.nativeLayout.assignmentBindingSha256 ||
        plan.profileSha256 !== inventory.nativeLayout.profileSha256)
      throw conflict("Cell native capacity layout does not match its retained provisioning assignment.");
  }

  private assertAssignment(input: RemoteWorkerCellCapacityAuthority) {
    const active = this.assignments.resolveActiveAuthorityByLeaseTokenHash(input.leaseTokenSha256, input.protectedAuthority);
    if (!active || active.assignment.registryWorkspaceId !== input.registryWorkspaceId || active.assignment.assignmentId !== input.assignmentId ||
        active.generation.assignmentGeneration !== input.assignmentGeneration || active.lease.leaseRevision !== input.leaseRevision) {
      throw conflict("Cell capacity admission requires the exact active assignment lease.");
    }
    return active;
  }

  private lockActiveCell(input: RemoteWorkerCellCapacityAuthority): RemoteWorkerCellRecord {
    const active = this.assertAssignment(input);
    const bindings = this.db.prepare(`SELECT assignment_manifest_sha256, path_jail_sha256,
      capability_profile_sha256, context_snapshot_sha256, tool_effect_posture_sha256
      FROM remote_worker_cells WHERE ${WHERE}${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`)
      .get<{ assignment_manifest_sha256: string; path_jail_sha256: string; capability_profile_sha256: string;
        context_snapshot_sha256: string; tool_effect_posture_sha256: string }>(keyOf(input));
    const cell = this.cells.getCell(input);
    if (!cell || !bindings || cell.workerId !== active.generation.workerId || cell.workerGeneration !== active.generation.workerGeneration ||
        bindings.assignment_manifest_sha256 !== active.assignment.manifestSha256 || bindings.path_jail_sha256 !== active.assignment.manifest.pathJailSha256 ||
        bindings.capability_profile_sha256 !== active.assignment.manifest.capabilityProfileSha256 ||
        bindings.context_snapshot_sha256 !== active.assignment.manifest.contextSnapshotSha256 ||
        bindings.tool_effect_posture_sha256 !== active.assignment.manifest.toolEffectPostureSha256) {
      throw conflict("Cell capacity admission requires its canonical assignment profile.");
    }
    return cell;
  }
}
