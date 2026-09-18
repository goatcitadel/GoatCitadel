import { REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES, remoteWorkerCellCanonicalSha256 } from "./remote-worker-cell.js";
import { REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION,
  type RemoteWorkerCellCapacityInventoryObject, type RemoteWorkerCellCapacityInventory } from "./remote-worker-cell-capacity-inventory.js";
import { REMOTE_WORKER_NATIVE_CAPACITY_LAYOUT_SCHEMA, remoteWorkerNativeCapacityIdentitySha256 } from "./remote-worker-native-capacity-layout.js";

/** Controlled host-root identities for retention tests, never installed evidence. */
export function withNativeCapacityLayout(inventory: RemoteWorkerCellCapacityInventory, assignmentBindingSha256: string) {
  const rootIdentityHex = REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.map((_, index) =>
    "1100000000000000" + (index + 1).toString(16).padStart(32, "0"));
  return { ...inventory, nativeLayout: { schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_LAYOUT_SCHEMA,
    assignmentBindingSha256, profileSha256: inventory.profileSha256, rootIdentityHex },
    areas: inventory.areas.map((area, index) => ({ ...area, objects: [...area.objects, {
      identitySha256: remoteWorkerNativeCapacityIdentitySha256(rootIdentityHex[index]), kind: "directory" as const,
      logicalBytes: 0, allocatedBytes: 0, backingIdentitySha256: null,
    }] })) };
}

/** Controlled complete declared capture; never an OS or installed-host receipt. */
export function capacityInventoryFixture(profileSha256: string, seed: string) {
  const digest = (id: string) => remoteWorkerCellCanonicalSha256({ seed, id });
  const areas = REMOTE_WORKER_CELL_CAPACITY_FOOTPRINT_CATEGORIES.map(category => ({ category,
    evidenceSha256: digest(category), objects: [] as RemoteWorkerCellCapacityInventoryObject[] }));
  areas[0]!.objects.push({ identitySha256: digest("backing"), kind: "volume_backing", logicalBytes: 65_536,
    allocatedBytes: 69_632, backingIdentitySha256: null });
  areas[0]!.objects.push({ identitySha256: digest("guest"), kind: "file", logicalBytes: 9_000,
    allocatedBytes: 4_096, backingIdentitySha256: digest("backing") });
  areas[0]!.objects.push({ identitySha256: digest("directory"), kind: "directory", logicalBytes: 0,
    allocatedBytes: 512, backingIdentitySha256: digest("backing") });
  areas.find(area => area.category === "manifestBytes")!.objects.push({ identitySha256: digest("journal"), kind: "file",
    logicalBytes: 500, allocatedBytes: 4_096, backingIdentitySha256: null });
  areas.find(area => area.category === "immutableArtifactBytes")!.objects.push({ identitySha256: digest("artifact"), kind: "file",
    logicalBytes: 10_000, allocatedBytes: 12_288, backingIdentitySha256: null });
  return { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SCHEMA_VERSION, profileSha256, captureSha256: digest("capture"), areas,
    references: [
      { referenceSha256: digest("ref-guest"), objectIdentitySha256: digest("guest") },
      { referenceSha256: digest("ref-artifact-a"), objectIdentitySha256: digest("artifact") },
      { referenceSha256: digest("ref-artifact-b"), objectIdentitySha256: digest("artifact") },
    ] };
}
