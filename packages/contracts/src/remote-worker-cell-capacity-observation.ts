import { hexToBytes } from "@noble/hashes/utils";
import {
  normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerCellProvisioningCheckpoint,
  remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor, normalizeRemoteWorkerCellProvisioningHistory,
  type RemoteWorkerCellProvisioningHistory, type RemoteWorkerCellProvisioningExchange,
} from "./remote-worker-cell-provisioning.js";
import { readRemoteWorkerCellMountedWorkspaceCheckpoint } from "./remote-worker-cell-mounted-workspace.js";

export const REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-capacity-exchange.v1" as const;
/** Native success, disk_recorded phase, zero detail, all twenty-one records. */
export const REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT = "00000000050000000000000015000000";

/** Partial mounted-tree inventory, never complete pool accounting, enforced
 * quotas, workload quiescence, or authorization to execute. */
export interface RemoteWorkerCellCapacityObservation extends RemoteWorkerCellCapacityHistoryObservation {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
}
/** Validated resource evidence only; it carries no current assignment lease. */
export interface RemoteWorkerCellCapacityHistoryObservation {
  readonly planSha256: string;
  readonly observationHex: string;
  readonly connectionNonceHex: string;
  readonly journalIdentityHex: string;
  readonly preparedRecordSha256: string;
  readonly assignmentBindingSha256: string;
  readonly profileSha256: string;
  readonly checkpointSha256: string;
  readonly volumeRootIdentityHex: string;
  readonly directoryIdentityHex: readonly string[];
  readonly rootIdentityHex: string;
  readonly logicalFileBytes: number;
  readonly allocatedBytes: number;
  readonly fileCount: number;
  readonly directoryCount: number;
}

export type RemoteWorkerCellCapacitySubmission = Readonly<{ kind: "cell.capacity.snapshot" }> | Readonly<{
  kind: "cell.capacity.observation";
  expectedRevision: number;
  observationHex: string;
  nativeReceiptHex: string;
}>;
export interface RemoteWorkerCellCapacityRecord {
  readonly revision: number;
  /** Lease current at the original database commit, preserved on replay. */
  readonly leaseRevision: number;
  readonly recordedAt: string;
  readonly observationHex: string;
  readonly nativeReceiptHex: string;
}
export interface RemoteWorkerCellCapacityExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION;
  /** Independently retained complete native history under the current lease. */
  readonly history: RemoteWorkerCellProvisioningExchange;
  /** Snapshot returns the latest row; submission replay acknowledges its exact
   * original row, even when a newer observation has since committed. */
  readonly record: RemoteWorkerCellCapacityRecord | null;
}
const invalid = () => new TypeError("Native worker capacity observation is incomplete or does not match retained authority.");
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return input as Record<string, unknown>;
}
function integer(input: unknown, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > 2147483647) throw invalid();
  return input;
}
function frame(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{704}$/u.test(input)) throw invalid();
  return input;
}

/** Portable decoder shared by worker and Gateway. Never trust caller-provided
 * totals or an isolated checkpoint instead of the independently retained chain. */
