import { useSyncExternalStore } from "react";
export interface CapabilityScopeAttempt {
  phase: "idle" | "checking" | "saving" | "uncertain";
  message?: string;
}
const idle: CapabilityScopeAttempt = { phase: "idle" };
const attempts = new Map<string, CapabilityScopeAttempt>(),
  listeners = new Set<() => void>();
export function capabilityScopeAttempt(key: string) {
  return attempts.get(key) ?? idle;
}
export function setCapabilityScopeAttempt(key: string, value: CapabilityScopeAttempt) {
  if (value.phase === "idle") attempts.delete(key);
  else attempts.set(key, value);
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useCapabilityScopeAttempt(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => capabilityScopeAttempt(key),
    () => idle,
  );
}
export function __resetCapabilityScopeAttemptsForTests() {
  attempts.clear();
  listeners.forEach((listener) => listener());
}
