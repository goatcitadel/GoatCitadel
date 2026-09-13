import { normalizeRemoteWorkerCellDiskLayoutPlan, readRemoteWorkerCellDiskLayoutCheckpoint,
  assertRemoteWorkerCellDiskLayoutSuccessor, type RemoteWorkerCellDiskLayoutPlan,
  type RemoteWorkerCellDiskLayoutCheckpoint } from "./remote-worker-cell-disk-layout.js";
import { sha256BytesHex } from "./sha256.js";

export const REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-volume-anchor.v1" as const;
export const REMOTE_WORKER_CELL_VOLUME_RECORD_BYTES = 1024;
export const REMOTE_WORKER_CELL_VOLUME_PHASES = [
  "attachment_intent", "attached", "initialize_intent", "initialized", "partition_intent", "partitioned",
] as const;

/** The canonical owner supplies this from its independently retained complete
 * provisioning chain. A worker observation or a valid hash does not grant volume
 * mutation, workload, cleanup or recovery authority. */
export interface RemoteWorkerCellVolumeAnchor {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION;
  readonly diskRecordedSha256: string;
  readonly journalIdentityHex: string;
  readonly layoutPlan: RemoteWorkerCellDiskLayoutPlan;
}
export interface RemoteWorkerCellVolumeCheckpoint {
  readonly sequence: number;
  readonly phase: (typeof REMOTE_WORKER_CELL_VOLUME_PHASES)[number];
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly anchor: RemoteWorkerCellVolumeAnchor;
  readonly layoutCheckpoint?: RemoteWorkerCellDiskLayoutCheckpoint;
}
export type RemoteWorkerCellVolumeSubmission = Readonly<{
  kind: "cell.volume.checkpoint"; expectedSequence: number; recordHex: string;
}>;
const invalid = () => new TypeError("Native worker volume checkpoint metadata is invalid.");
function hex(input: unknown, count: number): string {
  if (typeof input !== "string" || input.length !== count * 2 || !/^[0-9a-f]+$/u.test(input) || /^0+$/u.test(input)) throw invalid();
  return input;
}
/** Only checks the bounded wire envelope and integrity here. The canonical
 * repository must bind the complete record to its independently retained anchor. */
export function normalizeRemoteWorkerCellVolumeSubmission(input: unknown): RemoteWorkerCellVolumeSubmission {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = ["kind", "expectedSequence", "recordHex"];
  if (Reflect.ownKeys(input).length !== keys.length || keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  const value = input as Record<string, unknown>;
  const recordHex = hex(value.recordHex, REMOTE_WORKER_CELL_VOLUME_RECORD_BYTES);
  const bytes = Uint8Array.from(recordHex.match(/../gu)!, (pair) => Number.parseInt(pair, 16));
  const view = new DataView(bytes.buffer), sequence = view.getUint32(8, true);
  if (value.kind !== "cell.volume.checkpoint" || sequence < 1 || sequence > 6 || view.getUint32(12, true) !== sequence ||
      recordHex.slice(0, 16) !== "474343564f4c3031" || value.expectedSequence !== sequence - 1 ||
      sha256BytesHex(bytes.subarray(0, 992)) !== recordHex.slice(1984) || !bytes.subarray(792, 992).every((byte) => byte === 0)) throw invalid();
  return Object.freeze({ kind: "cell.volume.checkpoint", expectedSequence: sequence - 1, recordHex });
}
export function normalizeRemoteWorkerCellVolumeAnchor(input: unknown): RemoteWorkerCellVolumeAnchor {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = ["schemaVersion", "diskRecordedSha256", "journalIdentityHex", "layoutPlan"];
  if (Reflect.ownKeys(input).length !== keys.length || keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION) throw invalid();
  const layoutPlan = normalizeRemoteWorkerCellDiskLayoutPlan(value.layoutPlan);
  const journalIdentityHex = hex(value.journalIdentityHex, 24);
  if (/^0+$/u.test(journalIdentityHex.slice(16)) || journalIdentityHex.slice(0, 16) !== layoutPlan.controlIdentityHex.slice(0, 16) ||
      [layoutPlan.controlIdentityHex, layoutPlan.backingIdentityHex].includes(journalIdentityHex)) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
    diskRecordedSha256: hex(value.diskRecordedSha256, 32), journalIdentityHex, layoutPlan });
}

