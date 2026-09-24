import { hexToBytes } from "@noble/hashes/utils";
import { canonicalJsonString } from "./canonical-json.js";
import { sha256BytesHex, sha256Hex } from "./sha256.js";
import { normalizeRemoteWorkerCellSid as sid } from "./remote-worker-cell-sid.js";
import { createRemoteWorkerCellDiskLayoutPlan, normalizeRemoteWorkerCellDiskLayoutPlan,
  type RemoteWorkerCellDiskLayoutPlan } from "./remote-worker-cell-disk-layout.js";
import { normalizeRemoteWorkerCellVolumeAnchor, normalizeRemoteWorkerCellVolumeSubmission,
  readRemoteWorkerCellVolumeCheckpoint, assertRemoteWorkerCellVolumeSuccessor,
  REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION, type RemoteWorkerCellVolumeAnchor,
  type RemoteWorkerCellVolumeCheckpoint, type RemoteWorkerCellVolumeSubmission } from "./remote-worker-cell-volume.js";
import { normalizeRemoteWorkerCellFormatAnchor, normalizeRemoteWorkerCellFormatSubmission,
  readRemoteWorkerCellFormatCheckpoint, assertRemoteWorkerCellFormatSuccessor, REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
  type RemoteWorkerCellFormatAnchor, type RemoteWorkerCellFormatCheckpoint, type RemoteWorkerCellFormatSubmission } from "./remote-worker-cell-format.js";
import { normalizeRemoteWorkerCellProtectionAnchor, normalizeRemoteWorkerCellProtectionSubmission,
  readRemoteWorkerCellProtectionCheckpoint, assertRemoteWorkerCellProtectionSuccessor, REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
  type RemoteWorkerCellProtectionAnchor, type RemoteWorkerCellProtectionCheckpoint, type RemoteWorkerCellProtectionSubmission } from "./remote-worker-cell-protection.js";
import { normalizeRemoteWorkerCellMountAnchor, normalizeRemoteWorkerCellMountSubmission,
  readRemoteWorkerCellMountCheckpoint, assertRemoteWorkerCellMountSuccessor, REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION,
  type RemoteWorkerCellMountAnchor, type RemoteWorkerCellMountCheckpoint, type RemoteWorkerCellMountSubmission } from "./remote-worker-cell-mount.js";
import { normalizeRemoteWorkerCellMountedWorkspaceAnchor, normalizeRemoteWorkerCellMountedWorkspaceSubmission,
  readRemoteWorkerCellMountedWorkspaceCheckpoint, assertRemoteWorkerCellMountedWorkspaceSuccessor, REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION,
  type RemoteWorkerCellMountedWorkspaceAnchor, type RemoteWorkerCellMountedWorkspaceCheckpoint,
  type RemoteWorkerCellMountedWorkspaceSubmission } from "./remote-worker-cell-mounted-workspace.js";

export const REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-provisioning-plan.v1" as const;
export const REMOTE_WORKER_CELL_PROVISIONING_RECORD_BYTES = 1024;
export const REMOTE_WORKER_CELL_PROVISIONING_JOURNAL_RESERVED_BYTES = 64 * 1024;
export const REMOTE_WORKER_CELL_PROVISIONING_PHASES = [
  "prepared", "workspace_started", "workspace_recorded", "disk_started", "disk_recorded",
] as const;
export type RemoteWorkerCellProvisioningPhase = (typeof REMOTE_WORKER_CELL_PROVISIONING_PHASES)[number];

/** Private native metadata, with no paths, credentials, or workload contents.
 * Identity hex is the native little-endian volume serial followed by FILE_ID_128;
 * the disk identifier is the exact 16 native GUID bytes, not GUID display text. */
export interface RemoteWorkerCellProvisioningPlan {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION;
  readonly assignmentBindingSha256: string;
  readonly profileSha256: string;
  readonly parentIdentityHex: string;
  readonly cellName: string;
  readonly ownerSid: string;
  readonly controllerSid: string;
  readonly diskIdentifierHex: string;
  readonly virtualDiskBytes: number;
  readonly reservedDiskBytes: number;
}

/** Minimal private recovery input; the coordinator keeps its complete history
 * independently and compares it with the native owner's returned records. */
export interface RemoteWorkerCellProvisioningRecovery {
  readonly plan: RemoteWorkerCellProvisioningPlan;
  readonly preparedRecordHex: string;
}

export interface RemoteWorkerCellProvisioningBinding {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly cellId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly profileSha256: string;
  readonly provisioningOwner: string;
  readonly provisioningLeaseExpiresAt: string;
}

export interface RemoteWorkerCellProvisioningCheckpoint {
  readonly sequence: number;
  readonly phase: RemoteWorkerCellProvisioningPhase;
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly plan: RemoteWorkerCellProvisioningPlan;
  readonly journalIdentityHex: string;
  readonly workspaceIdentityHex: readonly string[];
  readonly backingIdentityHex?: string;
}

