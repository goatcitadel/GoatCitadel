import { useEffect, useRef, useSyncExternalStore } from "react";
import { fetchLlmConfig, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { captureMutationAttempt } from "@goatcitadel/mission-control-shared/api/client-core";
import { withFreshReads } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import { OTHER_GATEWAY, sentToConnectedGateway } from "../mutation-attempt-tracking";
import {
  classifyMutationAttempt,
  fetchMutationAttempt,
  matchRoutePattern,
  type MutationAttemptVerdict,
} from "@goatcitadel/mission-control-shared/api/mutation-attempts";

/**
 * `checkable`: the lost attempt is identified, so its outcome can be read from the Gateway's own record.
 * `outcome`: what the last outcome check found.
 */
export type ProviderMutation = {
  pending: boolean;
  uncertain?: string;
  checkable?: boolean;
  checking?: boolean;
  outcome?: string;
};
type AttemptMethod = "POST" | "PATCH" | "PUT" | "DELETE";
type TrackedAttempt = { attemptKey: string; method: AttemptMethod; routePattern: string; installation?: string };
const IDLE: ProviderMutation = { pending: false };
let mutation = IDLE;
// Keys only, never request bodies: the last attempt dispatched by the running mutation, and the one left uncertain.
let lastAttempt: TrackedAttempt | undefined;
let uncertainAttempt: TrackedAttempt | undefined;
/** The Gateway routes provider owners write through; an attempt on any other route is not checkable here. */
const PROVIDER_ROUTE_PATTERNS = [
  "/api/v1/settings",
  "/api/v1/llm/config",
  "/api/v1/secrets/providers/:providerId",
  "/api/v1/change-plans",
  "/api/v1/change-plans/:planId/confirmations",
  "/api/v1/change-plans/:planId/cancellations",
  "/api/v1/change-plans/:planId/provider-secret",
  "/api/v1/change-plans/:planId/provider-oauth-starts",
  "/api/v1/change-plans/:planId/provider-oauth-polls",
  "/api/v1/change-plans/:planId/provider-oauth-completions",
] as const;
const ATTEMPT_METHODS = new Set<string>(["POST", "PATCH", "PUT", "DELETE"]);
const UNCERTAIN =
  "Outcome uncertain. Further provider changes are locked in this app session. Refresh only inspects Gateway evidence; it cannot unlock an action without its receipt. Your draft is retained.";
const UNCERTAIN_CHECKABLE =
  "Outcome uncertain. Further provider changes are locked in this app session until the Gateway's record of this attempt is checked. Your draft is retained.";
const STILL_LOCKED: Partial<Record<MutationAttemptVerdict, string>> = {
  in_progress: "The Gateway is still running this provider change. Changes stay locked; check again shortly.",
  unknown:
    "The Gateway's claim on this provider change expired without a recorded outcome. Changes stay locked in this app session; inspect provider activity.",
  resend_same_key:
    "The Gateway has no record of this provider change yet, so it may still arrive. Changes stay locked; check again shortly. If this persists, verify the provider settings, then reload the app.",
};
const listeners = new Set<() => void>();
function publish(next: ProviderMutation) {
  mutation = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** App-session coordination shared by both Settings shells. Never stores submitted credentials. */
export function useProviderMutationState() {
  return useSyncExternalStore(
    subscribe,
    () => mutation,
    () => IDLE,
  );
}
export function readProviderMutationState() {
  return mutation;
}
export function beginProviderMutation() {
  if (mutation.pending || mutation.uncertain) return false;
  lastAttempt = undefined;
  publish({ pending: true });
  return true;
}
export function finishProviderMutation() {
  publish({ ...mutation, pending: false });
}
/** Every provider write goes through here so a lost response leaves the identity of the attempt behind. */
export function dispatchProviderMutation<T>(dispatch: () => Promise<T>): Promise<T> {
  // A write the capture cannot identify must never inherit the key of an earlier write in the same run.
  lastAttempt = undefined;
  return captureMutationAttempt(dispatch, (attempt) => {
    const routePattern = matchRoutePattern(attempt.path, PROVIDER_ROUTE_PATTERNS);
    lastAttempt =
      routePattern && ATTEMPT_METHODS.has(attempt.method)
        ? {
            attemptKey: attempt.attemptKey,
            method: attempt.method as AttemptMethod,
            routePattern,
            ...(attempt.installation ? { installation: attempt.installation } : {}),
          }
        : undefined;
  });
}
export function retainProviderMutationUncertainty() {
  uncertainAttempt = lastAttempt;
  publish({
    pending: false,
    uncertain: uncertainAttempt ? UNCERTAIN_CHECKABLE : UNCERTAIN,
    checkable: Boolean(uncertainAttempt),
  });
}

/**
 * Settles an uncertain provider change from the Gateway's record of that exact attempt. Only a committed or released
 * attempt unlocks, and only after a canonical readback succeeds; a released attempt is not proof that nothing was
 * applied, so the operator reviews the reloaded settings either way. Any other answer, or any failure, keeps the lock.
 */
export async function checkProviderMutationOutcome(reload: () => Promise<unknown>): Promise<void> {
  const attempt = uncertainAttempt;
  if (!attempt || !mutation.uncertain || mutation.checking) return;
  // The record of an attempt lives on the installation it was sent to; never check it against another Gateway.
  if (!sentToConnectedGateway(attempt)) {
    publish({ ...mutation, outcome: OTHER_GATEWAY });
    return;
  }
  publish({ ...mutation, checking: true, outcome: undefined });
  const current = () => uncertainAttempt === attempt;
  // The operator can switch Gateway while the check runs; nothing read after that is evidence about this attempt.
  const switched = () => {
    if (sentToConnectedGateway(attempt)) return false;
    publish({ ...mutation, checking: false, outcome: OTHER_GATEWAY });
    return true;
  };
  try {
    const verdict = classifyMutationAttempt(
      await fetchMutationAttempt(attempt.attemptKey, attempt.method, attempt.routePattern),
    );
    if (!current() || switched()) return;
    if (verdict !== "committed" && verdict !== "failed_confirm_by_readback") {
      publish({ ...mutation, checking: false, outcome: STILL_LOCKED[verdict] });
      return;
    }
    await withFreshReads(() => fetchLlmConfig());
    if (!current() || switched()) return;
    await withFreshReads(reload);
    if (!current() || switched()) return;
    uncertainAttempt = undefined;
    publish({
      pending: false,
      outcome:
        verdict === "committed"
          ? "The Gateway recorded the uncertain provider change as processed. Current settings were read back; review them before another change."
          : "The Gateway released the uncertain provider attempt after an error. Current settings were read back; review them before another change, because part of it may still have been applied.",
    });
  } catch (error) {
    if (current())
      publish({
        ...mutation,
        checking: false,
        outcome:
          "The outcome check failed, so provider changes stay locked: " +
          (error instanceof Error ? error.message : "the Gateway did not answer."),
      });
  }
}
export function isProviderPrecommitConflict(error: unknown, revision: number) {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>;
  const details = body.details as Record<string, unknown> | undefined;
  return (
    body.code === "STATE_CONFLICT" &&
    Boolean(details) &&
    details!.expectedRevision === revision &&
    Number.isSafeInteger(details!.currentRevision) &&
    (details!.currentRevision as number) > revision &&
    body.committed !== true &&
    body.mutationCommitted !== true &&
    details!.committed !== true &&
    details!.mutationCommitted !== true
  );
}

/** An away-and-back editor transition still invalidates a preflight completion. */
export function useProviderEditorEpoch(identity: unknown) {
  const serialized = JSON.stringify(identity);
  const latest = useRef({ serialized, epoch: 0 });
  if (latest.current.serialized !== serialized) latest.current = { serialized, epoch: latest.current.epoch + 1 };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const captured = latest.current;
    return () => mounted.current && latest.current === captured;
  };
}

export function __resetProviderMutationStateForTests() {
  lastAttempt = undefined;
  uncertainAttempt = undefined;
  publish(IDLE);
}
