import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DurableBackgroundTaskControlAction, DurableBackgroundTaskRailResponse } from "@goatcitadel/contracts";
import {
  controlDurableBackgroundTask,
  fetchDurableBackgroundTaskRail,
} from "@goatcitadel/mission-control-shared/api/durable";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { SHELL_NAVIGATION_EVENTS } from "../../app/shell-transition";

const ACTIVE_POLL_INTERVAL_MS = 3_000;
const CONFLICT_MESSAGE =
  "Background work changed before this action could be applied. Close this review, refresh background work, then review the current child again.";

export interface BackgroundTaskControlReview {
  scopeKey: string;
  view: object;
  watcherId: string;
  childRunId: string;
  watcherRevision: number;
  childVersion?: number;
}
interface ControlState {
  watcherId: string;
  review: BackgroundTaskControlReview;
  kind: "pending" | "conflict" | "unknown";
  message?: string;
}
// Admission and uncertain writes survive shell changes/remounts in this app session.
const controls = new Map<string, ControlState>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(scope: string, state?: ControlState) {
  if (state) controls.set(scope, state);
  else controls.delete(scope);
  for (const listener of listeners) listener();
}
export function __resetBackgroundControlsForTests() {
  controls.clear();
  for (const listener of listeners) listener();
}

/** Only these exact owner branches reject before their transaction commits. */
export function isBackgroundControlConflict(
  caught: unknown,
  parentRunId: string,
  review: BackgroundTaskControlReview,
  action: DurableBackgroundTaskControlAction,
): boolean {
  if (
    !isApiRequestError(caught) ||
    caught.kind !== "http" ||
    caught.status !== 409 ||
    caught.method !== "POST" ||
    caught.path !==
      `/api/v1/durable/runs/${encodeURIComponent(parentRunId)}/background-tasks/${encodeURIComponent(review.watcherId)}/control`
  )
    return false;
  const body = caught.body;
  if (!body || typeof body !== "object" || Object.keys(body).some((key) => key !== "error")) return false;
  const message = (body as { error?: unknown }).error;
  if (typeof message !== "string") return false;
  if (message === `Durable child watcher ${review.watcherId} changed before ${action} could be applied.`) return true;
  const prefix =
    action === "cancel" ? `Durable run ${review.childRunId} changed from version ${review.childVersion} to ` : "";
  const watcherPrefix = `Durable child watcher ${review.watcherId} changed from revision ${review.watcherRevision} to `;
  return [
    [prefix, " before cancellation."],
    [watcherPrefix, " before control could be applied."],
  ].some(
    ([start, end]) =>
      Boolean(start) &&
      message.startsWith(start!) &&
      message.endsWith(end!) &&
      /^\d+$/.test(message.slice(start!.length, -end!.length)),
  );
}

export interface DurableBackgroundTaskRailState {
  snapshot: DurableBackgroundTaskRailResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  pendingWatcherId: string | null;
  controlFailure: ControlState | null;
  review: (watcherId: string) => BackgroundTaskControlReview | null;
  dismissReview: (review: BackgroundTaskControlReview) => void;
  isReviewCurrent: (review: BackgroundTaskControlReview) => boolean;
  refresh: () => Promise<void>;
  control: (
    watcherId: string,
    action: DurableBackgroundTaskControlAction,
    reason?: string,
    review?: BackgroundTaskControlReview,
  ) => Promise<boolean>;
}

