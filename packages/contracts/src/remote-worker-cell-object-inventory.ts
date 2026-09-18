import { readRemoteWorkerCellCapacityObservation, normalizeRemoteWorkerCellCapacitySubmission,
  readRemoteWorkerCellCapacityHistoryObservation, type RemoteWorkerCellCapacityHistoryObservation,
  normalizeRemoteWorkerCellCapacityRecord, type RemoteWorkerCellCapacityRecord, type RemoteWorkerCellCapacityObservation } from "./remote-worker-cell-capacity-observation.js";
import { normalizeRemoteWorkerCellProvisioningExchange, type RemoteWorkerCellProvisioningExchange, type RemoteWorkerCellProvisioningHistory } from "./remote-worker-cell-provisioning.js";

export const REMOTE_WORKER_CELL_OBJECT_INVENTORY_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-object-inventory.v1" as const;
export const REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-object-inventory-exchange.v1" as const;
export type RemoteWorkerCellObjectInventorySubmission = Readonly<{ kind: "cell.object_inventory.snapshot" }> | Readonly<{
  kind: "cell.object_inventory.observation"; expectedRevision: number; observationHex: string; chunkHex: readonly string[]; nativeReceiptHex: string;
}>;
export interface RemoteWorkerCellObjectInventoryRecord extends RemoteWorkerCellCapacityRecord { readonly chunkHex: readonly string[] }
export interface RemoteWorkerCellObjectInventoryExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION;
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly record: RemoteWorkerCellObjectInventoryRecord | null;
}
export interface RemoteWorkerCellObjectInventoryEntry {
  readonly identityHex: string;
  readonly directory: boolean;
  readonly logicalFileBytes: number;
  readonly allocatedBytes: number;
}
/** One native mounted tree. This is not the complete thirteen-area pool inventory. */
export interface RemoteWorkerCellObjectInventoryObservation extends RemoteWorkerCellCapacityObservation {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_OBJECT_INVENTORY_SCHEMA_VERSION;
  readonly chunkHex: readonly string[];
  readonly entries: readonly RemoteWorkerCellObjectInventoryEntry[];
}
export interface RemoteWorkerCellObjectInventoryHistoryObservation extends RemoteWorkerCellCapacityHistoryObservation {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_OBJECT_INVENTORY_SCHEMA_VERSION;
  readonly chunkHex: readonly string[];
  readonly entries: readonly RemoteWorkerCellObjectInventoryEntry[];
}
const refused = () => new TypeError("Native object inventory is incomplete or does not match retained authority.");
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw refused();
  return input as Record<string, unknown>;
}
function snapshotChunks(input: unknown): readonly string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 || input.length > 1000 ||
      Reflect.ownKeys(input).length !== input.length + 1) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input), output: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string" || !/^[0-9a-f]{2000}$/u.test(descriptor.value)) throw refused();
    output.push(descriptor.value as string);
  }
  return Object.freeze(output);
}
export function normalizeRemoteWorkerCellObjectInventorySubmission(input: unknown): RemoteWorkerCellObjectInventorySubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind === "cell.object_inventory.snapshot") { record(input, ["kind"]); return Object.freeze({ kind }); }
  if (kind !== "cell.object_inventory.observation") throw refused();
  const value = record(input, ["kind", "expectedRevision", "observationHex", "chunkHex", "nativeReceiptHex"]);
  const base = normalizeRemoteWorkerCellCapacitySubmission({ kind: "cell.capacity.observation", expectedRevision: value.expectedRevision,
    observationHex: value.observationHex, nativeReceiptHex: value.nativeReceiptHex });
  if (!("observationHex" in base)) throw refused();
  return Object.freeze({ ...base, kind, chunkHex: snapshotChunks(value.chunkHex) });
}
export function normalizeRemoteWorkerCellObjectInventoryExchange(input: unknown): RemoteWorkerCellObjectInventoryExchange {
  const value = record(input, ["schemaVersion", "history", "record"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION) throw refused();
  const history = normalizeRemoteWorkerCellProvisioningExchange(value.history);
  if (history.mountedWorkspaceRecords?.length !== 2) throw refused();
  if (value.record === null) return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION, history, record: null });
  const retained = record(value.record, ["revision", "leaseRevision", "recordedAt", "observationHex", "chunkHex", "nativeReceiptHex"]);
  const base = normalizeRemoteWorkerCellCapacityRecord({ revision: retained.revision, leaseRevision: retained.leaseRevision, recordedAt: retained.recordedAt,
    observationHex: retained.observationHex, nativeReceiptHex: retained.nativeReceiptHex }, history);
  const observation = readRemoteWorkerCellObjectInventory(base.observationHex, retained.chunkHex, history);
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_EXCHANGE_SCHEMA_VERSION, history,
    record: Object.freeze({ ...base, chunkHex: observation.chunkHex }) });
}

