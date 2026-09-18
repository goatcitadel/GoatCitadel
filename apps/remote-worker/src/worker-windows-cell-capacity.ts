import {
  readRemoteWorkerCellCapacityObservation,
  readRemoteWorkerCellBackingCapacityObservation,
  readRemoteWorkerCellObjectInventory, type RemoteWorkerCellObjectInventoryObservation,
  type RemoteWorkerCellBackingCapacityObservation, type RemoteWorkerCellCapacityObservation, type RemoteWorkerCellProvisioningExchange,
} from "@goatcitadel/contracts";

/** Bound read-only counts. These fields assert neither workload quiescence,
 * enforced quotas, complete pool accounting nor execution readiness. */
export type WindowsWorkerCellCapacityObservation = RemoteWorkerCellCapacityObservation;
export type WindowsWorkerCellCapacityResult = Readonly<WindowsWorkerCellCapacityObservation & { nativeReceiptHex: string }>;
export type WindowsWorkerCellBackingCapacityObservation = RemoteWorkerCellBackingCapacityObservation;
export type WindowsWorkerCellBackingCapacityResult = Readonly<WindowsWorkerCellBackingCapacityObservation & { nativeReceiptHex: string }>;
export type WindowsWorkerCellObjectInventoryResult = Readonly<RemoteWorkerCellObjectInventoryObservation & { nativeReceiptHex: string }>;
const refused = () => new TypeError("Native worker capacity observation is incomplete or does not match retained authority.");

/** Decode against a separately retained complete exchange. The helper already
 * verified the connection nonce; this result remains provisional until its
 * successful terminal receipt, process exit and current-authority checks. */
export function decodeWindowsWorkerCellCapacity(bytes: Buffer, input: RemoteWorkerCellProvisioningExchange): WindowsWorkerCellCapacityObservation {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 352) throw refused();
  return readRemoteWorkerCellCapacityObservation(bytes.toString("hex"), input);
}

export function decodeWindowsWorkerCellBackingCapacity(bytes: Buffer, input: RemoteWorkerCellProvisioningExchange): WindowsWorkerCellBackingCapacityObservation {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 424) throw refused();
  return readRemoteWorkerCellBackingCapacityObservation(bytes.toString("hex"), input);
}

export function decodeWindowsWorkerCellObjectInventory(summary: Buffer, chunks: readonly Buffer[], input: RemoteWorkerCellProvisioningExchange): RemoteWorkerCellObjectInventoryObservation {
  if (!Buffer.isBuffer(summary) || summary.length !== 352 || !Array.isArray(chunks) || chunks.length > 1000 ||
      chunks.some(value => !Buffer.isBuffer(value) || value.length !== 1000)) throw refused();
  return readRemoteWorkerCellObjectInventory(summary.toString("hex"), chunks.map(value => value.toString("hex")), input);
}
