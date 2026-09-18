import { createHash } from "node:crypto";
import { canonicalJsonString, normalizeRemoteWorkerNativeFileReceipt, remoteWorkerNativeFileReceiptSha256,
  normalizeRemoteWorkerNativeFileTransferPage, nativeFileTransferPageForDeclaration,
  normalizeRemoteWorkerRuntimeResultSubmission, createRemoteWorkerNativeArtifactManifest, remoteWorkerArtifactManifestSha256,
  type RemoteWorkerNativeFileReceipt, type RemoteWorkerNativeFileTransferPage } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerNativeFileReceiptRepository } from "./remote-worker-native-file-receipt-repo.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";

export interface RemoteWorkerNativeFileTransferRecord {
  readonly declaration: RemoteWorkerNativeFileReceipt;
  readonly transferSha256: string;
  readonly leaseRevision: number;
  readonly recordedAt: string;
}
export interface RemoteWorkerNativeFileTransferPageRecord {
  readonly fileIndex: number; readonly pageIndex: number; readonly bytesHex: string;
  readonly pageSha256: string; readonly leaseRevision: number; readonly recordedAt: string;
}
type Authority = RemoteWorkerCellCapacityAuthority;
type Lookup = Authority & { nonce: string; requestSha256: string };
interface Row { declaration_json: string; declaration_sha256: string; request_sha256: string; lease_revision: number; recorded_at: string }
interface PageRow { file_index: number; page_index: number; bytes_hex: string; page_sha256: string; lease_revision: number; recorded_at: string }
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration AND nonce = @nonce";
const conflict = () => new RemoteWorkerCellConflictError("Native file transfer requires its bounded declaration and current disclosure authority.");
function key(authority: Authority, nonce: string) { return { registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration, nonce }; }
function digest(bytesHex: string) { return createHash("sha256").update(Buffer.from(bytesHex, "hex")).digest("hex"); }

/** Temporary approved bytes, not artifact truth. Declaration and page slots are
 * immutable and bounded. Only canonical receipt plus verified manifest permits
 * raw-page cleanup; declaration metadata remains for replay and audit. */
export class RemoteWorkerNativeFileTransferRepository {
  private readonly results: RemoteWorkerRuntimeResultRepository;
  constructor(private readonly db: DatabaseClient) { this.results = new RemoteWorkerRuntimeResultRepository(db); }

