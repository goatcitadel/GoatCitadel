import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteWorkerRegistryPage } from "@goatcitadel/contracts";
import { fetchRemoteWorkerRegistry } from "../api/remote-workers.js";
import { useRefreshSubscription } from "./useRefreshSubscription.js";
export interface RemoteWorkerRegistryState {
  readonly page: RemoteWorkerRegistryPage | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly loadingMore: boolean;
  readonly moreError: string | null;
  readonly reload: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
}
/** Canonical pages only. Refresh retains the number of pages the operator opened. */
export function useRemoteWorkerRegistry(
  workspaceId: string,
  options: { limit?: number } = {},
): RemoteWorkerRegistryState {
  const [page, setPage] = useState<RemoteWorkerRegistryPage | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false),
    [moreError, setMoreError] = useState<string | null>(null);
  const sequence = useRef(0),
    pageCount = useRef(1),
    moreBusy = useRef(false);
  const pageRef = useRef(page);
  pageRef.current = page;
  const limit = options.limit;
  const reloadBusy = useRef(false);
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    reloadBusy.current = true;
    moreBusy.current = false;
    setLoadingMore(false);
    try {
      let result = await fetchRemoteWorkerRegistry(workspaceId, { limit });
      if (sequence.current !== id) return;
      if (result.workspaceId !== workspaceId) throw new Error("Registry scope changed");
      const seen = new Set<string>();
      const rows = new Map(result.items.map((item) => [item.workerId, item]));
      for (let index = 1; index < pageCount.current && result.nextCursor; index++) {
        const cursor = result.nextCursor;
        if (seen.has(cursor)) throw new Error("Registry cursor repeated");
        seen.add(cursor);
        const next = await fetchRemoteWorkerRegistry(workspaceId, { limit, cursor });
        if (next.workspaceId !== workspaceId) throw new Error("Registry scope changed");
        next.items.forEach((item) => rows.set(item.workerId, item));
        result = { ...next, items: [...rows.values()] };
      }
      if (sequence.current !== id) return;
      setPage(result);
      setError(null);
      setMoreError(null);
    } catch {
      if (sequence.current === id) {
        setPage(null);
        setError("The remote-worker registry is unavailable.");
      }
    } finally {
      if (sequence.current === id) { reloadBusy.current = false; setLoading(false); }
    }
  }, [workspaceId, limit]);
  const loadMore = useCallback(async () => {
    const current = pageRef.current;
    if (!current?.nextCursor || moreBusy.current || reloadBusy.current) return;
    const id = sequence.current;
    moreBusy.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await fetchRemoteWorkerRegistry(workspaceId, { limit, cursor: current.nextCursor });
      if (sequence.current !== id) return;
      if (next.workspaceId !== workspaceId || next.nextCursor === current.nextCursor)
        throw new Error("Registry cursor or scope changed");
      const rows = new Map(current.items.map((item) => [item.workerId, item]));
      next.items.forEach((item) => rows.set(item.workerId, item));
      pageCount.current++;
      setPage({ ...next, items: [...rows.values()] });
    } catch {
      if (sequence.current === id)
        setMoreError("Additional workers are unavailable. The loaded records remain available; retry to continue.");
    } finally {
      if (sequence.current === id) {
        moreBusy.current = false;
        setLoadingMore(false);
      }
    }
  }, [workspaceId, limit]);
  useEffect(() => {
    const lifecycle = sequence;
    setLoading(true);
    setPage(null);
    setError(null);
    setMoreError(null);
    pageCount.current = 1;
    void reload();
    return () => {
      lifecycle.current++;
    };
  }, [reload]);
  useRefreshSubscription("surface", reload, { staleMs: 15_000, pollIntervalMs: 15_000 });
  return useMemo(
    () => ({ page, loading, error, loadingMore, moreError, reload, loadMore }),
    [page, loading, error, loadingMore, moreError, reload, loadMore],
  );
}
