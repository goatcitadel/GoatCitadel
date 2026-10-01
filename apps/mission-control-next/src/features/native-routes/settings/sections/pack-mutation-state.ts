import { useSyncExternalStore } from "react";

export interface PackAttempt {
  phase: "idle" | "pending" | "uncertain";
  message?: string;
}
const idle: PackAttempt = { phase: "idle" };
const attempts = new Map<string, PackAttempt>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = (key: string) => attempts.get(key) ?? idle;
const publish = (key: string, value: PackAttempt) => {
  attempts.set(key, value);
  for (const listener of listeners) listener();
};
export function usePackAttempt(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => idle,
  );
}
/** App-session admission only. No manifest, authority, credential or operation payload is retained here. */
export function beginPackAttempt(key: string) {
  if (read(key).phase !== "idle") return undefined;
  const pending: PackAttempt = { phase: "pending" };
  publish(key, pending);
  return {
    async write<T>(dispatch: () => Promise<T>, verify: (receipt: T) => Promise<void>) {
      try {
        const receipt = await dispatch();
        await verify(receipt);
        return receipt;
      } catch (error) {
        publish(key, {
          phase: "uncertain",
          message:
            "Pack action outcome is unconfirmed. Further pack writes are withheld for this app session. Inspect Gateway evidence before continuing.",
        });
        throw error;
      }
    },
    finish() {
      if (read(key) === pending) publish(key, idle);
    },
  };
}
export function __resetPackAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
