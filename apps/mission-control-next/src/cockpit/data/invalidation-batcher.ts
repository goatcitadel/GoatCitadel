import type { QueryClient, QueryKey } from "@tanstack/react-query";

export interface InvalidationBatcher {
  invalidate: (queryKey: QueryKey) => void;
  flush: () => void;
  dispose: () => void;
}

/**
 * Coalesces query invalidations that arrive in a burst (an event-stream replay sends up to
 * twenty retained events at once). Each distinct key is invalidated once per flush instead of
 * once per event, so a replay no longer cancels and restarts the same request many times.
 */
export function createInvalidationBatcher(queryClient: QueryClient, delayMs = 120): InvalidationBatcher {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const keys = [...pending.values()];
    pending.clear();
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
  return {
    invalidate(queryKey) {
      pending.set(JSON.stringify(queryKey), queryKey);
      if (timer === undefined) timer = setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
