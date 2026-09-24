import { hexToBytes as fromHex } from "@noble/hashes/utils";
import { canonicalJsonString } from "./canonical-json.js";
import { sha256BytesHex } from "./sha256.js";

export const REMOTE_WORKER_CELL_DISK_LAYOUT_PLAN_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-disk-layout-plan.v1" as const;
export const REMOTE_WORKER_CELL_DISK_LAYOUT_RECORD_BYTES = 512;
export const REMOTE_WORKER_CELL_DISK_LAYOUT_PHASES = ["initialize_intent", "initialized", "partition_intent", "partitioned"] as const;
export interface RemoteWorkerCellDiskLayoutSeed {
  readonly provisioningPlanSha256: string;
  readonly assignmentBindingSha256: string;
  readonly profileSha256: string;
  readonly diskIdentifierHex: string;
  readonly virtualDiskBytes: number;
  readonly reservedDiskBytes: number;
  readonly controlIdentityHex: string;
  readonly backingIdentityHex: string;
}
export interface RemoteWorkerCellDiskLayoutPlan extends RemoteWorkerCellDiskLayoutSeed {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_DISK_LAYOUT_PLAN_SCHEMA_VERSION;
  readonly gptDiskIdentifierHex: string;
  readonly dataPartitionIdentifierHex: string;
}
export interface RemoteWorkerCellDiskLayoutSnapshot {
  readonly usableStart: number;
  readonly usableLength: number;
  readonly reservedPartitionIdentifierHex: string;
  readonly reservedStart: number;
  readonly reservedLength: number;
  readonly reservedAttributes: number;
  readonly reservedName: string;
  readonly dataStart: number;
  readonly dataLength: number;
}
export interface RemoteWorkerCellDiskLayoutCheckpoint {
  readonly sequence: number;
  readonly phase: (typeof REMOTE_WORKER_CELL_DISK_LAYOUT_PHASES)[number];
  readonly recordHex: string;
  readonly recordSha256: string;
  readonly previousRecordSha256: string;
  readonly plan: RemoteWorkerCellDiskLayoutPlan;
  readonly snapshot?: RemoteWorkerCellDiskLayoutSnapshot;
}
const mib = 1024 * 1024;
const seedKeys = ["provisioningPlanSha256", "assignmentBindingSha256", "profileSha256", "diskIdentifierHex",
  "virtualDiskBytes", "reservedDiskBytes", "controlIdentityHex", "backingIdentityHex"] as const;
const invalid = () => new TypeError("Native worker disk layout metadata is invalid.");
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
function identity(input: unknown): string {
  const value = hex(input, 24);
  if (/^0+$/u.test(value.slice(0, 16)) || /^0+$/u.test(value.slice(16))) throw invalid();
  return value;
}
function identifier(seed: RemoteWorkerCellDiskLayoutSeed, role: number): string {
  const prefix = new TextEncoder().encode("goatcitadel.native-cell-gpt.v1\0");
  const bytes = new Uint8Array(prefix.length + 81);
  bytes.set(prefix); bytes.set(fromHex(seed.assignmentBindingSha256), prefix.length);
  bytes.set(fromHex(seed.profileSha256), prefix.length + 32);
  bytes.set(fromHex(seed.diskIdentifierHex), prefix.length + 64); bytes[bytes.length - 1] = role;
  const guid = fromHex(sha256BytesHex(bytes).slice(0, 32));
  // Native GUID byte order: Data3 is little endian. Version 8 denotes the
  // domain-separated custom SHA256 derivation; variant is RFC 9562.
  guid[7] = (guid[7]! & 0x0f) | 0x80; guid[8] = (guid[8]! & 0x3f) | 0x80;
  return Array.from(guid, (value) => value.toString(16).padStart(2, "0")).join("");
}
/** Derivation is not authority. Production supplies a canonical frozen plan and
 * the exact independently retained disk_recorded checkpoint, never observations
 * obtained from an arbitrary device. Existing provisioning records remain intact. */
export function createRemoteWorkerCellDiskLayoutPlan(input: unknown): RemoteWorkerCellDiskLayoutPlan {
  const value = object(input, seedKeys);
  const virtual = value.virtualDiskBytes as number, reserved = value.reservedDiskBytes as number;
  if (!Number.isSafeInteger(virtual) || virtual < 64 * mib || virtual % (2 * mib) !== 0 ||
      !Number.isSafeInteger(reserved) || reserved < virtual + 64 * mib || reserved > 1024 ** 4) throw invalid();
  const seed: RemoteWorkerCellDiskLayoutSeed = {
    provisioningPlanSha256: hex(value.provisioningPlanSha256, 32), assignmentBindingSha256: hex(value.assignmentBindingSha256, 32),
    profileSha256: hex(value.profileSha256, 32), diskIdentifierHex: hex(value.diskIdentifierHex, 16),
    virtualDiskBytes: virtual, reservedDiskBytes: reserved,
    controlIdentityHex: identity(value.controlIdentityHex), backingIdentityHex: identity(value.backingIdentityHex),
  };
  if (seed.controlIdentityHex === seed.backingIdentityHex || seed.controlIdentityHex.slice(0, 16) !== seed.backingIdentityHex.slice(0, 16)) throw invalid();
  const gptDiskIdentifierHex = identifier(seed, 1), dataPartitionIdentifierHex = identifier(seed, 2);
  if (new Set([seed.diskIdentifierHex, gptDiskIdentifierHex, dataPartitionIdentifierHex]).size !== 3) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_DISK_LAYOUT_PLAN_SCHEMA_VERSION,
    ...seed, gptDiskIdentifierHex, dataPartitionIdentifierHex });
}
export function normalizeRemoteWorkerCellDiskLayoutPlan(input: unknown): RemoteWorkerCellDiskLayoutPlan {
  const value = object(input, ["schemaVersion", ...seedKeys, "gptDiskIdentifierHex", "dataPartitionIdentifierHex"]);
  const expected = createRemoteWorkerCellDiskLayoutPlan(Object.fromEntries(seedKeys.map((key) => [key, value[key]])));
  if (value.schemaVersion !== expected.schemaVersion || value.gptDiskIdentifierHex !== expected.gptDiskIdentifierHex ||
      value.dataPartitionIdentifierHex !== expected.dataPartitionIdentifierHex) throw invalid();
  return expected;
}

