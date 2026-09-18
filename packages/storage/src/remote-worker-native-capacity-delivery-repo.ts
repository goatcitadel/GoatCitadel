import { canonicalJsonString, normalizeRemoteWorkerCellProvisioningExchange, normalizeRemoteWorkerNativeCapacityLayout,
  readRemoteWorkerNativeCapacityDelivery, normalizeRemoteWorkerNativeCapacityCompositionBinding, REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  type RemoteWorkerNativeCapacityCompositionBinding, type RemoteWorkerNativeCapacityDelivery,
  type RemoteWorkerNativeCapacityLayout, type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import { RemoteWorkerCellProvisioningRepository } from "./remote-worker-cell-provisioning-repo.js";
import { RemoteWorkerCellCapacityStore } from "./remote-worker-cell-capacity-store.js";
import { RemoteWorkerCellCapacityAdmissionRepository, snapshotRemoteWorkerCellCapacityAuthority,
  snapshotRemoteWorkerCellCapacityInventoryAdmission, type RemoteWorkerCellCapacityAuthority,
  type RemoteWorkerCellCapacityInventoryAdmissionInput } from "./remote-worker-cell-capacity-admission-repo.js";

export interface RemoteWorkerNativeCapacityRetainedBindings {
  /** Owned by the protected capture coordinator, never copied from ingress. */
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly layout: RemoteWorkerNativeCapacityLayout;
  readonly window: RemoteWorkerNativeCapacityCompositionBinding;
}
export interface RemoteWorkerNativeCapacityDeliveryAdmissionInput extends Omit<RemoteWorkerCellCapacityInventoryAdmissionInput, "inventory" | "inventoryBinding"> {
  readonly retained: RemoteWorkerNativeCapacityRetainedBindings;
  readonly deliveryJson: string;
}
export interface RemoteWorkerNativeCapacityDeliveryReadInput extends RemoteWorkerCellCapacityAuthority {
  readonly bundleSha256: string;
  readonly retained: RemoteWorkerNativeCapacityRetainedBindings;
}
export interface RemoteWorkerNativeCapacityDeliveryRecord {
  readonly delivery: RemoteWorkerNativeCapacityDelivery;
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

export function snapshotRemoteWorkerNativeCapacityDeliveryAdmission(input: RemoteWorkerNativeCapacityDeliveryAdmissionInput) {
  const delivery = readRemoteWorkerNativeCapacityDelivery(input.deliveryJson, input.retained.history, input.retained.layout, input.retained.window);
  const admission = snapshotRemoteWorkerCellCapacityInventoryAdmission({ ...input, inventory: delivery.inventory, inventoryBinding: delivery.inventoryBinding });
  const deliveryJson = canonicalJsonString(delivery);
  if (Buffer.byteLength(deliveryJson, "utf8") > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES) throw conflict("Native capacity canonical delivery exceeds its retained bound.");
  return Object.freeze({ ...admission, retained: Object.freeze({ history: delivery.history, layout: delivery.layout, window: delivery.window }), delivery, deliveryJson });
}

export function snapshotRemoteWorkerNativeCapacityDeliveryRead(input: RemoteWorkerNativeCapacityDeliveryReadInput) {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), bundleSha256 = input.bundleSha256;
  if (typeof bundleSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(bundleSha256)) throw conflict("Native capacity read requires a bundle digest.");
  const retained = Object.freeze({ history: normalizeRemoteWorkerCellProvisioningExchange(input.retained.history),
    layout: normalizeRemoteWorkerNativeCapacityLayout(input.retained.layout), window: normalizeRemoteWorkerNativeCapacityCompositionBinding(input.retained.window) });
  return Object.freeze({ ...authority, bundleSha256, retained });
}

/** Exact source and capacity admission commit together. Replays recheck current
 * protected authority but never repeat admission or replace original evidence. */
export class RemoteWorkerNativeCapacityDeliveryRepository {
  private readonly capacity: RemoteWorkerCellCapacityAdmissionRepository;
  private readonly provisioning: RemoteWorkerCellProvisioningRepository;
  public constructor(private readonly db: DatabaseClient) {
    this.capacity = new RemoteWorkerCellCapacityAdmissionRepository(db);
    this.provisioning = new RemoteWorkerCellProvisioningRepository(db);
  }
  public retain(input: RemoteWorkerNativeCapacityDeliveryAdmissionInput): RemoteWorkerNativeCapacityDeliveryRecord {
    const command = snapshotRemoteWorkerNativeCapacityDeliveryAdmission(input);
    return this.db.transaction("immediate", () => {
      this.capacity.readForAssignment(command);
      this.assertHistory(command, command.delivery.history);
      const previous = this.readRow(command, command.delivery.bundleSha256);
      if (previous) {
        const result = this.decode(previous, command.delivery, command);
        if (canonicalJsonString(result.delivery) !== command.deliveryJson) throw conflict("Native capacity replay differs from retained source.");
        this.capacity.readForAssignment(command); this.assertHistory(command, command.delivery.history);
        return result;
      }
      const result = this.capacity.admitInventory(command);
      if (result.decision === "reject") throw conflict("Native capacity inventory admission rejected the capture.");
      this.db.prepare(`INSERT INTO remote_worker_native_capacity_deliveries
        (registry_workspace_id, assignment_id, assignment_generation, capacity_revision, bundle_sha256, capture_nonce,
          inventory_sha256, capture_sha256, decision, delivery_json, recorded_at)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @revision, @bundleSha256, @nonce,
          @inventorySha256, @captureSha256, @decision, @deliveryJson, @recordedAt)`).run({ ...keyOf(command),
        revision: result.cell.capacityRevision, bundleSha256: command.delivery.bundleSha256, nonce: command.delivery.window.nonce,
        inventorySha256: command.inventoryBinding.inventorySha256, captureSha256: command.inventoryBinding.captureSha256,
        decision: result.decision, deliveryJson: command.deliveryJson, recordedAt: result.cell.updatedAt });
      const row = this.readRow(command, command.delivery.bundleSha256);
      if (!row || row.delivery_json !== command.deliveryJson) throw conflict("Native capacity source failed durable readback.");
      const record = this.decode(row, command.delivery, command);
      if (canonicalJsonString(this.capacity.readForAssignment(command)) !== canonicalJsonString(result.cell)) throw conflict("Native capacity authority changed during source retention.");
      this.assertHistory(command, command.delivery.history);
      return record;
    });
  }
  public read(input: RemoteWorkerNativeCapacityDeliveryReadInput): RemoteWorkerNativeCapacityDeliveryRecord | null {
    const authority = snapshotRemoteWorkerNativeCapacityDeliveryRead(input), { retained, bundleSha256: hash } = authority;
    return this.db.transaction("immediate", () => {
      this.capacity.readForAssignment(authority); this.assertHistory(authority, retained.history);
      const row = this.readRow(authority, hash), result = row ? this.decode(row, retained, authority) : null;
      this.capacity.readForAssignment(authority); this.assertHistory(authority, retained.history);
      return result;
    });
  }
  private readRow(authority: RemoteWorkerCellCapacityAuthority, hash: string): Row | undefined {
    return this.db.prepare(`SELECT delivery_json, bundle_sha256, capture_sha256, inventory_sha256, capacity_revision, decision, recorded_at
      FROM remote_worker_native_capacity_deliveries WHERE ${WHERE} AND bundle_sha256 = @hash`).get<Row>({ ...keyOf(authority), hash });
  }
  private decode(row: Row, retained: RemoteWorkerNativeCapacityRetainedBindings, authority: RemoteWorkerCellCapacityAuthority): RemoteWorkerNativeCapacityDeliveryRecord {
    const delivery = readRemoteWorkerNativeCapacityDelivery(row.delivery_json, retained.history, retained.layout, retained.window);
    if (row.bundle_sha256 !== delivery.bundleSha256 || row.capture_sha256 !== delivery.inventoryBinding.captureSha256 ||
        row.inventory_sha256 !== delivery.inventoryBinding.inventorySha256 || !Number.isSafeInteger(row.capacity_revision) || row.capacity_revision < 1 ||
        !["accept", "quarantine"].includes(row.decision)) throw conflict("Native capacity retained receipt differs from its source.");
    const inventory = this.capacity.readInventory({ ...authority, capacityRevision: row.capacity_revision });
    if (!inventory || canonicalJsonString(inventory.inventory) !== canonicalJsonString(delivery.inventory) || inventory.recordedAt !== row.recorded_at)
      throw conflict("Native capacity source differs from its canonical inventory record.");
    return Object.freeze({ delivery, receipt: Object.freeze({ bundleSha256: row.bundle_sha256, captureSha256: row.capture_sha256,
      inventorySha256: row.inventory_sha256, revision: row.capacity_revision }), decision: row.decision, recordedAt: row.recorded_at });
  }
  private assertHistory(authority: RemoteWorkerCellCapacityAuthority, retained: RemoteWorkerCellProvisioningExchange): void {
    const cell = this.capacity.readForAssignment(authority);
    if (!["provisioning", "ready"].includes(cell.executionState)) throw conflict("Native capacity delivery requires a provisioning or ready cell.");
    const current = cell.executionState === "provisioning"
      ? this.provisioning.exchangeWithAssignment({ ...authority, submission: { kind: "cell.provisioning.snapshot" } })
      : new RemoteWorkerCellCapacityStore(this.db).exchange({ ...authority, submission: { kind: "cell.capacity.snapshot" } }, "mounted").history;
    if (retained.leaseRevision > current.leaseRevision || canonicalJsonString({ ...retained, leaseRevision: current.leaseRevision }) !== canonicalJsonString(current))
      throw conflict("Native capacity capture history differs from its canonical assignment head.");
  }
}