/** Decode exact ordered native batches against independent complete history.
 * No callback, getter, path, caller total or standalone identity supplies trust. */
export function readRemoteWorkerCellObjectInventory(summaryHex: unknown, input: unknown,
  retained: RemoteWorkerCellProvisioningExchange): RemoteWorkerCellObjectInventoryObservation {
  const prefix = readRemoteWorkerCellObjectInventoryPrefix(summaryHex, input, retained);
  if (!prefix.complete) throw refused();
  return Object.freeze({ ...prefix.summary, schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_SCHEMA_VERSION,
    chunkHex: prefix.chunkHex, entries: prefix.entries });
}

/** Complete historical resource evidence; never a current lease or staged prefix. */
export function readRemoteWorkerCellObjectInventoryHistory(summaryHex: unknown, input: unknown,
  retained: RemoteWorkerCellProvisioningHistory): RemoteWorkerCellObjectInventoryHistoryObservation {
  const prefix = decodeInventoryPrefix(readRemoteWorkerCellCapacityHistoryObservation(summaryHex, retained), input);
  if (!prefix.complete) throw refused();
  return Object.freeze({ ...prefix.summary, schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_SCHEMA_VERSION,
    chunkHex: prefix.chunkHex, entries: prefix.entries });
}

/** Validated contiguous staging prefix. An incomplete prefix is never an observation. */
export function readRemoteWorkerCellObjectInventoryPrefix(summaryHex: unknown, input: unknown,
  retained: RemoteWorkerCellProvisioningExchange) {
  return decodeInventoryPrefix(readRemoteWorkerCellCapacityObservation(summaryHex, retained), input);
}
function decodeInventoryPrefix<T extends RemoteWorkerCellCapacityHistoryObservation>(summary: T, input: unknown) {
  const total = summary.fileCount + summary.directoryCount, count = Math.ceil(total / 20);
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 || input.length > count ||
      Reflect.ownKeys(input).length !== input.length + 1 || count > 1000) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input), chunks: string[] = [];
  const entries: RemoteWorkerCellObjectInventoryEntry[] = [];
  const roots = new Set(summary.directoryIdentityHex);
  let logical = 0, allocated = 0, files = 0, directories = 0, previous = "";
  for (let batch = 0; batch < input.length; batch += 1) {
    const descriptor = descriptors[String(batch)];
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string" ||
        !/^[0-9a-f]{2000}$/u.test(descriptor.value)) throw refused();
    const hex = descriptor.value as string;
    const bytes = Uint8Array.from(hex.match(/../gu)!, (value) => Number.parseInt(value, 16));
    const view = new DataView(bytes.buffer), start = view.getUint32(32, true), size = view.getUint32(36, true);
    if (hex.slice(0, 64) !== summary.connectionNonceHex || start !== entries.length || size !== Math.min(20, total - start) ||
        size === 0 || /[^0]/u.test(hex.slice((40 + size * 48) * 2))) throw refused();
    for (let index = 0; index < size; index += 1) {
      const offset = 40 + index * 48, identityHex = hex.slice(offset * 2, (offset + 24) * 2);
      const fileIdentity = identityHex.slice(16), kind = view.getUint32(offset + 24, true);
      const logicalFileBytes = Number(view.getBigUint64(offset + 32, true)), allocatedBytes = Number(view.getBigUint64(offset + 40, true));
      if (kind > 1 || view.getUint32(offset + 28, true) !== 0 || identityHex.slice(0, 16) !== summary.rootIdentityHex.slice(0, 16) ||
          fileIdentity === "0".repeat(32) || fileIdentity <= previous || !Number.isSafeInteger(logicalFileBytes) ||
          !Number.isSafeInteger(allocatedBytes) || (kind === 1 && logicalFileBytes !== 0)) throw refused();
      logical += logicalFileBytes; allocated += allocatedBytes;
      if (!Number.isSafeInteger(logical) || !Number.isSafeInteger(allocated)) throw refused();
      if (kind === 1) { directories += 1; roots.delete(identityHex); } else files += 1;
      previous = fileIdentity;
      entries.push(Object.freeze({ identityHex, directory: kind === 1, logicalFileBytes, allocatedBytes }));
    }
    chunks.push(hex);
  }
  const complete = chunks.length === count;
  if (files > summary.fileCount || directories > summary.directoryCount || logical > summary.logicalFileBytes || allocated > summary.allocatedBytes ||
      (complete && (roots.size || entries.length !== total || files !== summary.fileCount || directories !== summary.directoryCount ||
       logical !== summary.logicalFileBytes || allocated !== summary.allocatedBytes))) throw refused();
  return Object.freeze({ summary, complete, chunkHex: Object.freeze(chunks), entries: Object.freeze(entries) });
}
