import { useEffect, useRef } from "react";
import type { RefreshSignal, RefreshTopic } from "../state/refresh-bus";
import { subscribeRefresh } from "../state/refresh-bus";
import { recordClientDiagnostic } from "../state/dev-diagnostics-store";

interface UseRefreshSubscriptionOptions {
  enabled?: boolean;
  coalesceMs?: number;
  staleMs?: number;
  pollIntervalMs?: number;
  runWhenHidden?: boolean;
  onFallbackStateChange?: (active: boolean) => void;
}

export function useRefreshSubscription(
  topic: RefreshTopic,
  callback: (signal: RefreshSignal) => Promise<void> | void,
  options: UseRefreshSubscriptionOptions = {},
): void {
  const callbackRef = useRef(callback);
  const latestSignalRef = useRef<RefreshSignal | null>(null);
  const timerRef = useRef<number | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const lastSignalAtRef = useRef<number>(Date.now());
  const fallbackActiveRef = useRef(false);
  const fallbackPollLastRanAtRef = useRef<number>(0);

  const enabled = options.enabled ?? true;
  const coalesceMs = options.coalesceMs ?? 900;
  const staleMs = options.staleMs;
  const pollIntervalMs = options.pollIntervalMs ?? 15000;
  const runWhenHidden = options.runWhenHidden ?? false;
  const debug = Boolean(import.meta.env.DEV);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const setFallbackActive = (active: boolean) => {
      if (fallbackActiveRef.current === active) {
        return;
      }
      fallbackActiveRef.current = active;
      options.onFallbackStateChange?.(active);
    };

    if (!enabled) {
      setFallbackActive(false);
      return;
    }

    const runLatest = async (source: "event" | "fallback") => {
      if (inFlightRef.current) {
        pendingRef.current = true;
        recordClientDiagnostic({
          level: "debug",
          category: "refresh",
          event: "queued",
          message: `Refresh for ${topic} queued while callback was in-flight`,
          context: { topic },
        });
        if (debug) {
          console.debug(`[refresh:${topic}] skipped while in-flight; queued follow-up refresh`);
        }
        return;
      }

      const signal = latestSignalRef.current ?? {
        topic,
        timestamp: Date.now(),
        reason: "fallback_poll",
        source: "refresh-hook",
        eventType: "fallback_poll",
      };

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
      if (debug) {
        console.debug(
          `[refresh:${topic}] started`,
          signal.reason,
          signal.eventType ?? signal.source ?? "unknown",
        );
      }
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
            error: (error as Error).message,
          },
        });
        if (debug) {
          console.warn(`[refresh:${topic}] callback failed`, error);
        }
      } finally {
        if (source === "fallback") {
          fallbackPollLastRanAtRef.current = Date.now();
        }
        inFlightRef.current = false;
        if (debug) {
          console.debug(`[refresh:${topic}] completed`);
        }
        recordClientDiagnostic({
          level: "debug",
          category: "refresh",
          event: "completed",
          message: `Refresh completed for ${topic}`,
          context: { topic, source },
        });
        if (pendingRef.current) {
          pendingRef.current = false;
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            void runLatest("event");
          }, coalesceMs);
        }
      }
    };

    const unsubscribe = subscribeRefresh(topic, (signal) => {
      latestSignalRef.current = signal;
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
      if (debug) {
        console.debug(
          `[refresh:${topic}] event`,
          signal.reason,
          signal.eventType ?? signal.source ?? "unknown",
        );
      }
      if (timerRef.current !== null) {
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void runLatest("event");
      }, coalesceMs);
    });

    if (typeof staleMs === "number" && staleMs > 0) {
      fallbackTimerRef.current = window.setInterval(() => {
        if (!enabled) {
          return;
        }
        if (!runWhenHidden && typeof document !== "undefined" && document.hidden) {
          return;
        }
        const now = Date.now();
        if (now - lastSignalAtRef.current < staleMs) {
          return;
        }
        if (now - fallbackPollLastRanAtRef.current < pollIntervalMs) {
          return;
        }
        setFallbackActive(true);
        void runLatest("fallback");
      }, Math.max(1000, pollIntervalMs));
    }

    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = null;
      if (fallbackTimerRef.current !== null) {
        window.clearInterval(fallbackTimerRef.current);
      }
      fallbackTimerRef.current = null;
      pendingRef.current = false;
      inFlightRef.current = false;
      latestSignalRef.current = null;
      setFallbackActive(false);
    };
  }, [
    coalesceMs,
    enabled,
    pollIntervalMs,
    runWhenHidden,
    staleMs,
    topic,
    options.onFallbackStateChange,
  ]);
}
