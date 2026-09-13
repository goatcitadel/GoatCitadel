import { normalizeRemoteWorkerCellFormatAnchor, readRemoteWorkerCellFormatCheckpoint,
  assertRemoteWorkerCellFormatSuccessor, type RemoteWorkerCellFormatAnchor,
  type RemoteWorkerCellFormatCheckpoint } from "./remote-worker-cell-format.js";
import { normalizeRemoteWorkerCellSid } from "./remote-worker-cell-sid.js";
import { sha256BytesHex } from "./sha256.js";

export const REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-protection-anchor.v1" as const;
export const REMOTE_WORKER_CELL_PROTECTION_RECORD_BYTES = 1024;
export interface RemoteWorkerCellProtectionAnchor {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION;
  readonly formatAnchor: RemoteWorkerCellFormatAnchor;
  readonly formatRecords: readonly string[];
  readonly ownerSid: string;
  readonly controllerSid: string;
}
export interface RemoteWorkerCellRootProtectionCheckpoint {
  readonly sequence: number;
  readonly phase: "intent" | "protected_root";
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly formatSha256: string;
  readonly securitySha256: string;
  readonly rootIdentityHex: string;
}
export interface RemoteWorkerCellProtectionCheckpoint {
  readonly sequence: number;
  readonly phase: "intent" | "protected_root";
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly formatRecordedSha256: string;
  readonly anchor: RemoteWorkerCellProtectionAnchor;
  readonly rootCheckpoint: RemoteWorkerCellRootProtectionCheckpoint;
}
export type RemoteWorkerCellProtectionSubmission = Readonly<{
  kind: "cell.protection.checkpoint"; expectedSequence: number; recordHex: string;
}>;
const invalid = () => new TypeError("Native worker protection metadata is invalid.");
// Cache only this module's deeply frozen, verified anchors. The retained format
// is immutable metadata; native OS state and current authority are never cached.
const verifiedAnchors = new WeakMap<RemoteWorkerCellProtectionAnchor, RemoteWorkerCellFormatCheckpoint>();
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

/** Versioned policy/SID hash, not SDK descriptor serialization. Native execution
 * must still compare the exact descriptor and read back Windows permissions. */
export function remoteWorkerCellRootSecuritySha256(ownerInput: unknown, controllerInput: unknown): string {
  const owner = normalizeRemoteWorkerCellSid(ownerInput, false), controller = normalizeRemoteWorkerCellSid(controllerInput, true);
  const parts = [...new TextEncoder().encode("goatcitadel.native-cell-volume-root-security.v1\0")];
  for (const sid of [owner, controller]) parts.push(sid.length & 255, sid.length >> 8, ...new TextEncoder().encode(sid));
  return sha256BytesHex(Uint8Array.from(parts));
}

/** The complete canonical format pair and frozen controller identities are
 * required. This metadata conveys no permission to protect a physical volume. */
export function normalizeRemoteWorkerCellProtectionAnchor(input: unknown): RemoteWorkerCellProtectionAnchor {
  if (input && typeof input === "object" && verifiedAnchors.has(input as RemoteWorkerCellProtectionAnchor)) return input as RemoteWorkerCellProtectionAnchor;
  const value = object(input, ["schemaVersion", "formatAnchor", "formatRecords", "ownerSid", "controllerSid"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION || !Array.isArray(value.formatRecords) ||
      Object.getPrototypeOf(value.formatRecords) !== Array.prototype || value.formatRecords.length !== 2 ||
      Reflect.ownKeys(value.formatRecords).length !== 3) throw invalid();
  const formatAnchor = normalizeRemoteWorkerCellFormatAnchor(value.formatAnchor), formatRecords: string[] = [];
  let previous: RemoteWorkerCellFormatCheckpoint | undefined;
  for (let index = 0; index < 2; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.formatRecords, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    const checkpoint = readRemoteWorkerCellFormatCheckpoint(formatAnchor, descriptor.value);
    assertRemoteWorkerCellFormatSuccessor(formatAnchor, previous, checkpoint);
    formatRecords.push(checkpoint.recordHex); previous = checkpoint;
  }
  const anchor = Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
    formatAnchor, formatRecords: Object.freeze(formatRecords), ownerSid: normalizeRemoteWorkerCellSid(value.ownerSid, false),
    controllerSid: normalizeRemoteWorkerCellSid(value.controllerSid, true) });
  verifiedAnchors.set(anchor, previous!);
  return anchor;
}

