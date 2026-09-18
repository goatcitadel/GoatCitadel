import { createHash } from "node:crypto";
import { canonicalJsonString, remoteWorkerCellCanonicalSha256, normalizeRemoteWorkerCellCapacityAdmissionRequest,
  normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerNativeCapacityLayout, normalizeRemoteWorkerNativeCapacityCompositionBinding,
  normalizeRemoteWorkerNativeCapacityPageSubmission, normalizeRemoteWorkerNativeCapacityPageExchange,
  REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA, REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES,
  REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  type RemoteWorkerNativeCapacityPageSubmission, type RemoteWorkerNativeCapacityPageExchange, type RemoteWorkerNativeCapacityPage,
  type RemoteWorkerNativeCapacityPageReceipt } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerNativePoolSnapshot, normalizeRemoteWorkerNativePoolCapacityWindow } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerCellConflictError, type RemoteWorkerCellRecord } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellCapacityAdmissionRepository, snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { RemoteWorkerCellCapacityStore } from "./remote-worker-cell-capacity-store.js";
import { RemoteWorkerNativeCapacityDeliveryRepository, type RemoteWorkerNativeCapacityDeliveryAdmissionInput,
  type RemoteWorkerNativeCapacityDeliveryRecord } from "./remote-worker-native-capacity-delivery-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerNativePoolRepository } from "./remote-worker-native-pool-repo.js";
import { RemoteWorkerNativePoolCapacityDeliveryRepository, type RemoteWorkerNativePoolCapacityDeliveryAdmissionInput,
  type RemoteWorkerNativePoolCapacityDeliveryRecord } from "./remote-worker-native-pool-capacity-delivery-repo.js";

const SCHEMA = "goatcitadel.native-capacity-expectation.v1";
const POOL_SCHEMA = "goatcitadel.native-pool-capacity-expectation.v1";
const SPECIFICATION_MAXIMUM_BYTES = 131072;
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration AND nonce = @nonce";
const refused = (message: string) => new RemoteWorkerCellConflictError(message);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const keyOf = (input: RemoteWorkerCellCapacityAuthority) => ({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration });
type SingleSpecification = Pick<RemoteWorkerNativeCapacityDeliveryAdmissionInput, "retained" | "observation" | "expectedCapacityRevision" | "expectedExecutionRevision" | "expectedCleanupRevision" | "expectedBackupRevision"> & {
  readonly schemaVersion: typeof SCHEMA; readonly bundleSha256: string; readonly deliverySha256: string; readonly byteLength: number;
};
type PoolSpecification = Omit<SingleSpecification, "schemaVersion" | "retained"> & {
  readonly schemaVersion: typeof POOL_SCHEMA;
  readonly retained: Omit<RemoteWorkerNativePoolCapacityDeliveryAdmissionInput["retained"], "pool"> & { readonly poolLeaseRevision: number };
};
type Specification = SingleSpecification | PoolSpecification;
type DeliveryRecord = RemoteWorkerNativeCapacityDeliveryRecord | RemoteWorkerNativePoolCapacityDeliveryRecord;
export interface RemoteWorkerNativeCapacityPreparationInput extends Omit<RemoteWorkerNativeCapacityDeliveryAdmissionInput, "deliveryJson"> {
  readonly bundleSha256: string; readonly deliverySha256: string; readonly byteLength: number;
}
export interface RemoteWorkerNativePoolCapacityPreparationInput extends Omit<RemoteWorkerNativePoolCapacityDeliveryAdmissionInput, "deliveryJson"> {
  readonly bundleSha256: string; readonly deliverySha256: string; readonly byteLength: number;
}
export interface RemoteWorkerNativeCapacityPageAssignmentInput extends RemoteWorkerCellCapacityAuthority {
  readonly submission: RemoteWorkerNativeCapacityPageSubmission;
}
type SpecificationRow = { specification_json: string; specification_sha256: string; bundle_sha256: string; delivery_sha256: string; byte_length: number; nonce: string };
type PageRow = { page_offset: number; bytes_hex: string; page_sha256: string };

