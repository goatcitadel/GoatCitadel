import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchOnboardingState, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";

export interface GatewayReachability {
  unavailable: boolean;
  lastConfirmedAt: number | null;
  /** Probe again now instead of waiting for the next five-second check. */
  retry?: () => void;
}

/** One sentence for every place that tells the operator how to bring the Gateway back. */
export const GATEWAY_START_HINT =
  "To start it, open the GoatCitadel desktop app, run goatcitadel up, or run pnpm dev in a source checkout.";

/** Probe HTTP when events fail; an SSE outage alone does not prove the Gateway is down. */
export function useGatewayReachability(enabled: boolean, streamState: EventStreamConnectionState): GatewayReachability {
  const installation = getGatewayApiBaseUrl();
  const [state, setState] = useState<{ unavailable: boolean; lastConfirmedAt: number | null }>({
    unavailable: false,
    lastConfirmedAt: null,
  });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    if (streamState === "open") {
      setState({ unavailable: false, lastConfirmedAt: Date.now() });
      return;
    }
    if (streamState !== "retrying" && streamState !== "error") return;
    let active = true;
    let inFlight = false;
    const controllers = new Set<AbortController>();
    const probe = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        await fetchOnboardingState({ signal: controller.signal });
        if (active && getGatewayApiBaseUrl() === installation)
          setState({ unavailable: false, lastConfirmedAt: Date.now() });
      } catch (error) {
        if (active && getGatewayApiBaseUrl() === installation && isApiRequestError(error)) {
          if (error.kind === "network" || (error.kind === "http" && (error.status ?? 0) >= 500))
            setState((current) => ({ ...current, unavailable: true }));
          else setState({ unavailable: false, lastConfirmedAt: Date.now() });
        }
      } finally {
        controllers.delete(controller);
        inFlight = false;
      }
    };
    void probe();
    const interval = window.setInterval(() => {
      void probe();
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      for (const controller of controllers) controller.abort();
    };
  }, [enabled, installation, streamState, attempt]);

  const reachability = useMemo(() => ({ ...state, retry }), [state, retry]);
  return enabled ? reachability : DISABLED;
}

const DISABLED: GatewayReachability = Object.freeze({ unavailable: false, lastConfirmedAt: null });
