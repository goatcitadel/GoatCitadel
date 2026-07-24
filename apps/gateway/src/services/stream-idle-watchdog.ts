import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import { observePromptSettlement, type PromptSettlement } from "./prompt-settlement.js";

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
  let idleTimedOut = false;
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const idleGuard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          idleTimedOut = true;
          try {
            options.abort?.();
          } catch (abortError) {
            // A throwing abort callback is treated as an unacknowledged
            // dispatch below. The watchdog must remain bounded either way.
            void abortError;
          }
          try {
            options.onTrip?.(options.idleTimeoutMs);
          } catch (diagnosticError) {
            // Diagnostics must not replace the canonical timeout/accounting
            // result from the provider iterator.
            void diagnosticError;
          }
          reject(new StreamIdleTimeoutError(options.idleTimeoutMs));
        }, options.idleTimeoutMs);
        timer.unref?.();
      });
      let next: IteratorResult<T>;
      const pendingNext = iterator.next();
      try {
        next = await Promise.race([pendingNext, idleGuard]);
      } catch (error) {
        if (error instanceof StreamIdleTimeoutError) {
          // Abort-aware provider iterators reject promptly, after their usage
          // attempt has been settled. Observe that result before allowing the
          // timeout to escape. An adapter that ignores AbortSignal must never
          // pin the watchdog indefinitely: its still-pending attempt is
          // classified as dispatch-uncertain so callers cannot retry/fallback
          // the same generation while recovery owns the accepted row.
          const readOutcome = await observePromptSettlement(pendingNext);
          let cleanup: Promise<IteratorResult<T>> | undefined;
          let cleanupOutcome: PromptSettlement<IteratorResult<T>> | undefined;
          try {
            cleanup = iterator.return?.();
            cleanupOutcome = cleanup ? await observePromptSettlement(cleanup) : undefined;
          } catch (cleanupError) {
            cleanupOutcome = { status: "rejected", error: cleanupError };
          }

          const accountingFailure =
            readOutcome.status === "rejected" && isAuthoritativeModelUsageAccountingError(readOutcome.error)
              ? readOutcome.error
              : cleanupOutcome?.status === "rejected" && isAuthoritativeModelUsageAccountingError(cleanupOutcome.error)
                ? cleanupOutcome.error
                : undefined;
          if (accountingFailure !== undefined) throw accountingFailure;

          if (readOutcome.status === "pending" || cleanupOutcome?.status === "pending") {
            void pendingNext.catch(() => undefined);
            void cleanup?.catch(() => undefined);
            error.name = "ModelUsageDispatchUncertainError";
            error.message = `${error.message}; provider abort was not acknowledged`;
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (next.done) {
        return;
      }
      yield next.value;
    }
  } finally {
    // The idle path already initiated bounded cleanup in the catch above.
    // Normal completion/consumer cancellation still waits for canonical
    // provider cleanup so accounting settlement errors remain authoritative.
    if (!idleTimedOut) {
      try {
        await iterator.return?.();
      } catch (error) {
        if (isAuthoritativeModelUsageAccountingError(error)) {
          // Canonical accounting settlement intentionally supersedes a normal or cancelled completion.
          // eslint-disable-next-line no-unsafe-finally -- Accounting authority must remain visible to callers.
          throw error;
        }
        // Ordinary source cleanup errors do not replace the provider/timeout
        // result. Accounting authority errors above are the sole exception.
      }
    }
  }
}
