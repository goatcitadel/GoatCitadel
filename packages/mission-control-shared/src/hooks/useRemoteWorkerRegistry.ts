import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteWorkerRegistryPage } from "@goatcitadel/contracts";
import { fetchRemoteWorkerRegistry } from "../api/remote-workers.js";
import { useRefreshSubscription } from "./useRefreshSubscription.js";

export interface RemoteWorkerRegistryState {
  readonly page: RemoteWorkerRegistryPage | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/**
 * HX-507B Ops truth for one workspace's remote-worker registry. The server owns
 * every fact; this hook only fetches the canonical read projection and exposes
 * `reload`. Live invalidation is content-free: the Ops page drives precise,
 * deduplicated refetches from the retained SSE workers signal, and this hook's
 * `useRefreshSubscription` fallback polls the visible registry every 15 seconds
 * while the stream is disconnected. It never treats an event payload as state.
 */
export function useRemoteWorkerRegistry(
  workspaceId: string,
  options: { limit?: number } = {},
): RemoteWorkerRegistryState {
  const [page, setPage] = useState<RemoteWorkerRegistryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const limit = options.limit;

  const reload = useCallback(async () => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    try {
      const result = await fetchRemoteWorkerRegistry(workspaceId, limit === undefined ? {} : { limit });
      if (loadSequenceRef.current !== loadId) return;
      setPage(result);
      setError(null);
    } catch {
      if (loadSequenceRef.current !== loadId) return;
      setPage(null);
      setError("The remote-worker registry is unavailable.");
    } finally {
      if (loadSequenceRef.current === loadId) setLoading(false);
    }
  }, [workspaceId, limit]);

  useEffect(() => {
    setLoading(true);
    setPage(null);
    setError(null);
    void reload();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [reload]);

  useRefreshSubscription("surface", reload, { staleMs: 15_000, pollIntervalMs: 15_000 });

  return useMemo(() => ({ page, loading, error, reload }), [page, loading, error, reload]);
}