function normalizeSpecification(input: Specification): Specification {
  if (input.schemaVersion !== SCHEMA && input.schemaVersion !== POOL_SCHEMA) throw refused("Native capacity expectation schema is invalid.");
  for (const hash of [input.bundleSha256, input.deliverySha256]) if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash) || /^0+$/u.test(hash)) throw refused("Native capacity expectation requires exact digests.");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 2 || input.byteLength > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES) throw refused("Native capacity expectation exceeds its delivery bound.");
  const revisions = { expectedCapacityRevision: input.expectedCapacityRevision, expectedExecutionRevision: input.expectedExecutionRevision,
    expectedCleanupRevision: input.expectedCleanupRevision, expectedBackupRevision: input.expectedBackupRevision };
  if (Object.values(revisions).some(value => !Number.isSafeInteger(value) || value < 0 || value > 2147483647)) throw refused("Native capacity expectation revisions are invalid.");
  const common = { ...revisions, observation: normalizeRemoteWorkerCellCapacityAdmissionRequest(input.observation),
    bundleSha256: input.bundleSha256, deliverySha256: input.deliverySha256, byteLength: input.byteLength };
  if (input.schemaVersion === POOL_SCHEMA) {
    const retained = Object.freeze({ poolLeaseRevision: input.retained.poolLeaseRevision,
      layout: normalizeRemoteWorkerNativeCapacityLayout(input.retained.layout), window: normalizeRemoteWorkerNativePoolCapacityWindow(input.retained.window) });
    if (!Number.isSafeInteger(retained.poolLeaseRevision) || retained.poolLeaseRevision < 1 || retained.poolLeaseRevision > 2147483647)
      throw refused("Native pool expectation requires its original lease revision.");
    return Object.freeze({ schemaVersion: POOL_SCHEMA, retained, ...common });
  }
  const retained = Object.freeze({ history: normalizeRemoteWorkerCellProvisioningExchange(input.retained.history),
    layout: normalizeRemoteWorkerNativeCapacityLayout(input.retained.layout), window: normalizeRemoteWorkerNativeCapacityCompositionBinding(input.retained.window) });
  if (retained.history.mountedWorkspaceRecords?.length !== 2 || retained.layout.assignmentBindingSha256 !== retained.history.plan.assignmentBindingSha256 ||
      retained.layout.profileSha256 !== retained.history.plan.profileSha256) throw refused("Native capacity expectation does not bind a mounted capture.");
  return Object.freeze({ schemaVersion: SCHEMA, retained, ...common });
}
export function snapshotRemoteWorkerNativeCapacityPreparation(input: RemoteWorkerNativeCapacityPreparationInput) {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), specification = normalizeSpecification({ ...input, schemaVersion: SCHEMA });
  const specificationJson = canonicalJsonString(specification);
  if (Buffer.byteLength(specificationJson, "utf8") > SPECIFICATION_MAXIMUM_BYTES) throw refused("Native capacity expectation exceeds its retained bound.");
  return Object.freeze({ ...authority, ...specification });
}
/** Trusted coordinator input only. Persist a fingerprint of independently
 * retained protected membership; recover its exact history under current
 * authority on every page/read. This keeps 64-member expectations bounded. */
export function snapshotRemoteWorkerNativePoolCapacityPreparation(input: RemoteWorkerNativePoolCapacityPreparationInput) {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), pool = normalizeRemoteWorkerNativePoolSnapshot(input.retained.pool);
  const specification = normalizeSpecification({ ...input, schemaVersion: POOL_SCHEMA,
    retained: { layout: input.retained.layout, window: input.retained.window, poolLeaseRevision: pool.leaseRevision } });
  if (specification.schemaVersion !== POOL_SCHEMA || remoteWorkerCellCanonicalSha256(pool) !== specification.retained.window.poolSnapshotSha256)
    throw refused("Native pool expectation differs from its retained pool.");
  if (Buffer.byteLength(canonicalJsonString(specification), "utf8") > SPECIFICATION_MAXIMUM_BYTES) throw refused("Native capacity expectation exceeds its retained bound.");
  return Object.freeze({ ...authority, ...specification });
}
export function snapshotRemoteWorkerNativeCapacityPageAssignment(input: RemoteWorkerNativeCapacityPageAssignmentInput) {
  return Object.freeze({ ...snapshotRemoteWorkerCellCapacityAuthority(input), submission: normalizeRemoteWorkerNativeCapacityPageSubmission(input.submission) });
}

