/**
 * Sleep for `ms`, resolving early (and clearing the timer) if `signal` aborts.
 *
 * The abort listener is removed when the timer fires normally — otherwise a
 * caller that polls in a loop on one long-lived request signal (e.g. live-tail
 * streaming) accumulates one retained listener/closure per iteration.
 */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
