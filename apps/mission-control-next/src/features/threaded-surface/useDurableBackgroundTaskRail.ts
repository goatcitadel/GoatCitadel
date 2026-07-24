import { useCallback, useEffect, useRef, useState } from "react";
import type { DurableBackgroundTaskControlAction, DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import {
  controlDurableBackgroundTask,
  fetchDurableBackgroundTaskRail,
} from "@goatcitadel/mission-control-shared/api/durable";

const ACTIVE_POLL_INTERVAL_MS = 3_000;

export interface DurableBackgroundTaskRailState {
  snapshot: DurableBackgroundTaskRailResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  pendingWatcherId: string | null;
  refresh: () => Promise<void>;
  control: (watcherId: string, action: DurableBackgroundTaskControlAction, reason?: string) => Promise<boolean>;
}

export function useDurableBackgroundTaskRail(input: {
  parentRunId?: string;
  workspaceId: string;
  sessionId?: string | null;
}): DurableBackgroundTaskRailState {
  const parentRunId = input.parentRunId?.trim() || undefined;
  const sessionId = input.sessionId?.trim() || undefined;
  const workspaceId = input.workspaceId.trim();
  const scopeKey =
    parentRunId && sessionId && workspaceId ? `${parentRunId}\u0000${workspaceId}\u0000${sessionId}` : "";
  const [snapshot, setSnapshot] = useState<DurableBackgroundTaskRailResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(scopeKey));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingWatcherId, setPendingWatcherId] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const pendingControlScopes = useRef(new Set<string>());
  const activeScopeKey = useRef(scopeKey);
  activeScopeKey.current = scopeKey;

  const refresh = useCallback(async () => {
    if (!parentRunId || !sessionId || !workspaceId) return;
    const requestId = ++requestSequence.current;
    setRefreshing(true);
    try {
      const next = await fetchDurableBackgroundTaskRail(parentRunId, { workspaceId, sessionId });
      if (requestId !== requestSequence.current || activeScopeKey.current !== scopeKey) return;
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (requestId !== requestSequence.current || activeScopeKey.current !== scopeKey) return;
      setError(caught instanceof Error ? caught.message : "Background-task state could not be loaded.");
    } finally {
      if (requestId === requestSequence.current && activeScopeKey.current === scopeKey) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [parentRunId, scopeKey, sessionId, workspaceId]);

  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot(null);
    setError(null);
    setPendingWatcherId(null);
    setLoading(Boolean(scopeKey));
    setRefreshing(false);
    if (!scopeKey) return;
    void refresh();
  }, [refresh, scopeKey]);

  const shouldPoll = snapshot
    ? !isTerminalStatus(snapshot.parent.status) ||
      snapshot.tasks.some((task) => !isTerminalStatus(task.canonicalStatus))
    : Boolean(scopeKey);
  useEffect(() => {
    if (!scopeKey || !shouldPoll) return;
    const timer = setInterval(() => void refresh(), ACTIVE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, scopeKey, shouldPoll]);

  const control = useCallback(
    async (watcherId: string, action: DurableBackgroundTaskControlAction, reason?: string): Promise<boolean> => {
      if (!parentRunId || !sessionId || !workspaceId || !snapshot || pendingControlScopes.current.has(scopeKey))
        return false;
      const task = snapshot.tasks.find((candidate) => candidate.watcherId === watcherId);
      if (!task) return false;
      const requestScopeKey = scopeKey;
      pendingControlScopes.current.add(scopeKey);
      setPendingWatcherId(watcherId);
      setError(null);
      try {
        const result = await controlDurableBackgroundTask(parentRunId, watcherId, {
          workspaceId,
          sessionId,
          action,
          expectedWatcherRevision: task.watcherRevision,
          expectedChildVersion: action === "cancel" ? task.childVersion : undefined,
          reason,
        });
        if (activeScopeKey.current !== requestScopeKey) return false;
        requestSequence.current += 1;
        setSnapshot(result.rail);
        return true;
      } catch (caught) {
        if (activeScopeKey.current === requestScopeKey) {
          setError(caught instanceof Error ? caught.message : `Background-task ${action} failed.`);
          void refresh();
        }
        return false;
      } finally {
        pendingControlScopes.current.delete(requestScopeKey);
        if (activeScopeKey.current === requestScopeKey) setPendingWatcherId(null);
      }
    },
    [parentRunId, refresh, scopeKey, sessionId, snapshot, workspaceId],
  );

  return { snapshot, loading, refreshing, error, pendingWatcherId, refresh, control };
}

export function isTerminalStatus(
  status: DurableBackgroundTaskRailResponse["tasks"][number]["canonicalStatus"],
): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
}