/** Only a trusted capture coordinator may prepare expectations. The peer page
 * protocol can neither create them nor supply admission parameters or bindings.
 * Every incomplete page remains durable evidence, never execution authority. */
export class RemoteWorkerNativeCapacityPagesRepository {
  private readonly capacity: RemoteWorkerCellCapacityAdmissionRepository;
  private readonly provisioning: RemoteWorkerCellProvisioningRepository;
  private readonly deliveries: RemoteWorkerNativeCapacityDeliveryRepository;
  private readonly clock: DurableRunRepository;
  private readonly poolDeliveries: RemoteWorkerNativePoolCapacityDeliveryRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.capacity = new RemoteWorkerCellCapacityAdmissionRepository(db); this.provisioning = new RemoteWorkerCellProvisioningRepository(db);
    this.deliveries = new RemoteWorkerNativeCapacityDeliveryRepository(db); this.clock = new DurableRunRepository(db);
    this.poolDeliveries = new RemoteWorkerNativePoolCapacityDeliveryRepository(db);
  }
  public prepareForAssignment(input: RemoteWorkerNativeCapacityPreparationInput): Readonly<{ nonce: string; bundleSha256: string; specificationSha256: string }> {
    return this.prepare(snapshotRemoteWorkerNativeCapacityPreparation(input));
  }
  public preparePoolForAssignment(input: RemoteWorkerNativePoolCapacityPreparationInput): Readonly<{ nonce: string; bundleSha256: string; specificationSha256: string }> {
    return this.prepare(snapshotRemoteWorkerNativePoolCapacityPreparation(input));
  }
  private prepare(command: RemoteWorkerCellCapacityAuthority & Specification) {
    const specification = normalizeSpecification(command);
    const specificationJson = canonicalJsonString(specification), specificationSha256 = remoteWorkerCellCanonicalSha256(specification);
    return this.db.transaction("immediate", () => {
      const before = this.assertCurrent(command, specification, false), nonce = specification.retained.window.nonce;
      const previous = this.readSpecification(command, nonce);
      if (previous) {
        if (canonicalJsonString(previous) !== specificationJson) throw refused("Native capacity capture expectation is immutable.");
      } else {
        this.assertRevisions(before, specification);
        this.db.prepare(`INSERT INTO remote_worker_native_capacity_captures
          (registry_workspace_id, assignment_id, assignment_generation, nonce, bundle_sha256, delivery_sha256, byte_length, specification_sha256, specification_json, recorded_at)
          VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @bundleSha256, @deliverySha256, @byteLength, @specificationSha256, @specificationJson, @recordedAt)`)
          .run({ ...keyOf(command), nonce, bundleSha256: specification.bundleSha256, deliverySha256: specification.deliverySha256,
            byteLength: specification.byteLength, specificationSha256, specificationJson, recordedAt: this.clock.readDatabaseNow() });
      }
      if (canonicalJsonString(this.readSpecification(command, nonce)) !== specificationJson ||
          canonicalJsonString(this.assertCurrent(command, specification, false)) !== canonicalJsonString(before)) throw refused("Native capacity authority changed during expectation retention.");
      return Object.freeze({ nonce, bundleSha256: specification.bundleSha256, specificationSha256 });
    });
  }
  /** Resolve only a complete accepted capture at the exact reviewed revisions.
   * Retained observations are not a fresh measurement or execution permission. */
  public readAdmissionForAssignment(input: RemoteWorkerCellCapacityAuthority & {
    expectedCapacityRevision: number; expectedExecutionRevision: number; expectedCleanupRevision: number; expectedBackupRevision: number;
  }) {
    return this.readAcceptedCapture(input, "ready");
  }
  /** Installation has its own provisioning-phase read. This returns retained
   * complete-capture evidence, not a fresh reservation or copy permission. */
  public readInstallationCapacityForAssignment(input: RemoteWorkerCellCapacityAuthority & {
    expectedCapacityRevision: number; expectedExecutionRevision: number; expectedCleanupRevision: number; expectedBackupRevision: number;
  }) {
    return this.readAcceptedCapture(input, "provisioning");
  }
  /** Trusted installation owner baseline for a subsequent fresh capture. The
   * layout comes from accepted full-pool evidence; membership and lease come
   * from canonical storage. No old capture window is promoted to live authority. */
  public readInstallationPoolBaselineForAssignment(input: RemoteWorkerCellCapacityAuthority & {
    expectedCapacityRevision: number; expectedExecutionRevision: number; expectedCleanupRevision: number; expectedBackupRevision: number;
  }) {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input);
    const command = Object.freeze({ ...authority, expectedCapacityRevision: input.expectedCapacityRevision,
      expectedExecutionRevision: input.expectedExecutionRevision, expectedCleanupRevision: input.expectedCleanupRevision,
      expectedBackupRevision: input.expectedBackupRevision });
    return this.db.transaction("immediate", () => {
      const capacity = this.readInstallationCapacityForAssignment(command);
      const row = this.db.prepare(`SELECT capture_nonce, bundle_sha256 FROM remote_worker_native_capacity_deliveries
        WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration
          AND capacity_revision = @revision`).get<{ capture_nonce: string; bundle_sha256: string }>({ ...keyOf(authority), revision: command.expectedCapacityRevision });
      const specification = row ? this.readSpecification(authority, row.capture_nonce) : null;
      if (!specification || specification.schemaVersion !== POOL_SCHEMA || specification.bundleSha256 !== row!.bundle_sha256)
        throw refused("Installation pool baseline requires accepted complete-pool evidence.");
      const retained = this.resolvePool(authority, specification);
      const pool = new RemoteWorkerNativePoolRepository(this.db).readSnapshotForAssignment(authority);
      if (canonicalJsonString({ ...pool, leaseRevision: retained.pool.leaseRevision }) !== canonicalJsonString(retained.pool) ||
          canonicalJsonString(this.readInstallationCapacityForAssignment(command)) !== canonicalJsonString(capacity))
        throw refused("Installation pool baseline changed during readback.");
      const delivery = this.poolDeliveries.read({ ...authority, retained, bundleSha256: specification.bundleSha256 });
      if (!delivery || delivery.decision !== "accept") throw refused("Installation baseline requires retained reference evidence.");
      return Object.freeze({ capacity, pool, layout: retained.layout,
        referencesJson: canonicalJsonString((delivery.delivery.source as { references: unknown }).references) });
    });
  }
  private readAcceptedCapture(input: RemoteWorkerCellCapacityAuthority & {
    expectedCapacityRevision: number; expectedExecutionRevision: number; expectedCleanupRevision: number; expectedBackupRevision: number;
  }, phase: "ready" | "provisioning") {
    const authority = snapshotRemoteWorkerCellCapacityAuthority(input);
    const revisions = { expectedCapacityRevision: input.expectedCapacityRevision, expectedExecutionRevision: input.expectedExecutionRevision,
      expectedCleanupRevision: input.expectedCleanupRevision, expectedBackupRevision: input.expectedBackupRevision };
    if (Object.values(revisions).some(value => !Number.isSafeInteger(value) || value < 0 || value > 2147483647)) throw refused("Native admission revisions are invalid.");
    return this.db.transaction("immediate", () => {
      const before = this.capacity.readForAssignment(authority);
      if (before.executionState !== phase || (phase === "provisioning" && before.nativePlatform) || before.capacityRevision !== revisions.expectedCapacityRevision ||
          before.executionRevision !== revisions.expectedExecutionRevision || before.cleanupRevision !== revisions.expectedCleanupRevision ||
          before.backupRevision !== revisions.expectedBackupRevision) throw refused("Native admission differs from the reviewed cell phase or revisions.");
      const row = this.db.prepare(`SELECT capture_nonce, bundle_sha256 FROM remote_worker_native_capacity_deliveries
        WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration
          AND capacity_revision = @revision`).get<{ capture_nonce: string; bundle_sha256: string }>({ ...keyOf(authority), revision: before.capacityRevision });
      if (!row) throw refused("Native admission requires a complete retained capacity delivery.");
      const specification = this.readSpecification(authority, row.capture_nonce);
      if (!specification || specification.bundleSha256 !== row.bundle_sha256 ||
          specification.expectedCapacityRevision + 1 !== before.capacityRevision || specification.expectedExecutionRevision !== before.executionRevision ||
          specification.expectedCleanupRevision !== before.cleanupRevision || specification.expectedBackupRevision !== before.backupRevision)
        throw refused("Native admission capture differs from reviewed revisions.");
      this.assertCurrent(authority, specification, false);
      const record = this.readDelivery(authority, specification);
      if (!record || record.decision !== "accept" || this.receipt(record, specification).revision !== before.capacityRevision)
        throw refused("Native admission requires an accepted complete capture.");
      const retained = this.capacity.readInventory({ ...authority, capacityRevision: before.capacityRevision });
      if (!retained || canonicalJsonString(retained.inventory) !== canonicalJsonString(record.delivery.inventory) ||
          canonicalJsonString(this.capacity.readForAssignment(authority)) !== canonicalJsonString(before))
        throw refused("Native admission inventory changed during readback.");
      return Object.freeze({ ...revisions, observation: specification.observation,
        inventory: record.delivery.inventory, inventoryBinding: record.delivery.inventoryBinding });
    });
  }
  public exchangeWithAssignment(input: RemoteWorkerNativeCapacityPageAssignmentInput): RemoteWorkerNativeCapacityPageExchange {
    const command = snapshotRemoteWorkerNativeCapacityPageAssignment(input), page = command.submission;
    return this.db.transaction("immediate", () => {
      this.capacity.readForAssignment(command);
      const specification = this.readSpecification(command, page.nonce);
      if (!specification || specification.bundleSha256 !== page.bundleSha256) throw refused("Native capacity delivery requires its independently registered expectation.");
      const before = this.assertCurrent(command, specification, false);
      const completed = this.readDelivery(command, specification);
      let record = completed ? this.receipt(completed, specification) : null;
      let nextOffset: number | null = null;
      if (page.kind === "cell.native_capacity.page") {
        if (page.deliverySha256 !== specification.deliverySha256 || page.byteLength !== specification.byteLength) throw refused("Native capacity page differs from its registered delivery.");
        const previous = this.readPage(command, page);
        if (previous) this.assertPage(previous, page);
        if (completed) {
          if (!previous) throw refused("Native capacity committed delivery is missing its staged page.");
          nextOffset = specification.byteLength;
        } else {
          this.assertRevisions(before, specification);
          if (!previous) {
            if (page.offset !== this.nextOffset(command, page.nonce)) throw refused("Native capacity pages must be retained in order.");
            this.db.prepare(`INSERT INTO remote_worker_native_capacity_pages
              (registry_workspace_id, assignment_id, assignment_generation, nonce, page_offset, bytes_hex, page_sha256, lease_revision, recorded_at)
              VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @offset, @bytesHex, @pageSha256, @leaseRevision, @recordedAt)`)
              .run({ ...keyOf(command), nonce: page.nonce, offset: page.offset, bytesHex: page.bytesHex,
                pageSha256: sha256(Buffer.from(page.bytesHex, "hex")), leaseRevision: command.leaseRevision, recordedAt: this.clock.readDatabaseNow() });
            const stored = this.readPage(command, page);
            if (!stored) throw refused("Native capacity page failed durable readback."); this.assertPage(stored, page);
          }
          nextOffset = this.nextOffset(command, page.nonce);
          if (nextOffset === specification.byteLength) {
            const json = this.assemble(command, specification);
            const retained = specification.schemaVersion === POOL_SCHEMA
              ? this.poolDeliveries.retain({ ...specification, ...command, retained: this.resolvePool(command, specification), deliveryJson: json })
              : this.deliveries.retain({ ...specification, ...command, deliveryJson: json });
            if (canonicalJsonString(retained.delivery) !== json) throw refused("Native capacity delivery bytes must use the canonical envelope.");
            record = this.receipt(retained, specification);
          }
        }
      } else if (!completed) this.assertRevisions(before, specification);
      const after = this.assertCurrent(command, specification, false);
      if (!completed && record) {
        if (after.capacityRevision !== record.revision || record.revision !== specification.expectedCapacityRevision + 1 ||
            after.executionRevision !== before.executionRevision || after.cleanupRevision !== before.cleanupRevision || after.backupRevision !== before.backupRevision)
          throw refused("Native capacity authority changed during final page retention.");
      } else if (canonicalJsonString(after) !== canonicalJsonString(before)) throw refused("Native capacity authority changed during page retention.");
      return normalizeRemoteWorkerNativeCapacityPageExchange({ schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA,
        ...keyOf(command), leaseRevision: command.leaseRevision, nonce: page.nonce, bundleSha256: page.bundleSha256, record,
        accepted: page.kind === "cell.native_capacity.page" ? { page, nextOffset } : null });
    });
  }
  private readSpecification(authority: RemoteWorkerCellCapacityAuthority, nonce: string): Specification | undefined {
    const row = this.db.prepare(`SELECT specification_json, specification_sha256, bundle_sha256, delivery_sha256, byte_length, nonce
      FROM remote_worker_native_capacity_captures WHERE ${WHERE}`).get<SpecificationRow>({ ...keyOf(authority), nonce });
    if (!row) return undefined;
    if (Buffer.byteLength(row.specification_json, "utf8") > SPECIFICATION_MAXIMUM_BYTES) throw refused("Native capacity expectation exceeds its retained bound.");
    const value = normalizeSpecification(JSON.parse(row.specification_json) as Specification);
    if (canonicalJsonString(value) !== row.specification_json || remoteWorkerCellCanonicalSha256(value) !== row.specification_sha256 ||
        value.bundleSha256 !== row.bundle_sha256 || value.deliverySha256 !== row.delivery_sha256 || value.byteLength !== row.byte_length || value.retained.window.nonce !== row.nonce)
      throw refused("Native capacity expectation metadata differs from its retained source.");
    return value;
  }
  private readPage(authority: RemoteWorkerCellCapacityAuthority, page: RemoteWorkerNativeCapacityPage): PageRow | undefined {
    return this.db.prepare(`SELECT page_offset, bytes_hex, page_sha256 FROM remote_worker_native_capacity_pages WHERE ${WHERE} AND page_offset = @offset`)
      .get<PageRow>({ ...keyOf(authority), nonce: page.nonce, offset: page.offset });
  }
  private assertPage(row: PageRow, page: RemoteWorkerNativeCapacityPage): void {
    if (row.page_offset !== page.offset || row.bytes_hex !== page.bytesHex || row.page_sha256 !== sha256(Buffer.from(page.bytesHex, "hex"))) throw refused("Native capacity replay differs from its retained page.");
  }
  private nextOffset(authority: RemoteWorkerCellCapacityAuthority, nonce: string): number {
    const value = this.db.prepare(`SELECT COALESCE(MAX(page_offset + length(bytes_hex) / 2), 0) AS next_offset FROM remote_worker_native_capacity_pages WHERE ${WHERE}`)
      .get<{ next_offset: number | string | bigint }>({ ...keyOf(authority), nonce });
    const result = Number(value?.next_offset);
    if (!Number.isSafeInteger(result) || result < 0 || result > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES) throw refused("Native capacity retained prefix is invalid.");
    return result;
  }
  private assemble(authority: RemoteWorkerCellCapacityAuthority, specification: Specification): string {
    const rows = this.db.prepare(`SELECT page_offset, bytes_hex, page_sha256 FROM remote_worker_native_capacity_pages WHERE ${WHERE} ORDER BY page_offset`)
      .all<PageRow>({ ...keyOf(authority), nonce: specification.retained.window.nonce });
    if (rows.length !== Math.ceil(specification.byteLength / REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES)) throw refused("Native capacity capture has missing pages.");
    const buffers = rows.map((row, index) => {
      const page = normalizeRemoteWorkerNativeCapacityPageSubmission({ kind: "cell.native_capacity.page", nonce: specification.retained.window.nonce,
        bundleSha256: specification.bundleSha256, deliverySha256: specification.deliverySha256, byteLength: specification.byteLength,
        offset: index * REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES, bytesHex: row.bytes_hex });
      if (page.kind !== "cell.native_capacity.page") throw refused("Native capacity page shape is invalid.");
      this.assertPage(row, page); return Buffer.from(row.bytes_hex, "hex");
    });
    const bytes = Buffer.concat(buffers);
    if (bytes.length !== specification.byteLength || sha256(bytes) !== specification.deliverySha256) throw refused("Native capacity assembled source differs from its registered digest.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  private receipt(record: DeliveryRecord, specification: Specification): RemoteWorkerNativeCapacityPageReceipt {
    const json = canonicalJsonString(record.delivery);
    if (record.receipt.bundleSha256 !== specification.bundleSha256 || Buffer.byteLength(json, "utf8") !== specification.byteLength || sha256(json) !== specification.deliverySha256)
      throw refused("Native capacity receipt differs from its registered delivery bytes.");
    return Object.freeze({ ...record.receipt, deliverySha256: specification.deliverySha256, byteLength: specification.byteLength, decision: record.decision });
  }
  private assertRevisions(cell: RemoteWorkerCellRecord, specification: Specification): void {
    if (cell.capacityRevision !== specification.expectedCapacityRevision || cell.executionRevision !== specification.expectedExecutionRevision ||
        cell.cleanupRevision !== specification.expectedCleanupRevision || cell.backupRevision !== specification.expectedBackupRevision)
      throw refused("Native capacity capture revisions changed before page admission.");
  }
  private assertCurrent(authority: RemoteWorkerCellCapacityAuthority, specification: Specification, revisions: boolean): RemoteWorkerCellRecord {
    const cell = this.capacity.readForAssignment(authority);
    if (!["provisioning", "ready"].includes(cell.executionState)) throw refused("Native capacity capture requires a provisioning or ready cell.");
    if (specification.schemaVersion === POOL_SCHEMA) {
      this.resolvePool(authority, specification);
      if (canonicalJsonString(cell.capacity) !== canonicalJsonString(specification.observation.reservation))
        throw refused("Native pool expectation differs from current canonical reservation.");
      if (revisions) this.assertRevisions(cell, specification);
      return cell;
    }
    // A legacy capture covers exactly one cell. Retained historical or
    // incomplete cells still consume pool resources and must not disappear
    // merely because this assignment is the only active lease.
    const pool = new RemoteWorkerNativePoolRepository(this.db).readForAssignment(authority);
    const member = pool.members[0]?.cell;
    if (pool.members.length !== 1 || member?.assignmentId !== cell.assignmentId ||
        member.assignmentGeneration !== cell.assignmentGeneration || member.cellId !== cell.cellId ||
        member.workerGeneration !== cell.workerGeneration)
      throw refused("Legacy native capacity requires the complete pool to contain only its current cell.");
    const history = cell.executionState === "provisioning"
      ? this.provisioning.exchangeWithAssignment({ ...authority, submission: { kind: "cell.provisioning.snapshot" } })
      : new RemoteWorkerCellCapacityStore(this.db).exchange({ ...authority, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
    if (specification.retained.history.leaseRevision > history.leaseRevision ||
        canonicalJsonString({ ...specification.retained.history, leaseRevision: history.leaseRevision }) !== canonicalJsonString(history) ||
        canonicalJsonString(cell.capacity) !== canonicalJsonString(specification.observation.reservation)) throw refused("Native capacity expectation differs from current canonical history or reservation.");
    if (revisions) this.assertRevisions(cell, specification);
    return cell;
  }
  private resolvePool(authority: RemoteWorkerCellCapacityAuthority, specification: PoolSpecification) {
    const current = new RemoteWorkerNativePoolRepository(this.db).readSnapshotForAssignment(authority);
    const pool = normalizeRemoteWorkerNativePoolSnapshot({ ...current, leaseRevision: specification.retained.poolLeaseRevision });
    const active = pool.members.find(member => member.assignmentId === pool.assignmentId && member.assignmentGeneration === pool.assignmentGeneration);
    if (pool.leaseRevision > current.leaseRevision || remoteWorkerCellCanonicalSha256(pool) !== specification.retained.window.poolSnapshotSha256 ||
        pool.members.some(member => member.history?.mountedWorkspaceRecords?.length !== 2) ||
        !active?.history || active.workerGeneration !== pool.workerGeneration ||
        active.history.plan.assignmentBindingSha256 !== specification.retained.layout.assignmentBindingSha256 ||
        active.history.plan.profileSha256 !== specification.retained.layout.profileSha256)
      throw refused("Native pool expectation differs from current protected pool history.");
    return Object.freeze({ pool, layout: specification.retained.layout, window: specification.retained.window });
  }
  private readDelivery(authority: RemoteWorkerCellCapacityAuthority, specification: Specification): DeliveryRecord | null {
    return specification.schemaVersion === POOL_SCHEMA
      ? this.poolDeliveries.read({ ...authority, retained: this.resolvePool(authority, specification), bundleSha256: specification.bundleSha256 })
      : this.deliveries.read({ ...authority, retained: specification.retained, bundleSha256: specification.bundleSha256 });
  }
}
