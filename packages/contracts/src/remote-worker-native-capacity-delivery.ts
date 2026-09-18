import { canonicalJsonString } from "./canonical-json.js";
import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { normalizeRemoteWorkerCellProvisioningExchange, type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { remoteWorkerCellCapacityInventorySha256, type RemoteWorkerCellCapacityInventory, type RemoteWorkerCellCapacityInventoryBinding } from "./remote-worker-cell-capacity-inventory.js";
import { normalizeRemoteWorkerNativeCapacityLayout, type RemoteWorkerNativeCapacityLayout } from "./remote-worker-native-capacity-layout.js";
import { composeRemoteWorkerNativeCapacityInventory, type RemoteWorkerNativeCapacityCompositionBinding } from "./remote-worker-native-capacity-composition.js";

export const REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_SCHEMA = "goatcitadel.worker-native-capacity-delivery.v1";
export const REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES = 16 * 1024 * 1024;
export interface RemoteWorkerNativeCapacityDelivery {
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly layout: RemoteWorkerNativeCapacityLayout;
  readonly window: RemoteWorkerNativeCapacityCompositionBinding;
  readonly source: unknown;
  readonly inventory: RemoteWorkerCellCapacityInventory;
  readonly inventoryBinding: RemoteWorkerCellCapacityInventoryBinding;
  readonly bundleSha256: string;
}
const refused = () => new TypeError("Native capacity delivery does not match its independently retained capture.");
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
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Fix capture bytes before delivery. This establishes byte integrity only;
 * protected authority and ownership of the capture window remain external. */
export function createRemoteWorkerNativeCapacityDelivery(payloadJson: unknown,
  retainedHistory: RemoteWorkerCellProvisioningExchange, nonce: string): RemoteWorkerNativeCapacityDelivery {
  const payload = record(parse(payloadJson), ["layout", "window", "source"]);
  const history = normalizeRemoteWorkerCellProvisioningExchange(retainedHistory);
  const layout = normalizeRemoteWorkerNativeCapacityLayout(payload.layout);
  const window = payload.window as RemoteWorkerNativeCapacityCompositionBinding;
  const inventory = composeRemoteWorkerNativeCapacityInventory(payload.source, history, layout, window);
  if (window.nonce !== nonce) throw refused();
  const inventoryBinding = { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
    inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) };
  return freeze({ history, layout, window, source: payload.source, inventory, inventoryBinding,
    bundleSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_SCHEMA,
      history, layout, window, source: payload.source }) });
}

/** Verify wire or persisted evidence against independently retained capture
 * history, layout and window. The current lease may be newer than the capture;
 * its authorization is the canonical owner's responsibility, not this decoder's.
 * Never populate these independent bindings from the submitted delivery. */
export function readRemoteWorkerNativeCapacityDelivery(deliveryJson: unknown,
  retainedHistory: RemoteWorkerCellProvisioningExchange, retainedLayout: unknown,
  retainedWindow: RemoteWorkerNativeCapacityCompositionBinding): RemoteWorkerNativeCapacityDelivery {
  const wire = record(parse(deliveryJson), ["history", "layout", "window", "source", "inventory", "inventoryBinding", "bundleSha256"]);
  const history = normalizeRemoteWorkerCellProvisioningExchange(retainedHistory);
  const layout = normalizeRemoteWorkerNativeCapacityLayout(retainedLayout);
  const window = record(retainedWindow, ["nonce", "hostCaptureSha256", "guestObservationSha256", "backingObservationSha256", "referencesSha256"]);
  if (Object.values(window).some(value => typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value))) throw refused();
  if (canonicalJsonString(wire.history) !== canonicalJsonString(history) ||
      canonicalJsonString(wire.layout) !== canonicalJsonString(layout) ||
      canonicalJsonString(wire.window) !== canonicalJsonString(window)) throw refused();
  const delivery = createRemoteWorkerNativeCapacityDelivery(canonicalJsonString({ layout, window, source: wire.source }), history, window.nonce as string);
  if (wire.bundleSha256 !== delivery.bundleSha256 || canonicalJsonString(wire.inventory) !== canonicalJsonString(delivery.inventory) ||
      canonicalJsonString(wire.inventoryBinding) !== canonicalJsonString(delivery.inventoryBinding)) throw refused();
  return delivery;
}
