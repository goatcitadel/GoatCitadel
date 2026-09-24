import { hexToBytes as fromHex } from "@noble/hashes/utils";
import { normalizeRemoteWorkerCellProtectionAnchor, readRemoteWorkerCellProtectionCheckpoint,
  assertRemoteWorkerCellProtectionSuccessor, type RemoteWorkerCellProtectionAnchor,
  type RemoteWorkerCellProtectionCheckpoint } from "./remote-worker-cell-protection.js";
import { sha256BytesHex } from "./sha256.js";

export const REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-mount-anchor.v1" as const;
export const REMOTE_WORKER_CELL_MOUNT_RECORD_BYTES = 1024;
export const REMOTE_WORKER_CELL_MOUNT_PHASES = ["prepared", "directory_recorded", "mount_intent", "mounted"] as const;
export type RemoteWorkerCellMountPhase = (typeof REMOTE_WORKER_CELL_MOUNT_PHASES)[number];
export interface RemoteWorkerCellMountAnchor {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION;
  readonly protectionAnchor: RemoteWorkerCellProtectionAnchor;
  readonly protectionRecords: readonly string[];
  readonly parentIdentityHex: string;
  readonly workspaceIdentityHex: readonly string[];
}
export interface RemoteWorkerCellVolumeMountCheckpoint {
  readonly sequence: number;
  readonly phase: RemoteWorkerCellMountPhase;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly protectionSha256: string;
  readonly securitySha256: string;
  readonly parentIdentityHex: string;
  readonly rootIdentityHex: string;
  readonly directoryIdentityHex?: string;
}
export interface RemoteWorkerCellMountCheckpoint {
  readonly sequence: number;
  readonly phase: RemoteWorkerCellMountPhase;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly protectionRecordedSha256: string;
  readonly anchor: RemoteWorkerCellMountAnchor;
  readonly mountCheckpoint: RemoteWorkerCellVolumeMountCheckpoint;
}
export type RemoteWorkerCellMountSubmission = Readonly<{
  kind: "cell.mount.checkpoint"; expectedSequence: number; recordHex: string;
}>;
const invalid = () => new TypeError("Native worker mount metadata is invalid.");
// Only anchors deeply normalized and frozen in this module can reuse their
// verified protection chain. Caller-frozen objects never acquire this brand.
const verifiedAnchors = new WeakMap<RemoteWorkerCellMountAnchor, RemoteWorkerCellProtectionCheckpoint>();
function object(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== names.length || names.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return input as Record<string, unknown>;
}
function array(input: unknown, length: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length !== length ||
      Reflect.ownKeys(input).length !== length + 1) throw invalid();
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    return descriptor.value as unknown;
  });
}
function hex(input: unknown, bytes: number): string {
  if (typeof input !== "string" || input.length !== bytes * 2 || !/^[0-9a-f]+$/u.test(input) || /^0+$/u.test(input)) throw invalid();
  return input;
}
function identity(input: unknown): string {
  const value = hex(input, 24);
  if (/^0+$/u.test(value.slice(0, 16)) || /^0+$/u.test(value.slice(16))) throw invalid();
  return value;
}

/** Independently retained creation identities and complete protection history
 * bind the mount. Metadata does not authorize a Windows mount operation. */
export function normalizeRemoteWorkerCellMountAnchor(input: unknown): RemoteWorkerCellMountAnchor {
  if (input && typeof input === "object" && verifiedAnchors.has(input as RemoteWorkerCellMountAnchor)) return input as RemoteWorkerCellMountAnchor;
  const value = object(input, ["schemaVersion", "protectionAnchor", "protectionRecords", "parentIdentityHex", "workspaceIdentityHex"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION) throw invalid();
  const protectionAnchor = normalizeRemoteWorkerCellProtectionAnchor(value.protectionAnchor), protectionRecords: string[] = [];
  let previous: RemoteWorkerCellProtectionCheckpoint | undefined;
  for (const record of array(value.protectionRecords, 2)) {
    const checkpoint = readRemoteWorkerCellProtectionCheckpoint(protectionAnchor, record);
    assertRemoteWorkerCellProtectionSuccessor(protectionAnchor, previous, checkpoint);
    protectionRecords.push(checkpoint.recordHex); previous = checkpoint;
  }
  const parentIdentityHex = identity(value.parentIdentityHex), workspaceIdentityHex = array(value.workspaceIdentityHex, 4).map(identity);
  const volume = protectionAnchor.formatAnchor.volumeAnchor;
  const identities = [parentIdentityHex, volume.journalIdentityHex, ...workspaceIdentityHex, volume.layoutPlan.backingIdentityHex];
  if (new Set(identities).size !== identities.length || workspaceIdentityHex[1] !== volume.layoutPlan.controlIdentityHex ||
      identities.some((item) => item.slice(0, 16) !== parentIdentityHex.slice(0, 16)) ||
      previous!.rootCheckpoint.rootIdentityHex.slice(0, 16) === parentIdentityHex.slice(0, 16)) throw invalid();
  const anchor = Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION, protectionAnchor,
    protectionRecords: Object.freeze(protectionRecords), parentIdentityHex, workspaceIdentityHex: Object.freeze(workspaceIdentityHex) });
  verifiedAnchors.set(anchor, previous!);
  return anchor;
}

