import { useSyncExternalStore } from "react";

export interface LocalAiRequestState {
  phase: "checking" | "requesting" | "confirmed" | "uncertain";
  message?: string;
  approvalId?: string;
}
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
export function __resetLocalAiRequestStateForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}
