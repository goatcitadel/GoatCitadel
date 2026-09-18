import { accountRemoteWorkerCellCapacityInventory, readRemoteWorkerCellProvisioningCheckpoint,
  remoteWorkerNativeCapacityIdentitySha256, type RemoteWorkerCellProvisioningHistory,
  type RemoteWorkerRuntimeBundleManifest } from "@goatcitadel/contracts";
import { RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import type { RemoteWorkerNativeCapacityPagesRepository } from "./remote-worker-native-capacity-pages-repo.js";

/** Project the reviewed copy into its own captured guest disk. The preallocated
 * backing already counts against host allocation; do not charge it twice.
 * This is an admission prerequisite, not live reservation or allocation proof. */
export function assertRuntimeInstallFitsCapturedCapacity(history: RemoteWorkerCellProvisioningHistory,
  bundle: RemoteWorkerRuntimeBundleManifest,
  capacity: ReturnType<RemoteWorkerNativeCapacityPagesRepository["readInstallationCapacityForAssignment"]>): void {
  const refuse = () => new RemoteWorkerCellConflictError("Runtime installation exceeds or lacks its captured guest capacity.");
  const backingHex = readRemoteWorkerCellProvisioningCheckpoint(history.records[4]!).backingIdentityHex;
  if (!backingHex) throw refuse();
  const backingId = remoteWorkerNativeCapacityIdentitySha256(backingHex);
  const accounting = accountRemoteWorkerCellCapacityInventory(capacity.inventory, capacity.inventoryBinding);
  const objects = capacity.inventory.areas.flatMap(area => area.objects);
  if (!objects.some(object => object.identitySha256 === backingId && object.kind === "volume_backing" && object.backingIdentitySha256 === null)) throw refuse();
  const guest = objects.filter(object => object.backingIdentitySha256 === backingId);
  if (!guest.some(object => object.kind === "directory")) throw refuse();
  const projectedLogical = guest.reduce((total, object) => total + object.logicalBytes, 0) + bundle.files.reduce((total, file) => total + file.bytes, 0);
  const files = accounting.hostFileCount + accounting.guestFileCount + bundle.files.length;
  const inodes = files + accounting.hostDirectoryCount + accounting.guestDirectoryCount;
  const limits = capacity.observation.reservation;
  if (!Number.isSafeInteger(projectedLogical) || projectedLogical > Math.min(history.plan.virtualDiskBytes, limits.logicalDiskBytes) ||
      files > limits.fileLimit || inodes > limits.inodeLimit) throw refuse();
}
