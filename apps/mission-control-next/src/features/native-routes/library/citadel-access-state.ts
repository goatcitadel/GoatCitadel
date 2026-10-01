export interface AccessAttempt { phase: "idle" | "checking" | "saving" | "uncertain"; message?: string }
const idle: AccessAttempt = Object.freeze({ phase: "idle" });
const attempts = new Map<string, AccessAttempt>();
const listeners = new Set<() => void>();
export const accessAttempt = (key: string) => attempts.get(key) ?? idle;
export const accessLocked = (key: string) => accessAttempt(key).phase !== "idle";
export function setAccessAttempt(key: string, value: AccessAttempt) {
  attempts.set(key, value); for (const listener of listeners) listener();
}
export function subscribeAccessAttempts(listener: () => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function __resetCitadelAccessAttemptsForTests() {
  attempts.clear(); for (const listener of listeners) listener();
}
