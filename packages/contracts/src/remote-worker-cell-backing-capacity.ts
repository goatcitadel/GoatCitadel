import {
  normalizeRemoteWorkerCellProvisioningExchange, readRemoteWorkerCellProvisioningCheckpoint,
  remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor, normalizeRemoteWorkerCellProvisioningHistory,
  type RemoteWorkerCellProvisioningHistory, type RemoteWorkerCellProvisioningExchange,
} from "./remote-worker-cell-provisioning.js";
import { readRemoteWorkerCellMountedWorkspaceCheckpoint } from "./remote-worker-cell-mounted-workspace.js";
import { REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, type RemoteWorkerCellCapacityRecord } from "./remote-worker-cell-capacity-observation.js";

export const REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-backing-capacity-exchange.v1" as const;
export type RemoteWorkerCellBackingCapacitySubmission = Readonly<{ kind: "cell.backing_capacity.snapshot" }> | Readonly<{
  kind: "cell.backing_capacity.observation";
  expectedRevision: number;
  observationHex: string;
  nativeReceiptHex: string;
}>;
/** Same receipt metadata shape as mounted observations, with a separate stream
 * and backing-frame validator. Lease revision/time belong to the original write. */
export type RemoteWorkerCellBackingCapacityRecord = RemoteWorkerCellCapacityRecord;
export interface RemoteWorkerCellBackingCapacityExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION;
  readonly history: RemoteWorkerCellProvisioningExchange;
  readonly record: RemoteWorkerCellBackingCapacityRecord | null;
}

/** Host VHDX and journal charges only. Other pool objects and metadata require
 * their own inventory. This observation grants no execution or quota authority. */
export interface RemoteWorkerCellBackingCapacityObservation extends RemoteWorkerCellBackingCapacityHistoryObservation {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
}
/** Validated host resource evidence without current assignment authority. */
export interface RemoteWorkerCellBackingCapacityHistoryObservation {
  readonly planSha256: string;
  readonly observationHex: string;
  readonly connectionNonceHex: string;
  readonly journalIdentityHex: string;
  readonly preparedRecordSha256: string;
  readonly assignmentBindingSha256: string;
  readonly profileSha256: string;
  readonly checkpointSha256: string;
  readonly hostParentIdentityHex: string;
  readonly hostDirectoryIdentityHex: readonly string[];
  readonly diskIdentifierHex: string;
  readonly virtualDiskBytes: number;
  readonly reservedDiskBytes: number;
  readonly controlIdentityHex: string;
  readonly backingIdentityHex: string;
  readonly backingFileBytes: number;
  readonly backingAllocatedBytes: number;
  readonly journalBytes: number;
  readonly journalAllocatedBytes: number;
  readonly hostFileAllocatedBytes: number;
}
const invalid = () => new TypeError("Native worker backing capacity does not match complete retained authority.");
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
  if (typeof input !== "string" || !/^[0-9a-f]{848}$/u.test(input)) throw invalid();
  return input;
}

/** Portable operation-15 decoder. The full history is independently retained;
 * a host observation can never substitute mounted-tree identities or totals. */