/** Exact GCCVOL01 metadata verification. Attachment facts still require current
 * native verification; completed bytes alone cannot establish OS readiness. */
export function readRemoteWorkerCellVolumeCheckpoint(expectedAnchor: unknown, input: unknown): RemoteWorkerCellVolumeCheckpoint {
  const anchor = normalizeRemoteWorkerCellVolumeAnchor(expectedAnchor), plan = anchor.layoutPlan;
  const recordHex = hex(input, REMOTE_WORKER_CELL_VOLUME_RECORD_BYTES);
  const bytes = Uint8Array.from(recordHex.match(/../gu)!, (pair) => Number.parseInt(pair, 16));
  const view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(992, 32);
  if (at(0, 8) !== "474343564f4c3031" || sequence < 1 || sequence > 6 || view.getUint32(12, true) !== sequence ||
      (sequence === 1 ? previousRecordSha256 !== anchor.diskRecordedSha256 : /^0+$/u.test(previousRecordSha256)) ||
      sha256BytesHex(bytes.subarray(0, 992)) !== recordSha256 ||
      at(48, 32) !== plan.assignmentBindingSha256 || at(80, 32) !== plan.profileSha256 || at(112, 16) !== plan.diskIdentifierHex ||
      view.getBigUint64(128, true) !== BigInt(plan.virtualDiskBytes) || view.getBigUint64(136, true) !== BigInt(plan.reservedDiskBytes) ||
      at(144, 24) !== anchor.journalIdentityHex || at(168, 24) !== plan.controlIdentityHex || at(192, 24) !== plan.backingIdentityHex ||
      at(216, 32) !== anchor.diskRecordedSha256 || at(248, 16) !== plan.gptDiskIdentifierHex || at(264, 16) !== plan.dataPartitionIdentifierHex ||
      !bytes.subarray(792, 992).every((byte) => byte === 0)) throw invalid();
  let layoutCheckpoint: RemoteWorkerCellDiskLayoutCheckpoint | undefined;
  if (sequence <= 2) {
    if (!bytes.subarray(280, 792).every((byte) => byte === 0)) throw invalid();
  } else {
    layoutCheckpoint = readRemoteWorkerCellDiskLayoutCheckpoint(plan, at(280, 512));
    if (layoutCheckpoint.sequence !== sequence - 2) throw invalid();
  }
  return Object.freeze({ sequence, phase: REMOTE_WORKER_CELL_VOLUME_PHASES[sequence - 1]!, recordHex,
    recordSha256, previousRecordSha256, anchor, ...(layoutCheckpoint ? { layoutCheckpoint } : {}) });
}

export function assertRemoteWorkerCellVolumeSuccessor(expectedAnchor: unknown,
  previous: RemoteWorkerCellVolumeCheckpoint | undefined, next: RemoteWorkerCellVolumeCheckpoint): void {
  const checked = readRemoteWorkerCellVolumeCheckpoint(expectedAnchor, next.recordHex);
  const prior = previous ? readRemoteWorkerCellVolumeCheckpoint(expectedAnchor, previous.recordHex) : undefined;
  if (checked.sequence !== (prior?.sequence ?? 0) + 1 ||
      checked.previousRecordSha256 !== (prior?.recordSha256 ?? checked.anchor.diskRecordedSha256)) throw invalid();
  if (checked.layoutCheckpoint) assertRemoteWorkerCellDiskLayoutSuccessor(checked.anchor.layoutPlan, prior?.layoutCheckpoint, checked.layoutCheckpoint);
}
