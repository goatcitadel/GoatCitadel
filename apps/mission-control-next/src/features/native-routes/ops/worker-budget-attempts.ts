import { useCallback, useSyncExternalStore } from "react";
import type { RemoteWorkerBudgetGrantInput } from "@goatcitadel/contracts";
export type WorkerBudgetAttempt = {
  request: RemoteWorkerBudgetGrantInput;
  submitted: { requests: string; cost: string; minutes: string };
  dispatched: boolean;
};
// In-memory transaction identity. An uncertain response must never cause a new grant ID.
const attempts = new Map<string, WorkerBudgetAttempt>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useWorkerBudgetAttempt(key: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => attempts.get(key) ?? null,
    () => null,
  );
  const setValue = useCallback(
    (next: WorkerBudgetAttempt | null) => {
      if (next) attempts.set(key, next);
      else attempts.delete(key);
      listeners.forEach((listener) => listener());
    },
    [key],
  );
  const clear = useCallback(
    (grantId: string) => {
      if (attempts.get(key)?.request.grantId !== grantId) return;
      attempts.delete(key);
      listeners.forEach((listener) => listener());
    },
    [key],
  );
  return [value, setValue, clear] as const;
}
export function resetWorkerBudgetAttemptsForTests() {
  attempts.clear();
  listeners.forEach((listener) => listener());
}
