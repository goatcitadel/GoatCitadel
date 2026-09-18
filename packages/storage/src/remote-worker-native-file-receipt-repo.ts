import { canonicalJsonString, normalizeRemoteWorkerNativeFileStaging, normalizeRemoteWorkerNativeFileExportSelection,
  normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256, REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA,
  type RemoteWorkerNativeFileReceipt, type RemoteWorkerNativeFileExportSelection } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { normalizeRemoteWorkerRuntimeReadKey, createRemoteWorkerNativeArtifactManifest, remoteWorkerArtifactManifestSha256,
  type RemoteWorkerRuntimeReadKey } from "@goatcitadel/contracts";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";

export interface RemoteWorkerNativeFileReceiptRecord {
  readonly receipt: RemoteWorkerNativeFileReceipt;
  readonly receiptSha256: string;
  readonly leaseRevision: number;
  readonly recordedAt: string;
}
interface Row { receipt_json: string; receipt_sha256: string; result_sha256: string; lease_revision: number; recorded_at: string }
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration AND nonce = @nonce";
const conflict = () => new RemoteWorkerCellConflictError("Native file receipt requires the complete approved batch and current protected authority.");
function key(input: RemoteWorkerCellCapacityAuthority, nonce: string) {
  return { registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration, nonce };
}
/** Internal protected-receiver receipt. No RPC, model publication or CAS-success
 * claim: the artifact owner must install/reverify every referenced blob. */
export class RemoteWorkerNativeFileReceiptRepository {
  private readonly results: RemoteWorkerRuntimeResultRepository;
  constructor(private readonly db: DatabaseClient) { this.results = new RemoteWorkerRuntimeResultRepository(db); }

