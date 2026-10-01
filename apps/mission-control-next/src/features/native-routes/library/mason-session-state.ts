export interface MasonAttempt {
  phase: "idle" | "checking" | "saving" | "uncertain";
  message?: string;
}
const idle: MasonAttempt = { phase: "idle" };
const attempts = new Map<string, MasonAttempt>();
const listeners = new Set<() => void>();
// Admission only, for this document. Mason sessions are global, not Citadel-scoped records.
export const masonAttemptKey = (installation: string, sessionId: string | null) =>
  JSON.stringify([installation, sessionId ?? "create"]);
export const masonAttempt = (key: string) => attempts.get(key) ?? idle;
export function setMasonAttempt(key: string, value: MasonAttempt) {
  if (value.phase === "idle") attempts.delete(key);
  else attempts.set(key, value);
  for (const listener of listeners) listener();
}
export function subscribeMasonAttempts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function resetMasonAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
