import { hexToBytes as fromHex } from "@noble/hashes/utils";
import { normalizeRemoteWorkerCellMountAnchor, readRemoteWorkerCellMountCheckpoint,
  assertRemoteWorkerCellMountSuccessor, type RemoteWorkerCellMountAnchor,
  type RemoteWorkerCellMountCheckpoint } from "./remote-worker-cell-mount.js";
import { sha256BytesHex } from "./sha256.js";

export const REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-mounted-workspace-anchor.v1" as const;
export const REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_RECORD_BYTES = 1024;
export const REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_PHASES = ["intent", "recorded"] as const;
export type RemoteWorkerCellMountedWorkspacePhase = (typeof REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_PHASES)[number];
export interface RemoteWorkerCellMountedWorkspaceAnchor {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION;
  readonly mountAnchor: RemoteWorkerCellMountAnchor;
  readonly mountRecords: readonly string[];
  readonly cellName: string;
}
export interface RemoteWorkerCellWorkspaceCheckpoint {
  readonly sequence: number;
  readonly phase: RemoteWorkerCellMountedWorkspacePhase;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly mountSha256: string;
  readonly securitySha256: string;
  readonly rootIdentityHex: string;
  readonly directoryIdentityHex: readonly string[];
}
export interface RemoteWorkerCellMountedWorkspaceCheckpoint {
  readonly sequence: number;
  readonly phase: RemoteWorkerCellMountedWorkspacePhase;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly mountRecordedSha256: string;
  readonly anchor: RemoteWorkerCellMountedWorkspaceAnchor;
  readonly workspaceCheckpoint: RemoteWorkerCellWorkspaceCheckpoint;
}
export type RemoteWorkerCellMountedWorkspaceSubmission = Readonly<{
  kind: "cell.mounted-workspace.checkpoint"; expectedSequence: number; recordHex: string;
}>;
const invalid = () => new TypeError("Native worker mounted workspace metadata is invalid.");
// Reuse only complete chains normalized here, never caller-frozen objects.
const verifiedAnchors = new WeakMap<RemoteWorkerCellMountedWorkspaceAnchor, RemoteWorkerCellMountCheckpoint>();
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

/** Complete mount evidence binds the execution roots. It grants no filesystem
 * authority and cannot replace native readback or the original creation grant. */
