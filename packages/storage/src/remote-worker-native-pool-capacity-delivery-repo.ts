import { canonicalJsonString, normalizeRemoteWorkerNativePoolSnapshot, normalizeRemoteWorkerNativeCapacityLayout,
  readRemoteWorkerNativePoolCapacityDelivery, normalizeRemoteWorkerNativePoolCapacityWindow, REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  type RemoteWorkerNativePoolCapacityWindow, type RemoteWorkerNativePoolCapacityDelivery,
  type RemoteWorkerNativeCapacityLayout, type RemoteWorkerNativePoolSnapshot } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import { RemoteWorkerNativePoolRepository } from "./remote-worker-native-pool-repo.js";
import { RemoteWorkerCellCapacityAdmissionRepository, snapshotRemoteWorkerCellCapacityAuthority,
  snapshotRemoteWorkerCellCapacityInventoryAdmission, type RemoteWorkerCellCapacityAuthority,
  type RemoteWorkerCellCapacityInventoryAdmissionInput } from "./remote-worker-cell-capacity-admission-repo.js";

export interface RemoteWorkerNativePoolCapacityRetainedBindings {
  /** Owned by the protected capture coordinator, never copied from ingress. */
  readonly pool: RemoteWorkerNativePoolSnapshot;
  readonly layout: RemoteWorkerNativeCapacityLayout;
  readonly window: RemoteWorkerNativePoolCapacityWindow;
}
export interface RemoteWorkerNativePoolCapacityDeliveryAdmissionInput extends Omit<RemoteWorkerCellCapacityInventoryAdmissionInput, "inventory" | "inventoryBinding"> {
  readonly retained: RemoteWorkerNativePoolCapacityRetainedBindings;
  readonly deliveryJson: string;
}
export interface RemoteWorkerNativePoolCapacityDeliveryReadInput extends RemoteWorkerCellCapacityAuthority {
  readonly bundleSha256: string;
  readonly retained: RemoteWorkerNativePoolCapacityRetainedBindings;
}
export interface RemoteWorkerNativePoolCapacityDeliveryRecord {
  readonly delivery: RemoteWorkerNativePoolCapacityDelivery;
  readonly receipt: { readonly bundleSha256: string; readonly captureSha256: string; readonly inventorySha256: string; readonly revision: number };
  readonly decision: "accept" | "quarantine";
  readonly recordedAt: string;
}
const WHERE = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration";
const conflict = (message: string) => new RemoteWorkerCellConflictError(message);
const keyOf = (input: RemoteWorkerCellCapacityAuthority) => ({ registryWorkspaceId: input.registryWorkspaceId,
  assignmentId: input.assignmentId, assignmentGeneration: input.assignmentGeneration });
type Row = { delivery_json: string; bundle_sha256: string; capture_sha256: string; inventory_sha256: string;
  capacity_revision: number; decision: "accept" | "quarantine"; recorded_at: string };

export function snapshotRemoteWorkerNativePoolCapacityDeliveryAdmission(input: RemoteWorkerNativePoolCapacityDeliveryAdmissionInput) {
  const delivery = readRemoteWorkerNativePoolCapacityDelivery(input.deliveryJson, input.retained.pool, input.retained.layout, input.retained.window);
  const admission = snapshotRemoteWorkerCellCapacityInventoryAdmission({ ...input, inventory: delivery.inventory, inventoryBinding: delivery.inventoryBinding });
  const deliveryJson = canonicalJsonString(delivery);
  if (Buffer.byteLength(deliveryJson, "utf8") > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES) throw conflict("Native pool capacity canonical delivery exceeds its retained bound.");
  return Object.freeze({ ...admission, retained: Object.freeze({ pool: delivery.pool, layout: delivery.layout, window: delivery.window }), delivery, deliveryJson });
}

export function snapshotRemoteWorkerNativePoolCapacityDeliveryRead(input: RemoteWorkerNativePoolCapacityDeliveryReadInput) {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), bundleSha256 = input.bundleSha256;
  if (typeof bundleSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(bundleSha256)) throw conflict("Native pool capacity read requires a bundle digest.");
  const retained = Object.freeze({ pool: normalizeRemoteWorkerNativePoolSnapshot(input.retained.pool),
    layout: normalizeRemoteWorkerNativeCapacityLayout(input.retained.layout), window: normalizeRemoteWorkerNativePoolCapacityWindow(input.retained.window) });
  return Object.freeze({ ...authority, bundleSha256, retained });
}

/** Exact source and capacity admission commit together. Replays recheck current
 * protected authority but never repeat admission or replace original evidence.
 * Shares the existing immutable source table and nonce namespace with single-cell
 * deliveries. Only a trusted capture coordinator supplies retained bindings;
 * this repository does not register expectations from worker ingress. */
