import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCostSummary,
  fetchDaemonStatus,
  fetchDashboardState,
  fetchHealthSummary,
  fetchLlmEvalProofRuns,
  fetchLlmLocalEngines,
  fetchLlmRuntimeMeasurements,
  fetchMcpServers,
  fetchSessions,
  fetchTimelineSummary,
  listBackups,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "../api/client";
import { useRefreshSubscription } from "./useRefreshSubscription";

const RUNTIME_POLL_INTERVAL_MS = 15_000;
const BASE_OPS_POLL_SOURCES = ["dashboard", "health", "daemon"] as const;

type RuntimeSnapshotData = {
  dashboard: Awaited<ReturnType<typeof fetchDashboardState>> | null;
  timeline: Awaited<ReturnType<typeof fetchTimelineSummary>> | null;
  health: Awaited<ReturnType<typeof fetchHealthSummary>> | null;
  cost: Awaited<ReturnType<typeof fetchCostSummary>> | null;
  daemon: Awaited<ReturnType<typeof fetchDaemonStatus>> | null;
  backups: Awaited<ReturnType<typeof listBackups>>["items"];
  sessions: Awaited<ReturnType<typeof fetchSessions>>["items"];
  mcpServers: Awaited<ReturnType<typeof fetchMcpServers>>["items"];
  runtimeMeasurements: Awaited<ReturnType<typeof fetchLlmRuntimeMeasurements>>["items"];
  localEngines: Awaited<ReturnType<typeof fetchLlmLocalEngines>>["items"];
  evalProofRuns: Awaited<ReturnType<typeof fetchLlmEvalProofRuns>>["items"];
  sourceStatus: RuntimeSnapshotSourceStatusMap;
};

type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

type RuntimeSnapshotSourceKey =
  | "dashboard"
  | "timeline"
  | "health"
  | "cost"
  | "daemon"
  | "backups"
  | "sessions"
  | "mcpServers"
  | "runtimeMeasurements"
  | "localEngines"
  | "evalProofRuns";

export type RuntimeSnapshotSourceStatus =
  | { status: "ok" }
  | {
      status: "error";
      message: string;
    };

export type RuntimeSnapshotSourceStatusMap = Record<RuntimeSnapshotSourceKey, RuntimeSnapshotSourceStatus>;

type RuntimeSnapshotReloadMode = "full" | "poll";