  public beginForAssignment(input: Authority & { declaration: RemoteWorkerNativeFileReceipt }): RemoteWorkerNativeFileTransferRecord {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), declaration = normalizeRemoteWorkerNativeFileReceipt(input.declaration);
    const transferSha256 = remoteWorkerNativeFileReceiptSha256(declaration), lookup = key(authority, declaration.disclosure.nonce);
    const declarationJson = canonicalJsonString(declaration);
    if (Buffer.byteLength(declarationJson) > 131072) throw conflict();
    return this.db.transaction("immediate", () => {
      this.authorize(authority, declaration);
      const previous = this.row(lookup);
      if (previous) {
        const saved = this.decode(previous, authority, declaration.disclosure.nonce, declaration.disclosure.requestSha256);
        if (saved.transferSha256 !== transferSha256) throw conflict(); return saved;
      }
      this.db.prepare(`INSERT INTO remote_worker_native_file_transfers
        (registry_workspace_id, assignment_id, assignment_generation, nonce, declaration_json, declaration_sha256, request_sha256, lease_revision, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @declarationJson, @transferSha256, @requestSha256, @leaseRevision, @recordedAt)`)
        .run({ ...lookup, declarationJson, transferSha256, requestSha256: declaration.disclosure.requestSha256,
          leaseRevision: authority.leaseRevision, recordedAt: this.now() });
      this.authorize(authority, declaration);
      return this.decode(this.row(lookup)!, authority, declaration.disclosure.nonce, declaration.disclosure.requestSha256);
    });
  }

  public appendPageForAssignment(input: Authority & { page: RemoteWorkerNativeFileTransferPage }): Omit<RemoteWorkerNativeFileTransferPageRecord, "bytesHex"> {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), page = normalizeRemoteWorkerNativeFileTransferPage(input.page);
    const lookup = key(authority, page.nonce);
    return this.db.transaction("immediate", () => {
      this.results.authorizeForAssignment({ ...authority, nonce: page.nonce, requestSha256: page.requestSha256, phase: "delivery" });
      const row = this.row(lookup); if (!row) throw conflict();
      const saved = this.decode(row, authority, page.nonce, page.requestSha256);
      nativeFileTransferPageForDeclaration(page, saved.declaration);
      this.authorize(authority, saved.declaration, page.fileIndex);
      if (new RemoteWorkerNativeFileReceiptRepository(this.db).findForAssignment({ ...authority, nonce: page.nonce, requestSha256: page.requestSha256 })) throw conflict();
      const partKey = { ...lookup, fileIndex: page.fileIndex, pageIndex: page.pageIndex };
      const existing = this.pageRow(partKey), pageSha256 = digest(page.bytesHex);
      if (existing) {
        const checked = this.decodePage(existing, authority, saved);
        if (checked.bytesHex !== page.bytesHex || checked.pageSha256 !== pageSha256) throw conflict();
        return this.pageReceipt(checked);
      }
      this.db.prepare(`INSERT INTO remote_worker_native_file_transfer_pages
        (registry_workspace_id, assignment_id, assignment_generation, nonce, file_index, page_index, bytes_hex, page_sha256, lease_revision, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @fileIndex, @pageIndex, @bytesHex, @pageSha256, @leaseRevision, @recordedAt)`)
        .run({ ...partKey, bytesHex: page.bytesHex, pageSha256, leaseRevision: authority.leaseRevision, recordedAt: this.now() });
      this.authorize(authority, saved.declaration, page.fileIndex);
      return this.pageReceipt(this.decodePage(this.pageRow(partKey)!, authority, saved));
    });
  }

  /** Internal recovery only. Partial pages are not a complete file or receipt;
   * callers must assemble exact records and pass native content validation. */
  public readForAssignment(input: Lookup): { transfer: RemoteWorkerNativeFileTransferRecord; pages: readonly RemoteWorkerNativeFileTransferPageRecord[] } | null {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), request = this.request(input);
    return this.db.transaction("immediate", () => {
      this.results.authorizeForAssignment({ ...authority, ...request, phase: "delivery" });
      const row = this.row(key(authority, request.nonce)); if (!row) return null;
      const transfer = this.decode(row, authority, request.nonce, request.requestSha256); this.authorize(authority, transfer.declaration);
      const rows = this.db.prepare(`SELECT * FROM remote_worker_native_file_transfer_pages WHERE ${WHERE} ORDER BY file_index, page_index`)
        .all<PageRow>(key(authority, request.nonce));
      const pages = rows.map(page => this.decodePage(page, authority, transfer));
      return Object.freeze({ transfer, pages: Object.freeze(pages) });
    });
  }

  public releasePagesForAssignment(input: Lookup): number {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input), request = this.request(input), lookup = key(authority, request.nonce);
    return this.db.transaction("immediate", () => {
      this.results.authorizeForAssignment({ ...authority, ...request, phase: "delivery" });
      const row = this.row(lookup); if (!row) throw conflict();
      const transfer = this.decode(row, authority, request.nonce, request.requestSha256); this.authorize(authority, transfer.declaration);
      const receipt = new RemoteWorkerNativeFileReceiptRepository(this.db).findForAssignment({ ...authority, ...request });
      const verified = new RemoteWorkerArtifactRepository(this.db).getVerifiedManifest(authority.registryWorkspaceId, authority.assignmentId, authority.assignmentGeneration);
      if (!receipt || receipt.receiptSha256 !== transfer.transferSha256 || !verified ||
          remoteWorkerArtifactManifestSha256(verified) !== remoteWorkerArtifactManifestSha256(createRemoteWorkerNativeArtifactManifest({ receipt: receipt.receipt, identity: verified.identity }))) throw conflict();
      const count = this.db.prepare(`SELECT COUNT(*) AS count FROM remote_worker_native_file_transfer_pages WHERE ${WHERE}`).get<{ count: number }>(lookup)!.count;
      this.db.prepare(`DELETE FROM remote_worker_native_file_transfer_pages WHERE ${WHERE}`).run(lookup);
      this.authorize(authority, transfer.declaration); return Number(count);
    });
  }

  private authorize(authority: Authority, declaration: RemoteWorkerNativeFileReceipt, fileIndex?: number): void {
    const disclosure = declaration.disclosure;
    if (disclosure.registryWorkspaceId !== authority.registryWorkspaceId || disclosure.assignmentId !== authority.assignmentId || disclosure.assignmentGeneration !== authority.assignmentGeneration) throw conflict();
    const active = new RemoteWorkerAssignmentRepository(this.db).resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, authority.protectedAuthority);
    if (!active || active.assignment.registryWorkspaceId !== authority.registryWorkspaceId || active.assignment.assignmentId !== authority.assignmentId ||
        active.generation.assignmentGeneration !== authority.assignmentGeneration || active.lease.leaseRevision !== authority.leaseRevision ||
        !active.assignment.manifest.requiredCapabilityClasses.includes("artifact_stage") || declaration.totalBytes > active.assignment.manifest.maxArtifactBytes) throw conflict();
    const files = fileIndex === undefined ? declaration.files : [declaration.files[fileIndex]!];
    for (const file of files) {
      const current = this.results.authorizeFileDisclosureForAssignment({ ...authority, selection: file.selection, fileStaging: declaration.fileStaging });
      if (canonicalJsonString(current.disclosure) !== canonicalJsonString(disclosure)) throw conflict();
    }
  }
  private decode(row: Row, authority: Authority, nonce: string, requestSha256: string): RemoteWorkerNativeFileTransferRecord {
    const declaration = normalizeRemoteWorkerNativeFileReceipt(JSON.parse(row.declaration_json));
    if (remoteWorkerNativeFileReceiptSha256(declaration) !== row.declaration_sha256 || declaration.disclosure.nonce !== nonce ||
        declaration.disclosure.requestSha256 !== requestSha256 || row.request_sha256 !== requestSha256 ||
        !Number.isSafeInteger(row.lease_revision) || row.lease_revision < 1 || row.lease_revision > authority.leaseRevision) throw conflict();
    return Object.freeze({ declaration, transferSha256: row.declaration_sha256, leaseRevision: row.lease_revision, recordedAt: row.recorded_at });
  }
  private decodePage(row: PageRow, authority: Authority, transfer: RemoteWorkerNativeFileTransferRecord): RemoteWorkerNativeFileTransferPageRecord {
    const page = nativeFileTransferPageForDeclaration({ kind: "runtime.files.page", nonce: transfer.declaration.disclosure.nonce,
      requestSha256: transfer.declaration.disclosure.requestSha256, transferSha256: transfer.transferSha256,
      fileIndex: row.file_index, pageIndex: row.page_index, bytesHex: row.bytes_hex }, transfer.declaration);
    if (digest(page.bytesHex) !== row.page_sha256 || !Number.isSafeInteger(row.lease_revision) || row.lease_revision < 1 || row.lease_revision > authority.leaseRevision) throw conflict();
    return Object.freeze({ fileIndex: page.fileIndex, pageIndex: page.pageIndex, bytesHex: page.bytesHex,
      pageSha256: row.page_sha256, leaseRevision: row.lease_revision, recordedAt: row.recorded_at });
  }
  private pageReceipt(page: RemoteWorkerNativeFileTransferPageRecord): Omit<RemoteWorkerNativeFileTransferPageRecord, "bytesHex"> {
    return Object.freeze({ fileIndex: page.fileIndex, pageIndex: page.pageIndex, pageSha256: page.pageSha256, leaseRevision: page.leaseRevision, recordedAt: page.recordedAt });
  }
  private row(input: ReturnType<typeof key>): Row | undefined { return this.db.prepare(`SELECT * FROM remote_worker_native_file_transfers WHERE ${WHERE}`).get<Row>(input); }
  private pageRow(input: ReturnType<typeof key> & { fileIndex: number; pageIndex: number }): PageRow | undefined {
    return this.db.prepare(`SELECT * FROM remote_worker_native_file_transfer_pages WHERE ${WHERE} AND file_index = @fileIndex AND page_index = @pageIndex`).get<PageRow>(input);
  }
  private request(input: Lookup) {
    const value = normalizeRemoteWorkerRuntimeResultSubmission({ kind: "runtime.result.lookup", nonce: input.nonce, requestSha256: input.requestSha256 });
    return { nonce: value.nonce, requestSha256: value.requestSha256 };
  }
  private now() { return new DurableRunRepository(this.db).readDatabaseNow(); }
}
