import { normalizeRemoteWorkerCellObjectInventorySubmission } from "./remote-worker-cell-object-inventory.js";
import { normalizeRemoteWorkerCellProvisioningExchange, type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { normalizeRemoteWorkerCellCapacityRecord, readRemoteWorkerCellCapacityObservation, type RemoteWorkerCellCapacityRecord } from "./remote-worker-cell-capacity-observation.js";

export const REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_CHUNKS = 64;
export const REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-object-inventory-page.v1" as const;
export type RemoteWorkerCellObjectInventoryPage = Readonly<{
  kind: "cell.object_inventory.page"; expectedRevision: number; observationHex: string;
  nativeReceiptHex: string; startChunk: number; chunkHex: readonly string[];
}>;
export type RemoteWorkerCellObjectInventoryPageSubmission = RemoteWorkerCellObjectInventoryPage | Readonly<{ kind: "cell.object_inventory.page_snapshot" }>;
export interface RemoteWorkerCellObjectInventoryPageExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION;
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly record: RemoteWorkerCellCapacityRecord | null;
  readonly accepted: Readonly<{ page: RemoteWorkerCellObjectInventoryPage; nextChunk: number; committedRevision: number | null }> | null;
}
const refused = () => new TypeError("Worker inventory page is invalid or does not bind its capture.");
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw refused();
  return input as Record<string, unknown>;
}
export function normalizeRemoteWorkerCellObjectInventoryPageSubmission(input: unknown): RemoteWorkerCellObjectInventoryPageSubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind === "cell.object_inventory.page_snapshot") { fields(input, ["kind"]); return Object.freeze({ kind }); }
  if (kind !== "cell.object_inventory.page") throw refused();
  const value = fields(input, ["kind", "expectedRevision", "observationHex", "nativeReceiptHex", "startChunk", "chunkHex"]);
  if (!Number.isSafeInteger(value.startChunk) || Number(value.startChunk) < 0 || Number(value.startChunk) >= 1000 || Number(value.startChunk) % 64 !== 0) throw refused();
  const normalized = normalizeRemoteWorkerCellObjectInventorySubmission({ kind: "cell.object_inventory.observation",
    expectedRevision: value.expectedRevision, observationHex: value.observationHex, nativeReceiptHex: value.nativeReceiptHex, chunkHex: value.chunkHex });
  if (!("chunkHex" in normalized) || normalized.chunkHex.length > 64 || Number(value.startChunk) + normalized.chunkHex.length > 1000) throw refused();
  return Object.freeze({ ...normalized, kind, startChunk: Number(value.startChunk) });
}
export function normalizeRemoteWorkerCellObjectInventoryPageExchange(input: unknown): RemoteWorkerCellObjectInventoryPageExchange {
  const value = fields(input, ["schemaVersion", "history", "record", "accepted"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION) throw refused();
  const history = normalizeRemoteWorkerCellProvisioningExchange(value.history);
  if (history.mountedWorkspaceRecords?.length !== 2) throw refused();
  const record = value.record === null ? null : normalizeRemoteWorkerCellCapacityRecord(value.record, history);
  let accepted: RemoteWorkerCellObjectInventoryPageExchange["accepted"] = null;
  if (value.accepted !== null) {
    const receipt = fields(value.accepted, ["page", "nextChunk", "committedRevision"]);
    const page = normalizeRemoteWorkerCellObjectInventoryPageSubmission(receipt.page);
    if (page.kind !== "cell.object_inventory.page") throw refused();
    const summary = readRemoteWorkerCellCapacityObservation(page.observationHex, history);
    const total = Math.ceil((summary.fileCount + summary.directoryCount) / 20), nextChunk = Number(receipt.nextChunk);
    if (total > 1000 || page.chunkHex.length !== Math.min(64, total - page.startChunk) || !Number.isSafeInteger(receipt.nextChunk) ||
        nextChunk < page.startChunk + page.chunkHex.length || nextChunk > total || (nextChunk !== total && nextChunk % 64 !== 0)) throw refused();
    if (receipt.committedRevision === null) {
      if (nextChunk === total || (record?.revision ?? 0) !== page.expectedRevision) throw refused();
    } else if (receipt.committedRevision !== page.expectedRevision + 1 || nextChunk !== total ||
        record?.revision !== receipt.committedRevision || record.observationHex !== page.observationHex || record.nativeReceiptHex !== page.nativeReceiptHex) throw refused();
    accepted = Object.freeze({ page, nextChunk, committedRevision: receipt.committedRevision as number | null });
  }
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION, history, record, accepted });
}
