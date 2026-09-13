import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { exchangeWorkerCellProvisioning, prepareWorkerCellProvisioning } from "./worker-cell-provisioning-client.js";
import { provisionWorkerCell, type WorkerCellProvisioningResult } from "./worker-cell-provisioning-coordinator.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import { renewWorkerLeaseControl } from "./worker-lease-control.js";
import { requireWorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
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
  if (process.platform !== "win32" || !input.context.credential.protectedKey) throw new Error("Native cells require protected Windows worker custody.");
  const protectedKeys = requireWorkerProtectedKeyOwner(input.context.credential.protectedKey, input.context.protectedKeys);
  const context = Object.freeze({ ...input.context, credential: Object.freeze({ ...input.context.credential }), protectedKeys });
  if (input.lease.registryWorkspaceId !== context.credential.registryWorkspaceId)
    throw new Error("Native cell assignment differs from its current worker authority.");
  let lease = Object.freeze({ ...input.lease });
  const stop = new AbortController();
  const signal = AbortSignal.any([input.signal, stop.signal, AbortSignal.timeout(600000)]);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | undefined;
  let closed = false;
  const assertCurrent = (): Promise<void> => {
    if (current) return current;
    current = (async () => {
      signal.throwIfAborted();
      if (closed) throw new Error("Native cell startup has closed.");
      const refreshed = await renewWorkerLeaseControl({ context, owner: input.owner, lease,
        workerSentThrough: input.owner.workerSentThrough(), observed: input.observed });
      // Retain the rotated lease even when the subsequent control read cancels
      // work. No checkpoint RPC ever uses the original captured lease revision.
      lease = Object.freeze({ ...refreshed.lease });
      signal.throwIfAborted();
      const remaining = input.owner.remainingLeaseMs();
      if (closed || refreshed.control.body.disposition !== "active" || !Number.isFinite(remaining) || remaining < 100 || remaining > 900000)
        throw new Error("Native cell startup lost current assignment authority.");
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => stop.abort(), remaining);
    })().catch((error: unknown) => { stop.abort(); throw error; }).finally(() => { current = undefined; });
    return current;
  };
  try {
    const custody = await readWindowsWorkerCellControllerCustody({ wallMs: 10000, signal,
      assertCurrent, imageGuard: input.imageGuard });
    const provisioning = await provisionWorkerCell({ scope: lease, state: input.state, custody, signal, assertCurrent, requireMountedWorkspace: true,
      prepare: (submission, callSignal) => prepareWorkerCellProvisioning(context, lease, submission, callSignal),
      exchange: (submission, callSignal) => exchangeWorkerCellProvisioning(context, lease, submission, callSignal),
      native: (options) => createWindowsWorkerCellProvisioning({ ...options, parentPath: custody.parentPath,
        controllerService: true, assertCurrent, imageGuard: input.imageGuard }),
    });
    return { lease, provisioning };
  } finally {
    closed = true; stop.abort(); clearTimeout(expiryTimer);
    // The native helper races cancellation with checks. Join the precise check
    // still retaining a lease so it cannot write after this owner has returned.
    if (current) await current.catch(() => undefined);
  }
}
