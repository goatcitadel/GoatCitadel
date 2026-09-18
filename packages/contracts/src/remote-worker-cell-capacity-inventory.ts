import {
  REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_MAX_DISK_BYTES,
  normalizeRemoteWorkerCellCapacityFootprint,
  remoteWorkerCellCanonicalSha256,
  remoteWorkerCellCapacityFootprintTotalBytes,
  type RemoteWorkerCellCapacityFootprint,
} from "./remote-worker-cell.js";
import { normalizeRemoteWorkerNativeCapacityLayout, remoteWorkerNativeCapacityIdentitySha256,
  type RemoteWorkerNativeCapacityLayout } from "./remote-worker-native-capacity-layout.js";

export const REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION = "goatcitadel.remote-worker-cell-capacity-inventory.v1" as const;
export const REMOTE_WORKER_CELL_CAPACITY_INVENTORY_MAX_OBJECTS = 20_000;
export type RemoteWorkerCellCapacityCategory = typeof REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES[number];

/** A physical identity appears once. Shared CAS references belong in references,
 * not as repeated objects. Native producers must reject filesystem hard links. */
export interface RemoteWorkerCellCapacityInventoryObject {
  readonly identitySha256: string;
  readonly kind: "file" | "directory" | "volume_backing";
  readonly logicalBytes: number;
  readonly allocatedBytes: number;
  /** Guest allocation is already contained by this host volume-backing object. */
  readonly backingIdentitySha256: string | null;
}
export interface RemoteWorkerCellCapacityInventoryArea {
  readonly category: RemoteWorkerCellCapacityCategory;
  /** Independently retained enumeration/absence evidence, including empty areas. */
  readonly evidenceSha256: string;
  readonly objects: readonly RemoteWorkerCellCapacityInventoryObject[];
}
export interface RemoteWorkerCellCapacityInventoryReference {
  readonly referenceSha256: string;
  readonly objectIdentitySha256: string;
}
export interface RemoteWorkerCellCapacityInventory {
  readonly schemaVersion: typeof REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION;
  readonly profileSha256: string;
  /** One owner-held capture window, never an observation's unrelated connection nonce. */
  readonly captureSha256: string;
  readonly areas: readonly RemoteWorkerCellCapacityInventoryArea[];
  readonly references: readonly RemoteWorkerCellCapacityInventoryReference[];
  /** Omitted by historical/non-native inventories; once retained, admission
   * must preserve this assignment's exact host layout on subsequent captures. */
  readonly nativeLayout?: RemoteWorkerNativeCapacityLayout;
}
/** Supplied independently by the admitted inventory owner. None of these hashes
 * grants authority by itself or proves that an OS scan was complete/quiescent. */
export interface RemoteWorkerCellCapacityInventoryBinding {
  readonly profileSha256: string;
  readonly captureSha256: string;
  readonly inventorySha256: string;
}
export interface RemoteWorkerCellCapacityAccounting extends RemoteWorkerCellCapacityInventoryBinding {
  readonly footprint: RemoteWorkerCellCapacityFootprint;
  readonly hostAllocatedBytes: number;
  readonly guestAllocatedBytes: number;
  readonly logicalReferenceBytes: number;
  readonly logicalReferenceCount: number;
  readonly hostFileCount: number;
  readonly hostDirectoryCount: number;
  readonly guestFileCount: number;
  readonly guestDirectoryCount: number;
}

