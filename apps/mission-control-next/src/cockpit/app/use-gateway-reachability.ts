import { useEffect, useState } from "react";
import { fetchOnboardingState, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";

export interface GatewayReachability {
  unavailable: boolean;
  lastConfirmedAt: number | null;
}

/** Probe HTTP when events fail; an SSE outage alone does not prove the Gateway is down. */
export function useGatewayReachability(enabled: boolean, streamState: EventStreamConnectionState): GatewayReachability {
  const installation = getGatewayApiBaseUrl();
  const [state, setState] = useState<GatewayReachability>({ unavailable: false, lastConfirmedAt: null });

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
  }, [enabled, installation, streamState]);

  return enabled ? state : { unavailable: false, lastConfirmedAt: null };
}
