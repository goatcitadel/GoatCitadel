import { useCallback, useRef, useSyncExternalStore, type SetStateAction } from "react";

// App-session presentation state and non-secret task receipts. Never written to persistent storage.
const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

export function useSessionViewState<T>(key: string, initial: T) {
  const baselineRef = useRef({ key, initial });
  if (baselineRef.current.key !== key) baselineRef.current = { key, initial };
  const baseline = baselineRef.current.initial;
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
      };
    },
    [key],
  );
  const getSnapshot = () => (values.has(key) ? (values.get(key) as T) : baseline);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setValue = useCallback(
    (update: SetStateAction<T>) => {
      const current = values.has(key) ? (values.get(key) as T) : baseline;
      const next = typeof update === "function" ? (update as (value: T) => T)(current) : update;
      values.set(key, next);
      listeners.get(key)?.forEach((listener) => listener());
    },
    [key, baseline],
  );
  return [value, setValue] as const;
}

export function __resetSessionViewStateForTests() {
  values.clear();
  listeners.forEach((group) => group.forEach((notify) => notify()));
}
