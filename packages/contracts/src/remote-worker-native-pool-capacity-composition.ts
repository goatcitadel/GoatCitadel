import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { normalizeRemoteWorkerNativePoolSnapshot, type RemoteWorkerNativePoolSnapshot } from "./remote-worker-native-pool.js";
import { readRemoteWorkerCellObjectInventoryHistory } from "./remote-worker-cell-object-inventory.js";
import { readRemoteWorkerCellBackingCapacityHistoryObservation } from "./remote-worker-cell-backing-capacity.js";
import { readRemoteWorkerNativeCapacityCapture } from "./remote-worker-native-capacity-capture.js";
import { remoteWorkerNativeCapacityIdentitySha256 as identity } from "./remote-worker-native-capacity-layout.js";
import { normalizeRemoteWorkerCellCapacityInventory, REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CAPACITY_INVENTORY_MAX_OBJECTS, type RemoteWorkerCellCapacityInventoryObject } from "./remote-worker-cell-capacity-inventory.js";

export interface RemoteWorkerNativePoolCapacityWindow {
  readonly nonce: string;
  readonly connectionNonceHex: string;
  readonly poolSnapshotSha256: string;
  readonly hostCaptureSha256: string;
  readonly membersSha256: string;
  readonly referencesSha256: string;
}
const refused = () => new TypeError("Native pool capacity does not match the complete independently retained capture.");
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value as unknown]));
}
function members(input: unknown, count: number) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length !== count ||
      Reflect.ownKeys(input).length !== count + 1) throw refused();
  const fields = Object.getOwnPropertyDescriptors(input);
  return Array.from({ length: count }, (_, index) => {
    const field = fields[String(index)];
    if (!field?.enumerable || !("value" in field)) throw refused();
    return record(field.value, ["guestObservationHex", "guestChunkHex", "backingObservationHex"]);
  });
}
export function normalizeRemoteWorkerNativePoolCapacityWindow(input: unknown): RemoteWorkerNativePoolCapacityWindow {
  const value = record(input, ["nonce", "connectionNonceHex", "poolSnapshotSha256", "hostCaptureSha256", "membersSha256", "referencesSha256"]);
  if (Object.values(value).some(item => typeof item !== "string" || !/^[0-9a-f]{64}$/u.test(item) || /^0+$/u.test(item))) throw refused();
  return Object.freeze(value) as unknown as RemoteWorkerNativePoolCapacityWindow;
}

/** One host capture plus all admitted guest trees. Historical members carry no
 * fabricated lease. Matching bytes do not grant collection or write authority. */
