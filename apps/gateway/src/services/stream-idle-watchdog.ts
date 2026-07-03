/**
 * Per-chunk provider-stream idle watchdog (round-3 R3-3, kill switch
 * `streamIdleWatchdogV1Disabled`).
 *
 * The request-level timeout only bounds total duration: a provider that emits
 * one chunk and then hangs pins the turn until that absolute deadline (or
 * forever when the deadline is generous). This wrapper re-arms an idle timer
 * on every chunk; on trip it aborts the underlying request and throws a
 * recognizable error so the existing attempt/salvage machinery treats the
 * hang exactly like any other mid-stream provider failure.
 */

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const MIN_STREAM_IDLE_TIMEOUT_MS = 5_000;

export class StreamIdleTimeoutError extends Error {
  readonly code = "stream_idle_timeout";

  constructor(idleTimeoutMs: number) {
    super(`Provider stream produced no data for ${idleTimeoutMs}ms (idle watchdog)`);
    this.name = "StreamIdleTimeoutError";
  }
}

export interface StreamIdleWatchdogOptions {
  idleTimeoutMs: number;
  /** Called once when the idle bound trips, before the error is thrown. */
  onTrip?: (idleTimeoutMs: number) => void;
  /** Aborts the underlying provider request so the connection is released. */
  abort?: () => void;
}

export function resolveStreamIdleTimeoutMs(configured: number | undefined): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }
  return Math.max(MIN_STREAM_IDLE_TIMEOUT_MS, Math.floor(configured));
}

export async function* withStreamIdleWatchdog<T>(
  source: AsyncIterable<T>,
  options: StreamIdleWatchdogOptions,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const idleGuard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          options.abort?.();
          options.onTrip?.(options.idleTimeoutMs);
          reject(new StreamIdleTimeoutError(options.idleTimeoutMs));
        }, options.idleTimeoutMs);
        timer.unref?.();
      });
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([iterator.next(), idleGuard]);
      } finally {
        clearTimeout(timer);
      }
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    // Release the underlying stream WITHOUT awaiting: a generator suspended on
    // a hung provider read cannot service return() until that read settles, so
    // awaiting here would re-introduce the very hang the watchdog removes. The
    // abort() callback is what actually unblocks the underlying request.
    void iterator.return?.().then(
      () => undefined,
      () => undefined,
    );
  }
}
