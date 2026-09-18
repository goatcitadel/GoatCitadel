import { canonicalJsonString, createRemoteWorkerNativeCapacityDelivery, normalizeRemoteWorkerCellProvisioningExchange,
  remoteWorkerCellCanonicalSha256, REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_SCHEMA,
  REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES,
  createRemoteWorkerNativePoolCapacityDelivery, normalizeRemoteWorkerNativePoolSnapshot, REMOTE_WORKER_NATIVE_POOL_CAPACITY_DELIVERY_SCHEMA,
  type RemoteWorkerNativePoolSnapshot, type RemoteWorkerNativePoolCapacityDelivery,
  type RemoteWorkerCellProvisioningExchange, type RemoteWorkerNativeCapacityDelivery } from "@goatcitadel/contracts";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";

const MAXIMUM_BYTES = REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES;
const active = new WeakMap<WorkerDurableStatePort, Set<string>>();
const refused = () => new TypeError("Worker native capacity delivery does not match its retained capture.");
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value as unknown]));
}
function parse(input: unknown): unknown {
  if (typeof input !== "string" || input.length > MAXIMUM_BYTES || Buffer.byteLength(input, "utf8") > MAXIMUM_BYTES) throw refused();
  return JSON.parse(input) as unknown;
}
export type WorkerNativeCapacityDelivery = RemoteWorkerNativeCapacityDelivery;
export interface WorkerNativeCapacityReceipt {
  readonly inventorySha256: string;
  readonly captureSha256: string;
  readonly bundleSha256: string;
  readonly revision: number;
}
export interface WorkerNativeCapacityDeliveryInput {
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly captureNonce: string;
  readonly state: WorkerDurableStatePort;
  readonly signal: AbortSignal;
  /** Current protected assignment/lease/head authority, not endpoint health. */
  readonly assertCurrent: (history: RemoteWorkerCellProvisioningExchange) => Promise<void>;
  /** Terminally successful, owner-quiesced capture as JSON {layout, window, source}.
   * Serialization fixes its bytes before an asynchronous ownership boundary. */
  readonly capture: (history: RemoteWorkerCellProvisioningExchange, authorize: () => Promise<void>) => Promise<string>;
  /** Must retain the exact bundle through the protected canonical owner and
   * deduplicate retries by bundleSha256, returning that owner's receipt.
   * When a local receipt exists, confirm its canonical record rather than
   * treating the local cache as remote proof. This is not an admission bypass. */
  readonly deliver: (delivery: WorkerNativeCapacityDelivery, signal: AbortSignal, retainedReceipt: WorkerNativeCapacityReceipt | null) => Promise<unknown>;
}

type ReceiptBoundDelivery = Pick<WorkerNativeCapacityDelivery, "inventory" | "inventoryBinding" | "bundleSha256">;
type CaptureScope = Pick<RemoteWorkerCellProvisioningExchange, "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "leaseRevision">;
interface NativeDeliveryInput<S, D> extends Pick<WorkerNativeCapacityDeliveryInput, "captureNonce" | "state" | "signal"> {
  readonly history: S;
  readonly assertCurrent: (snapshot: S) => Promise<void>;
  readonly capture: (snapshot: S, authorize: () => Promise<void>) => Promise<string>;
  readonly deliver: (delivery: D, signal: AbortSignal, retainedReceipt: WorkerNativeCapacityReceipt | null) => Promise<unknown>;
}
export interface WorkerNativePoolCapacityDeliveryInput extends Omit<NativeDeliveryInput<RemoteWorkerNativePoolSnapshot, RemoteWorkerNativePoolCapacityDelivery>, "history"> {
  readonly pool: RemoteWorkerNativePoolSnapshot;
}
function receipt(input: unknown, delivery: ReceiptBoundDelivery): WorkerNativeCapacityReceipt {
  const value = record(input, ["inventorySha256", "captureSha256", "bundleSha256", "revision"]);
  if (value.inventorySha256 !== delivery.inventoryBinding.inventorySha256 || value.captureSha256 !== delivery.inventory.captureSha256 ||
      value.bundleSha256 !== delivery.bundleSha256 || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) throw refused();
  return Object.freeze(value) as unknown as WorkerNativeCapacityReceipt;
}

/** One explicitly identified capture, retained before delivery and never
 * recollected after response loss. A fresh capture requires a new nonce. This
 * owner does not install a collector, infer quiescence or enable execution. */
export function deliverWorkerNativeCapacityInventory(supplied: WorkerNativeCapacityDeliveryInput): Promise<WorkerNativeCapacityReceipt> {
  return deliverNativeInventory(supplied, { schema: REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_SCHEMA, prefix: "native-capacity", field: "history",
    normalize: normalizeRemoteWorkerCellProvisioningExchange, create: createRemoteWorkerNativeCapacityDelivery });
}
export function deliverWorkerNativePoolCapacityInventory(supplied: WorkerNativePoolCapacityDeliveryInput): Promise<WorkerNativeCapacityReceipt> {
  return deliverNativeInventory({ ...supplied, history: supplied.pool }, { schema: REMOTE_WORKER_NATIVE_POOL_CAPACITY_DELIVERY_SCHEMA,
    prefix: "native-pool-capacity", field: "pool", normalize: normalizeRemoteWorkerNativePoolSnapshot, create: createRemoteWorkerNativePoolCapacityDelivery });
}
/** Retain a complete local capture under the caller's stable measurement lease.
 * This neither uploads nor confirms a canonical receipt. Delivery must later
 * use the normal owner, which rechecks current authority and the remote receipt. */
