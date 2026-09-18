import { canonicalJsonString } from "./canonical-json.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { normalizeRemoteWorkerNativePoolSnapshot, type RemoteWorkerNativePoolSnapshot } from "./remote-worker-native-pool.js";
import { normalizeRemoteWorkerNativeCapacityLayout, type RemoteWorkerNativeCapacityLayout } from "./remote-worker-native-capacity-layout.js";
import { composeRemoteWorkerNativePoolCapacityInventory, normalizeRemoteWorkerNativePoolCapacityWindow,
  type RemoteWorkerNativePoolCapacityWindow } from "./remote-worker-native-pool-capacity-composition.js";
import { remoteWorkerCellCapacityInventorySha256, type RemoteWorkerCellCapacityInventory, type RemoteWorkerCellCapacityInventoryBinding } from "./remote-worker-cell-capacity-inventory.js";
import { REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES } from "./remote-worker-native-capacity-delivery.js";

export const REMOTE_WORKER_NATIVE_POOL_CAPACITY_DELIVERY_SCHEMA = "goatcitadel.worker-native-pool-capacity-delivery.v1";
export interface RemoteWorkerNativePoolCapacityDelivery {
  readonly pool: RemoteWorkerNativePoolSnapshot;
  readonly layout: RemoteWorkerNativeCapacityLayout;
  readonly window: RemoteWorkerNativePoolCapacityWindow;
  readonly source: unknown;
  readonly inventory: RemoteWorkerCellCapacityInventory;
  readonly inventoryBinding: RemoteWorkerCellCapacityInventoryBinding;
  readonly bundleSha256: string;
}
const refused = () => new TypeError("Native pool delivery differs from its independently retained capture.");
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value as unknown]));
}
function parse(input: unknown): unknown {
  if (typeof input !== "string" || input.length > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES ||
      new TextEncoder().encode(input).byteLength > REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES) throw refused();
  return JSON.parse(input) as unknown;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Fix complete capture bytes before asynchronous delivery. Neither a digest
 * nor serialization grants current lease, writer or collection authority. */
export function createRemoteWorkerNativePoolCapacityDelivery(payloadJson: unknown,
  retainedPool: RemoteWorkerNativePoolSnapshot, nonce: string): RemoteWorkerNativePoolCapacityDelivery {
  const payload = record(parse(payloadJson), ["layout", "window", "source"]);
  const pool = normalizeRemoteWorkerNativePoolSnapshot(retainedPool), layout = normalizeRemoteWorkerNativeCapacityLayout(payload.layout);
  const window = normalizeRemoteWorkerNativePoolCapacityWindow(payload.window);
  if (window.nonce !== nonce) throw refused();
  const inventory = composeRemoteWorkerNativePoolCapacityInventory(payload.source, pool, layout, window);
  const inventoryBinding = { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
    inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) };
  return freeze({ pool, layout, window, source: payload.source, inventory, inventoryBinding,
    bundleSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: REMOTE_WORKER_NATIVE_POOL_CAPACITY_DELIVERY_SCHEMA,
      pool, layout, window, source: payload.source }) });
}
/** Retained bindings come from the canonical capture owner, never the submitted
 * delivery. Recompose the complete inventory; do not trust claimed totals. */
export function readRemoteWorkerNativePoolCapacityDelivery(deliveryJson: unknown,
  retainedPool: RemoteWorkerNativePoolSnapshot, retainedLayout: unknown,
  retainedWindow: RemoteWorkerNativePoolCapacityWindow): RemoteWorkerNativePoolCapacityDelivery {
  const wire = record(parse(deliveryJson), ["pool", "layout", "window", "source", "inventory", "inventoryBinding", "bundleSha256"]);
  const pool = normalizeRemoteWorkerNativePoolSnapshot(retainedPool), layout = normalizeRemoteWorkerNativeCapacityLayout(retainedLayout);
  const window = normalizeRemoteWorkerNativePoolCapacityWindow(retainedWindow);
  if (canonicalJsonString(wire.pool) !== canonicalJsonString(pool) || canonicalJsonString(wire.layout) !== canonicalJsonString(layout) ||
      canonicalJsonString(wire.window) !== canonicalJsonString(window)) throw refused();
  const result = createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout, window, source: wire.source }), pool, window.nonce);
  if (wire.bundleSha256 !== result.bundleSha256 || canonicalJsonString(wire.inventory) !== canonicalJsonString(result.inventory) ||
      canonicalJsonString(wire.inventoryBinding) !== canonicalJsonString(result.inventoryBinding)) throw refused();
  return result;
}
