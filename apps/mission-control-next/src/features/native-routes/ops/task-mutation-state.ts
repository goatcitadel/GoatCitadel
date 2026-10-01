import { useSyncExternalStore } from "react";

export type TaskMutationState = { phase: "idle" | "pending" | "uncertain"; message?: string };
const IDLE: TaskMutationState = { phase: "idle" };
let attempts = new Map<string, TaskMutationState>();
const listeners = new Set<() => void>();
export const taskMutationKey = (base: string, workspaceId: string, taskId: string) =>
  JSON.stringify([base, workspaceId, taskId]);
export const readTaskMutation = (key: string) => attempts.get(key) ?? IDLE;
function publish(key: string, state: TaskMutationState) {
  attempts = new Map(attempts);
  if (state === IDLE) attempts.delete(key);
  else attempts.set(key, state);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useTaskMutation(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => readTaskMutation(key),
    () => IDLE,
  );
}
export function useTaskMutations() {
  return useSyncExternalStore(
    subscribe,
    () => attempts,
    () => attempts,
  );
}
/** Shared admission only; the Gateway still owns scope and revision validation. */
export function acquireTaskMutations(keys: string[]) {
  const unique = [...new Set(keys)];
  if (unique.some((key) => readTaskMutation(key).phase !== "idle")) return null;
  const token: TaskMutationState = { phase: "pending" };
  for (const key of unique) publish(key, token);
  return {
    settle: () => {
      for (const key of unique) if (readTaskMutation(key) === token) publish(key, IDLE);
    },
    uncertain: (message: string) => {
      for (const key of unique) if (readTaskMutation(key) === token) publish(key, { phase: "uncertain", message });
    },
  };
}
export function __resetTaskMutationsForTests() {
  attempts = new Map();
  for (const listener of listeners) listener();
}