export function readRemoteWorkerCellBackingCapacityObservation(input: unknown, retained: RemoteWorkerCellProvisioningExchange): RemoteWorkerCellBackingCapacityObservation {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(retained);
  const { schemaVersion: _schema, registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, ...history } = exchange;
  return Object.freeze({ registryWorkspaceId, assignmentId, assignmentGeneration, leaseRevision, ...decodeHistoryObservation(input, history) });
}
export function readRemoteWorkerCellBackingCapacityHistoryObservation(input: unknown, retained: RemoteWorkerCellProvisioningHistory): RemoteWorkerCellBackingCapacityHistoryObservation {
  return decodeHistoryObservation(input, normalizeRemoteWorkerCellProvisioningHistory(retained));
}
function decodeHistoryObservation(input: unknown, exchange: RemoteWorkerCellProvisioningHistory): RemoteWorkerCellBackingCapacityHistoryObservation {
  if (typeof input !== "string" || !/^[0-9a-f]{848}$/u.test(input)) throw invalid();
  if (exchange.mountedWorkspaceRecords?.length !== 2) throw invalid();
  const prepared = readRemoteWorkerCellProvisioningCheckpoint(exchange.records[0]);
  const disk = readRemoteWorkerCellProvisioningCheckpoint(exchange.records[4]);
  const last = readRemoteWorkerCellMountedWorkspaceCheckpoint(remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor(exchange), exchange.mountedWorkspaceRecords[1]);
  const hex = (start: number, end: number) => input.slice(start * 2, end * 2);
  const bytes = Uint8Array.from(input.match(/../gu)!, (value) => Number.parseInt(value, 16));
  const view = new DataView(bytes.buffer);
  const integer = (offset: number) => {
    const value = Number(view.getBigUint64(offset, true));
    if (!Number.isSafeInteger(value)) throw invalid();
    return value;
  };
  const hostDirectoryIdentityHex = [208, 232, 256, 280].map((offset) => hex(offset, offset + 24));
  const virtualDiskBytes = integer(320), reservedDiskBytes = integer(328);
  const backingFileBytes = integer(384), backingAllocatedBytes = integer(392);
  const journalBytes = integer(400), journalAllocatedBytes = integer(408), hostFileAllocatedBytes = integer(416);
  const identities = [hex(184, 208), ...hostDirectoryIdentityHex, hex(32, 56), hex(360, 384)];
  if (hex(0, 32) === "0".repeat(64) || hex(32, 56) !== prepared.journalIdentityHex || hex(56, 88) !== prepared.recordSha256 ||
      hex(88, 120) !== exchange.plan.assignmentBindingSha256 || hex(120, 152) !== exchange.plan.profileSha256 ||
      hex(152, 184) !== last.recordSha256 || hex(184, 208) !== exchange.plan.parentIdentityHex ||
      hostDirectoryIdentityHex.some((identity, index) => identity !== disk.workspaceIdentityHex[index]) ||
      hex(304, 320) !== exchange.plan.diskIdentifierHex || virtualDiskBytes !== exchange.plan.virtualDiskBytes || reservedDiskBytes !== exchange.plan.reservedDiskBytes ||
      hex(336, 360) !== hostDirectoryIdentityHex[1] || hex(360, 384) !== disk.backingIdentityHex ||
      new Set(identities).size !== identities.length || identities.some((identity) => identity.slice(0, 16) !== exchange.plan.parentIdentityHex.slice(0, 16)) ||
      backingFileBytes < virtualDiskBytes || backingAllocatedBytes < backingFileBytes || backingAllocatedBytes > reservedDiskBytes ||
      journalBytes !== 21 * 1024 || journalAllocatedBytes < journalBytes || journalAllocatedBytes > 65536 ||
      hostFileAllocatedBytes !== backingAllocatedBytes + journalAllocatedBytes) throw invalid();
  return Object.freeze({ planSha256: exchange.planSha256,
    observationHex: input, connectionNonceHex: hex(0, 32), journalIdentityHex: prepared.journalIdentityHex,
    preparedRecordSha256: prepared.recordSha256, assignmentBindingSha256: exchange.plan.assignmentBindingSha256,
    profileSha256: exchange.plan.profileSha256, checkpointSha256: last.recordSha256, hostParentIdentityHex: exchange.plan.parentIdentityHex,
    hostDirectoryIdentityHex: Object.freeze(hostDirectoryIdentityHex), diskIdentifierHex: exchange.plan.diskIdentifierHex,
    virtualDiskBytes, reservedDiskBytes, controlIdentityHex: hex(336, 360), backingIdentityHex: hex(360, 384),
    backingFileBytes, backingAllocatedBytes, journalBytes, journalAllocatedBytes, hostFileAllocatedBytes });
}

export function normalizeRemoteWorkerCellBackingCapacitySubmission(input: unknown): RemoteWorkerCellBackingCapacitySubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind === "cell.backing_capacity.snapshot") { object(input, ["kind"]); return Object.freeze({ kind }); }
  if (kind !== "cell.backing_capacity.observation") throw invalid();
  const value = object(input, ["kind", "expectedRevision", "observationHex", "nativeReceiptHex"]);
  if (value.nativeReceiptHex !== REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT) throw invalid();
  return Object.freeze({ kind, expectedRevision: integer(value.expectedRevision, 0), observationHex: frame(value.observationHex),
    nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT });
}

export function normalizeRemoteWorkerCellBackingCapacityRecord(input: unknown, history: RemoteWorkerCellProvisioningExchange): RemoteWorkerCellBackingCapacityRecord {
  const value = object(input, ["revision", "leaseRevision", "recordedAt", "observationHex", "nativeReceiptHex"]);
  const leaseRevision = integer(value.leaseRevision, 1);
  if (leaseRevision > history.leaseRevision || value.nativeReceiptHex !== REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT ||
      typeof value.recordedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.recordedAt) ||
      !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) throw invalid();
  const observation = readRemoteWorkerCellBackingCapacityObservation(value.observationHex, history);
  return Object.freeze({ revision: integer(value.revision, 1), leaseRevision, recordedAt: value.recordedAt,
    observationHex: observation.observationHex, nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT });
}

export function normalizeRemoteWorkerCellBackingCapacityExchange(input: unknown): RemoteWorkerCellBackingCapacityExchange {
  const value = object(input, ["schemaVersion", "history", "record"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION) throw invalid();
  const history = normalizeRemoteWorkerCellProvisioningExchange(value.history);
  if (history.mountedWorkspaceRecords?.length !== 2) throw invalid();
  const record = value.record === null ? null : normalizeRemoteWorkerCellBackingCapacityRecord(value.record, history);
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION, history, record });
}