export function readRemoteWorkerCellCapacityObservation(input: unknown, retained: RemoteWorkerCellProvisioningExchange): RemoteWorkerCellCapacityObservation {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(retained);
  const { schemaVersion: _schema, registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, ...history } = exchange;
  return Object.freeze({ registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, ...decodeHistoryObservation(input, history) });
}
export function readRemoteWorkerCellCapacityHistoryObservation(input: unknown, retained: RemoteWorkerCellProvisioningHistory): RemoteWorkerCellCapacityHistoryObservation {
  return decodeHistoryObservation(input, normalizeRemoteWorkerCellProvisioningHistory(retained));
}
function decodeHistoryObservation(input: unknown, exchange: RemoteWorkerCellProvisioningHistory): RemoteWorkerCellCapacityHistoryObservation {
  const observationHex = frame(input);
  if (exchange.mountedWorkspaceRecords?.length !== 2) throw invalid();
  const prepared = readRemoteWorkerCellProvisioningCheckpoint(exchange.records[0]);
  const recorded = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor(exchange), exchange.mountedWorkspaceRecords[1]);
  const hex = (start: number, end: number) => observationHex.slice(start * 2, end * 2);
  const bytes = hexToBytes(observationHex);
  const view = new DataView(bytes.buffer);
  const directoryIdentityHex = [208, 232, 256, 280].map((offset) => hex(offset, offset + 24));
  const logicalFileBytes = Number(view.getBigUint64(328, true)), allocatedBytes = Number(view.getBigUint64(336, true));
  const fileCount = view.getUint32(344, true), directoryCount = view.getUint32(348, true);
  if (hex(0, 32) === "0".repeat(64) || hex(32, 56) !== prepared.journalIdentityHex || hex(56, 88) !== prepared.recordSha256 ||
      hex(88, 120) !== exchange.plan.assignmentBindingSha256 || hex(120, 152) !== exchange.plan.profileSha256 ||
      hex(152, 184) !== recorded.recordSha256 || hex(184, 208) !== recorded.workspaceCheckpoint.rootIdentityHex ||
      directoryIdentityHex.some((value, index) => value !== recorded.workspaceCheckpoint.directoryIdentityHex[index]) ||
      hex(304, 328) !== directoryIdentityHex[0] || !Number.isSafeInteger(logicalFileBytes) || !Number.isSafeInteger(allocatedBytes) ||
      directoryCount < 4 || directoryCount > 20000 || fileCount > 20000 - directoryCount || (!fileCount && logicalFileBytes)) throw invalid();
  return Object.freeze({ planSha256: exchange.planSha256,
    observationHex, connectionNonceHex: hex(0, 32), journalIdentityHex: prepared.journalIdentityHex, preparedRecordSha256: prepared.recordSha256,
    assignmentBindingSha256: exchange.plan.assignmentBindingSha256, profileSha256: exchange.plan.profileSha256,
    checkpointSha256: recorded.recordSha256, volumeRootIdentityHex: recorded.workspaceCheckpoint.rootIdentityHex,
    directoryIdentityHex: Object.freeze(directoryIdentityHex), rootIdentityHex: directoryIdentityHex[0]!,
    logicalFileBytes, allocatedBytes, fileCount, directoryCount });
}

export function normalizeRemoteWorkerCellCapacitySubmission(input: unknown): RemoteWorkerCellCapacitySubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind === "cell.capacity.snapshot") { object(input, ["kind"]); return Object.freeze({ kind }); }
  if (kind !== "cell.capacity.observation") throw invalid();
  const value = object(input, ["kind", "expectedRevision", "observationHex", "nativeReceiptHex"]);
  if (value.nativeReceiptHex !== REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT) throw invalid();
  return Object.freeze({ kind, expectedRevision: integer(value.expectedRevision, 0), observationHex: frame(value.observationHex),
    nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT });
}

export function normalizeRemoteWorkerCellCapacityRecord(input: unknown, history: RemoteWorkerCellProvisioningExchange): RemoteWorkerCellCapacityRecord {
  const value = object(input, ["revision", "leaseRevision", "recordedAt", "observationHex", "nativeReceiptHex"]);
  const leaseRevision = integer(value.leaseRevision, 1);
  if (leaseRevision > history.leaseRevision || value.nativeReceiptHex !== REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT ||
      typeof value.recordedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.recordedAt) ||
      !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) throw invalid();
  const observation = readRemoteWorkerCellCapacityObservation(value.observationHex, history);
  return Object.freeze({ revision: integer(value.revision, 1), leaseRevision, recordedAt: value.recordedAt,
    observationHex: observation.observationHex, nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT });
}

export function normalizeRemoteWorkerCellCapacityExchange(input: unknown): RemoteWorkerCellCapacityExchange {
  const value = object(input, ["schemaVersion", "history", "record"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION) throw invalid();
  const history = normalizeRemoteWorkerCellProvisioningExchange(value.history);
  if (history.mountedWorkspaceRecords?.length !== 2) throw invalid();
  const record = value.record === null ? null : normalizeRemoteWorkerCellCapacityRecord(value.record, history);
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history, record });
}
