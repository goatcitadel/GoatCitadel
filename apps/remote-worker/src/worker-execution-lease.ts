import type { readControl, LeaseBinding, RouteContext } from "./connected-worker-routes.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { renewWorkerLeaseControl } from "./worker-lease-control.js";

interface ExecutionLeaseOwner {
  renew: WorkerAssignmentLeaseOwner["renew"];
  remainingLeaseMs: WorkerAssignmentLeaseOwner["remainingLeaseMs"];
}

/** Retain one assignment's lease while awaiting Gateway work. A renewal or
 * control failure aborts the owned request and drains the exact pending renewal;
 * it does not mint a replacement assignment or retry an uncertain inference. */
export async function withRenewingWorkerLease<T>(
  input: {
    context: RouteContext;
    owner: ExecutionLeaseOwner;
    lease: LeaseBinding;
    workerSentThrough: number;
    observed: Record<string, unknown>;
    readControl?: typeof readControl;
  },
  execute: (lease: LeaseBinding, signal: AbortSignal) => Promise<T>,
): Promise<{ lease: LeaseBinding; value: T }> {
  const controller = new AbortController();
  let lease = input.lease;
  let renewal: Promise<void> | undefined;
  let nextTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failure: Error | undefined;
  const fail = (message: string): void => {
    failure ??= new Error(message);
    controller.abort();
  };
  const arm = (): void => {
    clearTimeout(expiryTimer);
    const remaining = input.owner.remainingLeaseMs();
    if (!Number.isFinite(remaining) || remaining < 150 || remaining > 900_000)
      throw new Error("Worker renewal has no sufficient bounded lease window.");
    expiryTimer = setTimeout(() => fail("Worker lease expired while execution was pending."), remaining);
    nextTimer = setTimeout(
      () => {
        renewal = renew().catch(() => fail("Worker lease renewal or control could not be confirmed."));
      },
      Math.min(5_000, Math.max(50, remaining / 3)),
    );
  };
  const renew = async (): Promise<void> => {
    const refreshed = await renewWorkerLeaseControl({ ...input, lease });
    lease = refreshed.lease;
    if (refreshed.control.body.disposition !== "active")
      throw new Error("Worker assignment was cancelled or is no longer active.");
    if (!stopped && !failure) arm();
  };
  try {
    // Renew and inspect cancellation before spending provider work. This also
    // avoids relying on a stale recovered renewal's timing projection.
    await renew();
    const value = await execute(lease, controller.signal);
    stopped = true;
    clearTimeout(nextTimer);
    await renewal;
    if (failure) throw failure;
    // A parent heartbeat can advance while the provider is working. Re-enter
    // the exact renewal fence before any subsequent worker publication.
    await renew();
    if (input.owner.remainingLeaseMs() <= 0) throw new Error("Worker completion lost its lease window.");
    return { lease, value };
  } finally {
    stopped = true;
    clearTimeout(nextTimer);
    clearTimeout(expiryTimer);
    controller.abort();
    await renewal;
  }
}
