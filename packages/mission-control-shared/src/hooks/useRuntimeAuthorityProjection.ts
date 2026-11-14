import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RuntimeAuthorityProjectionResponse } from "@goatcitadel/contracts";
import { fetchRuntimeAuthorityProjection } from "../api/runtime-authority";
import { useRefreshSubscription } from "./useRefreshSubscription";

export function useRuntimeAuthorityProjection(workspaceId: string) {
  const scope = useMemo(() => ({ workspaceId }), [workspaceId]);
  const activeScope = useRef<typeof scope | null>(null);
  const loadSequenceRef = useRef(0);
  const [result, setResult] = useState<{
    scope: typeof scope;
    data: RuntimeAuthorityProjectionResponse | null;
    error: string | null;
  }>();

  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = null;
      loadSequenceRef.current += 1;
    };
  }, [scope]);

  const reload = useCallback(async () => {
    if (activeScope.current !== scope) return;
    const loadId = ++loadSequenceRef.current;
    setResult((previous) => (previous?.scope === scope && previous.error ? { ...previous, error: null } : previous));
    try {
      const data = await fetchRuntimeAuthorityProjection(scope.workspaceId);
      if (loadSequenceRef.current === loadId) {
        setResult({ scope, data, error: null });
      }
    } catch {
      if (loadSequenceRef.current === loadId) {
        setResult({ scope, data: null, error: "The scoped runtime authority envelope is unavailable." });
      }
    }
  }, [scope]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRefreshSubscription("system", reload, {
    staleMs: 60_000,
    pollIntervalMs: 60_000,
  });
  useRefreshSubscription("approvals", reload);

  const current = result?.scope === scope ? result : undefined;
  return useMemo(
    () => ({ data: current?.data ?? null, error: current?.error ?? null, loading: !current, reload }),
    [current, reload],
  );
}
