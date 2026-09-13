import { normalizeRemoteWorkerCellVolumeAnchor, readRemoteWorkerCellVolumeCheckpoint,
  assertRemoteWorkerCellVolumeSuccessor, type RemoteWorkerCellVolumeAnchor,
  type RemoteWorkerCellVolumeCheckpoint } from "./remote-worker-cell-volume.js";
import { sha256BytesHex } from "./sha256.js";

export const REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-format-anchor.v1" as const;
export const REMOTE_WORKER_CELL_FORMAT_RECORD_BYTES = 1024;
export interface RemoteWorkerCellFormatAnchor {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION;
  readonly volumeAnchor: RemoteWorkerCellVolumeAnchor;
  readonly volumeRecords: readonly string[];
}
export interface RemoteWorkerCellNtfsCheckpoint {
  readonly sequence: number;
  readonly phase: "intent" | "formatted";
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly layoutSha256: string;
  readonly volumeIdentifierHex: string;
  readonly partitionBytes: number;
  /** The unsigned 64-bit serial is retained as native little-endian bytes. */
  readonly identity?: Readonly<{ serialHex: string; sectors: number; clusters: number }>;
}
export interface RemoteWorkerCellFormatCheckpoint {
  readonly sequence: number;
  readonly phase: "intent" | "formatted";
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly volumeRecordedSha256: string;
  readonly anchor: RemoteWorkerCellFormatAnchor;
  readonly ntfsCheckpoint: RemoteWorkerCellNtfsCheckpoint;
}
export type RemoteWorkerCellFormatSubmission = Readonly<{
  kind: "cell.format.checkpoint"; expectedSequence: number; recordHex: string;
}>;
const invalid = () => new TypeError("Native worker formatting metadata is invalid.");
// Only anchors fully validated and deeply frozen here reuse their volume chain.
// Copies, wire input and caller-frozen objects must still pass every check.
const verifiedAnchors = new WeakMap<RemoteWorkerCellFormatAnchor, RemoteWorkerCellVolumeCheckpoint>();
function object(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== names.length || names.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return input as Record<string, unknown>;
}
function hex(input: unknown, bytes: number): string {
  if (typeof input !== "string" || input.length !== bytes * 2 || !/^[0-9a-f]+$/u.test(input) || /^0+$/u.test(input)) throw invalid();
  return input;
}
function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu)!, (pair) => Number.parseInt(pair, 16));
}

/** Complete canonical volume history is the anchor, not a worker-supplied path
 * or a readiness flag. Metadata validation does not authorize an OS operation. */
export function normalizeRemoteWorkerCellFormatAnchor(input: unknown): RemoteWorkerCellFormatAnchor {
  if (input && typeof input === "object" && verifiedAnchors.has(input as RemoteWorkerCellFormatAnchor)) return input as RemoteWorkerCellFormatAnchor;
  const value = object(input, ["schemaVersion", "volumeAnchor", "volumeRecords"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION || !Array.isArray(value.volumeRecords) ||
      Object.getPrototypeOf(value.volumeRecords) !== Array.prototype || value.volumeRecords.length !== 6 ||
      Reflect.ownKeys(value.volumeRecords).length !== 7) throw invalid();
  const volumeAnchor = normalizeRemoteWorkerCellVolumeAnchor(value.volumeAnchor);
  const volumeRecords: string[] = [];
  let previous: RemoteWorkerCellVolumeCheckpoint | undefined;
  for (let index = 0; index < 6; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.volumeRecords, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    const checkpoint = readRemoteWorkerCellVolumeCheckpoint(volumeAnchor, descriptor.value);
    assertRemoteWorkerCellVolumeSuccessor(volumeAnchor, previous, checkpoint);
    volumeRecords.push(checkpoint.recordHex); previous = checkpoint;
  }
  const anchor = Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
    volumeAnchor, volumeRecords: Object.freeze(volumeRecords) });
  verifiedAnchors.set(anchor, previous!);
  return anchor;
}

/** Exact fixed GCCNTF01 bytes. Intent records no filesystem result; completion
 * retains a nonzero unsigned serial and geometry consistent with its partition. */
export function readRemoteWorkerCellNtfsCheckpoint(layoutSha256: string, partitionBytes: number, input: unknown): RemoteWorkerCellNtfsCheckpoint {
  hex(layoutSha256, 32);
  if (!Number.isSafeInteger(partitionBytes) || partitionBytes < 8 * 1024 ** 2 || partitionBytes > 1024 ** 4 || partitionBytes % 1024 ** 2) throw invalid();
  const recordHex = hex(input, 512), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(480, 32);
  const label = "GoatCitadel cell";
  if (at(0, 8) !== "4743434e54463031" || ![1, 2].includes(sequence) || view.getUint32(12, true) !== 0 ||
      (sequence === 1) !== /^0+$/u.test(previousRecordSha256) || at(48, 32) !== layoutSha256 ||
      view.getBigUint64(96, true) !== BigInt(partitionBytes) || view.getUint32(104, true) !== 512 || view.getUint32(108, true) !== 4096 ||
      Array.from(label).some((char, index) => view.getUint16(112 + index * 2, true) !== char.charCodeAt(0)) ||
      !bytes.subarray(112 + label.length * 2, 184).every((byte) => byte === 0) ||
      !bytes.subarray(208, 480).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 480)) !== recordSha256) throw invalid();
  const volumeIdentifierHex = hex(at(80, 16), 16);
  let identity: RemoteWorkerCellNtfsCheckpoint["identity"];
  if (sequence === 1) {
    if (!bytes.subarray(184, 208).every((byte) => byte === 0)) throw invalid();
  } else {
    const sectors = view.getBigUint64(192, true), clusters = view.getBigUint64(200, true), capacity = BigInt(partitionBytes) / 512n;
    if (sectors > capacity || sectors < capacity - 8n || clusters !== sectors / 8n) throw invalid();
    identity = Object.freeze({ serialHex: hex(at(184, 8), 8), sectors: Number(sectors), clusters: Number(clusters) });
  }
  return Object.freeze({ sequence, phase: sequence === 1 ? "intent" : "formatted", recordHex, recordSha256,
    previousRecordSha256, layoutSha256, volumeIdentifierHex, partitionBytes, ...(identity ? { identity } : {}) });
}

