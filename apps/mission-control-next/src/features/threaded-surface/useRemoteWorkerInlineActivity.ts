import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteWorkerAssignmentProjection } from "@goatcitadel/contracts";
import { fetchRemoteWorkerAssignments } from "@goatcitadel/mission-control-shared/api/remote-workers";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import {
  REMOTE_WORKER_REALTIME_COALESCE_MS,
  RemoteWorkerRealtimeCursor,
  subscribeRemoteWorkerRealtime,
} from "../../app/remote-worker-realtime";

export interface RemoteWorkerInlineActivityInput {
  workspaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
}

export interface RemoteWorkerInlineActivityState {
  readonly assignments: readonly RemoteWorkerAssignmentProjection[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

const ACTIVE_POLL_MS = 3_000;

/**
 * HX-507B one-Chat activity binding. Loads ONLY the assignments whose stored
 * lineage matches the active workspace/session/turn — storage decides
 * membership, never a caller assertion. Live invalidation reuses the existing
 * retained SSE workers signal (assignment scope); while the stream is
 * disconnected and a turn is active, it polls every 3 seconds. It never treats
 * an event payload as canonical state.
 */
export function useRemoteWorkerInlineActivity(input: RemoteWorkerInlineActivityInput): RemoteWorkerInlineActivityState {
  const { workspaceId } = input;
  const sessionId = input.sessionId ?? undefined;
  const turnId = input.turnId ?? undefined;
  const enabled = Boolean(workspaceId && sessionId && turnId);
  const [assignments, setAssignments] = useState<readonly RemoteWorkerAssignmentProjection[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const streamStatus = useEventStreamStatus();

  const reload = useCallback(async () => {
    if (!enabled || !sessionId || !turnId) {
      setAssignments([]);
      setLoading(false);
      return;
    }
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    try {
      const page = await fetchRemoteWorkerAssignments(workspaceId, { sessionId, turnId, limit: 25 });
      if (loadSequenceRef.current !== loadId) return;
      setAssignments(page.items);
      setError(null);
    } catch {
      if (loadSequenceRef.current !== loadId) return;
      setAssignments([]);
      setError("Remote-worker activity is unavailable.");
    } finally {
      if (loadSequenceRef.current === loadId) setLoading(false);
    }
  }, [enabled, sessionId, turnId, workspaceId]);

  useEffect(() => {
    if (!enabled) {
      setAssignments([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    void reload();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [enabled, reload]);

  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    if (!enabled) return;
    const cursor = new RemoteWorkerRealtimeCursor();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeRemoteWorkerRealtime((signal) => {
      if (signal.kind === "change" && (signal.workspaceId !== workspaceId || signal.entity !== "assignment")) return;
      if (!cursor.decide(signal).reload) return;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          void reloadRef.current();
        }, REMOTE_WORKER_REALTIME_COALESCE_MS);
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      cursor.reset();
    };
  }, [enabled, workspaceId]);

  const disconnected = streamStatus.state !== "open";
  useEffect(() => {
    if (!enabled || !disconnected) return;
    const interval = setInterval(() => {
      void reloadRef.current();
    }, ACTIVE_POLL_MS);
    return () => clearInterval(interval);
  }, [enabled, disconnected]);

  return useMemo(() => ({ assignments, loading, error, reload }), [assignments, loading, error, reload]);
}
