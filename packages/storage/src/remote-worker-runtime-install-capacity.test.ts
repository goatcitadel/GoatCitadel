import assert from "node:assert/strict";
import { it } from "node:test";
import { accountRemoteWorkerCellCapacityInventory, remoteWorkerCellCanonicalSha256,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerNativeCapacityIdentitySha256,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION, REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { nativeCapacityCompositionFixture } from "../../contracts/src/remote-worker-native-capacity-composition-test-fixture.js";
import { nativePoolCapacityFixture } from "../../contracts/src/remote-worker-native-pool-capacity-test-fixture.js";
import { assertRuntimeInstallFitsCapturedCapacity } from "./remote-worker-runtime-install-capacity.js";

function fixture() {
  const native = nativeCapacityCompositionFixture({ guestLogicalBytes: 9000 }), inventory = native.compose();
  const bundle = { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
    { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) },
    { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
  ] };
  const inventoryBinding = { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
    inventorySha256: remoteWorkerCellCanonicalSha256(inventory) };
  const accounting = accountRemoteWorkerCellCapacityInventory(inventory, inventoryBinding);
  const guestBytes = inventory.areas.flatMap(area => area.objects).filter(object => object.backingIdentitySha256 !== null)
    .reduce((total, object) => total + object.logicalBytes, 0);
  const files = accounting.hostFileCount + accounting.guestFileCount + 2;
  const capacity = { inventory, inventoryBinding,
    expectedCapacityRevision: 1, expectedExecutionRevision: 1, expectedCleanupRevision: 1, expectedBackupRevision: 1,
    observation: { incomingBytes: 0, peakDiskBytes: 0, peakMemoryBytes: 0, peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0,
      reservation: { schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
        logicalDiskBytes: guestBytes + 120, allocatedDiskBytes: 256 * 1024 * 1024,
        fileLimit: files, inodeLimit: files + accounting.hostDirectoryCount + accounting.guestDirectoryCount,
        processLimit: 2, cpuLimitMilli: 1000, wallLimitMs: 60000, memoryLimitBytes: 64 * 1024 * 1024,
        rawOutputLimitBytes: 65536, diagnosticLimitBytes: 65536, artifactCeilingBytes: 65536,
        backupStagingBytes: 65536, backupPublicationBytes: 65536 } } };
  return { history: native.history, bundle, capacity };
}

it("admits exact guest-byte/file/inode boundaries without charging the preallocated host backing again", () => {
  const f = fixture();
  assertRuntimeInstallFitsCapturedCapacity(f.history, f.bundle, f.capacity);
});

for (const limit of ["logicalDiskBytes", "fileLimit", "inodeLimit"] as const) it(`refuses installation beyond captured ${limit}`, () => {
  const f = fixture();
  f.capacity.observation.reservation[limit]--;
  assert.throws(() => assertRuntimeInstallFitsCapturedCapacity(f.history, f.bundle, f.capacity), /captured guest capacity/u);
});

it("enforces the actual guest disk size even when the logical profile allows more", () => {
  const f = fixture();
  f.capacity.observation.reservation.logicalDiskBytes = 256 * 1024 * 1024;
  f.bundle.files[0]!.bytes = f.history.plan.virtualDiskBytes;
  assert.throws(() => assertRuntimeInstallFitsCapturedCapacity(f.history, f.bundle, f.capacity), /captured guest capacity/u);
});

it("refuses a changed inventory binding rather than trusting its projected totals", () => {
  const f = fixture();
  f.capacity.inventoryBinding.inventorySha256 = "aa".repeat(32);
  assert.throws(() => assertRuntimeInstallFitsCapturedCapacity(f.history, f.bundle, f.capacity));
});

it("projects bytes into the target guest rather than charging another retained cell's logical files", () => {
  const f = fixture(), pool = nativePoolCapacityFixture(2), original = pool.compose();
  const backing = remoteWorkerNativeCapacityIdentitySha256(readRemoteWorkerCellProvisioningCheckpoint(f.history.records[4]!).backingIdentityHex!);
  const inventory = { ...original, areas: original.areas.map(area => ({ ...area, objects: area.objects.map(object =>
    object.backingIdentitySha256 === backing && object.logicalBytes > 0 ? { ...object, logicalBytes: 9000 } : object) })) };
  assert.ok(inventory.areas.flatMap(area => area.objects).some(object => object.backingIdentitySha256 !== null &&
    object.backingIdentitySha256 !== backing && object.logicalBytes > f.history.plan.virtualDiskBytes));
  const capacity = { ...f.capacity, inventory, inventoryBinding: { profileSha256: inventory.profileSha256,
    captureSha256: inventory.captureSha256, inventorySha256: remoteWorkerCellCanonicalSha256(inventory) },
    observation: { ...f.capacity.observation, reservation: { ...f.capacity.observation.reservation, fileLimit: 100, inodeLimit: 200 } } };
  assertRuntimeInstallFitsCapturedCapacity(f.history, f.bundle, capacity);
});
