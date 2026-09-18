import {
  normalizeRemoteWorkerCellCapacityExchange, normalizeRemoteWorkerCellCapacitySubmission,
  normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerCellCapacityObservation,
  remoteWorkerCellProvisioningBindingSha256,
  REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  type RemoteWorkerCellCapacityExchange, type RemoteWorkerCellCapacityRecord, type RemoteWorkerCellCapacitySubmission,
  normalizeRemoteWorkerCellBackingCapacitySubmission, normalizeRemoteWorkerCellBackingCapacityExchange, readRemoteWorkerCellBackingCapacityObservation,
  REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerCellBackingCapacitySubmission, type RemoteWorkerCellBackingCapacityExchange,
  normalizeRemoteWorkerCellObjectInventorySubmission, normalizeRemoteWorkerCellObjectInventoryExchange, readRemoteWorkerCellObjectInventory,
  REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerCellObjectInventorySubmission,
  type RemoteWorkerCellObjectInventoryExchange, type RemoteWorkerCellObjectInventoryRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellConflictError, RemoteWorkerCellRepository, type RemoteWorkerCellKey } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellProvisioningRepository, type RemoteWorkerCellProvisioningAssignmentInput } from "./remote-worker-cell-provisioning-repo.js";
import { REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK, REMOTE_WORKER_CAPACITY_SQLITE_CLOCK } from "./remote-worker-cell-capacity-observation-schema.js";

export interface RemoteWorkerCellCapacityAssignmentInput extends Omit<RemoteWorkerCellProvisioningAssignmentInput, "submission"> {
  readonly submission: RemoteWorkerCellCapacitySubmission;
}
export interface RemoteWorkerCellBackingCapacityAssignmentInput extends Omit<RemoteWorkerCellProvisioningAssignmentInput, "submission"> {
  readonly submission: RemoteWorkerCellBackingCapacitySubmission;
}
export interface RemoteWorkerCellObjectInventoryAssignmentInput extends Omit<RemoteWorkerCellProvisioningAssignmentInput, "submission"> {
  readonly submission: RemoteWorkerCellObjectInventorySubmission;
}
const CODECS = {
  mounted: { table: "remote_worker_cell_capacity_observations", schema: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION,
    submission: normalizeRemoteWorkerCellCapacitySubmission, decode: readRemoteWorkerCellCapacityObservation, exchange: normalizeRemoteWorkerCellCapacityExchange },
  backing: { table: "remote_worker_cell_backing_capacity_observations", schema: REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION,
    submission: normalizeRemoteWorkerCellBackingCapacitySubmission, decode: readRemoteWorkerCellBackingCapacityObservation, exchange: normalizeRemoteWorkerCellBackingCapacityExchange },
  inventory: { table: "remote_worker_cell_object_inventory_observations", schema: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION,
    submission: normalizeRemoteWorkerCellObjectInventorySubmission,
    decode: (hex: unknown, history: Parameters<typeof readRemoteWorkerCellObjectInventory>[2], chunks?: unknown) => readRemoteWorkerCellObjectInventory(hex, chunks, history),
    exchange: normalizeRemoteWorkerCellObjectInventoryExchange },
} as const;
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const keyOf = (input: RemoteWorkerCellKey) => ({ registryWorkspaceId: input.registryWorkspaceId,
  assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration });
const conflict = (message: string) => new RemoteWorkerCellConflictError(message);
type Row = { revision: number; lease_revision: number; recorded_at: string; observation_hex: string; native_receipt_hex: string;
  connection_nonce_hex: string; plan_sha256: string; profile_sha256: string; checkpoint_sha256: string; chunk_hex_json?: string };

/** Assignment-fenced, append-only partial observations. It neither modifies
 * complete capacity high-water accounting nor advances cell readiness. */
