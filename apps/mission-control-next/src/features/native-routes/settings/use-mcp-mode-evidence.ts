import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { readMcpModeEvidence, type McpModeEvidence } from "./mcp-mode-evidence";

/** Scope is a view lifetime boundary; these owners are installation-wide, not workspace-filtered. */
export function useMcpModeEvidence(scope: string, enabled: boolean) {
  const base = getGatewayApiBaseUrl();
  const identity = useRef({ scope, enabled, base });
  if (identity.current.scope !== scope || identity.current.enabled !== enabled || identity.current.base !== base)
    identity.current = { scope, enabled, base };
  const view = identity.current;
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const [state, setState] = useState<{ view: typeof view; loading: boolean; data?: McpModeEvidence }>();
  const refresh = useCallback(async () => {
    if (!enabled || !mounted.current || identity.current !== view) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState({ view, loading: true });
    const data = await readMcpModeEvidence(controller.signal);
    if (
      mounted.current &&
      identity.current === view &&
      getGatewayApiBaseUrl() === view.base &&
      pending.current === controller &&
      !controller.signal.aborted
    )
      setState({ view, loading: false, data });
  }, [enabled, view]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, [refresh]);
  const current = enabled && state?.view === view ? state : undefined;
  return { loading: enabled && (!current || current.loading), data: current?.data, refresh };
}