export class RemoteWorkerNativePoolCapacityDeliveryRepository {
  private readonly capacity: RemoteWorkerCellCapacityAdmissionRepository;
  private readonly pools: RemoteWorkerNativePoolRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.capacity = new RemoteWorkerCellCapacityAdmissionRepository(db);
    this.pools = new RemoteWorkerNativePoolRepository(db);
  }
  public retain(input: RemoteWorkerNativePoolCapacityDeliveryAdmissionInput): RemoteWorkerNativePoolCapacityDeliveryRecord {
    const command = snapshotRemoteWorkerNativePoolCapacityDeliveryAdmission(input);
    return this.db.transaction("immediate", () => {
      this.capacity.readForAssignment(command);
      this.assertPool(command, command.delivery.pool);
      const previous = this.readRow(command, command.delivery.bundleSha256);
      if (previous) {
        const result = this.decode(previous, command.delivery, command);
        if (canonicalJsonString(result.delivery) !== command.deliveryJson) throw conflict("Native pool capacity replay differs from retained source.");
        this.capacity.readForAssignment(command); this.assertPool(command, command.delivery.pool);
        return result;
      }
      const result = this.capacity.admitInventory(command);
      if (result.decision === "reject") throw conflict("Native pool capacity inventory admission rejected the capture.");
      this.db.prepare(`INSERT INTO remote_worker_native_capacity_deliveries
        (registry_workspace_id, assignment_id, assignment_generation, capacity_revision, bundle_sha256, capture_nonce,
          inventory_sha256, capture_sha256, decision, delivery_json, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @revision, @bundleSha256, @nonce,
          @inventorySha256, @captureSha256, @decision, @deliveryJson, @recordedAt)`).run({ ...keyOf(command),
        revision: result.cell.capacityRevision, bundleSha256: command.delivery.bundleSha256, nonce: command.delivery.window.nonce,
        inventorySha256: command.inventoryBinding.inventorySha256, captureSha256: command.inventoryBinding.captureSha256,
        decision: result.decision, deliveryJson: command.deliveryJson, recordedAt: result.cell.updatedAt });
      const row = this.readRow(command, command.delivery.bundleSha256);
      if (!row || row.delivery_json !== command.deliveryJson) throw conflict("Native pool capacity source failed durable readback.");
      const record = this.decode(row, command.delivery, command);
      if (canonicalJsonString(this.capacity.readForAssignment(command)) !== canonicalJsonString(result.cell)) throw conflict("Native pool capacity authority changed during source retention.");
      this.assertPool(command, command.delivery.pool);
      return record;
    });
  }
  public read(input: RemoteWorkerNativePoolCapacityDeliveryReadInput): RemoteWorkerNativePoolCapacityDeliveryRecord | null {
    const authority = snapshotRemoteWorkerNativePoolCapacityDeliveryRead(input), { retained, bundleSha256: hash } = authority;
    return this.db.transaction("immediate", () => {
      this.capacity.readForAssignment(authority); this.assertPool(authority, retained.pool);
      const row = this.readRow(authority, hash), result = row ? this.decode(row, retained, authority) : null;
      this.capacity.readForAssignment(authority); this.assertPool(authority, retained.pool);
      return result;
    });
  }
  private readRow(authority: RemoteWorkerCellCapacityAuthority, hash: string): Row | undefined {
    return this.db.prepare(`SELECT delivery_json, bundle_sha256, capture_sha256, inventory_sha256, capacity_revision, decision, recorded_at
      FROM remote_worker_native_capacity_deliveries WHERE ${WHERE} AND bundle_sha256 = @hash`).get<Row>({ ...keyOf(authority), hash });
  }
  private decode(row: Row, retained: RemoteWorkerNativePoolCapacityRetainedBindings, authority: RemoteWorkerCellCapacityAuthority): RemoteWorkerNativePoolCapacityDeliveryRecord {
    const delivery = readRemoteWorkerNativePoolCapacityDelivery(row.delivery_json, retained.pool, retained.layout, retained.window);
    if (row.bundle_sha256 !== delivery.bundleSha256 || row.capture_sha256 !== delivery.inventoryBinding.captureSha256 ||
        row.inventory_sha256 !== delivery.inventoryBinding.inventorySha256 || !Number.isSafeInteger(row.capacity_revision) || row.capacity_revision < 1 ||
        !["accept", "quarantine"].includes(row.decision)) throw conflict("Native pool capacity retained receipt differs from its source.");
    const inventory = this.capacity.readInventory({ ...authority, capacityRevision: row.capacity_revision });
    if (!inventory || canonicalJsonString(inventory.inventory) !== canonicalJsonString(delivery.inventory) || inventory.recordedAt !== row.recorded_at)
      throw conflict("Native pool capacity source differs from its canonical inventory record.");
    return Object.freeze({ delivery, receipt: Object.freeze({ bundleSha256: row.bundle_sha256, captureSha256: row.capture_sha256,
      inventorySha256: row.inventory_sha256, revision: row.capacity_revision }), decision: row.decision, recordedAt: row.recorded_at });
  }
  private assertPool(authority: RemoteWorkerCellCapacityAuthority, retained: RemoteWorkerNativePoolSnapshot): void {
    const cell = this.capacity.readForAssignment(authority);
    if (!["provisioning", "ready"].includes(cell.executionState)) throw conflict("Native pool capacity delivery requires a provisioning or ready cell.");
    const current = this.pools.readSnapshotForAssignment(authority);
    if (retained.leaseRevision > current.leaseRevision || canonicalJsonString({ ...retained, leaseRevision: current.leaseRevision }) !== canonicalJsonString(current))
      throw conflict("Native pool capacity capture history differs from its canonical protected pool.");
  }
}
