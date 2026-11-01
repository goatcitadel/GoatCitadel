import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  completeChangePlanProviderOAuth,
  pollChangePlanProviderOAuth,
  startChangePlanProviderOAuth,
} from "@goatcitadel/mission-control-shared/api/client";

const SIGN_IN_MIN_POLL_MS = 1_000;
export const SIGN_IN_EXPIRED_MESSAGE = "Sign-in expired. Start it again.";

/** Waits `ms`, resolving early when the sign-in is cancelled. */
const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = globalThis.setTimeout(done, ms);
    function done() {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException("Provider sign-in was cancelled.", "AbortError");
};

/**
 * Starts the provider's device sign-in, opens its verification page and polls until it connects, fails, expires
 * or `signal` aborts. Every await is followed by an abort check, so a cancelled run never completes the plan.
 */
export async function runProviderSignIn(plan: ChangePlanRecord, workspaceId: string, signal: AbortSignal) {
  const action = plan.requiredAction;
  if (action?.kind !== "oauth") throw new Error("This sign-in action changed. Reopen the setup request.");
  const context = {
    workspaceId,
    ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}),
    ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}),
  };
  const exact = { expectedRevision: plan.revision, actionId: action.actionId, actionNonce: action.actionNonce };
  const flow = await startChangePlanProviderOAuth(plan.planId, context, exact);
  throwIfAborted(signal);
  globalThis.open?.(flow.verificationUrl, "_blank", "noopener,noreferrer");
  const expiresAt = Date.parse(flow.expiresAt);
  let pollAfterMs = flow.pollAfterMs;
  for (;;) {
    await sleepUnlessAborted(Math.max(SIGN_IN_MIN_POLL_MS, pollAfterMs), signal);
    throwIfAborted(signal);
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) throw new Error(SIGN_IN_EXPIRED_MESSAGE);
    const result = await pollChangePlanProviderOAuth(plan.planId, context, { ...exact, flowId: flow.flowId });
    throwIfAborted(signal);
    if (result.status === "pending") {
      pollAfterMs = result.retryAfterMs ?? flow.pollAfterMs;
      continue;
    }
    if (result.status === "expired") throw new Error(SIGN_IN_EXPIRED_MESSAGE);
    if (result.status !== "connected") {
      throw new Error(result.error ?? `Provider sign-in ${result.status}. Start it again.`);
    }
    const completed = await completeChangePlanProviderOAuth(plan.planId, context, exact);
    throwIfAborted(signal);
    return completed;
  }
}