const invalid = () => new TypeError("Native worker provisioning metadata is invalid.");
function object(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== names.length || names.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]))) throw invalid();
  return input as Record<string, unknown>;
}
function hex(input: unknown, bytes: number, nonzero = true): string {
  if (typeof input !== "string" || input.length !== bytes * 2 || !/^[0-9a-f]+$/u.test(input) || (nonzero && /^0+$/u.test(input))) throw invalid();
  return input;
}
function identity(input: unknown): string {
  const value = hex(input, 24);
  if (/^0+$/u.test(value.slice(0, 16)) || /^0+$/u.test(value.slice(16))) throw invalid();
  return value;
}
export function normalizeRemoteWorkerCellProvisioningPlan(input: unknown): RemoteWorkerCellProvisioningPlan {
  const value = object(input, ["schemaVersion", "assignmentBindingSha256", "profileSha256", "parentIdentityHex", "cellName",
    "ownerSid", "controllerSid", "diskIdentifierHex", "virtualDiskBytes", "reservedDiskBytes"]);
  const virtual = value.virtualDiskBytes as number;
  const reserved = value.reservedDiskBytes as number;
  if (value.schemaVersion !== REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION ||
      typeof value.cellName !== "string" || !/^gc-cell-[0-9a-f]{32}$/u.test(value.cellName) ||
      !Number.isSafeInteger(virtual) || virtual < 16 * 1024 * 1024 || virtual % (2 * 1024 * 1024) !== 0 ||
      !Number.isSafeInteger(reserved) || reserved < virtual + 64 * 1024 * 1024 || reserved > 1024 ** 4) throw invalid();
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: hex(value.assignmentBindingSha256, 32), profileSha256: hex(value.profileSha256, 32),
    parentIdentityHex: identity(value.parentIdentityHex), cellName: value.cellName,
    ownerSid: sid(value.ownerSid, false), controllerSid: sid(value.controllerSid, true),
    diskIdentifierHex: hex(value.diskIdentifierHex, 16), virtualDiskBytes: virtual, reservedDiskBytes: reserved,
  });
}

export function remoteWorkerCellProvisioningPlanSha256(input: unknown): string {
  return sha256Hex(canonicalJsonString(normalizeRemoteWorkerCellProvisioningPlan(input)));
}

/** Derived from canonical cell and claim owners, never from worker assertions. */
export function remoteWorkerCellProvisioningBindingSha256(input: RemoteWorkerCellProvisioningBinding): string {
  const value = object(input, ["registryWorkspaceId", "assignmentId", "assignmentGeneration", "cellId", "workerId",
    "workerGeneration", "profileSha256", "provisioningOwner", "provisioningLeaseExpiresAt"]);
  for (const name of ["registryWorkspaceId", "assignmentId", "cellId", "workerId", "provisioningOwner"]) {
    if (typeof value[name] !== "string" || !value[name].length || value[name].length > 256 || value[name] !== value[name].trim() || /\p{Cc}/u.test(value[name])) throw invalid();
  }
  for (const name of ["assignmentGeneration", "workerGeneration"]) {
    if (!Number.isSafeInteger(value[name]) || (value[name] as number) < 1) throw invalid();
  }
  hex(value.profileSha256, 32);
  if (typeof value.provisioningLeaseExpiresAt !== "string" || !Number.isFinite(Date.parse(value.provisioningLeaseExpiresAt)) ||
      new Date(value.provisioningLeaseExpiresAt).toISOString() !== value.provisioningLeaseExpiresAt) throw invalid();
  return sha256Hex(canonicalJsonString({ schemaVersion: "goatcitadel.remote-worker-cell-provisioning-binding.v1", ...value }));
}

/** Decode and authenticate the exact fixed native record format. This verifies
 * metadata consistency only; the native owner must independently verify OS state. */
