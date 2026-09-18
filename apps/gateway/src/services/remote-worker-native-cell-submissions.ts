import { exchangeRemoteWorkerCellProvisioning, prepareRemoteWorkerCellProvisioning,
  type RemoteWorkerCellProvisioningExchangePort } from "./remote-worker-cell-provisioning-exchange.js";
import { exchangeRemoteWorkerCellCapacity, type RemoteWorkerCellCapacityExchangePort } from "./remote-worker-cell-capacity-exchange.js";
import { exchangeRemoteWorkerCellBackingCapacity, type RemoteWorkerCellBackingCapacityExchangePort } from "./remote-worker-cell-backing-capacity-exchange.js";
import type { RemoteWorkerCellObjectInventoryExchangePort } from "./remote-worker-cell-object-inventory-exchange.js";
import { exchangeRemoteWorkerCellObjectInventoryPage, type RemoteWorkerCellObjectInventoryPageExchangePort } from "./remote-worker-cell-object-inventory-exchange.js";
import { exchangeRemoteWorkerNativeCapacityPage, type RemoteWorkerNativeCapacityPageExchangePort } from "./remote-worker-native-capacity-page-exchange.js";
import type { RemoteWorkerCellProvisioningSubmission, RemoteWorkerCellCapacitySubmission, RemoteWorkerCellBackingCapacitySubmission,
  RemoteWorkerCellPreparationSubmission, RemoteWorkerCellObjectInventoryPageSubmission, RemoteWorkerNativeCapacityPageSubmission } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerCellCapacityAuthority } from "@goatcitadel/storage";
import type { RemoteWorkerNativePoolPageSubmission, RemoteWorkerNativePoolCleanupPageSubmission } from "@goatcitadel/contracts";
import { exchangeRemoteWorkerNativePoolPage, type RemoteWorkerNativePoolExchangePort } from "./remote-worker-native-pool-exchange.js";
export interface NativeCellSubmissionOwners {
  readonly cellProvisioning?: RemoteWorkerCellProvisioningExchangePort;
  readonly cellCapacity?: RemoteWorkerCellCapacityExchangePort;
  readonly cellBackingCapacity?: RemoteWorkerCellBackingCapacityExchangePort;
  readonly cellObjectInventory?: RemoteWorkerCellObjectInventoryExchangePort;
  readonly cellObjectInventoryPages?: RemoteWorkerCellObjectInventoryPageExchangePort;
  readonly nativeCapacityPages?: RemoteWorkerNativeCapacityPageExchangePort;
  readonly nativePool?: RemoteWorkerNativePoolExchangePort;
}
export type NativeCellSubmission = RemoteWorkerCellProvisioningSubmission | RemoteWorkerCellCapacitySubmission | RemoteWorkerCellBackingCapacitySubmission |
  RemoteWorkerCellPreparationSubmission | RemoteWorkerCellObjectInventoryPageSubmission | RemoteWorkerNativeCapacityPageSubmission | RemoteWorkerNativePoolPageSubmission | RemoteWorkerNativePoolCleanupPageSubmission;
export function isNativeCellSubmission(value: { kind: string }): value is NativeCellSubmission {
  return ["cell.native_pool.page", "cell.native_pool.cleanup.page", "cell.native_capacity.page", "cell.native_capacity.lookup", "cell.object_inventory.page", "cell.object_inventory.page_snapshot",
    "cell.backing_capacity.snapshot", "cell.backing_capacity.observation", "cell.capacity.snapshot", "cell.capacity.observation", "cell.provisioning.prepare",
    "cell.provisioning.snapshot", "cell.provisioning.checkpoint", "cell.volume.checkpoint", "cell.format.checkpoint", "cell.protection.checkpoint",
    "cell.mount.checkpoint", "cell.mounted-workspace.checkpoint"].includes(value.kind);
}
/** Cell provisioning and observation dispatch remains inside the signed route.
 * Owners retain approval, custody, capacity and transactional authority checks. */
export async function dispatchNativeCellSubmission(owners: NativeCellSubmissionOwners,
  input: ReturnType<typeof snapshotRemoteWorkerCellCapacityAuthority> & { submission: NativeCellSubmission; signal: AbortSignal }) {
  const authority = snapshotRemoteWorkerCellCapacityAuthority(input), submission = input.submission;
  input.signal.throwIfAborted();
  if (submission.kind === "cell.native_pool.page" || submission.kind === "cell.native_pool.cleanup.page") {
    const nativePoolPage = await exchangeRemoteWorkerNativePoolPage(owners.nativePool, { ...authority, submission, signal: input.signal });
    return submission.kind === "cell.native_pool.cleanup.page"
      ? ({ disposition: "native_pool_cleanup_page", nativePoolPage } as const)
      : ({ disposition: "native_pool_page", nativePoolPage } as const);
  }
  if (submission.kind === "cell.native_capacity.page" || submission.kind === "cell.native_capacity.lookup") {
    const nativeCapacityPage = await exchangeRemoteWorkerNativeCapacityPage(owners.nativeCapacityPages,
      { ...authority, submission, signal: input.signal });
    return ({ disposition: "native_capacity_page", nativeCapacityPage } as const);
  }
  if (submission.kind === "cell.object_inventory.page" || submission.kind === "cell.object_inventory.page_snapshot") {
    const cellObjectInventoryPage = await exchangeRemoteWorkerCellObjectInventoryPage(owners.cellObjectInventoryPages,
      { ...authority, submission, signal: input.signal });
    return ({ disposition: "cell_object_inventory_page", cellObjectInventoryPage } as const);
  }
  if (submission.kind === "cell.backing_capacity.snapshot" || submission.kind === "cell.backing_capacity.observation") {
    const cellBackingCapacity = await exchangeRemoteWorkerCellBackingCapacity(owners.cellBackingCapacity,
      { ...authority, submission, signal: input.signal });
    return ({ disposition: submission.kind === "cell.backing_capacity.snapshot" ? "cell_backing_capacity_snapshot" : "cell_backing_capacity_recorded", cellBackingCapacity } as const);
  }
  if (submission.kind === "cell.capacity.snapshot" || submission.kind === "cell.capacity.observation") {
    const cellCapacity = await exchangeRemoteWorkerCellCapacity(owners.cellCapacity,
      { ...authority, submission, signal: input.signal });
    return ({ disposition: submission.kind === "cell.capacity.snapshot" ? "cell_capacity_snapshot" : "cell_capacity_recorded", cellCapacity } as const);
  }
  if (submission.kind === "cell.provisioning.prepare") {
    const cellPreparation = await prepareRemoteWorkerCellProvisioning(owners.cellProvisioning,
      { ...authority, submission, signal: input.signal });
    return ({ disposition: "cell_provisioning_prepared", cellPreparation } as const);
  }
  if (submission.kind === "cell.provisioning.snapshot" || submission.kind === "cell.provisioning.checkpoint" ||
      submission.kind === "cell.volume.checkpoint" || submission.kind === "cell.format.checkpoint" ||
      submission.kind === "cell.protection.checkpoint" || submission.kind === "cell.mount.checkpoint" || submission.kind === "cell.mounted-workspace.checkpoint") {
    const cellProvisioning = await exchangeRemoteWorkerCellProvisioning(owners.cellProvisioning,
      { ...authority, submission, signal: input.signal });
    return ({ disposition: "cell_provisioning_recorded", cellProvisioning } as const);
  }
  throw new Error("Unsupported native cell submission.");
}
