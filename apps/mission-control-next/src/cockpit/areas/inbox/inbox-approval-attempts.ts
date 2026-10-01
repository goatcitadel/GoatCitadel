import { useSyncExternalStore } from "react";

interface InboxApprovalAttempt {
  token: symbol;
  phase: "checking" | "submitted" | "resolved" | "uncertain";
  message: string;
}

// Session-local presentation locks, not approval authority. Never store action
// payloads or persist these attempts to browser storage. The Gateway owns outcomes.
const attempts = new Map<string, InboxApprovalAttempt>();
const listeners = new Set<() => void>();
const keyFor = (workspaceId: string, approvalId: string) => JSON.stringify([workspaceId, approvalId]);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = () => {
  for (const listener of listeners) listener();
};

export function useInboxApprovalAttempt(workspaceId: string, approvalId: string) {
  return useSyncExternalStore(
    subscribe,
    () => attempts.get(keyFor(workspaceId, approvalId)),
    () => undefined,
  );
}

export function beginInboxApprovalAttempt(workspaceId: string, approvalId: string): symbol | undefined {
  const key = keyFor(workspaceId, approvalId);
  if (attempts.has(key)) return undefined;
  const token = Symbol();
  attempts.set(key, { token, phase: "checking", message: "Checking the current approval…" });
  emit();
  return token;
}

export function updateInboxApprovalAttempt(
  workspaceId: string,
  approvalId: string,
  token: symbol,
  phase: InboxApprovalAttempt["phase"],
  message: string,
) {
  const key = keyFor(workspaceId, approvalId);
  if (attempts.get(key)?.token !== token) return;
  attempts.set(key, { token, phase, message });
  emit();
}

export function releaseInboxApprovalCheck(workspaceId: string, approvalId: string, token: symbol) {
  const key = keyFor(workspaceId, approvalId);
  const current = attempts.get(key);
  if (current?.token !== token || current.phase !== "checking") return;
  attempts.delete(key);
  emit();
}

export function __resetInboxApprovalAttemptsForTests() {
  attempts.clear();
  emit();
}
