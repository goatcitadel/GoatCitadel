import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteWorkerAssignmentPage,
  RemoteWorkerReconciliation,
  RemoteWorkerRegistryDetail,
} from "@goatcitadel/contracts";
import {
  fetchRemoteWorkerAssignments,
  fetchRemoteWorkerDetail,
  fetchRemoteWorkerReconciliation,
} from "@goatcitadel/mission-control-shared/api/remote-workers";
import {
  REMOTE_WORKER_REALTIME_COALESCE_MS,
  RemoteWorkerRealtimeCursor,
  subscribeRemoteWorkerRealtime,
} from "../../../../app/remote-worker-realtime";

type Loaded = {
  workerId: string;
  detail: RemoteWorkerRegistryDetail | null;
  assignments: RemoteWorkerAssignmentPage | null;
  reconciliation: RemoteWorkerReconciliation | null;
  error: string | null;
  /** Set when a refresh of this worker failed in part and the last loaded records are shown instead. */
  stale: string | null;
};

const STALE = "Some of this worker's records could not be refreshed. The last loaded ones are shown.";

const pick = <T>(result: PromiseSettledResult<T>, previous: T | null | undefined): T | null =>
  result.status === "fulfilled" ? result.value : (previous ?? null);

/**
 * One worker's detail, assignments and reconciliation, moved unchanged from the Classic workers page: every load is
 * sequence-guarded, a previous worker's records are never shown while the next loads, paging refuses a repeated
 * cursor, and realtime changes reload the registry and (when they concern this worker) its detail.
 */
export function useWorkerDetail(workspaceId: string, workerId: string | undefined, reloadRegistry: () => unknown) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const sequence = useRef(0);
  const pageCount = useRef(1);
  const moreLock = useRef(false);

  const loadAssignmentPages = useCallback(
    async (id: string) => {
      let result = await fetchRemoteWorkerAssignments(workspaceId, { workerId: id, limit: 50 });
      const rows = new Map(result.items.map((item) => [item.assignmentId, item]));
      const seen = new Set<string>();
      for (let page = 1; page < pageCount.current && result.nextCursor; page++) {
        const cursor = result.nextCursor;
        if (seen.has(cursor)) throw new Error("Assignment cursor repeated");
        seen.add(cursor);
        const next = await fetchRemoteWorkerAssignments(workspaceId, { workerId: id, limit: 50, cursor });
        next.items.forEach((item) => rows.set(item.assignmentId, item));
        result = { ...next, items: [...rows.values()] };
      }
      return result;
    },
    [workspaceId],
  );

  const load = useCallback(
    async (id: string) => {
      const loadId = ++sequence.current;
      // A reload of the same worker keeps its records on screen; only a different worker starts empty.
      setLoaded((prev) => (prev?.workerId === id ? prev : null));
      setLoading(true);
      const [detail, assignments, reconciliation] = await Promise.allSettled([
        fetchRemoteWorkerDetail(workspaceId, id),
        loadAssignmentPages(id),
        fetchRemoteWorkerReconciliation(workspaceId, id),
      ]);
      if (sequence.current !== loadId) return;
      setLoaded((prev) => {
        // A failed part of a refresh keeps the last loaded value for the same worker, marked stale.
        const last = prev?.workerId === id ? prev : null;
        const failed = [detail, assignments, reconciliation].some((result) => result.status === "rejected");
        const kept = pick(detail, last?.detail);
        return {
          workerId: id,
          detail: kept,
          assignments: pick(assignments, last?.assignments),
          reconciliation: pick(reconciliation, last?.reconciliation),
          error: detail.status === "rejected" && !kept ? "This worker's detail is unavailable." : null,
          stale: failed && last ? STALE : null,
        };
      });
      setLoading(false);
    },
    [workspaceId, loadAssignmentPages],
  );

  useEffect(() => {
    pageCount.current = 1;
    setMoreError(null);
    setLoadingMore(false);
    if (!workerId) {
      setLoaded(null);
      setLoading(false);
      return;
    }
    void load(workerId);
    return () => {
      sequence.current += 1;
    };
  }, [workerId, load]);

  // Synced refs: the realtime subscription reads the freshest callbacks and selection without resubscribing.
  const registryRef = useRef(reloadRegistry);
  const loadRef = useRef(load);
  const selectedRef = useRef(workerId);
  useEffect(() => {
    registryRef.current = reloadRegistry;
    loadRef.current = load;
    selectedRef.current = workerId;
  }, [reloadRegistry, load, workerId]);

  useEffect(() => {
    const cursor = new RemoteWorkerRealtimeCursor();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingDetail = false;
    const flush = () => {
      timer = null;
      void registryRef.current();
      const selected = selectedRef.current;
      if (pendingDetail && selected) void loadRef.current(selected);
      pendingDetail = false;
    };
    const unsubscribe = subscribeRemoteWorkerRealtime((signal) => {
      if (signal.kind === "change" && signal.workspaceId !== workspaceId) return;
      if (!cursor.decide(signal).reload) return;
      if (
        signal.kind === "replay_gap" ||
        signal.entity === "assignment" ||
        (signal.entity === "worker" && signal.entityId === selectedRef.current)
      )
        pendingDetail = true;
      if (timer === null) timer = setTimeout(flush, REMOTE_WORKER_REALTIME_COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      cursor.reset();
    };
  }, [workspaceId]);

  const current = loaded && loaded.workerId === workerId ? loaded : null;

  const loadMoreAssignments = async () => {
    const assignments = current?.assignments;
    if (!workerId || !assignments?.nextCursor || moreLock.current || loading) return;
    const id = sequence.current;
    moreLock.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await fetchRemoteWorkerAssignments(workspaceId, {
        workerId,
        limit: 50,
        cursor: assignments.nextCursor,
      });
      if (id !== sequence.current) return;
      if (next.nextCursor === assignments.nextCursor) throw new Error("Assignment cursor repeated");
      const rows = new Map(assignments.items.map((item) => [item.assignmentId, item]));
      next.items.forEach((item) => rows.set(item.assignmentId, item));
      pageCount.current++;
      setLoaded((prev) =>
        prev && prev.workerId === workerId ? { ...prev, assignments: { ...next, items: [...rows.values()] } } : prev,
      );
    } catch {
      if (id === sequence.current)
        setMoreError("Additional assignments are unavailable. Try again to continue from the loaded records.");
    } finally {
      moreLock.current = false;
      setLoadingMore(false);
    }
  };

  return {
    detail: current?.detail ?? null,
    assignments: current?.assignments ?? null,
    reconciliation: current?.reconciliation ?? null,
    error: current?.error ?? null,
    stale: current?.stale ?? null,
    loading,
    loadingMore,
    moreError,
    loadMoreAssignments,
    refresh: () => (workerId ? load(workerId) : Promise.resolve()),
  };
}