export function readRemoteWorkerCellProvisioningCheckpoint(input: unknown): RemoteWorkerCellProvisioningCheckpoint {
  const recordHex = hex(input, REMOTE_WORKER_CELL_PROVISIONING_RECORD_BYTES);
  const bytes = hexToBytes(recordHex);
  const view = new DataView(bytes.buffer);
  const sequence = view.getUint32(8, true);
  if (recordHex.slice(0, 16) !== "474343454c4c5031" || sequence < 1 || sequence > 5 ||
      view.getUint32(12, true) !== sequence || !bytes.slice(720, 992).every((byte) => byte === 0)) throw invalid();
  const recordSha256 = recordHex.slice(1984);
  if (sha256BytesHex(bytes.slice(0, 992)) !== recordSha256) throw invalid();
  const at = (offset: number, length: number) => recordHex.slice(offset * 2, (offset + length) * 2);
  const text = (offset: number, length: number) => {
    const field = bytes.slice(offset, offset + length);
    const terminator = field.indexOf(0);
    const end = terminator < 0 ? length : terminator;
    if (!field.slice(end).every((byte) => byte === 0) || field.slice(0, end).some((byte) => byte < 32 || byte > 126)) throw invalid();
    return String.fromCharCode(...field.slice(0, end));
  };
  const plan = normalizeRemoteWorkerCellProvisioningPlan({
    schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: at(48, 32), profileSha256: at(80, 32), diskIdentifierHex: at(112, 16),
    virtualDiskBytes: Number(view.getBigUint64(128, true)), reservedDiskBytes: Number(view.getBigUint64(136, true)),
    parentIdentityHex: at(144, 24), cellName: text(192, 40), ownerSid: text(232, 184), controllerSid: text(416, 184),
  });
  const journalIdentityHex = identity(at(168, 24));
  const workspaceIdentityHex = sequence >= 3 ? [600, 624, 648, 672].map((offset) => identity(at(offset, 24))) : [];
  const backingIdentityHex = sequence === 5 ? identity(at(696, 24)) : undefined;
  if ((sequence < 3 && !bytes.slice(600, 696).every((byte) => byte === 0)) ||
      (sequence < 5 && !bytes.slice(696, 720).every((byte) => byte === 0))) throw invalid();
  const identities = [plan.parentIdentityHex, journalIdentityHex, ...workspaceIdentityHex, ...(backingIdentityHex ? [backingIdentityHex] : [])];
  if (new Set(identities).size !== identities.length || identities.some((value) => value.slice(0, 16) !== plan.parentIdentityHex.slice(0, 16))) throw invalid();
  const previousRecordSha256 = at(16, 32);
  if ((sequence === 1) !== /^0+$/u.test(previousRecordSha256)) throw invalid();
  return Object.freeze({ sequence, phase: REMOTE_WORKER_CELL_PROVISIONING_PHASES[sequence - 1]!, recordHex, recordSha256,
    previousRecordSha256, plan, journalIdentityHex, workspaceIdentityHex: Object.freeze(workspaceIdentityHex),
    ...(backingIdentityHex ? { backingIdentityHex } : {}),
  });
}

export function assertRemoteWorkerCellProvisioningSuccessor(
  plan: RemoteWorkerCellProvisioningPlan,
  prior: RemoteWorkerCellProvisioningCheckpoint | undefined,
  next: RemoteWorkerCellProvisioningCheckpoint,
): void {
  if (canonicalJsonString(normalizeRemoteWorkerCellProvisioningPlan(plan)) !== canonicalJsonString(next.plan) ||
      next.sequence !== (prior?.sequence ?? 0) + 1 || next.previousRecordSha256 !== (prior?.recordSha256 ?? "0".repeat(64)) ||
      (prior && next.journalIdentityHex !== prior.journalIdentityHex) ||
      (prior && prior.sequence >= 3 && canonicalJsonString(next.workspaceIdentityHex) !== canonicalJsonString(prior.workspaceIdentityHex))) throw invalid();
}

export const REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-cell-provisioning-exchange.v7" as const;

/** Carried by the existing protected assignment settlement envelope. Neither
 * operation grants permission to create a cell or execute a workload. */
export type RemoteWorkerCellProvisioningSubmission =
  | Readonly<{ kind: "cell.provisioning.snapshot" }>
  | Readonly<{ kind: "cell.provisioning.checkpoint"; expectedSequence: number; recordHex: string }>
  | RemoteWorkerCellVolumeSubmission
  | RemoteWorkerCellFormatSubmission
  | RemoteWorkerCellProtectionSubmission
  | RemoteWorkerCellMountSubmission
  | RemoteWorkerCellMountedWorkspaceSubmission;

// Reuse only projections deeply normalized and frozen by this module. Untrusted
// wire objects, copies and caller-frozen values still undergo every check.
const verifiedExchanges = new WeakSet<RemoteWorkerCellProvisioningExchange>();
const verifiedHistories = new WeakSet<RemoteWorkerCellProvisioningHistory>();

/** Private, bounded projection. Provisioning claims and credential fences remain
 * Gateway-owned; only the canonical plan and exact checkpoint bytes cross out. */
export interface RemoteWorkerCellProvisioningExchange {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION;
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly plan: RemoteWorkerCellProvisioningPlan;
  readonly planSha256: string;
  readonly records: readonly string[];
  /** Derived only after an exact disk_recorded checkpoint, with sufficient
   * capacity. This freezes identifiers; it does not authorize layout writes. */
  readonly diskLayoutPlan?: RemoteWorkerCellDiskLayoutPlan;
  /** Omitted only when no volume checkpoint is retained. Never folded into the
   * original five creation records or interpreted as current OS readiness. */
  readonly volumeRecords?: readonly string[];
  /** A retained NTFS intent/completion pair is separate from volume preparation;
   * these bytes alone do not establish current filesystem or execution readiness. */
  readonly formatRecords?: readonly string[];
  /** Root protection evidence is distinct from mutable-tree, quota or execution readiness. */
  readonly protectionRecords?: readonly string[];
  /** Mount checkpoints retain folder/root identity; they do not establish execution readiness. */
  readonly mountRecords?: readonly string[];
  /** Execution-root identities require separate native readback before use. */
  readonly mountedWorkspaceRecords?: readonly string[];
}

