import { useSyncExternalStore } from "react";
import { isApiRequestError } from "../api/http-internal";

type Attempt = {
  token: symbol;
  phase: "checking" | "submitted" | "resolved" | "uncertain";
  revision: string;
  message: string;
};
// Session-local replay suppression only. No payloads, approval authority or browser persistence.
// Keys use installation/caller/scope, without transient access revisions: an away-and-back
// transition or a remount must not erase an operation whose response was lost.
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useApprovalOperationAttempt(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => attempts.get(key),
    () => undefined,
  );
}
export function canReviewApprovalOperation(attempt: Attempt | undefined, revision: string, allowResolved = false) {
  return !attempt || (attempt.phase === "resolved" && (allowResolved || attempt.revision !== revision));
}
export function beginApprovalOperation(key: string, revision: string, allowResolved = false): symbol | undefined {
  if (!canReviewApprovalOperation(attempts.get(key), revision, allowResolved)) return undefined;
  const token = Symbol();
  attempts.set(key, { token, revision, phase: "checking", message: "Checking current operation…" });
  emit();
  return token;
}
export function updateApprovalOperation(key: string, token: symbol, phase: Attempt["phase"], message: string) {
  const current = attempts.get(key);
  if (current?.token !== token) return;
  attempts.set(key, { ...current, phase, message });
  emit();
}
export function releaseApprovalOperationCheck(key: string, token: symbol) {
  const current = attempts.get(key);
  if (current?.token !== token || current.phase !== "checking") return;
  attempts.delete(key);
  emit();
}
/** The owner answered and refused: nothing was recorded, so the same revision may be reviewed again. */
export function releaseRefusedApprovalOperation(key: string, token: symbol) {
  const current = attempts.get(key);
  if (current?.token !== token) return;
  attempts.delete(key);
  emit();
}
/** Operator-initiated only. Clears a lost-response lock without claiming the original write settled. */
export function dismissUncertainApprovalOperation(key: string): boolean {
  const current = attempts.get(key);
  if (current?.phase !== "uncertain") return false;
  attempts.delete(key);
  emit();
  return true;
}

export type OperationFailureClass = "refused" | "uncertain";
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);
/**
 * A Gateway answer with a definitive 4xx refusal means the write was not recorded. Lost
 * responses, aborts, timeouts, protocol failures and 5xx leave the outcome unknown.
 */
export function classifyOperationFailure(cause: unknown): OperationFailureClass {
  return isApiRequestError(cause) && cause.kind === "http" && cause.status !== undefined && REFUSAL_STATUSES.has(cause.status)
    ? "refused"
    : "uncertain";
}
export const UNCERTAIN_OPERATION_LOCK_NOTE =
  "Further writes to this record are locked until this notice is dismissed or the page is reloaded; a later read does not settle the original attempt.";
export function __resetApprovalOperationAttemptsForTests() {
  attempts.clear();
  emit();
}

/** Exact owner-idempotent replay only; atomically reserve the prior uncertain attempt. */
export function resumeUncertainApprovalOperation(key: string, revision: string): symbol | undefined {
  const current = attempts.get(key);
  if (!current || current.phase !== "uncertain" || current.revision !== revision) return undefined;
  updateApprovalOperation(key, current.token, "checking", "Checking the original idempotent request before exact replay…");
  return current.token;
}
