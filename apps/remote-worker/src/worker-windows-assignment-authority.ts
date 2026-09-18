import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { readWorkerLeaseControl, renewWorkerLeaseControl } from "./worker-lease-control.js";
import { requireWorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";

export interface WindowsWorkerAssignmentAuthorityInput {
  readonly context: RouteContext;
  readonly owner: Pick<WorkerAssignmentLeaseOwner, "renew" | "remainingLeaseMs" | "workerSentThrough">;
  readonly lease: LeaseBinding;
  readonly signal: AbortSignal;
  readonly observed: Record<string, unknown>;
}
export interface WindowsWorkerAssignmentAuthority {
  readonly context: RouteContext;
  readonly signal: AbortSignal;
  lease(): LeaseBinding;
  assertCurrent(): Promise<void>;
  withCurrentLease<T>(operation: (lease: LeaseBinding) => Promise<T>): Promise<T>;
  withStableLease<T>(operation: (lease: LeaseBinding, check: () => Promise<void>) => Promise<T>): Promise<T>;
}

/** Shared installed custody/lease lifetime. Joining a late renewal is mandatory:
 * no caller returns while its own authority check can still rotate the lease. */
export async function withWindowsWorkerAssignmentAuthority<T>(input: WindowsWorkerAssignmentAuthorityInput,
  timeoutMs: number, work: (authority: WindowsWorkerAssignmentAuthority) => Promise<T>, autoRenew = false): Promise<T> {
  if (process.platform !== "win32" || !input.context.credential.protectedKey)
    throw new Error("Native cells require protected Windows worker custody.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 86400000)
    throw new Error("Native assignment lifetime is invalid.");
  const protectedKeys = requireWorkerProtectedKeyOwner(input.context.credential.protectedKey, input.context.protectedKeys);
  const context = Object.freeze({ ...input.context, credential: Object.freeze({ ...input.context.credential }), protectedKeys });
  if (input.lease.registryWorkspaceId !== context.credential.registryWorkspaceId)
    throw new Error("Native cell assignment differs from its current worker authority.");
  let lease = Object.freeze({ ...input.lease });
  const stop = new AbortController(), signal = AbortSignal.any([input.signal, stop.signal, AbortSignal.timeout(timeoutMs)]);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, current: Promise<void> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let held: Promise<void> | undefined;
  const assertCurrent = (): Promise<void> => {
    if (held) return held.then(() => assertCurrent());
    if (current) return current;
    current = (async () => {
      signal.throwIfAborted();
      if (closed) throw new Error("Native assignment authority has closed.");
      const refreshed = await renewWorkerLeaseControl({ context, owner: input.owner, lease,
        workerSentThrough: input.owner.workerSentThrough(), observed: input.observed });
      lease = Object.freeze({ ...refreshed.lease });
      signal.throwIfAborted();
      const remaining = input.owner.remainingLeaseMs();
      if (closed || refreshed.control.body.disposition !== "active" || !validRemainingLifetime(remaining))
        throw new Error("Native assignment lost current authority.");
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => stop.abort(), remaining);
      if (autoRenew) {
        clearTimeout(renewalTimer);
        renewalTimer = setTimeout(() => { void assertCurrent().catch(() => { stop.abort(); }); }, Math.floor(remaining / 2));
      }
    })().catch((error: unknown) => { stop.abort(); throw error; }).finally(() => { current = undefined; });
    return current;
  };
  const withCurrentLease = async <R>(operation: (binding: LeaseBinding) => Promise<R>): Promise<R> => {
    await assertCurrent();
    signal.throwIfAborted();
    if (held || closed) throw new Error("Native assignment lease is already held or closed.");
    let release!: () => void;
    held = new Promise<void>(resolve => { release = resolve; });
    try { const result = await operation(lease); signal.throwIfAborted(); return result; }
    finally { held = undefined; release(); }
  };
  const withStableLease = <R>(operation: (binding: LeaseBinding, check: () => Promise<void>) => Promise<R>): Promise<R> =>
    withCurrentLease(async binding => {
      // Renew and persist before entering the caller's writer-quiescent window.
      // Auto-renew waits on held; reads never re-enter that renewal queue.
      let active = true;
      const check = async () => {
        signal.throwIfAborted();
        if (!active || closed || !validRemainingLifetime(input.owner.remainingLeaseMs())) throw new Error("Native stable lease has expired.");
        const control = await readWorkerLeaseControl(context, binding);
        signal.throwIfAborted();
        if (!active || closed || !validRemainingLifetime(input.owner.remainingLeaseMs()) || control.body.disposition !== "active")
          throw new Error("Native stable lease lost current authority.");
      };
      try {
        await check();
        const result = await operation(binding, check);
        await check();
        return result;
      } catch (error) { stop.abort(); throw error; }
      finally { active = false; }
    });
  try {
    signal.throwIfAborted();
    return await work(Object.freeze({ context, signal, lease: () => lease, assertCurrent, withCurrentLease, withStableLease }));
  } finally {
    closed = true; stop.abort(); clearTimeout(expiryTimer); clearTimeout(renewalTimer);
    if (held) await held;
    if (current) await current.catch(() => undefined);
  }
}

function validRemainingLifetime(remaining: number): boolean {
  return Number.isFinite(remaining) && remaining >= 100 && remaining <= 900000;
}