/** Retained resource evidence, without a current assignment lease or execution
 * grant. Pool members may belong to older, no-longer-active generations. */
export type RemoteWorkerCellProvisioningHistory = Omit<RemoteWorkerCellProvisioningExchange,
  "schemaVersion" | "registryWorkspaceId" | "assignmentId" | "assignmentGeneration" | "leaseRevision">;

export function normalizeRemoteWorkerCellProvisioningSubmission(input: unknown): RemoteWorkerCellProvisioningSubmission {
  const kind = input && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, "kind")?.value : undefined;
  if (kind === "cell.volume.checkpoint") return normalizeRemoteWorkerCellVolumeSubmission(input);
  if (kind === "cell.format.checkpoint") return normalizeRemoteWorkerCellFormatSubmission(input);
  if (kind === "cell.protection.checkpoint") return normalizeRemoteWorkerCellProtectionSubmission(input);
  if (kind === "cell.mount.checkpoint") return normalizeRemoteWorkerCellMountSubmission(input);
  if (kind === "cell.mounted-workspace.checkpoint") return normalizeRemoteWorkerCellMountedWorkspaceSubmission(input);
  if (kind === "cell.provisioning.snapshot") {
    object(input, ["kind"]);
    return Object.freeze({ kind });
  }
  if (kind !== "cell.provisioning.checkpoint") throw invalid();
  const value = object(input, ["kind", "expectedSequence", "recordHex"]);
  const checkpoint = readRemoteWorkerCellProvisioningCheckpoint(value.recordHex);
  if (!Number.isSafeInteger(value.expectedSequence) || value.expectedSequence !== checkpoint.sequence - 1) throw invalid();
  return Object.freeze({ kind, expectedSequence: checkpoint.sequence - 1, recordHex: checkpoint.recordHex });
}

export function normalizeRemoteWorkerCellProvisioningExchange(input: unknown): RemoteWorkerCellProvisioningExchange {
  if (input && typeof input === "object" && verifiedExchanges.has(input as RemoteWorkerCellProvisioningExchange)) return input as RemoteWorkerCellProvisioningExchange;
  const suppliedLayout = input !== null && typeof input === "object" && Object.hasOwn(input, "diskLayoutPlan");
  const suppliedVolume = input !== null && typeof input === "object" && Object.hasOwn(input, "volumeRecords");
  const suppliedFormat = input !== null && typeof input === "object" && Object.hasOwn(input, "formatRecords");
  const suppliedProtection = input !== null && typeof input === "object" && Object.hasOwn(input, "protectionRecords");
  const suppliedMount = input !== null && typeof input === "object" && Object.hasOwn(input, "mountRecords");
  const suppliedWorkspace = input !== null && typeof input === "object" && Object.hasOwn(input, "mountedWorkspaceRecords");
  const value = object(input, ["schemaVersion", "registryWorkspaceId", "assignmentId", "assignmentGeneration",
    "leaseRevision", "plan", "planSha256", "records", ...(suppliedLayout ? ["diskLayoutPlan"] : []),
    ...(suppliedVolume ? ["volumeRecords"] : []), ...(suppliedFormat ? ["formatRecords"] : []),
    ...(suppliedProtection ? ["protectionRecords"] : []), ...(suppliedMount ? ["mountRecords"] : []),
    ...(suppliedWorkspace ? ["mountedWorkspaceRecords"] : [])]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION &&
      value.schemaVersion !== "goatcitadel.remote-worker-cell-provisioning-exchange.v1" &&
      value.schemaVersion !== "goatcitadel.remote-worker-cell-provisioning-exchange.v2" &&
      value.schemaVersion !== "goatcitadel.remote-worker-cell-provisioning-exchange.v3" &&
      value.schemaVersion !== "goatcitadel.remote-worker-cell-provisioning-exchange.v4" &&
      value.schemaVersion !== "goatcitadel.remote-worker-cell-provisioning-exchange.v5" &&
      value.schemaVersion !== "goatcitadel.remote-worker-cell-provisioning-exchange.v6") throw invalid();
  if (suppliedVolume && ![REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    "goatcitadel.remote-worker-cell-provisioning-exchange.v3", "goatcitadel.remote-worker-cell-provisioning-exchange.v4",
    "goatcitadel.remote-worker-cell-provisioning-exchange.v5", "goatcitadel.remote-worker-cell-provisioning-exchange.v6"].includes(value.schemaVersion as string)) throw invalid();
  if (suppliedFormat && ![REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    "goatcitadel.remote-worker-cell-provisioning-exchange.v4", "goatcitadel.remote-worker-cell-provisioning-exchange.v5",
    "goatcitadel.remote-worker-cell-provisioning-exchange.v6"].includes(value.schemaVersion as string)) throw invalid();
  if (suppliedProtection && ![REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    "goatcitadel.remote-worker-cell-provisioning-exchange.v5", "goatcitadel.remote-worker-cell-provisioning-exchange.v6"].includes(value.schemaVersion as string)) throw invalid();
  if (suppliedMount && ![REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    "goatcitadel.remote-worker-cell-provisioning-exchange.v6"].includes(value.schemaVersion as string)) throw invalid();
  if (suppliedWorkspace && value.schemaVersion !== REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION) throw invalid();
  for (const name of ["registryWorkspaceId", "assignmentId"]) {
    if (typeof value[name] !== "string" || !value[name].length || value[name].length > 256 ||
        value[name] !== value[name].trim() || /\p{Cc}/u.test(value[name])) throw invalid();
  }
  for (const name of ["assignmentGeneration", "leaseRevision"]) {
    if (!Number.isSafeInteger(value[name]) || (value[name] as number) < 1) throw invalid();
  }
  const history = normalizeRemoteWorkerCellProvisioningHistory({ plan: value.plan, planSha256: value.planSha256,
    records: value.records, ...(suppliedLayout ? { diskLayoutPlan: value.diskLayoutPlan } : {}),
    ...(suppliedVolume ? { volumeRecords: value.volumeRecords } : {}),
    ...(suppliedFormat ? { formatRecords: value.formatRecords } : {}),
    ...(suppliedProtection ? { protectionRecords: value.protectionRecords } : {}),
    ...(suppliedMount ? { mountRecords: value.mountRecords } : {}),
    ...(suppliedWorkspace ? { mountedWorkspaceRecords: value.mountedWorkspaceRecords } : {}) });
  const exchange: RemoteWorkerCellProvisioningExchange = Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
    registryWorkspaceId: value.registryWorkspaceId as string, assignmentId: value.assignmentId as string,
    assignmentGeneration: value.assignmentGeneration as number, leaseRevision: value.leaseRevision as number, ...history });
  verifiedExchanges.add(exchange);
  return exchange;
}

