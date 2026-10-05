import { useEffect, useRef } from "react";
import type { RefreshSignal, RefreshTopic } from "../state/refresh-bus";
import { subscribeRefresh } from "../state/refresh-bus";
import { recordClientDiagnostic } from "../state/dev-diagnostics-store";
import { getEventStreamStatus } from "../state/event-stream-status-store";

/**
 * While the shared event stream is open, events already announce changes, so a quiet topic is
 * quiet, not stale: the fallback poll waits at least this long instead of its normal stale time.
 */
export const OPEN_STREAM_FALLBACK_STALE_MS = 600_000;

function fallbackStaleMs(staleMs: number): number {
  return getEventStreamStatus().state === "open" ? Math.max(staleMs, OPEN_STREAM_FALLBACK_STALE_MS) : staleMs;
}

interface UseRefreshSubscriptionOptions {
  enabled?: boolean;
  coalesceMs?: number;
  staleMs?: number;
  pollIntervalMs?: number;
  runWhenHidden?: boolean;
  onFallbackStateChange?: (active: boolean) => void;
  /** Preserve the strongest invalidation when several events share a batch. */
  signalPriority?: (signal: RefreshSignal) => number;
}

export function useRefreshSubscription(
  topic: RefreshTopic,
  callback: (signal: RefreshSignal) => Promise<void> | void,
  options: UseRefreshSubscriptionOptions = {},
): void {
  const callbackRef = useRef(callback);
  const onFallbackStateChangeRef = useRef(options.onFallbackStateChange);
  const signalPriorityRef = useRef(options.signalPriority);
  const latestSignalRef = useRef<RefreshSignal | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const lastSignalAtRef = useRef<number>(Date.now());
  const fallbackActiveRef = useRef(false);
  const fallbackPollLastRanAtRef = useRef<number>(0);
  const generationRef = useRef(0);

  const enabled = options.enabled ?? true;
  const coalesceMs = options.coalesceMs ?? 900;
  const staleMs = options.staleMs;
  const pollIntervalMs = options.pollIntervalMs ?? 15000;
  const runWhenHidden = options.runWhenHidden ?? false;

  useEffect(() => {
    callbackRef.current = callback;
    onFallbackStateChangeRef.current = options.onFallbackStateChange;
    signalPriorityRef.current = options.signalPriority;
  }, [callback, options.onFallbackStateChange, options.signalPriority]);

  useEffect(() => {
    const generation = ++generationRef.current;
    lastSignalAtRef.current = Date.now();
    fallbackPollLastRanAtRef.current = 0;
    const timers = getTimerApi();
    const setFallbackActive = (active: boolean) => {
      if (fallbackActiveRef.current === active) {
        return;
      }
      fallbackActiveRef.current = active;
      onFallbackStateChangeRef.current?.(active);
    };

    if (!enabled) {
      setFallbackActive(false);
      return;
    }

    const runLatest = async (source: "event" | "fallback") => {
      if (generationRef.current !== generation) return;
      if (inFlightRef.current) {
        // A periodic tick carries no new invalidation. Wait for the active
        // request rather than immediately polling again when it settles.
        if (source === "fallback") return;
        pendingRef.current = true;
        recordClientDiagnostic({
          level: "debug",
          category: "refresh",
          event: "queued",
          message: `Refresh for ${topic} queued while callback was in-flight`,
          context: { topic },
        });
        return;
      }

      const signal = (source === "event" ? latestSignalRef.current : null) ?? {
        topic,
        timestamp: Date.now(),
        reason: "fallback_poll",
        source: "refresh-hook",
        eventType: "fallback_poll",
      };
      if (source === "event") latestSignalRef.current = null;

      inFlightRef.current = true;
      recordClientDiagnostic({
        level: "debug",
        category: "refresh",
        event: "started",
        message: `Refresh started for ${topic}`,
        context: {
          topic,
          source,
          reason: signal.reason,
          eventType: signal.eventType,
        },
      });
      try {
        await callbackRef.current(signal);
      } catch (error) {
        recordClientDiagnostic({
          level: "warn",
          category: "refresh",
          event: "callback_failed",
          message: `Refresh callback failed for ${topic}`,
          context: {
            topic,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        // A completion from an old page must not unlock or schedule work for
        // its replacement subscription.
        if (generationRef.current === generation) {
          if (source === "fallback") {
            fallbackPollLastRanAtRef.current = Date.now();
          }
          inFlightRef.current = false;
          recordClientDiagnostic({
            level: "debug",
            category: "refresh",
            event: "completed",
            message: `Refresh completed for ${topic}`,
            context: { topic, source },
          });
          if (pendingRef.current) {
            pendingRef.current = false;
            if (timerRef.current === null) {
              timerRef.current = timers.setTimeout(() => {
                timerRef.current = null;
                void runLatest("event");
              }, coalesceMs);
            }
          }
        }
      }
    };

    const unsubscribe = subscribeRefresh(topic, (signal) => {
      const pending = latestSignalRef.current;
      const priority = signalPriorityRef.current;
      if (!pending || !priority || priority(signal) >= priority(pending)) latestSignalRef.current = signal;
      lastSignalAtRef.current = signal.timestamp;
      setFallbackActive(false);
      recordClientDiagnostic({
        level: "debug",
        category: "refresh",
        event: "event",
        message: `Refresh signal received for ${topic}`,
        context: {
          topic,
          reason: signal.reason,
          eventType: signal.eventType,
          source: signal.source,
        },
      });
      if (timerRef.current !== null) {
        return;
      }
      timerRef.current = timers.setTimeout(() => {
        timerRef.current = null;
        void runLatest("event");
      }, coalesceMs);
    });

    if (typeof staleMs === "number" && staleMs > 0) {
      fallbackTimerRef.current = timers.setInterval(
        () => {
          if (!enabled) {
            return;
          }
          if (!runWhenHidden && typeof document !== "undefined" && document.hidden) {
            return;
          }
          const now = Date.now();
          if (now - lastSignalAtRef.current < fallbackStaleMs(staleMs)) {
            return;
          }
          if (now - fallbackPollLastRanAtRef.current < pollIntervalMs) {
            return;
          }
          setFallbackActive(true);
          void runLatest("fallback");
        },
        Math.max(1000, pollIntervalMs),
      );
    }

    return () => {
      generationRef.current += 1;
      unsubscribe();
      if (timerRef.current !== null) {
        timers.clearTimeout(timerRef.current);
      }
      timerRef.current = null;
      if (fallbackTimerRef.current !== null) {
        timers.clearInterval(fallbackTimerRef.current);
      }
      fallbackTimerRef.current = null;
      pendingRef.current = false;
      inFlightRef.current = false;
      latestSignalRef.current = null;
      setFallbackActive(false);
    };
    // onFallbackStateChange is read via onFallbackStateChangeRef so an inline
    // (non-memoized) callback does not tear down and re-subscribe the whole
    // effect (which would restart the fallback poll wiring) on every parent render.
  }, [coalesceMs, enabled, pollIntervalMs, runWhenHidden, staleMs, topic]);
}

function getTimerApi() {
  const browserTimers = typeof window === "undefined" ? undefined : window;
  return {
    setTimeout:
      typeof browserTimers?.setTimeout === "function"
        ? browserTimers.setTimeout.bind(browserTimers)
        : globalThis.setTimeout.bind(globalThis),
    clearTimeout:
      typeof browserTimers?.clearTimeout === "function"
        ? browserTimers.clearTimeout.bind(browserTimers)
        : globalThis.clearTimeout.bind(globalThis),
    setInterval:
      typeof browserTimers?.setInterval === "function"
        ? browserTimers.setInterval.bind(browserTimers)
        : globalThis.setInterval.bind(globalThis),
    clearInterval:
      typeof browserTimers?.clearInterval === "function"
        ? browserTimers.clearInterval.bind(browserTimers)
        : globalThis.clearInterval.bind(globalThis),
  };
}