export function useDurableBackgroundTaskRail(input: {
  parentRunId?: string;
  workspaceId: string;
  sessionId?: string | null;
}): DurableBackgroundTaskRailState {
  const parentRunId = input.parentRunId?.trim() || undefined;
  const sessionId = input.sessionId?.trim() || undefined;
  const workspaceId = input.workspaceId.trim();
  const installation = getGatewayApiBaseUrl();
  const scopeKey =
    parentRunId && sessionId && workspaceId
      ? `${installation}\u0000${parentRunId}\u0000${workspaceId}\u0000${sessionId}`
      : "";
  const [snapshot, setSnapshot] = useState<DurableBackgroundTaskRailResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(scopeKey));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const currentSnapshot = useRef(snapshot);
  currentSnapshot.current = snapshot;
  const mounted = useRef(true);
  const view = useRef({ scopeKey, token: {} });
  if (view.current.scopeKey !== scopeKey) view.current = { scopeKey, token: {} };
  const renderedView = view.current.token;
  const consumed = useRef(new WeakSet<object>());
  const dismissed = useRef(new WeakSet<object>());
  const activeReview = useRef<BackgroundTaskControlReview | null>(null);
  const controlState = useSyncExternalStore(
    subscribe,
    () => controls.get(scopeKey),
    () => undefined,
  );
  const isCurrent = useCallback(
    () => mounted.current && view.current.token === renderedView && getGatewayApiBaseUrl() === installation,
    [installation, renderedView],
  );

  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      view.current = { ...view.current, token: {} };
      requestSequence.current += 1;
      setSnapshot(null);
    };
    if (typeof window !== "undefined")
      for (const event of SHELL_NAVIGATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
      view.current = { ...view.current, token: {} };
      if (typeof window !== "undefined")
        for (const event of SHELL_NAVIGATION_EVENTS) window.removeEventListener(event, invalidate);
    };
  }, []);

  const review = useCallback(
    (watcherId: string): BackgroundTaskControlReview | null => {
      if (!isCurrent()) return null;
      const current = currentSnapshot.current;
      if (
        !current ||
        current.parent.runId !== parentRunId ||
        current.scope.workspaceId !== workspaceId ||
        current.scope.sessionId !== sessionId
      )
        return null;
      const task = current.tasks.find((item) => item.watcherId === watcherId);
      if (!task) return null;
      if (activeReview.current) dismissed.current.add(activeReview.current);
      activeReview.current = Object.freeze({
        scopeKey,
        view: renderedView,
        watcherId,
        childRunId: task.childRunId,
        watcherRevision: task.watcherRevision,
        childVersion: task.childVersion,
      });
      return activeReview.current;
    },
    [isCurrent, parentRunId, renderedView, scopeKey, sessionId, workspaceId],
  );
  const dismissReview = useCallback((item: BackgroundTaskControlReview) => {
    dismissed.current.add(item);
  }, []);
  const isReviewCurrent = useCallback(
    (item: BackgroundTaskControlReview) =>
      isCurrent() && item.scopeKey === scopeKey && item.view === renderedView && !dismissed.current.has(item),
    [isCurrent, renderedView, scopeKey],
  );

  const refresh = useCallback(async () => {
    if (!parentRunId || !sessionId || !workspaceId || !isCurrent()) return;
    const requestId = ++requestSequence.current;
    setRefreshing(true);
    try {
      // A fresh read must not join a transport started before a committed control.
      const next = await fetchDurableBackgroundTaskRail(
        parentRunId,
        { workspaceId, sessionId },
        { signal: new AbortController().signal },
      );
      if (requestId !== requestSequence.current || !isCurrent()) return;
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (requestId !== requestSequence.current || !isCurrent()) return;
      // A valid parent run with no child watchers returns a successful empty
      // rail; a 404 means the run is missing or outside this workspace/session
      // scope, so it MUST stay an error — but as an operator sentence, not the
      // raw API envelope JSON.
      if (isApiRequestError(caught)) {
        setError(
          caught.status === 404
            ? "No background-task rail exists for this run in the active workspace/session scope."
            : `Background-task state could not be loaded (HTTP ${caught.status ?? "error"}).`,
        );
      } else {
        setError(caught instanceof Error ? caught.message : "Background-task state could not be loaded.");
      }
    } finally {
      if (requestId === requestSequence.current && isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [isCurrent, parentRunId, sessionId, workspaceId]);

  useEffect(() => {
    requestSequence.current += 1;
    setSnapshot(null);
    setError(null);
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
    async (
      watcherId: string,
      action: DurableBackgroundTaskControlAction,
      reason?: string,
      suppliedReview?: BackgroundTaskControlReview,
    ): Promise<boolean> => {
      const retained = controls.get(scopeKey);
      if (
        !parentRunId ||
        !sessionId ||
        !workspaceId ||
        !isCurrent() ||
        retained?.kind === "pending" ||
        retained?.kind === "unknown"
      )
        return false;
      const reviewed = suppliedReview ?? review(watcherId);
      if (!reviewed || reviewed.watcherId !== watcherId || !isReviewCurrent(reviewed) || consumed.current.has(reviewed))
        return false;
      const currentTask = currentSnapshot.current?.tasks.find((task) => task.watcherId === watcherId);
      if (!currentTask || currentTask.childRunId !== reviewed.childRunId || !currentTask.controls[action].enabled)
        return false;
      consumed.current.add(reviewed);
      if (
        currentTask.watcherRevision !== reviewed.watcherRevision ||
        (action === "cancel" && currentTask.childVersion !== reviewed.childVersion)
      ) {
        publish(scopeKey, { watcherId, review: reviewed, kind: "conflict", message: CONFLICT_MESSAGE });
        return false;
      }
      const requestScopeKey = scopeKey;
      publish(scopeKey, { watcherId, review: reviewed, kind: "pending" });
      setError(null);
      try {
        const result = await controlDurableBackgroundTask(parentRunId, watcherId, {
          workspaceId,
          sessionId,
          action,
          expectedWatcherRevision: reviewed.watcherRevision,
          expectedChildVersion: action === "cancel" ? reviewed.childVersion : undefined,
          reason,
        });
        if (result.childRunId !== reviewed.childRunId)
          throw new Error("The control receipt identifies another child run.");
        publish(requestScopeKey);
        if (!isCurrent()) return false;
        requestSequence.current += 1;
        // The bump masks any in-flight refresh's sequence-guarded `.finally`,
        // so this commit must settle the flags that refresh can no longer
        // clear: when the control rail ends polling (everything terminal)
        // while a poll refresh is in flight, `refreshing` would otherwise
        // stick true forever. A committed rail also means the scope is past
        // its initial load, so `loading` drops at this choke point too.
        setSnapshot(result.rail);
        setLoading(false);
        setRefreshing(false);
        return true;
      } catch (caught) {
        const conflict = isBackgroundControlConflict(caught, parentRunId, reviewed, action);
        publish(requestScopeKey, {
          watcherId,
          review: reviewed,
          kind: conflict ? "conflict" : "unknown",
          message: conflict
            ? CONFLICT_MESSAGE
            : "The background control outcome is unconfirmed. Further controls are locked; inspect the canonical run evidence before taking another action.",
        });
        if (isCurrent()) {
          void refresh();
        }
        return false;
      }
    },
    [isCurrent, isReviewCurrent, parentRunId, refresh, review, scopeKey, sessionId, workspaceId],
  );

  return {
    snapshot,
    loading,
    refreshing,
    error: controlState?.message ?? error,
    pendingWatcherId: controlState && controlState.kind !== "conflict" ? controlState.watcherId : null,
    controlFailure: controlState?.message ? controlState : null,
    review,
    dismissReview,
    isReviewCurrent,
    refresh,
    control,
  };
}

export function isTerminalStatus(
  status: DurableBackgroundTaskRailResponse["tasks"][number]["canonicalStatus"],
): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
}