export function normalizeRemoteWorkerCellProvisioningHistory(input: unknown): RemoteWorkerCellProvisioningHistory {
  if (input && typeof input === "object" && verifiedHistories.has(input as RemoteWorkerCellProvisioningHistory)) return input as RemoteWorkerCellProvisioningHistory;
  const suppliedLayout = input !== null && typeof input === "object" && Object.hasOwn(input, "diskLayoutPlan");
  const suppliedVolume = input !== null && typeof input === "object" && Object.hasOwn(input, "volumeRecords");
  const suppliedFormat = input !== null && typeof input === "object" && Object.hasOwn(input, "formatRecords");
  const suppliedProtection = input !== null && typeof input === "object" && Object.hasOwn(input, "protectionRecords");
  const suppliedMount = input !== null && typeof input === "object" && Object.hasOwn(input, "mountRecords");
  const suppliedWorkspace = input !== null && typeof input === "object" && Object.hasOwn(input, "mountedWorkspaceRecords");
  const value = object(input, ["plan", "planSha256", "records", ...(suppliedLayout ? ["diskLayoutPlan"] : []),
    ...(suppliedVolume ? ["volumeRecords"] : []), ...(suppliedFormat ? ["formatRecords"] : []),
    ...(suppliedProtection ? ["protectionRecords"] : []), ...(suppliedMount ? ["mountRecords"] : []),
    ...(suppliedWorkspace ? ["mountedWorkspaceRecords"] : [])]);
  const plan = normalizeRemoteWorkerCellProvisioningPlan(value.plan);
  const planSha256 = remoteWorkerCellProvisioningPlanSha256(plan);
  if (value.planSha256 !== planSha256 || !Array.isArray(value.records) ||
      Object.getPrototypeOf(value.records) !== Array.prototype || value.records.length > 5 ||
      Reflect.ownKeys(value.records).length !== value.records.length + 1) throw invalid();
  const records: string[] = [];
  let previous: RemoteWorkerCellProvisioningCheckpoint | undefined;
  for (let index = 0; index < value.records.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.records, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    const checkpoint = readRemoteWorkerCellProvisioningCheckpoint(descriptor.value);
    assertRemoteWorkerCellProvisioningSuccessor(plan, previous, checkpoint);
    records.push(checkpoint.recordHex);
    previous = checkpoint;
  }
  const diskLayoutPlan = previous?.phase === "disk_recorded" && plan.virtualDiskBytes >= 64 * 1024 * 1024
    ? createRemoteWorkerCellDiskLayoutPlan({ provisioningPlanSha256: planSha256,
      assignmentBindingSha256: plan.assignmentBindingSha256, profileSha256: plan.profileSha256,
      diskIdentifierHex: plan.diskIdentifierHex, virtualDiskBytes: plan.virtualDiskBytes, reservedDiskBytes: plan.reservedDiskBytes,
      controlIdentityHex: previous.workspaceIdentityHex[1], backingIdentityHex: previous.backingIdentityHex }) : undefined;
  if (suppliedLayout && (!diskLayoutPlan ||
      canonicalJsonString(normalizeRemoteWorkerCellDiskLayoutPlan(value.diskLayoutPlan)) !== canonicalJsonString(diskLayoutPlan))) throw invalid();
  const volumeRecords: string[] = [];
  if (suppliedVolume) {
    if (!Array.isArray(value.volumeRecords) || Object.getPrototypeOf(value.volumeRecords) !== Array.prototype ||
        value.volumeRecords.length > 6 || Reflect.ownKeys(value.volumeRecords).length !== value.volumeRecords.length + 1) throw invalid();
    let priorVolume: RemoteWorkerCellVolumeCheckpoint | undefined;
    for (let index = 0; index < value.volumeRecords.length; index++) {
      if (!diskLayoutPlan || !previous) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value.volumeRecords, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      const anchor = volumeAnchor(diskLayoutPlan, previous);
      const checkpoint = readRemoteWorkerCellVolumeCheckpoint(anchor, descriptor.value);
      assertRemoteWorkerCellVolumeSuccessor(anchor, priorVolume, checkpoint);
      volumeRecords.push(checkpoint.recordHex); priorVolume = checkpoint;
    }
  }
  const formatRecords: string[] = [];
  if (suppliedFormat) {
    if (!Array.isArray(value.formatRecords) || Object.getPrototypeOf(value.formatRecords) !== Array.prototype ||
        value.formatRecords.length > 2 || Reflect.ownKeys(value.formatRecords).length !== value.formatRecords.length + 1) throw invalid();
    let priorFormat: RemoteWorkerCellFormatCheckpoint | undefined;
    for (let index = 0; index < value.formatRecords.length; index++) {
      if (!diskLayoutPlan || !previous || volumeRecords.length !== 6) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value.formatRecords, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      const anchor = normalizeRemoteWorkerCellFormatAnchor({ schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
        volumeAnchor: volumeAnchor(diskLayoutPlan, previous), volumeRecords });
      const checkpoint = readRemoteWorkerCellFormatCheckpoint(anchor, descriptor.value);
      assertRemoteWorkerCellFormatSuccessor(anchor, priorFormat, checkpoint);
      formatRecords.push(checkpoint.recordHex); priorFormat = checkpoint;
    }
  }
  const protectionRecords: string[] = [];
  if (suppliedProtection) {
    if (!Array.isArray(value.protectionRecords) || Object.getPrototypeOf(value.protectionRecords) !== Array.prototype ||
        value.protectionRecords.length > 2 || Reflect.ownKeys(value.protectionRecords).length !== value.protectionRecords.length + 1) throw invalid();
    let priorProtection: RemoteWorkerCellProtectionCheckpoint | undefined;
    for (let index = 0; index < value.protectionRecords.length; index++) {
      if (!diskLayoutPlan || !previous || volumeRecords.length !== 6 || formatRecords.length !== 2) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value.protectionRecords, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      const anchor = normalizeRemoteWorkerCellProtectionAnchor({ schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
        formatAnchor: { schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
          volumeAnchor: volumeAnchor(diskLayoutPlan, previous), volumeRecords }, formatRecords,
        ownerSid: plan.ownerSid, controllerSid: plan.controllerSid });
      const checkpoint = readRemoteWorkerCellProtectionCheckpoint(anchor, descriptor.value);
      assertRemoteWorkerCellProtectionSuccessor(anchor, priorProtection, checkpoint);
      protectionRecords.push(checkpoint.recordHex); priorProtection = checkpoint;
    }
  }
  const mountRecords: string[] = [];
  let mountAnchor: RemoteWorkerCellMountAnchor | undefined;
  if (suppliedMount) {
    if (!Array.isArray(value.mountRecords) || Object.getPrototypeOf(value.mountRecords) !== Array.prototype ||
        value.mountRecords.length > 4 || Reflect.ownKeys(value.mountRecords).length !== value.mountRecords.length + 1) throw invalid();
    let priorMount: RemoteWorkerCellMountCheckpoint | undefined;
    for (let index = 0; index < value.mountRecords.length; index++) {
      if (!diskLayoutPlan || !previous || volumeRecords.length !== 6 || formatRecords.length !== 2 || protectionRecords.length !== 2) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value.mountRecords, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      const anchor = mountAnchor ??= normalizeRemoteWorkerCellMountAnchor({ schemaVersion: REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION,
        protectionAnchor: { schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
          formatAnchor: { schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
            volumeAnchor: volumeAnchor(diskLayoutPlan, previous), volumeRecords }, formatRecords,
          ownerSid: plan.ownerSid, controllerSid: plan.controllerSid }, protectionRecords,
        parentIdentityHex: plan.parentIdentityHex, workspaceIdentityHex: previous.workspaceIdentityHex });
      const checkpoint = readRemoteWorkerCellMountCheckpoint(anchor, descriptor.value);
      assertRemoteWorkerCellMountSuccessor(anchor, priorMount, checkpoint);
      mountRecords.push(checkpoint.recordHex); priorMount = checkpoint;
    }
  }
  const mountedWorkspaceRecords: string[] = [];
  if (suppliedWorkspace) {
    if (!Array.isArray(value.mountedWorkspaceRecords) || Object.getPrototypeOf(value.mountedWorkspaceRecords) !== Array.prototype ||
        value.mountedWorkspaceRecords.length > 2 || Reflect.ownKeys(value.mountedWorkspaceRecords).length !== value.mountedWorkspaceRecords.length + 1) throw invalid();
    let priorWorkspace: RemoteWorkerCellMountedWorkspaceCheckpoint | undefined;
    let workspaceAnchor: RemoteWorkerCellMountedWorkspaceAnchor | undefined;
    for (let index = 0; index < value.mountedWorkspaceRecords.length; index++) {
      if (!mountAnchor || mountRecords.length !== 4) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value.mountedWorkspaceRecords, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      const anchor = workspaceAnchor ??= normalizeRemoteWorkerCellMountedWorkspaceAnchor({
        schemaVersion: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION, mountAnchor, mountRecords, cellName: plan.cellName });
      const checkpoint = readRemoteWorkerCellMountedWorkspaceCheckpoint(anchor, descriptor.value);
      assertRemoteWorkerCellMountedWorkspaceSuccessor(anchor, priorWorkspace, checkpoint);
      mountedWorkspaceRecords.push(checkpoint.recordHex); priorWorkspace = checkpoint;
    }
  }
  const history: RemoteWorkerCellProvisioningHistory = Object.freeze({
    plan, planSha256, records: Object.freeze(records), ...(diskLayoutPlan ? { diskLayoutPlan } : {}),
    ...(volumeRecords.length ? { volumeRecords: Object.freeze(volumeRecords) } : {}),
    ...(formatRecords.length ? { formatRecords: Object.freeze(formatRecords) } : {}),
    ...(protectionRecords.length ? { protectionRecords: Object.freeze(protectionRecords) } : {}),
    ...(mountRecords.length ? { mountRecords: Object.freeze(mountRecords) } : {}),
    ...(mountedWorkspaceRecords.length ? { mountedWorkspaceRecords: Object.freeze(mountedWorkspaceRecords) } : {}) });
  verifiedHistories.add(history);
  return history;
}

