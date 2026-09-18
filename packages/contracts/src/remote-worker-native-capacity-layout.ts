import { sha256BytesHex } from "./sha256.js";
import { REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES } from "./remote-worker-cell.js";

export const REMOTE_WORKER_NATIVE_CAPACITY_LAYOUT_SCHEMA = "goatcitadel.native-capacity-layout.v1" as const;
/** Independently retained host roots, in footprint-category order. This records
 * identities; native collection and current installed custody remain required. */
export interface RemoteWorkerNativeCapacityLayout {
  readonly schemaVersion: typeof REMOTE_WORKER_NATIVE_CAPACITY_LAYOUT_SCHEMA;
  readonly assignmentBindingSha256: string;
  readonly profileSha256: string;
  readonly rootIdentityHex: readonly string[];
}
const invalid = () => new TypeError("Native capacity layout must match its retained assignment, profile and thirteen roots.");
/** Decode the native owner's fixed GCLAY001 record. Admission must supply this
 * independently of incoming capture bytes; decoding alone grants no custody. */
export function readRemoteWorkerNativeCapacityLayout(input: unknown): RemoteWorkerNativeCapacityLayout {
  if (typeof input !== "string" || !/^[0-9a-f]{768}$/u.test(input) || input.slice(0, 16) !== "47434c4159303031") throw invalid();
  return normalizeRemoteWorkerNativeCapacityLayout({ schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_LAYOUT_SCHEMA,
    assignmentBindingSha256: input.slice(16, 80), profileSha256: input.slice(80, 144),
    rootIdentityHex: Array.from({ length: 13 }, (_, i) => input.slice(144 + 48 * i, 192 + 48 * i)) });
}
function identity(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{48}$/u.test(input) || /^0+$/u.test(input.slice(16))) throw invalid();
  return input;
}
export function remoteWorkerNativeCapacityIdentitySha256(input: unknown): string {
  const hex = identity(input), prefix = new TextEncoder().encode("goatcitadel.native-file-identity.v1\0");
  const bytes = new Uint8Array(prefix.length + 24); bytes.set(prefix);
  for (let i = 0; i < 24; i++) bytes[prefix.length + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return sha256BytesHex(bytes);
}
export function normalizeRemoteWorkerNativeCapacityLayout(input: unknown): RemoteWorkerNativeCapacityLayout {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const keys = ["schemaVersion", "assignmentBindingSha256", "profileSha256", "rootIdentityHex"] as const;
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw invalid();
  const value = Object.fromEntries(keys.map(key => [key, fields[key]!.value]));
  if (value.schemaVersion !== REMOTE_WORKER_NATIVE_CAPACITY_LAYOUT_SCHEMA) throw invalid();
  for (const key of ["assignmentBindingSha256", "profileSha256"] as const)
    if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/u.test(value[key]) || /^0+$/u.test(value[key])) throw invalid();
  const roots = value.rootIdentityHex;
  if (!Array.isArray(roots) || Object.getPrototypeOf(roots) !== Array.prototype) throw invalid();
  const entries = Object.getOwnPropertyDescriptors(roots as object), count = REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.length;
  if (entries.length?.value !== count || Reflect.ownKeys(entries).length !== count + 1) throw invalid();
  const captured = Array.from({ length: count }, (_, i) => {
    const entry = entries[String(i)];
    if (!entry?.enumerable || !("value" in entry)) throw invalid();
    return identity(entry.value);
  });
  if (new Set(captured).size !== count) throw invalid();
  return Object.freeze({ schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_LAYOUT_SCHEMA,
    assignmentBindingSha256: value.assignmentBindingSha256 as string, profileSha256: value.profileSha256 as string,
    rootIdentityHex: Object.freeze(captured) });
}
