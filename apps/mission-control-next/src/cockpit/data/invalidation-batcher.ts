import type { QueryClient, QueryKey } from "@tanstack/react-query";

export interface InvalidationBatcher {
  invalidate: (queryKey: QueryKey) => void;
  flush: () => void;
  dispose: () => void;
}

export interface InvalidationBatcherOptions {
  delayMs?: number;
  minIntervalMs?: (queryKey: QueryKey) => number;
  now?: () => number;
}

export const THROTTLED_INTERVAL_MS = 5_000;
const THROTTLED_PREFIXES: readonly (readonly string[])[] = [
  ["system", "health"],
  ["system", "directory"],
];

/** Health probes and directory listings refresh at most once every five seconds, whatever the event rate. */
export function throttleIntervalFor(queryKey: QueryKey): number {
  return THROTTLED_PREFIXES.some((prefix) => prefix.every((part, index) => queryKey[index] === part))
    ? THROTTLED_INTERVAL_MS
    : 0;
}

/**
 * Coalesces invalidations that arrive in a burst (an event-stream replay sends up to twenty retained
 * events at once) and enforces a minimum interval per key. Each distinct key is invalidated once per
 * flush; a key that arrives inside its interval gets one trailing refresh when the interval ends.
 */
export function createInvalidationBatcher(
  queryClient: QueryClient,
  options: InvalidationBatcherOptions = {},
): InvalidationBatcher {
  const delayMs = options.delayMs ?? 120;
  const minIntervalMs = options.minIntervalMs ?? (() => 0);
  const now = options.now ?? Date.now;
  const pending = new Map<string, QueryKey>();
  const lastRun = new Map<string, number>();
  const trailing = new Map<string, ReturnType<typeof setTimeout>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const run = (id: string, queryKey: QueryKey) => {
    lastRun.set(id, now());
    void queryClient.invalidateQueries({ queryKey });
  };
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const entries = [...pending.entries()];
    pending.clear();
    for (const [id, queryKey] of entries) {
      const wait = (lastRun.get(id) ?? -Infinity) + minIntervalMs(queryKey) - now();
      if (wait <= 0) {
        run(id, queryKey);
      } else if (!trailing.has(id)) {
        trailing.set(
          id,
          setTimeout(() => {
            trailing.delete(id);
            if (!disposed) run(id, queryKey);
          }, wait),
        );
      }
    }
  };
  return {
    invalidate(queryKey) {
      if (disposed) return;
      pending.set(JSON.stringify(queryKey), queryKey);
      if (timer === undefined) timer = setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const handle of trailing.values()) clearTimeout(handle);
      trailing.clear();
      pending.clear();
    },
  };
}
