import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "../api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScope,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "../api/access-scope";

/** Invalidates captured reads/reviews across access changes, including an away-and-back change. */
export function useProjectAccess(scope: string) {
  const revision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  const installation = getGatewayApiBaseUrl();
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, () => "");
  const identity = JSON.stringify([installation, caller, revision, scope]);
  const ref = useRef({ identity });
  if (ref.current.identity !== identity) ref.current = { identity };
  const token = ref.current;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useCallback(
    () =>
      mounted.current &&
      ref.current === token &&
      getGatewayApiBaseUrl() === installation &&
      getGatewayAccessRevision() === revision &&
      getGatewayCallerScope() === caller,
    [token, installation, revision, caller],
  );
  return {
    identity,
    token,
    presentationScope: JSON.stringify([installation, caller, scope]),
    current,
  };
}
