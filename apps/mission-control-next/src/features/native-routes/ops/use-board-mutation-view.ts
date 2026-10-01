import { useLayoutEffect, useRef } from "react";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
/** Monotonic view lifetime; includes rendered draft/review identity and cancels edit-away/back before dispatch. */
export function useBoardMutationView(value: unknown) {
  const base = getGatewayApiBaseUrl(),
    identity = canonicalJsonString([base, value]);
  const live = useRef({ identity, epoch: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch++;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch++;
    };
  }, [identity]);
  return {
    invalidate: () => {
      live.current.epoch++;
    },
    capture: () => {
      const epoch = live.current.epoch;
      return () =>
        live.current.mounted &&
        live.current.identity === identity &&
        live.current.epoch === epoch &&
        getGatewayApiBaseUrl() === base;
    },
  };
}
