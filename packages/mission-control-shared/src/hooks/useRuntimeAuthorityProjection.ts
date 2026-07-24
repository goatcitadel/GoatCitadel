import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeAuthorityProjectionResponse } from "@goatcitadel/contracts";
import { fetchRuntimeAuthorityProjection } from "../api/runtime-authority";
import { useRefreshSubscription } from "./useRefreshSubscription";

export function useRuntimeAuthorityProjection(workspaceId: string) {
  const [data, setData] = useState<RuntimeAuthorityProjectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  const reload = useCallback(async () => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setError(null);
    try {
      const next = await fetchRuntimeAuthorityProjection(workspaceId);
      if (loadSequenceRef.current === loadId) {
        setData(next);
      }
    } catch {
      if (loadSequenceRef.current === loadId) {
        setData(null);
        setError("The scoped runtime authority envelope is unavailable.");
      }
    } finally {
      if (loadSequenceRef.current === loadId) {
        setLoading(false);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setError(null);
    void reload();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [reload]);

  useRefreshSubscription("system", reload, {
    staleMs: 60_000,
    pollIntervalMs: 60_000,
  });
  useRefreshSubscription("approvals", reload);

  return useMemo(() => ({ data, loading, error, reload }), [data, loading, error, reload]);
}