function volumeAnchor(layoutPlan: RemoteWorkerCellDiskLayoutPlan, disk: RemoteWorkerCellProvisioningCheckpoint): RemoteWorkerCellVolumeAnchor {
  return normalizeRemoteWorkerCellVolumeAnchor({ schemaVersion: REMOTE_WORKER_CELL_VOLUME_ANCHOR_SCHEMA_VERSION,
    diskRecordedSha256: disk.recordSha256, journalIdentityHex: disk.journalIdentityHex, layoutPlan });
}
/** Metadata only: callers must independently retain these creation bytes. */
export function deriveRemoteWorkerCellVolumeAnchor(planInput: unknown, recordsInput: unknown): RemoteWorkerCellVolumeAnchor {
  const plan = normalizeRemoteWorkerCellProvisioningPlan(planInput);
  if (!Array.isArray(recordsInput) || Object.getPrototypeOf(recordsInput) !== Array.prototype ||
      recordsInput.length !== 5 || Reflect.ownKeys(recordsInput).length !== 6) throw invalid();
  let previous: RemoteWorkerCellProvisioningCheckpoint | undefined;
  for (let index = 0; index < 5; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(recordsInput, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    const checkpoint = readRemoteWorkerCellProvisioningCheckpoint(descriptor.value);
    assertRemoteWorkerCellProvisioningSuccessor(plan, previous, checkpoint);
    previous = checkpoint;
  }
  const disk = previous!;
  return volumeAnchor(createRemoteWorkerCellDiskLayoutPlan({ provisioningPlanSha256: remoteWorkerCellProvisioningPlanSha256(plan),
    assignmentBindingSha256: plan.assignmentBindingSha256, profileSha256: plan.profileSha256,
    diskIdentifierHex: plan.diskIdentifierHex, virtualDiskBytes: plan.virtualDiskBytes, reservedDiskBytes: plan.reservedDiskBytes,
    controlIdentityHex: disk.workspaceIdentityHex[1], backingIdentityHex: disk.backingIdentityHex }), disk);
}
/** Derive only from the validated complete canonical creation chain. */
export function remoteWorkerCellProvisioningVolumeAnchor(input: unknown): RemoteWorkerCellVolumeAnchor {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(input);
  if (!exchange.diskLayoutPlan || exchange.records.length !== 5) throw invalid();
  return volumeAnchor(exchange.diskLayoutPlan, readRemoteWorkerCellProvisioningCheckpoint(exchange.records[4]));
}
export function remoteWorkerCellProvisioningFormatAnchor(input: unknown): RemoteWorkerCellFormatAnchor {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(input);
  if (!exchange.diskLayoutPlan || exchange.records.length !== 5) throw invalid();
  return normalizeRemoteWorkerCellFormatAnchor({ schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
    volumeAnchor: volumeAnchor(exchange.diskLayoutPlan, readRemoteWorkerCellProvisioningCheckpoint(exchange.records[4])),
    volumeRecords: exchange.volumeRecords });
}
export function remoteWorkerCellProvisioningProtectionAnchor(input: unknown): RemoteWorkerCellProtectionAnchor {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(input);
  return normalizeRemoteWorkerCellProtectionAnchor({ schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
    formatAnchor: remoteWorkerCellProvisioningFormatAnchor(exchange), formatRecords: exchange.formatRecords,
    ownerSid: exchange.plan.ownerSid, controllerSid: exchange.plan.controllerSid });
}
export function remoteWorkerCellProvisioningMountAnchor(input: unknown): RemoteWorkerCellMountAnchor {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(input);
  const disk = readRemoteWorkerCellProvisioningCheckpoint(exchange.records[4]);
  return normalizeRemoteWorkerCellMountAnchor({ schemaVersion: REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION,
    protectionAnchor: remoteWorkerCellProvisioningProtectionAnchor(exchange), protectionRecords: exchange.protectionRecords,
    parentIdentityHex: exchange.plan.parentIdentityHex, workspaceIdentityHex: disk.workspaceIdentityHex });
}
export function remoteWorkerCellProvisioningMountedWorkspaceAnchor(input: unknown): RemoteWorkerCellMountedWorkspaceAnchor {
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(input);
  return normalizeRemoteWorkerCellMountedWorkspaceAnchor({ schemaVersion: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION,
    mountAnchor: remoteWorkerCellProvisioningMountAnchor(exchange), mountRecords: exchange.mountRecords, cellName: exchange.plan.cellName });
}

/** Resource-only anchor for retained pool members. This validates the original
 * chain without manufacturing assignment, lease or provisioning-owner fields. */
export function remoteWorkerCellProvisioningHistoryMountedWorkspaceAnchor(input: unknown): RemoteWorkerCellMountedWorkspaceAnchor {
  const history = normalizeRemoteWorkerCellProvisioningHistory(input), plan = history.plan;
  if (history.records.length !== 5 || !history.diskLayoutPlan || history.volumeRecords?.length !== 6 ||
      history.formatRecords?.length !== 2 || history.protectionRecords?.length !== 2 || history.mountRecords?.length !== 4) throw invalid();
  const disk = readRemoteWorkerCellProvisioningCheckpoint(history.records[4]!);
  return normalizeRemoteWorkerCellMountedWorkspaceAnchor({ schemaVersion: REMOTE_WORKER_CELL_MOUNTED_WORKSPACE_ANCHOR_SCHEMA_VERSION,
    mountAnchor: { schemaVersion: REMOTE_WORKER_CELL_MOUNT_ANCHOR_SCHEMA_VERSION,
      protectionAnchor: { schemaVersion: REMOTE_WORKER_CELL_PROTECTION_ANCHOR_SCHEMA_VERSION,
        formatAnchor: { schemaVersion: REMOTE_WORKER_CELL_FORMAT_ANCHOR_SCHEMA_VERSION,
          volumeAnchor: volumeAnchor(history.diskLayoutPlan, disk), volumeRecords: history.volumeRecords }, formatRecords: history.formatRecords,
        ownerSid: plan.ownerSid, controllerSid: plan.controllerSid }, protectionRecords: history.protectionRecords,
      parentIdentityHex: plan.parentIdentityHex, workspaceIdentityHex: disk.workspaceIdentityHex },
    mountRecords: history.mountRecords, cellName: plan.cellName });
}

export const REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-preparation.v1" as const;

/** An observed installed directory ID, not a profile, attestation or resource
 * grant. The native helper independently requires its fixed installed parent. */
export interface RemoteWorkerCellPreparationSubmission {
  readonly kind: "cell.provisioning.prepare";
  readonly parentIdentityHex: string;
}
export interface RemoteWorkerCellPreparation {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION;
  /** Only the transaction which first prepares the plan can return create_once.
   * An exact replay, including after a lost response, always requires recovery. */
  readonly decision: "create_once" | "reconcile";
  readonly provisioningExpiresAt: string;
  readonly exchange: RemoteWorkerCellProvisioningExchange;
}
export function normalizeRemoteWorkerCellPreparationSubmission(input: unknown): RemoteWorkerCellPreparationSubmission {
  const value = object(input, ["kind", "parentIdentityHex"]);
  if (value.kind !== "cell.provisioning.prepare") throw invalid();
  return Object.freeze({ kind: value.kind, parentIdentityHex: identity(value.parentIdentityHex) });
}
export function normalizeRemoteWorkerCellPreparation(input: unknown): RemoteWorkerCellPreparation {
  const value = object(input, ["schemaVersion", "decision", "provisioningExpiresAt", "exchange"]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION ||
      (value.decision !== "create_once" && value.decision !== "reconcile") ||
      typeof value.provisioningExpiresAt !== "string" || !Number.isFinite(Date.parse(value.provisioningExpiresAt)) ||
      new Date(value.provisioningExpiresAt).toISOString() !== value.provisioningExpiresAt) throw invalid();
  const exchange = normalizeRemoteWorkerCellProvisioningExchange(value.exchange);
  if (value.decision === "create_once" && exchange.records.length) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_PREPARATION_SCHEMA_VERSION,
    decision: value.decision, provisioningExpiresAt: value.provisioningExpiresAt, exchange });
}
