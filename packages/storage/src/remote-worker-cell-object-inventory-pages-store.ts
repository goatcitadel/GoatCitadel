import {
  normalizeRemoteWorkerCellObjectInventoryPageSubmission, normalizeRemoteWorkerCellObjectInventoryPageExchange,
  normalizeRemoteWorkerCellObjectInventoryExchange, readRemoteWorkerCellObjectInventoryPrefix,
  readRemoteWorkerCellCapacityObservation, REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION,
  type RemoteWorkerCellObjectInventoryPageSubmission, type RemoteWorkerCellObjectInventoryPageExchange,
  type RemoteWorkerCellObjectInventoryRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerCellCapacityStore, type RemoteWorkerCellObjectInventoryAssignmentInput } from "./remote-worker-cell-capacity-store.js";
import { RemoteWorkerCellRepository, RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";

export interface RemoteWorkerCellObjectInventoryPageAssignmentInput extends Omit<RemoteWorkerCellObjectInventoryAssignmentInput, "submission"> {
  readonly submission: RemoteWorkerCellObjectInventoryPageSubmission;
}
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const conflict = () => new RemoteWorkerCellConflictError("Worker inventory page conflicts with its current capture or assignment authority.");
interface StagingRow { expected_revision: number; lease_revision: number; execution_revision: number; cleanup_revision: number;
  observation_hex: string; native_receipt_hex: string; chunk_hex_json: string }
interface RetainedRow { revision: number; lease_revision: number; recorded_at: string; observation_hex: string; native_receipt_hex: string; chunk_hex_json: string }
const metadata = (record: RemoteWorkerCellObjectInventoryRecord | null) => record ? Object.freeze({ revision: record.revision,
  leaseRevision: record.leaseRevision, recordedAt: record.recordedAt, observationHex: record.observationHex, nativeReceiptHex: record.nativeReceiptHex }) : null;

export class RemoteWorkerCellObjectInventoryPagesStore {
  public constructor(private readonly db: DatabaseClient) {}
  public exchange(input: RemoteWorkerCellObjectInventoryPageAssignmentInput): RemoteWorkerCellObjectInventoryPageExchange {
    if (!input.protectedAuthority) throw conflict();
    const key = { registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration };
    const binding = Object.freeze({ ...key, leaseRevision: input.leaseRevision, leaseTokenSha256: input.leaseTokenSha256,
      protectedAuthority: Object.freeze({ credentialAuthority: Object.freeze({ ...input.protectedAuthority.credentialAuthority }),
        meshAdmission: Object.freeze({ ...input.protectedAuthority.meshAdmission }) }) });
    const submission = normalizeRemoteWorkerCellObjectInventoryPageSubmission(input.submission);
    return this.db.transaction("immediate", () => {
      const store = new RemoteWorkerCellCapacityStore(this.db), cells = new RemoteWorkerCellRepository(this.db);
      const snapshot = () => store.exchange({ ...binding, submission: { kind: "cell.object_inventory.snapshot" } }, "inventory");
      // The nested owner acquires assignment -> cell locks, held until this outer
      // transaction commits. Each page and replay re-enters protected authority.
      const original = snapshot(), cell = cells.getCell(key)!;
      let retained = original.record;
      let accepted: RemoteWorkerCellObjectInventoryPageExchange["accepted"] = null;
      if (submission.kind === "cell.object_inventory.page") {
        const summary = readRemoteWorkerCellCapacityObservation(submission.observationHex, original.history);
        const total = Math.ceil((summary.fileCount + summary.directoryCount) / 20);
        if (total > 1000 || submission.chunkHex.length !== Math.min(64, total - submission.startChunk)) throw conflict();
        const replay = this.db.prepare(`SELECT revision, lease_revision, recorded_at, observation_hex, native_receipt_hex, chunk_hex_json
          FROM remote_worker_cell_object_inventory_observations WHERE ${WHERE} AND connection_nonce_hex = @nonce`)
          .get<RetainedRow>({ ...key, nonce: summary.connectionNonceHex });
        let nextChunk: number, committedRevision: number | null = null;
        if (replay) {
          retained = normalizeRemoteWorkerCellObjectInventoryExchange({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION,
            history: original.history, record: { revision: replay.revision, leaseRevision: replay.lease_revision, recordedAt: replay.recorded_at,
              observationHex: replay.observation_hex, nativeReceiptHex: replay.native_receipt_hex, chunkHex: JSON.parse(replay.chunk_hex_json) } }).record!;
          if (retained.revision !== submission.expectedRevision + 1 || retained.observationHex !== submission.observationHex || retained.nativeReceiptHex !== submission.nativeReceiptHex ||
              submission.chunkHex.some((chunk, index) => chunk !== retained!.chunkHex[submission.startChunk + index])) throw conflict();
          nextChunk = retained.chunkHex.length; committedRevision = retained.revision;
        } else {
          if ((retained?.revision ?? 0) !== submission.expectedRevision) throw conflict();
          const staging = this.db.prepare(`SELECT * FROM remote_worker_cell_object_inventory_staging WHERE ${WHERE}`).get<StagingRow>(key);
          if (staging && staging.observation_hex.slice(0, 64) === summary.connectionNonceHex &&
              (staging.expected_revision !== submission.expectedRevision || staging.observation_hex !== submission.observationHex ||
                staging.native_receipt_hex !== submission.nativeReceiptHex)) throw conflict();
          const same = staging && staging.expected_revision === submission.expectedRevision && staging.lease_revision === binding.leaseRevision &&
            staging.execution_revision === cell.executionRevision && staging.cleanup_revision === cell.cleanupRevision &&
            staging.observation_hex === submission.observationHex && staging.native_receipt_hex === submission.nativeReceiptHex;
          let chunks: readonly string[] = [];
          if (same) chunks = readRemoteWorkerCellObjectInventoryPrefix(staging.observation_hex, JSON.parse(staging.chunk_hex_json), original.history).chunkHex;
          else if (submission.startChunk !== 0) throw conflict();
          if (submission.startChunk > chunks.length) throw conflict();
          if (submission.startChunk < chunks.length) {
            if (submission.chunkHex.some((chunk, index) => chunk !== chunks[submission.startChunk + index])) throw conflict();
          } else chunks = [...chunks, ...submission.chunkHex];
          const prefix = readRemoteWorkerCellObjectInventoryPrefix(submission.observationHex, chunks, original.history);
          nextChunk = prefix.chunkHex.length;
          if (prefix.complete) {
            retained = store.exchange({ ...binding, submission: { kind: "cell.object_inventory.observation", expectedRevision: submission.expectedRevision,
              observationHex: submission.observationHex, nativeReceiptHex: submission.nativeReceiptHex, chunkHex: prefix.chunkHex } }, "inventory").record!;
            committedRevision = retained.revision;
            this.db.prepare(`DELETE FROM remote_worker_cell_object_inventory_staging WHERE ${WHERE}`).run(key);
          } else {
            this.db.prepare(`INSERT INTO remote_worker_cell_object_inventory_staging (registry_workspace_id, assignment_id, assignment_generation,
              expected_revision, lease_revision, execution_revision, cleanup_revision, observation_hex, native_receipt_hex, chunk_hex_json)
              VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @expectedRevision, @leaseRevision, @executionRevision, @cleanupRevision, @observationHex, @nativeReceiptHex, @chunks)
              ON CONFLICT (registry_workspace_id, assignment_id, assignment_generation) DO UPDATE SET expected_revision = excluded.expected_revision,
                lease_revision = excluded.lease_revision, execution_revision = excluded.execution_revision, cleanup_revision = excluded.cleanup_revision,
                observation_hex = excluded.observation_hex, native_receipt_hex = excluded.native_receipt_hex, chunk_hex_json = excluded.chunk_hex_json`)
              .run({ ...key, expectedRevision: submission.expectedRevision, leaseRevision: binding.leaseRevision,
                executionRevision: cell.executionRevision, cleanupRevision: cell.cleanupRevision, observationHex: submission.observationHex,
                nativeReceiptHex: submission.nativeReceiptHex, chunks: JSON.stringify(prefix.chunkHex) });
          }
        }
        accepted = Object.freeze({ page: submission, nextChunk, committedRevision });
      }
      snapshot();
      const finalCell = cells.getCell(key)!;
      if (finalCell.executionRevision !== cell.executionRevision || finalCell.cleanupRevision !== cell.cleanupRevision) throw conflict();
      return normalizeRemoteWorkerCellObjectInventoryPageExchange({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION,
        history: original.history, record: metadata(retained), accepted });
    });
  }
}