/** Bounded wire admission. Full identity/order validation belongs to the
 * canonical repository and cannot be replaced by this checksum check. */
export function normalizeRemoteWorkerCellFormatSubmission(input: unknown): RemoteWorkerCellFormatSubmission {
  const value = object(input, ["kind", "expectedSequence", "recordHex"]);
  const recordHex = hex(value.recordHex, REMOTE_WORKER_CELL_FORMAT_RECORD_BYTES), bytes = fromHex(recordHex);
  const view = new DataView(bytes.buffer), sequence = view.getUint32(8, true);
  if (value.kind !== "cell.format.checkpoint" || ![1, 2].includes(sequence) || value.expectedSequence !== sequence - 1 ||
      view.getUint32(12, true) !== sequence || recordHex.slice(0, 16) !== "474343464d543031" ||
      !bytes.subarray(792, 992).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 992)) !== recordHex.slice(1984)) throw invalid();
  return Object.freeze({ kind: "cell.format.checkpoint", expectedSequence: sequence - 1, recordHex });
}

export function readRemoteWorkerCellFormatCheckpoint(expectedAnchor: unknown, input: unknown): RemoteWorkerCellFormatCheckpoint {
  const anchor = normalizeRemoteWorkerCellFormatAnchor(expectedAnchor), plan = anchor.volumeAnchor.layoutPlan;
  const volume = verifiedAnchors.get(anchor)!;
  const layout = volume.layoutCheckpoint;
  if (!layout?.snapshot || layout.sequence !== 4) throw invalid();
  const recordHex = hex(input, REMOTE_WORKER_CELL_FORMAT_RECORD_BYTES), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(992, 32);
  if (at(0, 8) !== "474343464d543031" || ![1, 2].includes(sequence) || view.getUint32(12, true) !== sequence ||
      (sequence === 1 ? previousRecordSha256 !== volume.recordSha256 : /^0+$/u.test(previousRecordSha256)) ||
      at(48, 32) !== plan.assignmentBindingSha256 || at(80, 32) !== plan.profileSha256 || at(112, 16) !== plan.diskIdentifierHex ||
      view.getBigUint64(128, true) !== BigInt(plan.virtualDiskBytes) || view.getBigUint64(136, true) !== BigInt(plan.reservedDiskBytes) ||
      at(144, 24) !== anchor.volumeAnchor.journalIdentityHex || at(168, 24) !== plan.controlIdentityHex || at(192, 24) !== plan.backingIdentityHex ||
      at(216, 32) !== volume.recordSha256 || at(248, 16) !== plan.gptDiskIdentifierHex || at(264, 16) !== plan.dataPartitionIdentifierHex ||
      !bytes.subarray(792, 992).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 992)) !== recordSha256) throw invalid();
  const ntfsCheckpoint = readRemoteWorkerCellNtfsCheckpoint(layout.recordSha256, layout.snapshot.dataLength, at(280, 512));
  if (ntfsCheckpoint.sequence !== sequence) throw invalid();
  return Object.freeze({ sequence, phase: sequence === 1 ? "intent" : "formatted", recordHex, recordSha256,
    previousRecordSha256, volumeRecordedSha256: volume.recordSha256, anchor, ntfsCheckpoint });
}

export function assertRemoteWorkerCellFormatSuccessor(expectedAnchor: unknown,
  previous: RemoteWorkerCellFormatCheckpoint | undefined, next: RemoteWorkerCellFormatCheckpoint): void {
  const checked = readRemoteWorkerCellFormatCheckpoint(expectedAnchor, next.recordHex);
  const prior = previous ? readRemoteWorkerCellFormatCheckpoint(expectedAnchor, previous.recordHex) : undefined;
  if (checked.sequence !== (prior?.sequence ?? 0) + 1 || checked.previousRecordSha256 !== (prior?.recordSha256 ?? checked.volumeRecordedSha256) ||
      checked.ntfsCheckpoint.previousRecordSha256 !== (prior?.ntfsCheckpoint.recordSha256 ?? "0".repeat(64)) ||
      (prior && checked.ntfsCheckpoint.volumeIdentifierHex !== prior.ntfsCheckpoint.volumeIdentifierHex)) throw invalid();
}