const invalid = (reason: string) => new TypeError(`Cell capacity inventory ${reason}.`);
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) throw invalid("must contain plain records");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw invalid("has missing, unexpected or accessor fields");
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value as unknown]));
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid("requires bounded arrays");
  const fields = Object.getOwnPropertyDescriptors(value as object), length = fields.length?.value as unknown;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(fields).length !== length + 1) throw invalid("array exceeds its bound or is sparse");
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const field = fields[String(i)];
    if (!field?.enumerable || !("value" in field)) throw invalid("array contains an accessor or hole");
    result.push(field.value as unknown);
  }
  return result;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalid("requires exact SHA-256 identities");
  return value;
}
function bytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > REMOTE_WORKER_CELL_MAX_DISK_BYTES) throw invalid("contains an invalid byte count");
  return value;
}
function sum(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw invalid("total exceeds safe integer accounting");
  return value;
}
function normalizeObject(input: unknown): RemoteWorkerCellCapacityInventoryObject {
  const value = record(input, ["identitySha256", "kind", "logicalBytes", "allocatedBytes", "backingIdentitySha256"]);
  if (value.kind !== "file" && value.kind !== "directory" && value.kind !== "volume_backing") throw invalid("object kind is unsupported");
  const logicalBytes = bytes(value.logicalBytes), allocatedBytes = bytes(value.allocatedBytes);
  const backingIdentitySha256 = value.backingIdentitySha256 === null ? null : digest(value.backingIdentitySha256);
  if (value.kind === "directory" && logicalBytes !== 0) throw invalid("directories cannot supply logical file bytes");
  if (value.kind === "volume_backing" && (backingIdentitySha256 !== null || logicalBytes === 0)) throw invalid("requires a nonempty host volume backing");
  return Object.freeze({ identitySha256: digest(value.identitySha256), kind: value.kind, logicalBytes, allocatedBytes, backingIdentitySha256 });
}

/** Validate complete declared coverage, without inventing absent areas. Actual
 * collection, path/identity checks, shared-pool coverage and a stable capture
 * window remain obligations of the admitted native/container inventory owner. */
export function normalizeRemoteWorkerCellCapacityInventory(input: unknown): RemoteWorkerCellCapacityInventory {
  const hasLayout = !!input && typeof input === "object" && Object.hasOwn(input, "nativeLayout");
  const value = record(input, ["schemaVersion", "profileSha256", "captureSha256", "areas", "references", ...(hasLayout ? ["nativeLayout"] : [])]);
  if (value.schemaVersion !== REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION) throw invalid("schema is unsupported");
  const areas = new Map<RemoteWorkerCellCapacityCategory, RemoteWorkerCellCapacityInventoryArea>();
  const objects = new Map<string, RemoteWorkerCellCapacityInventoryObject>();
  for (const item of array(value.areas, REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.length)) {
    const area = record(item, ["category", "evidenceSha256", "objects"]);
    if (!REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.some(category => category === area.category) || areas.has(area.category as RemoteWorkerCellCapacityCategory)) throw invalid("area coverage is duplicated or unsupported");
    const entries = array(area.objects, REMOTE_WORKER_CELL_CAPACITY_INVENTORY_MAX_OBJECTS - objects.size).map(normalizeObject);
    for (const entry of entries) {
      if (objects.has(entry.identitySha256)) throw invalid("repeats a physical object identity");
      objects.set(entry.identitySha256, entry);
    }
    areas.set(area.category as RemoteWorkerCellCapacityCategory, Object.freeze({
      category: area.category as RemoteWorkerCellCapacityCategory, evidenceSha256: digest(area.evidenceSha256),
      objects: Object.freeze(entries.sort((a, b) => a.identitySha256 < b.identitySha256 ? -1 : a.identitySha256 === b.identitySha256 ? 0 : 1)),
    }));
  }
  if (areas.size !== REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.length) throw invalid("does not cover every footprint area");
  const nativeLayout = hasLayout ? normalizeRemoteWorkerNativeCapacityLayout(value.nativeLayout) : undefined;
  if (nativeLayout) {
    if (nativeLayout.profileSha256 !== value.profileSha256) throw invalid("native layout profile differs from inventory");
    REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.forEach((category, index) => {
      const root = remoteWorkerNativeCapacityIdentitySha256(nativeLayout.rootIdentityHex[index]);
      if (!areas.get(category)!.objects.some(object => object.identitySha256 === root && object.kind === "directory" && object.backingIdentitySha256 === null))
        throw invalid("does not contain the native host root in its recorded area");
    });
  }
  for (const object of objects.values()) {
    if (object.backingIdentitySha256 !== null) {
      const backing = objects.get(object.backingIdentitySha256);
      if (!backing || backing.kind !== "volume_backing" || backing.backingIdentitySha256 !== null) throw invalid("guest allocation has no unique host backing");
    }
  }
  const referenceIds = new Set<string>();
  const references = array(value.references, REMOTE_WORKER_CELL_CAPACITY_INVENTORY_MAX_OBJECTS).map(item => {
    const reference = record(item, ["referenceSha256", "objectIdentitySha256"]);
    const referenceSha256 = digest(reference.referenceSha256), objectIdentitySha256 = digest(reference.objectIdentitySha256);
    if (referenceIds.has(referenceSha256) || objects.get(objectIdentitySha256)?.kind !== "file") throw invalid("logical reference is duplicate, absent or not a file");
    referenceIds.add(referenceSha256);
    return Object.freeze({ referenceSha256, objectIdentitySha256 });
  }).sort((a, b) => a.referenceSha256 < b.referenceSha256 ? -1 : a.referenceSha256 === b.referenceSha256 ? 0 : 1);
  return Object.freeze({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION,
    profileSha256: digest(value.profileSha256), captureSha256: digest(value.captureSha256),
    areas: Object.freeze(REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.map(category => areas.get(category)!)),
    references: Object.freeze(references), ...(nativeLayout ? { nativeLayout } : {}) });
}

