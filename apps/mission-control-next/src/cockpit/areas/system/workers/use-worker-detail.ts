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
};

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
      setLoaded(null);
      setLoading(true);
      const [detail, assignments, reconciliation] = await Promise.allSettled([
        fetchRemoteWorkerDetail(workspaceId, id),
        loadAssignmentPages(id),
        fetchRemoteWorkerReconciliation(workspaceId, id),
      ]);
      if (sequence.current !== loadId) return;
      setLoaded({
        workerId: id,
        detail: detail.status === "fulfilled" ? detail.value : null,
        assignments: assignments.status === "fulfilled" ? assignments.value : null,
        reconciliation: reconciliation.status === "fulfilled" ? reconciliation.value : null,
        error: detail.status === "rejected" ? "This worker's detail is unavailable." : null,
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
      if (id === sequence.current) setLoadingMore(false);
    }
  };

  return {
    detail: current?.detail ?? null,
    assignments: current?.assignments ?? null,
    reconciliation: current?.reconciliation ?? null,
    error: current?.error ?? null,
    loading,
    loadingMore,
    moreError,
    loadMoreAssignments,
    refresh: () => (workerId ? load(workerId) : Promise.resolve()),
  };
}