function readRootCheckpoint(format: RemoteWorkerCellFormatCheckpoint, securitySha256: string,
  input: unknown): RemoteWorkerCellRootProtectionCheckpoint {
  const ntfs = format.ntfsCheckpoint, identity = ntfs.identity;
  if (ntfs.sequence !== 2 || !identity) throw invalid();
  const recordHex = hex(input, 512), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(480, 32);
  if (at(0, 8) !== "4743435052543031" || ![1, 2].includes(sequence) || view.getUint32(12, true) !== 0 ||
      (sequence === 1) !== /^0+$/u.test(previousRecordSha256) || at(48, 32) !== ntfs.recordSha256 ||
      at(80, 32) !== securitySha256 || at(112, 16) !== ntfs.volumeIdentifierHex ||
      view.getBigUint64(128, true) !== BigInt(ntfs.partitionBytes) || at(136, 8) !== identity.serialHex ||
      view.getBigUint64(144, true) !== BigInt(identity.sectors) || view.getBigUint64(152, true) !== BigInt(identity.clusters) ||
      at(160, 8) !== identity.serialHex || /^0+$/u.test(at(168, 16)) ||
      !bytes.subarray(184, 480).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 480)) !== recordSha256) throw invalid();
  return Object.freeze({ sequence, phase: sequence === 1 ? "intent" : "protected_root", recordHex, recordSha256,
    previousRecordSha256, formatSha256: ntfs.recordSha256, securitySha256, rootIdentityHex: at(160, 24) });
}

/** Bounded wire admission only; canonical history/identity checks are mandatory. */
export function normalizeRemoteWorkerCellProtectionSubmission(input: unknown): RemoteWorkerCellProtectionSubmission {
  const value = object(input, ["kind", "expectedSequence", "recordHex"]);
  const recordHex = hex(value.recordHex, REMOTE_WORKER_CELL_PROTECTION_RECORD_BYTES), bytes = fromHex(recordHex);
  const view = new DataView(bytes.buffer), sequence = view.getUint32(8, true);
  if (value.kind !== "cell.protection.checkpoint" || ![1, 2].includes(sequence) || value.expectedSequence !== sequence - 1 ||
      view.getUint32(12, true) !== sequence || recordHex.slice(0, 16) !== "4743435052563031" ||
      !bytes.subarray(792, 992).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 992)) !== recordHex.slice(1984)) throw invalid();
  return Object.freeze({ kind: "cell.protection.checkpoint", expectedSequence: sequence - 1, recordHex });
}

export function readRemoteWorkerCellProtectionCheckpoint(expectedAnchor: unknown, input: unknown): RemoteWorkerCellProtectionCheckpoint {
  const anchor = normalizeRemoteWorkerCellProtectionAnchor(expectedAnchor);
  const format = verifiedAnchors.get(anchor)!;
  const recordHex = hex(input, REMOTE_WORKER_CELL_PROTECTION_RECORD_BYTES), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(992, 32);
  if (at(0, 8) !== "4743435052563031" || ![1, 2].includes(sequence) || view.getUint32(12, true) !== sequence ||
      (sequence === 1 ? previousRecordSha256 !== format.recordSha256 : /^0+$/u.test(previousRecordSha256)) ||
      at(48, 168) !== format.recordHex.slice(96, 432) || at(216, 32) !== format.recordSha256 ||
      at(248, 32) !== format.recordHex.slice(496, 560) || !bytes.subarray(792, 992).every((byte) => byte === 0) ||
      sha256BytesHex(bytes.subarray(0, 992)) !== recordSha256) throw invalid();
  const rootCheckpoint = readRootCheckpoint(format, remoteWorkerCellRootSecuritySha256(anchor.ownerSid, anchor.controllerSid), at(280, 512));
  if (rootCheckpoint.sequence !== sequence) throw invalid();
  return Object.freeze({ sequence, phase: sequence === 1 ? "intent" : "protected_root", recordHex, recordSha256,
    previousRecordSha256, formatRecordedSha256: format.recordSha256, anchor, rootCheckpoint });
}

export function assertRemoteWorkerCellProtectionSuccessor(expectedAnchor: unknown,
  previous: RemoteWorkerCellProtectionCheckpoint | undefined, next: RemoteWorkerCellProtectionCheckpoint): void {
  const checked = readRemoteWorkerCellProtectionCheckpoint(expectedAnchor, next.recordHex);
  const prior = previous ? readRemoteWorkerCellProtectionCheckpoint(expectedAnchor, previous.recordHex) : undefined;
  if (checked.sequence !== (prior?.sequence ?? 0) + 1 || checked.previousRecordSha256 !== (prior?.recordSha256 ?? checked.formatRecordedSha256) ||
      checked.rootCheckpoint.previousRecordSha256 !== (prior?.rootCheckpoint.recordSha256 ?? "0".repeat(64)) ||
      (prior && checked.rootCheckpoint.rootIdentityHex !== prior.rootCheckpoint.rootIdentityHex)) throw invalid();
}