export function remoteWorkerCellCapacityInventorySha256(input: unknown): string {
  return remoteWorkerCellCanonicalSha256(normalizeRemoteWorkerCellCapacityInventory(input));
}

/** Charge host allocation once. Guest allocation remains separate because its
 * physical storage is already charged through the backing object. Repeated
 * logical CAS references each charge their file bytes without duplicating host
 * allocation. Callers must retain the input and independent owner binding. */
export function accountRemoteWorkerCellCapacityInventory(input: unknown, expected: RemoteWorkerCellCapacityInventoryBinding): RemoteWorkerCellCapacityAccounting {
  const binding = record(expected, ["profileSha256", "captureSha256", "inventorySha256"]);
  const inventory = normalizeRemoteWorkerCellCapacityInventory(input);
  const inventorySha256 = remoteWorkerCellCanonicalSha256(inventory);
  if (inventory.profileSha256 !== digest(binding.profileSha256) || inventory.captureSha256 !== digest(binding.captureSha256) || inventorySha256 !== digest(binding.inventorySha256)) throw invalid("differs from its independent profile, capture or inventory binding");
  const physical: Record<string, number | string> = { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION };
  const objects = new Map<string, RemoteWorkerCellCapacityInventoryObject>();
  let guestAllocatedBytes = 0, logicalReferenceBytes = 0;
  let hostFileCount = 0, hostDirectoryCount = 0, guestFileCount = 0, guestDirectoryCount = 0;
  for (const area of inventory.areas) {
    let allocated = 0;
    for (const object of area.objects) {
      objects.set(object.identitySha256, object);
      if (object.backingIdentitySha256 === null) {
        allocated = sum(allocated, object.allocatedBytes);
        if (object.kind === "directory") hostDirectoryCount++; else hostFileCount++;
      } else {
        guestAllocatedBytes = sum(guestAllocatedBytes, object.allocatedBytes);
        if (object.kind === "directory") guestDirectoryCount++; else guestFileCount++;
      }
    }
    physical[area.category] = allocated;
  }
  for (const reference of inventory.references) logicalReferenceBytes = sum(logicalReferenceBytes, objects.get(reference.objectIdentitySha256)!.logicalBytes);
  const footprint = normalizeRemoteWorkerCellCapacityFootprint(physical as unknown as RemoteWorkerCellCapacityFootprint);
  return Object.freeze({ profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
    inventorySha256, footprint, hostAllocatedBytes: remoteWorkerCellCapacityFootprintTotalBytes(footprint),
    guestAllocatedBytes, logicalReferenceBytes, logicalReferenceCount: inventory.references.length,
    hostFileCount, hostDirectoryCount, guestFileCount, guestDirectoryCount });
}