  public listReceiptNoncesForOperator(input: RemoteWorkerRuntimeReadKey & { assignmentGeneration: number }) {
    const scope = { ...normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId }), assignmentGeneration: input.assignmentGeneration };
    if (!Number.isSafeInteger(scope.assignmentGeneration) || scope.assignmentGeneration < 1 || scope.assignmentGeneration > 2147483647) throw conflict();
    const rows = this.db.prepare(`SELECT nonce FROM remote_worker_native_file_receipts WHERE registry_workspace_id = @registryWorkspaceId
      AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration ORDER BY recorded_at DESC, nonce DESC LIMIT 33`).all<{ nonce: string }>(scope);
    if (rows.some(row => !/^[a-f0-9]{64}$/u.test(row.nonce) || /^0+$/u.test(row.nonce))) throw conflict();
    return Object.freeze({ nonces: Object.freeze(rows.slice(0, 32).map(row => row.nonce)), truncated: rows.length > 32 });
  }

  /** Historical operator read, separate from live worker delivery authority.
   * Only a complete receipt with its exact verified manifest can expose files.
   * The Gateway must still rehash the CAS blob before serving any content. */
  public readVerifiedForOperator(input: RemoteWorkerRuntimeReadKey & { assignmentGeneration: number; nonce: string }) {
    const scope = { ...normalizeRemoteWorkerRuntimeReadKey({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId }), assignmentGeneration: input.assignmentGeneration, nonce: input.nonce };
    if (!Number.isSafeInteger(scope.assignmentGeneration) || scope.assignmentGeneration < 1 || scope.assignmentGeneration > 2147483647 ||
        typeof scope.nonce !== "string" || !/^[a-f0-9]{64}$/u.test(scope.nonce) || /^0+$/u.test(scope.nonce)) throw conflict();
    const row = this.row(scope); if (!row) return null;
    const retained = this.decode(row, scope);
    if (retained.receipt.disclosure.nonce !== scope.nonce) throw conflict();
    const manifest = new RemoteWorkerArtifactRepository(this.db).getVerifiedManifest(scope.registryWorkspaceId, scope.assignmentId, scope.assignmentGeneration);
    if (!manifest) return null;
    if (remoteWorkerArtifactManifestSha256(manifest) !== remoteWorkerArtifactManifestSha256(createRemoteWorkerNativeArtifactManifest({ receipt: retained.receipt, identity: manifest.identity })))
      throw conflict();
    return Object.freeze({ ...retained, manifest });
  }

  public retainForAssignment(input: RemoteWorkerCellCapacityAuthority & {
    fileStaging: unknown; files: readonly { selection: RemoteWorkerNativeFileExportSelection; recordHex: string }[];
  }): RemoteWorkerNativeFileReceiptRecord {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), plan = normalizeRemoteWorkerNativeFileStaging(input.fileStaging);
    if (!Array.isArray(input.files) || input.files.length !== plan.paths.length) throw conflict();
    const files = Array.from(input.files, (file, index) => {
      const selection = normalizeRemoteWorkerNativeFileExportSelection(file?.selection), recordHex = file?.recordHex;
      if (selection.logicalPath !== plan.paths[index] || selection.maximumBytes !== plan.maximumFileBytes ||
          typeof recordHex !== "string" || recordHex.length > 2 * (plan.maximumFileBytes + 200)) throw conflict();
      return { selection, recordHex };
    });
    if (files.reduce((sum, file) => sum + file.selection.logicalFileBytes, 0) > plan.maximumTotalBytes) throw conflict();
    return this.db.transaction("immediate", () => {
      const verified = files.map(file => this.results.verifyDisclosedFileContentForAssignment({ ...authority, ...file, fileStaging: plan }));
      const receipt = normalizeRemoteWorkerNativeFileReceipt({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_RECEIPT_SCHEMA,
        disclosure: verified[0]!.disclosure, fileStaging: plan, resultSha256: verified[0]!.selection.resultSha256,
        totalBytes: verified.reduce((sum, file) => sum + file.content.byteLength, 0), files: verified.map(file => ({
          selection: file.selection, recordSha256: file.content.recordSha256, contentSha256: file.content.contentSha256 })) });
      const lookup = key(authority, receipt.disclosure.nonce), receiptSha256 = remoteWorkerNativeFileReceiptSha256(receipt);
      const previous = this.row(lookup);
      if (previous) {
        const saved = this.decode(previous, authority);
        if (saved.receiptSha256 !== receiptSha256) throw conflict();
        this.authorize(authority, saved.receipt); return saved;
      }
      const receiptJson = canonicalJsonString(receipt);
      if (Buffer.byteLength(receiptJson, "utf8") > 131072) throw conflict();
      this.db.prepare(`INSERT INTO remote_worker_native_file_receipts
        (registry_workspace_id, assignment_id, assignment_generation, nonce, receipt_json, receipt_sha256, result_sha256, lease_revision, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @receiptJson, @receiptSha256, @resultSha256, @leaseRevision, @recordedAt)`)
        .run({ ...lookup, receiptJson, receiptSha256, resultSha256: receipt.resultSha256, leaseRevision: authority.leaseRevision,
          recordedAt: new DurableRunRepository(this.db).readDatabaseNow() });
      this.authorize(authority, receipt);
      const saved = this.decode(this.row(lookup)!, authority);
      if (saved.receiptSha256 !== receiptSha256) throw conflict();
      return saved;
    });
  }

  public findForAssignment(input: RemoteWorkerCellCapacityAuthority & { nonce: string; requestSha256: string }): RemoteWorkerNativeFileReceiptRecord | null {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), nonce = input.nonce, requestSha256 = input.requestSha256;
    return this.db.transaction("immediate", () => {
      this.results.authorizeForAssignment({ ...authority, nonce, requestSha256, phase: "delivery" });
      const row = this.row(key(authority, nonce)); if (!row) return null;
      const saved = this.decode(row, authority);
      if (saved.receipt.disclosure.nonce !== nonce || saved.receipt.disclosure.requestSha256 !== requestSha256) throw conflict();
      this.authorize(authority, saved.receipt); return saved;
    });
  }

  private authorize(authority: RemoteWorkerCellCapacityAuthority, receipt: RemoteWorkerNativeFileReceipt): void {
    for (const file of receipt.files) {
      const current = this.results.authorizeFileDisclosureForAssignment({ ...authority, selection: file.selection, fileStaging: receipt.fileStaging });
      if (canonicalJsonString(current.disclosure) !== canonicalJsonString(receipt.disclosure)) throw conflict();
    }
  }
  private row(input: ReturnType<typeof key>): Row | undefined {
    return this.db.prepare(`SELECT * FROM remote_worker_native_file_receipts WHERE ${WHERE}`).get<Row>(input);
  }
  private decode(row: Row, authority: Pick<RemoteWorkerCellCapacityAuthority, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration"> & { leaseRevision?: number }): RemoteWorkerNativeFileReceiptRecord {
    const receipt = normalizeRemoteWorkerNativeFileReceipt(JSON.parse(row.receipt_json));
    if (remoteWorkerNativeFileReceiptSha256(receipt) !== row.receipt_sha256 || receipt.resultSha256 !== row.result_sha256 ||
        receipt.disclosure.registryWorkspaceId !== authority.registryWorkspaceId || receipt.disclosure.assignmentId !== authority.assignmentId ||
        receipt.disclosure.assignmentGeneration !== authority.assignmentGeneration || !Number.isSafeInteger(row.lease_revision) ||
        row.lease_revision < 1 || row.lease_revision > (authority.leaseRevision ?? 2147483647)) throw conflict();
    return Object.freeze({ receipt, receiptSha256: row.receipt_sha256, leaseRevision: row.lease_revision, recordedAt: row.recorded_at });
  }
}
