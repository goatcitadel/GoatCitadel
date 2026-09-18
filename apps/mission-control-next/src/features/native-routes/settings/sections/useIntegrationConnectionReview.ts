import { useCallback, useEffect, useRef, useState } from "react";
import { fetchIntegrationConnection, isApiRequestError, type IntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "../../shared/native-helpers";

export function describeIntegrationConnectionError(error: unknown): string {
  if (isApiRequestError(error) && error.body && typeof error.body === "object" && "error" in error.body && typeof error.body.error === "string") return error.body.error;
  return getErrorMessage(error);
}

/** A conflict refresh is read-only; accepting the review never retries a write. */
export function useIntegrationConnectionReview(workspaceId: string, connectionId: string, apply: (connectionId: string, connection: IntegrationConnection | null) => void) {
  const scope = useRef({ workspaceId, connectionId });
  if (scope.current.workspaceId !== workspaceId || scope.current.connectionId !== connectionId) scope.current = { workspaceId, connectionId };
  const token = scope.current;
  const mounted = useRef(true);
  const requestId = useRef(0);
  const [state, setState] = useState({ token, required: false, loading: false, error: null as string | null, missing: false });
  const isCurrent = useCallback(() => mounted.current && scope.current === token, [token]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (!isCurrent() || !connectionId) return;
    const readId = ++requestId.current;
    const isLatest = () => isCurrent() && readId === requestId.current;
    setState({ token, required: true, loading: true, error: null, missing: false });
    try {
      const current = await fetchIntegrationConnection(connectionId);
      if (current.connectionId !== connectionId || !/^[a-f0-9]{64}$/.test(current.revision)) throw new Error("The connection review could not be verified.");
      if (!isLatest()) return;
      apply(connectionId, current);
      setState({ token, required: true, loading: false, error: null, missing: false });
    } catch (error) {
      if (!isLatest()) return;
      const missing = isApiRequestError(error) && error.status === 404;
      if (missing) apply(connectionId, null);
      setState({ token, required: true, loading: false, missing, error: missing ? "This connection was deleted. Your draft is retained." : `Current settings could not be loaded: ${describeIntegrationConnectionError(error)}` });
    }
  }, [apply, connectionId, isCurrent, token]);
  const current = state.token === token ? state : { required: false, loading: false, error: null, missing: false };
  return { ...current, isCurrent, refresh,
    accept: () => { if (isCurrent() && !current.loading && !current.error && !current.missing) setState({ token, required: false, loading: false, error: null, missing: false }); },
  };
}
