import type { RemoteWorkerCellCapacityExchange, RemoteWorkerCellBackingCapacityExchange } from "@goatcitadel/contracts";
import { observeAndRecordWorkerCellCapacityOnConnection } from "./worker-cell-capacity-client.js";
import { observeAndRecordWorkerCellBackingCapacityOnConnection } from "./worker-cell-backing-capacity-client.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import { withWindowsWorkerAssignmentAuthority, type WindowsWorkerAssignmentAuthorityInput } from "./worker-windows-assignment-authority.js";
import { readWindowsAssignmentCleanupOnLease } from "./worker-windows-assignment-cleanup.js";
import { readWorkerNativePoolCleanupOnLease } from "./worker-native-pool-client.js";
import { createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody,
  type WindowsWorkerCellProvisioningImageGuard } from "./worker-windows-cell-provisioning.js";

export interface WindowsWorkerAssignmentCapacityInput extends WindowsWorkerAssignmentAuthorityInput {
  readonly state: WorkerDurableStatePort;
  readonly imageGuard?: WindowsWorkerCellProvisioningImageGuard;
}

/** Installed read composition, not provisioning or readiness admission. The
 * native controller must independently supply its quiescent measurement owner.
 * Lease persistence precedes the native writer hold; exact observation/receipt
 * persistence follows it. A pending delivery is replayed without another scan. */
function observe(input: WindowsWorkerAssignmentCapacityInput, kind: "mounted"): Promise<RemoteWorkerCellCapacityExchange>;
function observe(input: WindowsWorkerAssignmentCapacityInput, kind: "backing"): Promise<RemoteWorkerCellBackingCapacityExchange>;
async function observe(input: WindowsWorkerAssignmentCapacityInput, kind: "mounted" | "backing") {
  return withWindowsWorkerAssignmentAuthority(input, 60000, async authority => {
    const custody = await readWindowsWorkerCellControllerCustody({ wallMs: 10000, signal: authority.signal,
      assertCurrent: authority.assertCurrent, imageGuard: input.imageGuard });
    return authority.withStableLease(async (lease, check) => {
      const driver = createWindowsWorkerCellProvisioning({ parentPath: custody.parentPath, controllerService: true,
        wallMs: 60000, signal: authority.signal, assertCurrent: check, imageGuard: input.imageGuard,
        readPoolCleanup: signal => readWorkerNativePoolCleanupOnLease({ context: authority.context, lease, signal, assertCurrent: check }),
        readCleanup: (expectedHistory, signal) => readWindowsAssignmentCleanupOnLease({
          context: authority.context, lease, signal, assertCurrent: check, expectedHistory }) });
      const scope = { registryWorkspaceId: lease.registryWorkspaceId, assignmentId: lease.assignmentId, assignmentGeneration: lease.assignmentGeneration };
      const shared = { context: authority.context, scope, currentLease: () => lease,
        state: input.state, signal: authority.signal, assertCurrent: check };
      return kind === "mounted"
        ? observeAndRecordWorkerCellCapacityOnConnection({ ...shared, observe: driver.observeCapacity })
        : observeAndRecordWorkerCellBackingCapacityOnConnection({ ...shared, observe: driver.observeBackingCapacity });
    });
  });
}

export function observeWindowsWorkerAssignmentCapacity(input: WindowsWorkerAssignmentCapacityInput) {
  return observe(input, "mounted");
}

export function observeWindowsWorkerAssignmentBackingCapacity(input: WindowsWorkerAssignmentCapacityInput) {
  return observe(input, "backing");
}