export function composeRemoteWorkerNativePoolCapacityInventory(input: unknown, retained: RemoteWorkerNativePoolSnapshot,
  retainedLayout: unknown, expected: RemoteWorkerNativePoolCapacityWindow) {
  const source = record(input, ["hostCaptureHex", "members", "references"]);
  const pool = normalizeRemoteWorkerNativePoolSnapshot(retained), window = normalizeRemoteWorkerNativePoolCapacityWindow(expected);
  if (!pool.members.length || remoteWorkerCellCanonicalSha256(pool) !== window.poolSnapshotSha256) throw refused();
  const active = pool.members.find(member => member.assignmentId === pool.assignmentId && member.assignmentGeneration === pool.assignmentGeneration);
  if (!active?.history || active.workerGeneration !== pool.workerGeneration) throw refused();
  const host = readRemoteWorkerNativeCapacityCapture(source.hostCaptureHex, window.nonce, retainedLayout);
  if (host.captureSha256 !== window.hostCaptureSha256 || host.nativeLayout.assignmentBindingSha256 !== active.history.plan.assignmentBindingSha256 ||
      host.nativeLayout.profileSha256 !== active.history.plan.profileSha256 || host.nativeLayout.rootIdentityHex[0] !== active.history.plan.parentIdentityHex) throw refused();
  const supplied = members(source.members, pool.members.length);
  const objects = new Map(host.areas.flatMap(area => area.objects.map(object => [object.identitySha256, object] as const)));
  const backingIds = new Set<string>(), journalIds = new Set<string>(), volumes = new Set<string>();
  const guestObjects: RemoteWorkerCellCapacityInventoryObject[] = [];
  const normalizedMembers = supplied.map((item, index) => {
    const history = pool.members[index]!.history;
    if (!history || history.plan.parentIdentityHex !== active.history!.plan.parentIdentityHex ||
        history.plan.ownerSid !== active.history!.plan.ownerSid || history.plan.controllerSid !== active.history!.plan.controllerSid) throw refused();
    const guest = readRemoteWorkerCellObjectInventoryHistory(item.guestObservationHex, item.guestChunkHex, history);
    const backing = readRemoteWorkerCellBackingCapacityHistoryObservation(item.backingObservationHex, history);
    const volume = guest.rootIdentityHex.slice(0, 16), backingId = identity(backing.backingIdentityHex), journalId = identity(backing.journalIdentityHex);
    if (guest.connectionNonceHex !== window.connectionNonceHex || backing.connectionNonceHex !== window.connectionNonceHex ||
        guest.checkpointSha256 !== backing.checkpointSha256 || guest.allocatedBytes > backing.virtualDiskBytes || volumes.has(volume) ||
        backingIds.has(backingId) || journalIds.has(journalId) || host.nativeLayout.rootIdentityHex.some(root => root.slice(0, 16) === volume) ||
        guest.entries.length > REMOTE_WORKER_CELL_CAPACITY_INVENTORY_MAX_OBJECTS - objects.size - guestObjects.length) throw refused();
    volumes.add(volume); backingIds.add(backingId); journalIds.add(journalId);
    for (const [id, logical, allocated] of [[backingId, backing.backingFileBytes, backing.backingAllocatedBytes],
      [journalId, backing.journalBytes, backing.journalAllocatedBytes]] as const) {
      const file = objects.get(id);
      if (!file || file.kind !== "file" || file.backingIdentitySha256 !== null || file.logicalBytes !== logical || file.allocatedBytes !== allocated) throw refused();
    }
    for (const raw of [backing.hostParentIdentityHex, ...backing.hostDirectoryIdentityHex]) {
      const directory = objects.get(identity(raw));
      if (!directory || directory.kind !== "directory" || directory.backingIdentitySha256 !== null) throw refused();
    }
    guestObjects.push(...guest.entries.map(entry => ({ identitySha256: identity(entry.identityHex), kind: entry.directory ? "directory" as const : "file" as const,
      logicalBytes: entry.logicalFileBytes, allocatedBytes: entry.allocatedBytes, backingIdentitySha256: backingId })));
    return { guestObservationHex: guest.observationHex, guestChunkHex: guest.chunkHex, backingObservationHex: backing.observationHex };
  });
  if (remoteWorkerCellCanonicalSha256(normalizedMembers) !== window.membersSha256) throw refused();
  const candidate = normalizeRemoteWorkerCellCapacityInventory({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION,
    profileSha256: host.nativeLayout.profileSha256, captureSha256: host.captureSha256, nativeLayout: host.nativeLayout,
    areas: host.areas.map(area => ({ ...area, objects: [
      ...area.objects.map(object => backingIds.has(object.identitySha256) ? { ...object, kind: "volume_backing" } : object),
      ...(area.category === "mutableRootBytes" ? guestObjects : []),
    ] })), references: source.references });
  const shared = new Set(candidate.areas.find(area => area.category === "immutableArtifactBytes")!.objects
    .filter(object => object.kind === "file" && object.backingIdentitySha256 === null && !journalIds.has(object.identitySha256)).map(object => object.identitySha256));
  if (candidate.references.some(reference => !shared.has(reference.objectIdentitySha256)) || remoteWorkerCellCanonicalSha256(candidate.references) !== window.referencesSha256) throw refused();
  const captureSha256 = remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-pool-capacity-window.v1", ...window });
  return Object.freeze({ ...candidate, captureSha256, areas: Object.freeze(candidate.areas.map(area => Object.freeze({ ...area,
    evidenceSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-pool-capacity-composed-area.v1", captureSha256, category: area.category }),
  }))) });
}