/** Validates exact GCCGPT01 bytes against independent canonical expectations.
 * A matching digest or completed phase does not establish current OS state,
 * assignment authority, quota enforcement, workload death or permission to write. */
export function readRemoteWorkerCellDiskLayoutCheckpoint(expectedPlan: unknown, input: unknown): RemoteWorkerCellDiskLayoutCheckpoint {
  const plan = normalizeRemoteWorkerCellDiskLayoutPlan(expectedPlan);
  const recordHex = hex(input, REMOTE_WORKER_CELL_DISK_LAYOUT_RECORD_BYTES);
  const bytes = fromHex(recordHex), view = new DataView(bytes.buffer);
  const at = (offset: number, length: number) => recordHex.slice(offset * 2, (offset + length) * 2);
  const integer = (offset: number) => {
    const value = Number(view.getBigUint64(offset, true));
    if (!Number.isSafeInteger(value)) throw invalid();
    return value;
  };
  const sequence = view.getUint32(8, true), recordSha256 = at(480, 32), previousRecordSha256 = at(16, 32);
  if (at(0, 8) !== "4743434750543031" || sequence < 1 || sequence > 4 || view.getUint32(12, true) !== 0 ||
      sha256BytesHex(bytes.subarray(0, 480)) !== recordSha256 ||
      (sequence === 1) !== /^0+$/u.test(previousRecordSha256) || !bytes.subarray(392, 480).every((value) => value === 0) ||
      view.getUint32(388, true) !== 512 || at(48, 16) !== plan.diskIdentifierHex || integer(64) !== plan.virtualDiskBytes ||
      integer(72) !== plan.reservedDiskBytes || at(80, 24) !== plan.controlIdentityHex || at(104, 24) !== plan.backingIdentityHex ||
      at(128, 16) !== plan.gptDiskIdentifierHex || at(144, 16) !== plan.dataPartitionIdentifierHex) throw invalid();
  let snapshot: RemoteWorkerCellDiskLayoutSnapshot | undefined;
  if (sequence === 1) {
    if (!bytes.subarray(160, 388).every((value) => value === 0)) throw invalid();
  } else {
    const text = (offset: number): string => {
      const letters = Array.from({ length: 36 }, (_, index) => view.getUint16(offset + index * 2, true));
      const end = letters.indexOf(0);
      if (end < 0 || !letters.slice(end).every((value) => value === 0) || letters.slice(0, end).some((value) => value < 32 || value === 127)) throw invalid();
      return String.fromCharCode(...letters.slice(0, end));
    };
    snapshot = Object.freeze({ usableStart: integer(160), usableLength: integer(168),
      reservedPartitionIdentifierHex: hex(at(180, 16), 16), reservedStart: integer(196), reservedLength: integer(204),
      reservedAttributes: integer(212), reservedName: text(220), dataStart: integer(292), dataLength: integer(300) });
    if (view.getUint32(176, true) !== 128 || snapshot.usableStart !== 34 * 512 || snapshot.usableLength !== plan.virtualDiskBytes - 67 * 512 ||
        [plan.gptDiskIdentifierHex, plan.dataPartitionIdentifierHex].includes(snapshot.reservedPartitionIdentifierHex) ||
        snapshot.reservedStart < snapshot.usableStart || snapshot.reservedStart > mib || snapshot.reservedStart % 512 !== 0 ||
        ![16 * mib, 32 * mib, 128 * mib].includes(snapshot.reservedLength) || ![0, 1].includes(snapshot.reservedAttributes) ||
        view.getBigUint64(308, true) !== 0x8000000000000000n || text(316) !== "GoatCitadel cell") throw invalid();
    const dataStart = Math.ceil((snapshot.reservedStart + snapshot.reservedLength) / mib) * mib;
    const remaining = snapshot.usableStart + snapshot.usableLength - dataStart;
    if (remaining < 16 * mib || snapshot.dataStart !== dataStart || snapshot.dataLength !== Math.floor(remaining / mib) * mib) throw invalid();
  }
  return Object.freeze({ sequence, phase: REMOTE_WORKER_CELL_DISK_LAYOUT_PHASES[sequence - 1]!, recordHex,
    recordSha256, previousRecordSha256, plan, ...(snapshot ? { snapshot } : {}) });
}
export function assertRemoteWorkerCellDiskLayoutSuccessor(
  expectedPlan: unknown, previous: RemoteWorkerCellDiskLayoutCheckpoint | undefined, next: RemoteWorkerCellDiskLayoutCheckpoint,
): void {
  const checked = readRemoteWorkerCellDiskLayoutCheckpoint(expectedPlan, next.recordHex);
  const prior = previous ? readRemoteWorkerCellDiskLayoutCheckpoint(expectedPlan, previous.recordHex) : undefined;
  if (checked.sequence !== (prior?.sequence ?? 0) + 1 || checked.previousRecordSha256 !== (prior?.recordSha256 ?? "0".repeat(64)) ||
      (prior?.snapshot && canonicalJsonString(checked.snapshot) !== canonicalJsonString(prior.snapshot))) throw invalid();
}
