/**
 * Shared plumbing for the gateway's recurring background schedulers.
 *
 * Several gateway subsystems (maintenance sweep, orphaned-worktree reaper, ...)
 * follow the exact same lifecycle shape:
 *
 *   - an optional one-shot pass shortly after boot,
 *   - a recurring `setInterval` pass thereafter,
 *   - both timers `.unref()`'d so they never keep the process alive or block
 *     shutdown,
 *   - each tick failure-isolated (a throw/rejection is reported, never
 *     surfaced as an unhandled rejection or allowed to crash the process),
 *   - ticks are non-overlapping: a tick is skipped while the previous tick's
 *     work is still in flight (no overlapping passes under load),
 *   - each in-flight tick registered into a shared task set so `close()` can
 *     await drain, and
 *   - work skipped entirely while the owner is shutting down.
 *
 * This module factors out that repetitive timer/registration/error-isolation
 * boilerplate. The *tick body* (the closure that calls the owning service's
 * methods) stays with the caller — only the plumbing lives here. Callers keep
 * the returned {@link BackgroundIntervalHandle.stop} disposer and invoke it
 * during shutdown to clear both timers.
 */

/** Configuration for a single recurring background scheduler. */
export interface BackgroundIntervalOptions {
  /**
   * Human-readable label for the scheduler. Surfaced to {@link onError} so a
   * shared error reporter can attribute failures, and useful when debugging.
   */
  readonly label: string;
  /** Interval, in milliseconds, between recurring ticks. */
  readonly intervalMs: number;
  /**
   * Optional delay, in milliseconds, before a single post-boot pass runs. When
   * omitted (or non-positive), no boot pass is scheduled and the first tick
   * fires after {@link intervalMs}.
   */
  readonly bootDelayMs?: number;
  /**
   * The tick body. May reject; rejections are caught and routed to
   * {@link onError} rather than thrown.
   */
  readonly task: () => Promise<void>;
  /**
   * Returns `true` when the owner is shutting down. While closing, scheduled
   * passes are skipped entirely (no task is created or registered).
   */
  readonly isClosing: () => boolean;
  /**
   * Registers an in-flight tick promise with the owner so shutdown can await
   * its completion. Implementations typically add the promise to a shared set
   * and remove it when settled.
   */
  readonly registerInflight: (task: Promise<void>) => void;
  /**
   * Reports a tick failure. The caller decides the log level and shape so each
   * scheduler can preserve its existing logging behaviour. Receives the
   * scheduler {@link label} alongside the thrown value.
   */
  readonly onError: (error: unknown, label: string) => void;
}

/** Handle returned by {@link startBackgroundInterval}. */
export interface BackgroundIntervalHandle {
  /** Clears the boot timer (if any) and the recurring interval. Idempotent. */
  readonly stop: () => void;
}

/**
 * Tracks one owned background promise without creating a second, unobserved
 * rejecting branch. Calling `promise.finally(cleanup)` and ignoring the
 * returned promise mirrors the original rejection and can therefore turn an
 * otherwise observed transient failure into an unhandled rejection.
 *
 * The rejection handler here is intentionally limited to ownership cleanup.
 * Task owners remain responsible for classifying and reporting failures in the
 * task chain itself; the original promise also remains available to shutdown
 * drains through `backgroundTasks` until it settles.
 */
export function trackBackgroundTask<T>(backgroundTasks: Set<Promise<T>>, task: Promise<T>): void {
  backgroundTasks.add(task);
  void task.then(
    () => {
      backgroundTasks.delete(task);
    },
    () => {
      backgroundTasks.delete(task);
    },
  );
}

/**
 * Starts a recurring background scheduler with optional post-boot pass.
 *
 * Returns a {@link BackgroundIntervalHandle} whose `stop()` clears both timers.
 * Both timers are `.unref()`'d, so the scheduler never keeps the process alive.
 */
export function startBackgroundInterval(options: BackgroundIntervalOptions): BackgroundIntervalHandle {
  const { label, intervalMs, bootDelayMs, task, isClosing, registerInflight, onError } = options;

  // Re-entrancy guard (Finding 9): if a previous tick's work is still in flight
  // (e.g. a maintenance sweep that ran longer than intervalMs under load), skip
  // this tick rather than run overlapping passes — overlapping ticks can
  // double-run the same period's work. Mirrors dev-supervisor's inflight guard.
  let running = false;
  const runTick = (): void => {
    if (isClosing() || running) {
      return;
    }
    running = true;
    const inflight = task()
      .catch((error: unknown) => {
        onError(error, label);
      })
      .finally(() => {
        running = false;
      });
    registerInflight(inflight);
  };

  let bootTimer: NodeJS.Timeout | undefined;
  if (typeof bootDelayMs === "number" && bootDelayMs > 0) {
    bootTimer = setTimeout(runTick, bootDelayMs);
    bootTimer.unref();
  }

  const interval = setInterval(runTick, intervalMs);
  interval.unref();

  return {
    stop: (): void => {
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = undefined;
      }
      clearInterval(interval);
    },
  };
}
