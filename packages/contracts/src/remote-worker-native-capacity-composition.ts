import { remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { normalizeRemoteWorkerCellProvisioningExchange, type RemoteWorkerCellProvisioningExchange } from "./remote-worker-cell-provisioning.js";
import { readRemoteWorkerCellObjectInventory } from "./remote-worker-cell-object-inventory.js";
import { readRemoteWorkerCellBackingCapacityObservation } from "./remote-worker-cell-backing-capacity.js";
import { readRemoteWorkerNativeCapacityCapture } from "./remote-worker-native-capacity-capture.js";
import { remoteWorkerNativeCapacityIdentitySha256 } from "./remote-worker-native-capacity-layout.js";
import { normalizeRemoteWorkerCellCapacityInventory, REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION,
  type RemoteWorkerCellCapacityInventory, type RemoteWorkerCellCapacityInventoryObject } from "./remote-worker-cell-capacity-inventory.js";

export interface RemoteWorkerNativeCapacityCompositionBinding {
  readonly nonce: string;
  readonly hostCaptureSha256: string;
  readonly guestObservationSha256: string;
  readonly backingObservationSha256: string;
  readonly referencesSha256: string;
}
const refused = () => new TypeError("Native capacity sources do not match their independently retained capture window.");
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input) as object | null)) throw refused();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw refused();
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value as unknown]));
}

export function normalizeRemoteWorkerNativeCapacityCompositionBinding(input: unknown): RemoteWorkerNativeCapacityCompositionBinding {
  const window = record(input, ["nonce", "hostCaptureSha256", "guestObservationSha256", "backingObservationSha256", "referencesSha256"]);
  if (Object.values(window).some(value => typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value))) throw refused();
  return Object.freeze(window) as unknown as RemoteWorkerNativeCapacityCompositionBinding;
}

/** Join source-verified observations without charging guest allocation twice.
 * The native owner must independently retain every source digest while keeping
 * the complete pool quiescent. Matching bytes do not prove that ownership or
 * enable installed collection, admission, reservations or quotas. */
export function composeRemoteWorkerNativeCapacityInventory(input: unknown,
  retained: RemoteWorkerCellProvisioningExchange, retainedLayout: unknown,
  expectedWindow: RemoteWorkerNativeCapacityCompositionBinding): RemoteWorkerCellCapacityInventory {
  const source = record(input, ["hostCaptureHex", "guestObservationHex", "guestChunkHex", "backingObservationHex", "references"]);
  const window = normalizeRemoteWorkerNativeCapacityCompositionBinding(expectedWindow);
  const history = normalizeRemoteWorkerCellProvisioningExchange(retained);
  const host = readRemoteWorkerNativeCapacityCapture(source.hostCaptureHex, window.nonce, retainedLayout);
  const guest = readRemoteWorkerCellObjectInventory(source.guestObservationHex, source.guestChunkHex, history);
  const backing = readRemoteWorkerCellBackingCapacityObservation(source.backingObservationHex, history);
  const guestDigest = remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-guest-source.v1",
    observationHex: guest.observationHex, chunkHex: guest.chunkHex });
  const backingDigest = remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-backing-source.v1",
    observationHex: backing.observationHex });
  if (host.captureSha256 !== window.hostCaptureSha256 || guestDigest !== window.guestObservationSha256 || backingDigest !== window.backingObservationSha256 ||
      host.nativeLayout.assignmentBindingSha256 !== history.plan.assignmentBindingSha256 || host.nativeLayout.profileSha256 !== history.plan.profileSha256 ||
      guest.checkpointSha256 !== backing.checkpointSha256 || guest.allocatedBytes > backing.virtualDiskBytes ||
      host.nativeLayout.rootIdentityHex.some(identity => identity.slice(0, 16) === guest.entries[0]!.identityHex.slice(0, 16))) throw refused();
  const identity = remoteWorkerNativeCapacityIdentitySha256;
  const backingId = identity(backing.backingIdentityHex), journalId = identity(backing.journalIdentityHex);
  const objects = new Map(host.areas.flatMap(area => area.objects.map(object => [object.identitySha256, object] as const)));
  const requireFile = (key: string, logical: number, allocated: number) => {
    const object = objects.get(key);
    if (!object || object.kind !== "file" || object.backingIdentitySha256 !== null || object.logicalBytes !== logical || object.allocatedBytes !== allocated) throw refused();
  };
  requireFile(backingId, backing.backingFileBytes, backing.backingAllocatedBytes);
  requireFile(journalId, backing.journalBytes, backing.journalAllocatedBytes);
  for (const raw of [backing.hostParentIdentityHex, ...backing.hostDirectoryIdentityHex]) {
    const object = objects.get(identity(raw));
    if (!object || object.kind !== "directory" || object.backingIdentitySha256 !== null) throw refused();
  }
  const guestObjects: RemoteWorkerCellCapacityInventoryObject[] = guest.entries.map(entry => ({
    identitySha256: identity(entry.identityHex), kind: entry.directory ? "directory" : "file",
    logicalBytes: entry.logicalFileBytes, allocatedBytes: entry.allocatedBytes, backingIdentitySha256: backingId,
  }));
  const candidate = normalizeRemoteWorkerCellCapacityInventory({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION,
    profileSha256: host.nativeLayout.profileSha256, captureSha256: host.captureSha256, nativeLayout: host.nativeLayout,
    areas: host.areas.map(area => ({ ...area, objects: [
      ...area.objects.map(object => object.identitySha256 === backingId ? { ...object, kind: "volume_backing" } : object),
      ...(area.category === "mutableRootBytes" ? guestObjects : []),
    ] })), references: source.references });
  const sharedFiles = new Set(candidate.areas.find(area => area.category === "immutableArtifactBytes")!.objects
    .filter(object => object.kind === "file" && object.backingIdentitySha256 === null && object.identitySha256 !== journalId).map(object => object.identitySha256));
  if (candidate.references.some(reference => !sharedFiles.has(reference.objectIdentitySha256)) ||
      remoteWorkerCellCanonicalSha256(candidate.references) !== window.referencesSha256) throw refused();
  const captureSha256 = remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-window.v1",
    assignmentBindingSha256: host.nativeLayout.assignmentBindingSha256, profileSha256: candidate.profileSha256,
    checkpointSha256: guest.checkpointSha256, ...window });
  return Object.freeze({ ...candidate, captureSha256, areas: Object.freeze(candidate.areas.map(area => Object.freeze({ ...area,
    evidenceSha256: remoteWorkerCellCanonicalSha256({ schemaVersion: "goatcitadel.native-capacity-composed-area.v1", captureSha256, category: area.category }),
  }))) });
}