function readMountCheckpoint(anchor: RemoteWorkerCellMountAnchor, protection: RemoteWorkerCellProtectionCheckpoint,
  input: unknown): RemoteWorkerCellVolumeMountCheckpoint {
  const root = protection.rootCheckpoint;
  const recordHex = hex(input, 512), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(480, 32);
  if (at(0, 8) !== "4743434d4e543031" || sequence < 1 || sequence > 4 || view.getUint32(12, true) !== 0 ||
      (sequence === 1) !== /^0+$/u.test(previousRecordSha256) || at(48, 32) !== root.recordSha256 ||
      at(80, 32) !== root.securitySha256 || at(112, 16) !== root.recordHex.slice(224, 256) ||
      at(128, 24) !== anchor.workspaceIdentityHex[0] || at(152, 24) !== root.rootIdentityHex ||
      !bytes.subarray(200, 480).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 480)) !== recordSha256) throw invalid();
  const directoryIdentityHex = sequence === 1 ? undefined : identity(at(176, 24));
  const volume = anchor.protectionAnchor.formatAnchor.volumeAnchor;
  if (sequence === 1 ? !bytes.subarray(176, 200).every((byte) => byte === 0) :
    directoryIdentityHex!.slice(0, 16) !== anchor.parentIdentityHex.slice(0, 16) ||
      [anchor.parentIdentityHex, ...anchor.workspaceIdentityHex, volume.journalIdentityHex, volume.layoutPlan.backingIdentityHex]
        .includes(directoryIdentityHex!)) throw invalid();
  return Object.freeze({ sequence, phase: REMOTE_WORKER_CELL_MOUNT_PHASES[sequence - 1]!, recordHex, recordSha256,
    previousRecordSha256, protectionSha256: root.recordSha256, securitySha256: root.securitySha256,
    parentIdentityHex: at(128, 24), rootIdentityHex: root.rootIdentityHex,
    ...(directoryIdentityHex ? { directoryIdentityHex } : {}) });
}

/** Bounded wire admission only; canonical history and identity checks follow. */
export function normalizeRemoteWorkerCellMountSubmission(input: unknown): RemoteWorkerCellMountSubmission {
  const value = object(input, ["kind", "expectedSequence", "recordHex"]);
  const recordHex = hex(value.recordHex, REMOTE_WORKER_CELL_MOUNT_RECORD_BYTES), bytes = fromHex(recordHex);
  const view = new DataView(bytes.buffer), sequence = view.getUint32(8, true);
  if (value.kind !== "cell.mount.checkpoint" || sequence < 1 || sequence > 4 || value.expectedSequence !== sequence - 1 ||
      view.getUint32(12, true) !== sequence || recordHex.slice(0, 16) !== "4743434d4e563031" ||
      !bytes.subarray(792, 992).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 992)) !== recordHex.slice(1984)) throw invalid();
  return Object.freeze({ kind: "cell.mount.checkpoint", expectedSequence: sequence - 1, recordHex });
}

export function readRemoteWorkerCellMountCheckpoint(expectedAnchor: unknown, input: unknown): RemoteWorkerCellMountCheckpoint {
  const anchor = normalizeRemoteWorkerCellMountAnchor(expectedAnchor);
  const protection = verifiedAnchors.get(anchor)!;
  const recordHex = hex(input, REMOTE_WORKER_CELL_MOUNT_RECORD_BYTES), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(992, 32);
  if (at(0, 8) !== "4743434d4e563031" || sequence < 1 || sequence > 4 || view.getUint32(12, true) !== sequence ||
      (sequence === 1 ? previousRecordSha256 !== protection.recordSha256 : /^0+$/u.test(previousRecordSha256)) ||
      at(48, 168) !== protection.recordHex.slice(96, 432) || at(216, 32) !== protection.recordSha256 ||
      at(248, 32) !== protection.recordHex.slice(496, 560) || !bytes.subarray(792, 992).every((byte) => byte === 0) ||
      sha256BytesHex(bytes.subarray(0, 992)) !== recordSha256) throw invalid();
  const mountCheckpoint = readMountCheckpoint(anchor, protection, at(280, 512));
  if (mountCheckpoint.sequence !== sequence) throw invalid();
  return Object.freeze({ sequence, phase: REMOTE_WORKER_CELL_MOUNT_PHASES[sequence - 1]!, recordHex, recordSha256,
    previousRecordSha256, protectionRecordedSha256: protection.recordSha256, anchor, mountCheckpoint });
}

export function assertRemoteWorkerCellMountSuccessor(expectedAnchor: unknown,
  previous: RemoteWorkerCellMountCheckpoint | undefined, next: RemoteWorkerCellMountCheckpoint): void {
  const checked = readRemoteWorkerCellMountCheckpoint(expectedAnchor, next.recordHex);
  const prior = previous ? readRemoteWorkerCellMountCheckpoint(expectedAnchor, previous.recordHex) : undefined;
  if (checked.sequence !== (prior?.sequence ?? 0) + 1 || checked.previousRecordSha256 !== (prior?.recordSha256 ?? checked.protectionRecordedSha256) ||
      checked.mountCheckpoint.previousRecordSha256 !== (prior?.mountCheckpoint.recordSha256 ?? "0".repeat(64)) ||
      (prior?.mountCheckpoint.directoryIdentityHex && checked.mountCheckpoint.directoryIdentityHex !== prior.mountCheckpoint.directoryIdentityHex)) throw invalid();
}
