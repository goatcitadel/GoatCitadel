import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchOnboardingState, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";

export interface GatewayReachability {
  unavailable: boolean;
  lastConfirmedAt: number | null;
  /** A probe is in flight. */
  checking: boolean;
  /** When the last probe finished, whatever it found. */
  lastCheckedAt: number | null;
  /** Probe again now instead of waiting for the next five-second check. */
  retry?: () => void;
}

interface ProbeState {
  unavailable: boolean;
  lastConfirmedAt: number | null;
  checking: boolean;
  lastCheckedAt: number | null;
}

const PROBE_INTERVAL_MS = 5_000;

function tabHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Probe HTTP when events fail; an SSE outage alone does not prove the Gateway is down. A hidden tab
 * does not probe; it checks once when it becomes visible again.
 */
export function useGatewayReachability(enabled: boolean, streamState: EventStreamConnectionState): GatewayReachability {
  const installation = getGatewayApiBaseUrl();
  const [state, setState] = useState<ProbeState>({
    unavailable: false,
    lastConfirmedAt: null,
    checking: false,
    lastCheckedAt: null,
  });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    if (streamState === "open") {
      const now = Date.now();
      setState({ unavailable: false, lastConfirmedAt: now, checking: false, lastCheckedAt: now });
      return;
    }
    if (streamState !== "retrying" && streamState !== "error") return;
    let active = true;
    let inFlight = false;
    const controllers = new Set<AbortController>();
    const current = () => active && getGatewayApiBaseUrl() === installation;
    const probe = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      setState((previous) => ({ ...previous, checking: true }));
      try {
        await fetchOnboardingState({ signal: controller.signal });
        if (current()) {
          const now = Date.now();
          setState({ unavailable: false, lastConfirmedAt: now, checking: false, lastCheckedAt: now });
        }
      } catch (error) {
        if (current()) {
          const now = Date.now();
          const outage =
            isApiRequestError(error) &&
            (error.kind === "network" || (error.kind === "http" && (error.status ?? 0) >= 500));
          if (outage) setState((previous) => ({ ...previous, unavailable: true, checking: false, lastCheckedAt: now }));
          else if (isApiRequestError(error))
            setState({ unavailable: false, lastConfirmedAt: now, checking: false, lastCheckedAt: now });
          else setState((previous) => ({ ...previous, checking: false, lastCheckedAt: now }));
        }
      } finally {
        controllers.delete(controller);
        inFlight = false;
      }
    };
    let interval: number | undefined;
    const start = () => {
      if (interval !== undefined) return;
      void probe();
      interval = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
    };
    const stop = () => {
      if (interval !== undefined) window.clearInterval(interval);
      interval = undefined;
    };
    const onVisibility = () => (tabHidden() ? stop() : start());
    if (!tabHidden()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const controller of controllers) controller.abort();
      setState((previous) => (previous.checking ? { ...previous, checking: false } : previous));
    };
  }, [enabled, installation, streamState, attempt]);

  const reachability = useMemo(() => ({ ...state, retry }), [state, retry]);
  return enabled ? reachability : DISABLED;
}

const DISABLED: GatewayReachability = Object.freeze({
  unavailable: false,
  lastConfirmedAt: null,
  checking: false,
  lastCheckedAt: null,
});
