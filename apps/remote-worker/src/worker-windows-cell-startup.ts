import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { exchangeWorkerCellProvisioning, prepareWorkerCellProvisioning } from "./worker-cell-provisioning-client.js";
import { provisionWorkerCell, type WorkerCellProvisioningResult } from "./worker-cell-provisioning-coordinator.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import { withWindowsWorkerAssignmentAuthority } from "./worker-windows-assignment-authority.js";
import {
  createWindowsWorkerCellProvisioning, readWindowsWorkerCellControllerCustody,
  type WindowsWorkerCellProvisioningImageGuard,
} from "./worker-windows-cell-provisioning.js";

/** Trusted installed-service composition. Provisioning only: the assignment
 * runner must separately establish a real protected execution platform before
 * launching work. This is intentionally not enabled by foreground PEM config. */
export async function prepareWindowsWorkerAssignmentCell(input: {
  readonly context: RouteContext;
  readonly state: WorkerDurableStatePort;
  readonly owner: Pick<WorkerAssignmentLeaseOwner, "renew" | "remainingLeaseMs" | "workerSentThrough">;
  readonly lease: LeaseBinding;
  readonly signal: AbortSignal;
  readonly observed: Record<string, unknown>;
  readonly imageGuard?: WindowsWorkerCellProvisioningImageGuard;
}): Promise<{ readonly lease: LeaseBinding; readonly provisioning: WorkerCellProvisioningResult }> {
  return await withWindowsWorkerAssignmentAuthority(input, 600000, async ({ context, signal, assertCurrent, lease }) => {
    const custody = await readWindowsWorkerCellControllerCustody({ wallMs: 10000, signal,
      assertCurrent, imageGuard: input.imageGuard });
    const provisioning = await provisionWorkerCell({ scope: lease(), state: input.state, custody, signal, assertCurrent, requireMountedWorkspace: true,
      prepare: (submission, callSignal) => prepareWorkerCellProvisioning(context, lease(), submission, callSignal),
      exchange: (submission, callSignal) => exchangeWorkerCellProvisioning(context, lease(), submission, callSignal),
      native: (options) => createWindowsWorkerCellProvisioning({ ...options, parentPath: custody.parentPath,
        controllerService: true, assertCurrent, imageGuard: input.imageGuard }),
    });
    return { lease: lease(), provisioning };
  });
}
