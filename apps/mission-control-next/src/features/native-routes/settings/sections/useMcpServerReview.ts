import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMcpServer, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { getErrorMessage } from "../../shared/native-helpers";

export function describeMcpServerError(error: unknown): string {
  if (isApiRequestError(error) && error.body && typeof error.body === "object" && "error" in error.body && typeof error.body.error === "string") return error.body.error;
  return getErrorMessage(error);
}

/** Read-only conflict recovery. Review acceptance never retries a mutation. */
export function useMcpServerReview(workspaceId: string, serverId: string, apply: (serverId: string, server: McpServerRecord | null) => void) {
  const scope = useRef({ workspaceId, serverId });
  if (scope.current.workspaceId !== workspaceId || scope.current.serverId !== serverId) scope.current = { workspaceId, serverId };
  const token = scope.current;
  const mounted = useRef(true);
  const requestId = useRef(0);
  const [state, setState] = useState({ token, required: false, loading: false, error: null as string | null, missing: false });
  const isCurrent = useCallback(() => mounted.current && scope.current === token, [token]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (!isCurrent() || !serverId) return;
    const readId = ++requestId.current;
    const isLatest = () => isCurrent() && readId === requestId.current;
    setState({ token, required: true, loading: true, error: null, missing: false });
    try {
      const current = await fetchMcpServer(serverId);
      if (current.serverId !== serverId || !/^[a-f0-9]{64}$/.test(current.revision ?? "")) throw new Error("The server review could not be verified.");
      if (!isLatest()) return;
      apply(serverId, current);
      setState({ token, required: true, loading: false, error: null, missing: false });
    } catch (error) {
      if (!isLatest()) return;
      const missing = isApiRequestError(error) && error.status === 404;
      if (missing) apply(serverId, null);
      setState({ token, required: true, loading: false, missing, error: missing ? "This server was deleted. Your draft is retained." : `Current settings could not be loaded: ${describeMcpServerError(error)}` });
    }
  }, [apply, isCurrent, serverId, token]);
  const current = state.token === token ? state : { required: false, loading: false, error: null, missing: false };
  return { ...current, isCurrent, refresh,
    accept: () => { if (isCurrent() && !current.loading && !current.error && !current.missing) setState({ token, required: false, loading: false, error: null, missing: false }); },
  };
}