export function useOpsRuntimeSnapshot(activeSection = "activity") {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [daemonBusy, setDaemonBusy] = useState<null | "start" | "restart" | "stop">(null);
  const [data, setData] = useState<RuntimeSnapshotData | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(false);
  const dataRef = useRef<RuntimeSnapshotData | null>(null);
  // Monotonic load id: results from a superseded load (overlapping reloads, or a
  // reload that resolves after unmount/teardown) are dropped. Mirrors the guard in
  // useCrossProjectRecentSessions / useApprovalQueue.
  const loadSequenceRef = useRef(0);

  const commitData = useCallback((next: RuntimeSnapshotData) => {
    dataRef.current = next;
    setData(next);
  }, []);

  const load = useCallback(
    async (mode: RuntimeSnapshotReloadMode = "full") => {
      const sourceSet = mode === "poll" ? buildOpsPollSourceSet(activeSection) : undefined;
      const current = dataRef.current;
      const [
        dashboard,
        timeline,
        health,
        cost,
        daemon,
        backups,
        sessions,
        mcpServers,
        runtimeMeasurements,
        localEngines,
        evalProofRuns,
      ] = await Promise.all([
        loadRuntimeSnapshotSource("dashboard", current, sourceSet, null, () => fetchDashboardState()),
        loadRuntimeSnapshotSource("timeline", current, sourceSet, null, () => fetchTimelineSummary()),
        loadRuntimeSnapshotSource("health", current, sourceSet, null, () => fetchHealthSummary()),
        loadRuntimeSnapshotSource("cost", current, sourceSet, null, () => fetchCostSummary("day")),
        loadRuntimeSnapshotSource("daemon", current, sourceSet, null, () => fetchDaemonStatus()),
        loadRuntimeSnapshotSource("backups", current, sourceSet, [], async () => (await listBackups(10)).items),
        loadRuntimeSnapshotSource("sessions", current, sourceSet, [], async () => (await fetchSessions()).items),
        loadRuntimeSnapshotSource("mcpServers", current, sourceSet, [], async () => (await fetchMcpServers()).items),
        loadRuntimeSnapshotSource(
          "runtimeMeasurements",
          current,
          sourceSet,
          [],
          async () => (await fetchLlmRuntimeMeasurements({ limit: 20 })).items,
        ),
        loadRuntimeSnapshotSource(
          "localEngines",
          current,
          sourceSet,
          [],
          async () => (await fetchLlmLocalEngines()).items,
        ),
        loadRuntimeSnapshotSource(
          "evalProofRuns",
          current,
          sourceSet,
          [],
          async () => (await fetchLlmEvalProofRuns(10)).items,
        ),
      ]);

      return {
        dashboard: dashboard.data,
        timeline: timeline.data,
        health: health.data,
        cost: cost.data,
        daemon: daemon.data,
        backups: backups.data,
        sessions: sessions.data,
        mcpServers: mcpServers.data,
        runtimeMeasurements: runtimeMeasurements.data,
        localEngines: localEngines.data,
        evalProofRuns: evalProofRuns.data,
        sourceStatus: {
          dashboard: dashboard.status,
          timeline: timeline.status,
          health: health.status,
          cost: cost.status,
          daemon: daemon.status,
          backups: backups.status,
          sessions: sessions.status,
          mcpServers: mcpServers.status,
          runtimeMeasurements: runtimeMeasurements.status,
          localEngines: localEngines.status,
          evalProofRuns: evalProofRuns.status,
        },
      } satisfies RuntimeSnapshotData;
    },
    [activeSection],
  );

  const reload = useCallback(
    async (mode: RuntimeSnapshotReloadMode = "full") => {
      const loadId = loadSequenceRef.current + 1;
      loadSequenceRef.current = loadId;
      setError(null);
      try {
        const next = await load(mode);
        if (loadSequenceRef.current !== loadId) {
          return;
        }
        commitData(next);
        setLastFetchedAt(Date.now());
        setIsStale(false);
      } catch (loadError) {
        if (loadSequenceRef.current !== loadId) {
          return;
        }
        setError(getErrorMessage(loadError));
      }
    },
    [commitData, load],
  );

  useEffect(() => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setLoading(true);
    setError(null);
    void load()
      .then((next) => {
        if (loadSequenceRef.current !== loadId) {
          return;
        }
        commitData(next);
        setLastFetchedAt(Date.now());
        setIsStale(false);
      })
      .catch((loadError) => {
        if (loadSequenceRef.current !== loadId) {
          return;
        }
        setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (loadSequenceRef.current === loadId) {
          setLoading(false);
        }
      });

    return () => {
      // Invalidate this load (and any reload in flight) so a late resolution
      // after unmount or session switch cannot setState on an unmounted hook.
      loadSequenceRef.current += 1;
    };
  }, [commitData, load]);

  // Mirror the polling pattern used by `useApprovalQueue`: subscribe to the
  // shared refresh bus so realtime events trigger an immediate refetch, and
  // fall back to a 15s interval poll if no signal arrives. `useRefreshSubscription`
  // already pauses the fallback poll while `document.hidden` is true and resumes
  // on visibility change, so SR users and the activity feed never get stuck on
  // stale data after the tab refocuses.
  useRefreshSubscription(
    "system",
    async (signal) => {
      await reload(signal.reason === "fallback_poll" || signal.eventType === "fallback_poll" ? "poll" : "full");
    },
    {
      coalesceMs: 1000,
      staleMs: RUNTIME_POLL_INTERVAL_MS,
      pollIntervalMs: RUNTIME_POLL_INTERVAL_MS,
    },
  );

  // Mark the snapshot as stale once the data is older than 2x the poll interval.
  // This lets the UI surface a "data may be stale" indicator without forcing a
  // refetch (the polling above will catch up as soon as it can).
  useEffect(() => {
    if (lastFetchedAt === null) {
      setIsStale(false);
      return;
    }
    const staleAfter = lastFetchedAt + RUNTIME_POLL_INTERVAL_MS * 2;
    const now = Date.now();
    if (now >= staleAfter) {
      setIsStale(true);
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const timer = window.setTimeout(() => {
      setIsStale(true);
    }, staleAfter - now);
    return () => {
      window.clearTimeout(timer);
    };
  }, [lastFetchedAt]);

  const runDaemonAction = useCallback(
    async (action: "start" | "restart" | "stop") => {
      setDaemonBusy(action);
      setNotice(null);
      try {
        const response =
          action === "start" ? await startDaemon() : action === "restart" ? await restartDaemon() : await stopDaemon();
        setData((current) => {
          const next = current
            ? {
                ...current,
                daemon: response.status,
                sourceStatus: {
                  ...current.sourceStatus,
                  daemon: { status: "ok" as const },
                },
              }
            : current;
          dataRef.current = next;
          return next;
        });
        setNotice({
          tone: response.accepted ? "success" : "warning",
          message: response.reason,
        });
        await reload();
      } catch (actionError) {
        setNotice({
          tone: "error",
          message: getErrorMessage(actionError),
        });
      } finally {
        setDaemonBusy(null);
      }
    },
    [reload],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  // Stabilize the returned object so its reference only changes when one of its
  // constituent values changes. The consumer (RuntimeRoutePage's ~1000-line
  // `content` useMemo) depends on the whole snapshot object; without this memo a
  // fresh object literal every render would defeat that memoization and force a
  // recompute on essentially every render. Every constituent is already stable per
  // render: `notice` is a setState value, `loading`/`error`/`daemonBusy`/
  // `lastFetchedAt`/`isStale`/`data` are primitives or setState-managed references,
  // and `reload`/`runDaemonAction`/`clearNotice` are useCallback-memoized — so this
  // never drops a real update.
  return useMemo(
    () => ({
      loading,
      error,
      notice,
      daemonBusy,
      data,
      lastFetchedAt,
      isStale,
      reload,
      runDaemonAction,
      clearNotice,
    }),
    [loading, error, notice, daemonBusy, data, lastFetchedAt, isStale, reload, runDaemonAction, clearNotice],
  );
}

type RuntimeSourceResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function captureRuntimeSource<T>(load: () => Promise<T>): Promise<RuntimeSourceResult<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

async function loadRuntimeSnapshotSource<K extends RuntimeSnapshotSourceKey>(
  key: K,
  current: RuntimeSnapshotData | null,
  sourceSet: ReadonlySet<RuntimeSnapshotSourceKey> | undefined,
  fallback: RuntimeSnapshotData[K],
  load: () => Promise<RuntimeSnapshotData[K]>,
): Promise<{ data: RuntimeSnapshotData[K]; status: RuntimeSnapshotSourceStatus }> {
  if (sourceSet && !sourceSet.has(key)) {
    return {
      data: current?.[key] ?? fallback,
      status: current?.sourceStatus[key] ?? { status: "ok" },
    };
  }
  const source = await captureRuntimeSource(load);
  return {
    data: source.ok ? source.data : fallback,
    status: readRuntimeSourceStatus(source),
  };
}

function readRuntimeSourceStatus(source: RuntimeSourceResult<unknown>): RuntimeSnapshotSourceStatus {
  return source.ok ? { status: "ok" } : { status: "error", message: source.message };
}

function buildOpsPollSourceSet(activeSection: string): ReadonlySet<RuntimeSnapshotSourceKey> {
  return new Set([...BASE_OPS_POLL_SOURCES, ...sourcesForOpsSection(activeSection)]);
}

function sourcesForOpsSection(activeSection: string): RuntimeSnapshotSourceKey[] {
  switch (activeSection) {
    case "sessions":
      return ["sessions"];
    case "schedules":
    case "improvement":
    case "notifications":
    case "activity":
      return ["timeline"];
    case "costs":
      return ["cost"];
    case "runtime":
      return ["backups", "mcpServers", "runtimeMeasurements", "localEngines", "evalProofRuns"];
    case "diagnostics":
      return ["timeline", "backups", "mcpServers", "runtimeMeasurements", "localEngines", "evalProofRuns"];
    default:
      return ["timeline"];
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