export function retainWorkerNativePoolCapacityCapture(supplied: Omit<WorkerNativePoolCapacityDeliveryInput, "deliver">): Promise<RemoteWorkerNativePoolCapacityDelivery> {
  return deliverNativeInventory({ ...supplied, history: supplied.pool }, { schema: REMOTE_WORKER_NATIVE_POOL_CAPACITY_DELIVERY_SCHEMA,
    prefix: "native-pool-capacity", field: "pool", normalize: normalizeRemoteWorkerNativePoolSnapshot, create: createRemoteWorkerNativePoolCapacityDelivery }, true);
}
interface NativeDeliveryCodec<S, D> {
  readonly schema: string; readonly prefix: string; readonly field: "history" | "pool";
  readonly normalize: (input: unknown) => S; readonly create: (payload: unknown, snapshot: S, nonce: string) => D;
}
function deliverNativeInventory<S extends CaptureScope, D extends ReceiptBoundDelivery>(supplied: NativeDeliveryInput<S, D>, codec: NativeDeliveryCodec<S, D>): Promise<WorkerNativeCapacityReceipt>;
function deliverNativeInventory<S extends CaptureScope, D extends ReceiptBoundDelivery>(supplied: Omit<NativeDeliveryInput<S, D>, "deliver">, codec: NativeDeliveryCodec<S, D>, retainOnly: true): Promise<D>;
async function deliverNativeInventory<S extends CaptureScope, D extends ReceiptBoundDelivery>(
  supplied: Omit<NativeDeliveryInput<S, D>, "deliver"> & Partial<Pick<NativeDeliveryInput<S, D>, "deliver">>,
  codec: NativeDeliveryCodec<S, D>, retainOnly = false): Promise<WorkerNativeCapacityReceipt | D> {
  const input = Object.freeze({ ...supplied }), history = codec.normalize(input.history);
  if (typeof input.captureNonce !== "string" || !/^[0-9a-f]{64}$/u.test(input.captureNonce) || /^0+$/u.test(input.captureNonce)) throw refused();
  const scope = { registryWorkspaceId: history.registryWorkspaceId, assignmentId: history.assignmentId, assignmentGeneration: history.assignmentGeneration };
  const ownerKey = remoteWorkerCellCanonicalSha256(scope), key = `${codec.prefix}-${remoteWorkerCellCanonicalSha256({ ...scope, nonce: input.captureNonce })}`;
  const owners = active.get(input.state) ?? new Set<string>();
  if (owners.has(ownerKey)) throw new Error("Worker native capacity capture already has an active delivery owner.");
  active.set(input.state, owners); owners.add(ownerKey);
  let closed = false;
  const check = async () => {
    if (closed) throw refused();
    input.signal.throwIfAborted(); await input.assertCurrent(history); input.signal.throwIfAborted();
    if (closed) throw refused();
  };
  try {
    await check();
    const saved = await input.state.read(key); await check();
    let payloadJson: string, retainedHistory = history, recorded: unknown = null;
    if (saved !== undefined) {
      const value = record(parse(saved), ["schemaVersion", codec.field, "payloadJson", "receipt"]);
      if (value.schemaVersion !== codec.schema || typeof value.payloadJson !== "string") throw refused();
      retainedHistory = codec.normalize(value[codec.field]);
      const { leaseRevision: retainedLease, ...retainedResource } = retainedHistory;
      const { leaseRevision: currentLease, ...currentResource } = history;
      if (retainedLease > currentLease || canonicalJsonString(retainedResource) !== canonicalJsonString(currentResource)) throw refused();
      payloadJson = value.payloadJson; recorded = value.receipt;
    } else {
      payloadJson = await input.capture(history, check); await check();
    }
    const delivery = codec.create(payloadJson, retainedHistory, input.captureNonce);
    const persist = async (acknowledgement: WorkerNativeCapacityReceipt | null) => {
      const bytes = canonicalJsonString({ schemaVersion: codec.schema, [codec.field]: retainedHistory, payloadJson, receipt: acknowledgement });
      if (Buffer.byteLength(bytes, "utf8") > MAXIMUM_BYTES) throw refused();
      await check(); await input.state.write(key, bytes); await check();
      if (await input.state.read(key) !== bytes) throw new Error("Worker native capacity durable readback differs from the retained capture.");
      await check();
    };
    if (retainOnly) {
      if (recorded !== null) receipt(recorded, delivery);
      if (saved === undefined) await persist(null);
      await check();
      return delivery;
    }
    if (!input.deliver) throw refused();
    if (recorded !== null) {
      const retainedReceipt = receipt(recorded, delivery); await check();
      const confirmed = receipt(await input.deliver(delivery, input.signal, retainedReceipt), delivery); await check();
      if (confirmed.revision !== retainedReceipt.revision) throw new Error("Worker native capacity canonical receipt changed; retained evidence requires reconciliation.");
      return retainedReceipt;
    }
    if (saved === undefined) await persist(null);
    await check(); const result = receipt(await input.deliver(delivery, input.signal, null), delivery); await check();
    await persist(result); return result;
  } finally { closed = true; owners.delete(ownerKey); if (!owners.size) active.delete(input.state); }
}
