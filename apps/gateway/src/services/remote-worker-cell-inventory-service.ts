import {
  snapshotRemoteWorkerCellCapacityAuthority,
  snapshotRemoteWorkerCellCapacityInventoryAdmission,
  type RemoteWorkerCellCapacityAdmissionRepository,
  type RemoteWorkerCellCapacityAuthority,
  type RemoteWorkerCellCapacityInventoryAdmissionInput,
} from "@goatcitadel/storage";
import type { AwaitableOwnerMethods } from "./remote-worker-owner-port.js";

interface InventoryDependencies {
  readonly capacityAdmission: AwaitableOwnerMethods<
    RemoteWorkerCellCapacityAdmissionRepository,
    "admitInventory" | "readInventory"
  >;
}

/** Snapshot complete inventory requests before entering the protected storage
 * transaction owner. This port cannot provision cells or change their limits. */
export async function admitWorkerCellInventory(
  deps: InventoryDependencies,
  input: RemoteWorkerCellCapacityInventoryAdmissionInput,
) {
  return await deps.capacityAdmission.admitInventory(snapshotRemoteWorkerCellCapacityInventoryAdmission(input));
}

export async function readWorkerCellInventory(
  deps: InventoryDependencies,
  input: RemoteWorkerCellCapacityAuthority & { readonly capacityRevision: number },
) {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), capacityRevision = input.capacityRevision;
  if (!Number.isSafeInteger(capacityRevision) || capacityRevision < 1) throw new Error("Capacity inventory revision must be positive.");
  return await deps.capacityAdmission.readInventory(Object.freeze({ ...authority, capacityRevision }));
}
