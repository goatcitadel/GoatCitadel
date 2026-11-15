import { useEffect, useRef } from "react";
import { fetchOnboardingState, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { isGatewayUnreachableChatError } from "@goatcitadel/threaded-surface-core";

const PROBE_INTERVAL_MS = 5_000;

const tabHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/** The Gateway answered, even with a refusal: only a network failure or a server error means it is still out. */
function gatewayAnswered(error: unknown): boolean {
  return isApiRequestError(error) && error.kind !== "network" && !(error.kind === "http" && (error.status ?? 0) >= 500);
}

/**
 * While Chat shows the "Can't reach GoatCitadel" notice, check every few seconds whether the Gateway answers again.
 * The first answer clears the notice and reads the thread again, once, so the notice never outlives the outage.
 * A hidden tab does not check; it checks as soon as it is visible again. Any other error is left alone.
 */
export function useChatOutageRecovery(input: {
  streamError: string | null | undefined;
  onDismissError?: () => void;
  onRefreshThread?: () => void;
}): void {
  const { streamError } = input;
  const callbacks = useRef(input);
  callbacks.current = input;
  const unreachable = isGatewayUnreachableChatError(streamError);

  useEffect(() => {
    if (!unreachable) return;
    let active = true;
    let inFlight = false;
    const controllers = new Set<AbortController>();
    const probe = async () => {
      if (inFlight || tabHidden()) return;
      inFlight = true;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        await fetchOnboardingState({ signal: controller.signal });
      } catch (error) {
        if (!gatewayAnswered(error)) return;
      } finally {
        controllers.delete(controller);
        inFlight = false;
      }
      if (!active || controller.signal.aborted) return;
      active = false;
      window.clearInterval(interval);
      callbacks.current.onDismissError?.();
      callbacks.current.onRefreshThread?.();
    };
    const interval = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
    const onVisibility = () => {
      if (!tabHidden()) void probe();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const controller of controllers) controller.abort();
    };
  }, [unreachable, streamError]);
}