export function normalizeRemoteWorkerCellMountedWorkspaceAnchor(input: unknown): RemoteWorkerCellMountedWorkspaceAnchor {
  if (input && typeof input === "object" && verifiedAnchors.has(input as RemoteWorkerCellMountedWorkspaceAnchor)) return input as RemoteWorkerCellMountedWorkspaceAnchor;
  const value = object(input, ["schemaVersion", "mountAnchor", "mountRecords", "cellName"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION ||
      typeof value.cellName !== "string" || !/^gc-cell-[0-9a-f]{32}$/u.test(value.cellName)) throw invalid();
  const mountAnchor = normalizeRemoteWorkerCellMountAnchor(value.mountAnchor), mountRecords: string[] = [];
  let previous: RemoteWorkerCellMountCheckpoint | undefined;
  for (const record of array(value.mountRecords, 4)) {
    const checkpoint = readRemoteWorkerCellMountCheckpoint(mountAnchor, record);
    assertRemoteWorkerCellMountSuccessor(mountAnchor, previous, checkpoint);
    mountRecords.push(checkpoint.recordHex); previous = checkpoint;
  }
  const anchor = Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION,
    mountAnchor, mountRecords: Object.freeze(mountRecords), cellName: value.cellName });
  verifiedAnchors.set(anchor, previous!);
  return anchor;
}
function readWorkspaceCheckpoint(anchor: RemoteWorkerCellMountedWorkspaceAnchor, mount: RemoteWorkerCellMountCheckpoint,
  input: unknown): RemoteWorkerCellWorkspaceCheckpoint {
  const binding = mount.mountCheckpoint;
  const recordHex = hex(input, 512), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(480, 32);
  const nameHex = Array.from(anchor.cellName, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  if (at(0, 8) !== "47434357524b3031" || sequence < 1 || sequence > 2 || view.getUint32(12, true) !== 0 ||
      (sequence === 1) !== /^0+$/u.test(previousRecordSha256) || at(48, 32) !== binding.recordSha256 ||
      at(80, 32) !== binding.securitySha256 || at(112, 40) !== nameHex || at(152, 24) !== binding.rootIdentityHex ||
      !bytes.subarray(272, 480).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 480)) !== recordSha256) throw invalid();
  const directoryIdentityHex = sequence === 1 ? [] : [176, 200, 224, 248].map((offset) => identity(at(offset, 24)));
  if (sequence === 1 ? !bytes.subarray(176, 272).every((byte) => byte === 0) :
    new Set([binding.rootIdentityHex, ...directoryIdentityHex]).size !== 5 ||
      directoryIdentityHex.some((item) => item.slice(0, 16) !== binding.rootIdentityHex.slice(0, 16))) throw invalid();
  return Object.freeze({ sequence, phase: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_PHASES[sequence - 1]!, recordHex, recordSha256,
    previousRecordSha256, mountSha256: binding.recordSha256, securitySha256: binding.securitySha256,
    rootIdentityHex: binding.rootIdentityHex, directoryIdentityHex: Object.freeze(directoryIdentityHex) });
}
/** Bounded admission; canonical anchors and predecessor checks still follow. */
export function normalizeRemoteWorkerCellMountedWorkspaceSubmission(input: unknown): RemoteWorkerCellMountedWorkspaceSubmission {
  const value = object(input, ["kind", "expectedSequence", "recordHex"]);
  const recordHex = hex(value.recordHex, REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_RECORD_BYTES), bytes = fromHex(recordHex);
  const view = new DataView(bytes.buffer), sequence = view.getUint32(8, true);
  if (value.kind !== "cell.mounted-workspace.checkpoint" || sequence < 1 || sequence > 2 || value.expectedSequence !== sequence - 1 ||
      view.getUint32(12, true) !== sequence || recordHex.slice(0, 16) !== "4743434d57503031" ||
      !bytes.subarray(792, 992).every((byte) => byte === 0) || sha256BytesHex(bytes.subarray(0, 992)) !== recordHex.slice(1984)) throw invalid();
  return Object.freeze({ kind: "cell.mounted-workspace.checkpoint", expectedSequence: sequence - 1, recordHex });
}
export function readRemoteWorkerCellMountedWorkspaceCheckpoint(expectedAnchor: unknown, input: unknown): RemoteWorkerCellMountedWorkspaceCheckpoint {
  const anchor = normalizeRemoteWorkerCellMountedWorkspaceAnchor(expectedAnchor), mount = verifiedAnchors.get(anchor)!;
  const recordHex = hex(input, REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_RECORD_BYTES), bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, size: number) => recordHex.slice(offset * 2, (offset + size) * 2);
  const sequence = view.getUint32(8, true), previousRecordSha256 = at(16, 32), recordSha256 = at(992, 32);
  if (at(0, 8) !== "4743434d57503031" || sequence < 1 || sequence > 2 || view.getUint32(12, true) !== sequence ||
      (sequence === 1 ? previousRecordSha256 !== mount.recordSha256 : /^0+$/u.test(previousRecordSha256)) ||
      at(48, 168) !== mount.recordHex.slice(96, 432) || at(216, 32) !== mount.recordSha256 ||
      at(248, 32) !== mount.recordHex.slice(496, 560) || !bytes.subarray(792, 992).every((byte) => byte === 0) ||
      sha256BytesHex(bytes.subarray(0, 992)) !== recordSha256) throw invalid();
  const workspaceCheckpoint = readWorkspaceCheckpoint(anchor, mount, at(280, 512));
  if (workspaceCheckpoint.sequence !== sequence) throw invalid();
  return Object.freeze({ sequence, phase: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_PHASES[sequence - 1]!, recordHex, recordSha256,
    previousRecordSha256, mountRecordedSha256: mount.recordSha256, anchor, workspaceCheckpoint });
}
export function assertRemoteWorkerCellMountedWorkspaceSuccessor(expectedAnchor: unknown,
  previous: RemoteWorkerCellMountedWorkspaceCheckpoint | undefined, next: RemoteWorkerCellMountedWorkspaceCheckpoint): void {
  const checked = readRemoteWorkerCellMountedWorkspaceCheckpoint(expectedAnchor, next.recordHex);
  const prior = previous ? readRemoteWorkerCellMountedWorkspaceCheckpoint(expectedAnchor, previous.recordHex) : undefined;
  if (checked.sequence !== (prior?.sequence ?? 0) + 1 || checked.previousRecordSha256 !== (prior?.recordSha256 ?? checked.mountRecordedSha256) ||
      checked.workspaceCheckpoint.previousRecordSha256 !== (prior?.workspaceCheckpoint.recordSha256 ?? "0".repeat(64))) throw invalid();
}