export class RemoteWorkerCellCapacityStore {
  private readonly assignments: RemoteWorkerAssignmentRepository;
  private readonly cells: RemoteWorkerCellRepository;
  private readonly provisioning: RemoteWorkerCellProvisioningRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.assignments = new RemoteWorkerAssignmentRepository(db);
    this.cells = new RemoteWorkerCellRepository(db);
    this.provisioning = new RemoteWorkerCellProvisioningRepository(db);
  }

  public exchange(input: RemoteWorkerCellCapacityAssignmentInput, kind: "mounted"): RemoteWorkerCellCapacityExchange;
  public exchange(input: RemoteWorkerCellBackingCapacityAssignmentInput, kind: "backing"): RemoteWorkerCellBackingCapacityExchange;
  public exchange(input: RemoteWorkerCellObjectInventoryAssignmentInput, kind: "inventory"): RemoteWorkerCellObjectInventoryExchange;
  public exchange(input: RemoteWorkerCellCapacityAssignmentInput | RemoteWorkerCellBackingCapacityAssignmentInput | RemoteWorkerCellObjectInventoryAssignmentInput,
    kind: "mounted" | "backing" | "inventory"): RemoteWorkerCellCapacityExchange | RemoteWorkerCellBackingCapacityExchange | RemoteWorkerCellObjectInventoryExchange {
    const codec = CODECS[kind], TABLE = codec.table;
    if (!input.protectedAuthority) throw conflict("Cell capacity requires protected assignment authority.");
    const frozen = Object.freeze({ ...keyOf(input), leaseRevision: input.leaseRevision, leaseTokenSha256: input.leaseTokenSha256,
      protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
        meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }),
      submission: codec.submission(input.submission) });
    return this.db.transaction("immediate", () => {
      const active = this.assertAssignment(frozen);
      // Match the canonical assignment -> cell lock order, and hold both through
      // final authority validation. The original provisioning lease is history;
      // it need not remain live after setup to record a later observation.
      this.db.prepare(`SELECT assignment_id FROM remote_worker_cells WHERE ${WHERE}${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`).get(keyOf(frozen));
      const cell = this.cells.getCell(frozen), snapshot = this.provisioning.getSnapshot(frozen);
      if (!cell || !snapshot || cell.backend !== "windows_native" || cell.executionState === "profiled" || cell.cleanupState !== "not_started" ||
          cell.workerId !== active.generation.workerId || cell.workerGeneration !== active.generation.workerGeneration ||
          cell.profileSha256 !== snapshot.plan.plan.profileSha256 || cell.provisioningOwner !== snapshot.plan.provisioningOwner ||
          cell.provisioningLeaseExpiresAt !== snapshot.plan.provisioningLeaseExpiresAt ||
          snapshot.plan.plan.assignmentBindingSha256 !== remoteWorkerCellProvisioningBindingSha256({ ...keyOf(frozen),
            provisioningOwner: snapshot.plan.provisioningOwner, provisioningLeaseExpiresAt: snapshot.plan.provisioningLeaseExpiresAt,
            cellId: cell.cellId, workerId: cell.workerId, workerGeneration: cell.workerGeneration, profileSha256: cell.profileSha256 })) {
        throw conflict("Cell capacity requires its current native cell and complete canonical history.");
      }
      const history = normalizeRemoteWorkerCellProvisioningExchange({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
        ...keyOf(frozen), leaseRevision: frozen.leaseRevision, plan: snapshot.plan.plan, planSha256: snapshot.plan.planSha256,
        records: snapshot.checkpoints.map((record) => record.recordHex), volumeRecords: snapshot.volumeCheckpoints.map((record) => record.recordHex),
        formatRecords: snapshot.formatCheckpoints.map((record) => record.recordHex), protectionRecords: snapshot.protectionCheckpoints.map((record) => record.recordHex),
        mountRecords: snapshot.mountCheckpoints.map((record) => record.recordHex), mountedWorkspaceRecords: snapshot.mountedWorkspaceCheckpoints.map((record) => record.recordHex) });
      if (history.mountedWorkspaceRecords?.length !== 2) throw conflict("Cell capacity requires all twenty-one canonical native records.");
      let row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE ${WHERE} ORDER BY revision DESC LIMIT 1`).get<Row>(keyOf(frozen));
      const submission = frozen.submission;
      if ("observationHex" in submission) {
        const chunks = "chunkHex" in submission ? submission.chunkHex : undefined;
        const chunksJson = chunks ? JSON.stringify(chunks) : undefined;
        const observation = codec.decode(submission.observationHex, history, chunks);
        const replay = this.db.prepare(`SELECT * FROM ${TABLE} WHERE ${WHERE} AND connection_nonce_hex = @nonce`)
          .get<Row>({ ...keyOf(frozen), nonce: observation.connectionNonceHex });
        if (replay) {
          if (replay.observation_hex !== submission.observationHex || replay.native_receipt_hex !== submission.nativeReceiptHex ||
              replay.revision !== submission.expectedRevision + 1 || (kind === "inventory" && replay.chunk_hex_json !== chunksJson))
            throw conflict("Cell capacity replay conflicts with its immutable observation.");
          row = replay;
        } else {
          if ((row?.revision ?? 0) !== submission.expectedRevision || submission.expectedRevision >= 2147483647)
            throw conflict("Cell capacity observation revision changed.");
          const clock = this.db.dialect === "postgres" ? REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK : REMOTE_WORKER_CAPACITY_SQLITE_CLOCK;
          this.db.prepare(`INSERT INTO ${TABLE} (registry_workspace_id, assignment_id, assignment_generation, revision, lease_revision,
            observation_hex, native_receipt_hex, connection_nonce_hex, plan_sha256, profile_sha256, checkpoint_sha256, recorded_at${kind === "inventory" ? ", chunk_hex_json" : ""})
            VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @revision, @leaseRevision,
              @observationHex, @nativeReceiptHex, @nonce, @planSha256, @profileSha256, @checkpointSha256, ${clock}${kind === "inventory" ? ", @chunksJson" : ""})`)
            .run({ ...keyOf(frozen), revision: submission.expectedRevision + 1, leaseRevision: frozen.leaseRevision,
              observationHex: submission.observationHex, nativeReceiptHex: submission.nativeReceiptHex, nonce: observation.connectionNonceHex,
              planSha256: history.planSha256, profileSha256: observation.profileSha256, checkpointSha256: observation.checkpointSha256,
              ...(kind === "inventory" ? { chunksJson: chunksJson! } : {}) });
          row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE ${WHERE} AND revision = @revision`)
            .get<Row>({ ...keyOf(frozen), revision: submission.expectedRevision + 1 });
          if (!row) throw conflict("Cell capacity observation was not retained.");
        }
      }
      let record: RemoteWorkerCellCapacityRecord | RemoteWorkerCellObjectInventoryRecord | null = null;
      if (row) {
        const chunks: unknown = kind === "inventory" ? JSON.parse(row.chunk_hex_json ?? "null") : undefined;
        const decoded = codec.decode(row.observation_hex, history, chunks);
        if (row.connection_nonce_hex !== decoded.connectionNonceHex || row.plan_sha256 !== history.planSha256 ||
            row.profile_sha256 !== decoded.profileSha256 || row.checkpoint_sha256 !== decoded.checkpointSha256)
          throw conflict("Cell capacity observation metadata differs from its retained native bytes.");
        record = { revision: row.revision, leaseRevision: row.lease_revision, recordedAt: row.recorded_at,
          observationHex: row.observation_hex, nativeReceiptHex: row.native_receipt_hex,
          ...(kind === "inventory" && "chunkHex" in decoded ? { chunkHex: decoded.chunkHex } : {}) };
      }
      const result = codec.exchange({ schemaVersion: codec.schema, history, record });
      this.assertAssignment(frozen);
      const current = this.cells.getCell(frozen);
      if (!current || current.cleanupState !== "not_started" || current.executionRevision !== cell.executionRevision ||
          current.cleanupRevision !== cell.cleanupRevision || current.provisioningOwner !== cell.provisioningOwner ||
          current.provisioningLeaseExpiresAt !== cell.provisioningLeaseExpiresAt)
        throw conflict("Cell capacity authority changed during observation persistence.");
      return result;
    });
  }

  private assertAssignment(input: Omit<RemoteWorkerCellCapacityAssignmentInput, "submission">) {
    const active = this.assignments.resolveActiveAuthorityByLeaseTokenHash(input.leaseTokenSha256, input.protectedAuthority);
    if (!active || active.assignment.registryWorkspaceId !== input.registryWorkspaceId || active.assignment.assignmentId !== input.assignmentId ||
        active.generation.assignmentGeneration !== input.assignmentGeneration || active.lease.leaseRevision !== input.leaseRevision)
      throw conflict("Cell capacity requires the exact active assignment lease.");
    return active;
  }
}
