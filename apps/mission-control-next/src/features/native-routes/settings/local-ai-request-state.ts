import { useSyncExternalStore } from "react";
import { settleTrackedAttempt, type TrackedAttempt } from "./mutation-attempt-tracking";

/** `transport` identifies a lost approval request (key, method, route; never its body) so it can be settled. */
export interface LocalAiRequestState {
  phase: "checking" | "requesting" | "confirmed" | "uncertain";
  message?: string;
  approvalId?: string;
  transport?: TrackedAttempt;
  checking?: boolean;
}
/** The Gateway routes the Local AI request owner writes through. */
export const LOCAL_AI_ROUTE_PATTERNS = ["/api/v1/local-ai/downloads", "/api/v1/local-ai/serve"] as const;
const attempts = new Map<string, LocalAiRequestState>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setLocalAiRequest(key: string, value?: LocalAiRequestState) {
  if (value) attempts.set(key, value);
  else attempts.delete(key);
  version += 1;
  for (const listener of listeners) listener();
}
export const localAiRequestLocked = (key: string) =>
  ["checking", "requesting", "uncertain"].includes(attempts.get(key)?.phase ?? "");
export function useLocalAiRequestState() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return { stateFor: (key: string) => attempts.get(key), locked: localAiRequestLocked };
}
/**
 * Settles an uncertain approval request (keyed by installation, intent and model) from the Gateway's record of that exact
 * attempt and the canonical retained-job `readback`. Only a committed or released attempt unlocks; anything else keeps
 * the lock. A repeat after unlock creates a new approval request that still needs its own explicit approval.
 */
export async function checkLocalAiRequestOutcome(key: string, readback: () => Promise<unknown>) {
  const current = attempts.get(key);
  if (current?.phase !== "uncertain" || !current.transport || current.checking) return undefined;
  const checking = { ...current, checking: true };
  setLocalAiRequest(key, checking);
  const result = await settleTrackedAttempt(current.transport, readback, "Local AI request");
  if (attempts.get(key) !== checking) return undefined;
  setLocalAiRequest(key, result.settled ? undefined : { ...current, message: result.message });
  return result.settled ? result.message : undefined;
}
export function __resetLocalAiRequestStateForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}
