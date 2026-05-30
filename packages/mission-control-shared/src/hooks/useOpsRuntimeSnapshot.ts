import { useCallback, useEffect, useRef, useState } from "react";
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

export function useOpsRuntimeSnapshot() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [daemonBusy, setDaemonBusy] = useState<null | "start" | "restart" | "stop">(null);
  const [data, setData] = useState<RuntimeSnapshotData | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(false);
  // Monotonic load id: results from a superseded load (overlapping reloads, or a
  // reload that resolves after unmount/teardown) are dropped. Mirrors the guard in
  // useCrossProjectRecentSessions / useApprovalQueue.
  const loadSequenceRef = useRef(0);

  const load = useCallback(async () => {
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
      captureRuntimeSource(() => fetchDashboardState()),
      captureRuntimeSource(() => fetchTimelineSummary()),
      captureRuntimeSource(() => fetchHealthSummary()),
      captureRuntimeSource(() => fetchCostSummary("day")),
      captureRuntimeSource(() => fetchDaemonStatus()),
      captureRuntimeSource(() => listBackups(10)),
      captureRuntimeSource(() => fetchSessions()),
      captureRuntimeSource(() => fetchMcpServers()),
      captureRuntimeSource(() => fetchLlmRuntimeMeasurements({ limit: 20 })),
      captureRuntimeSource(() => fetchLlmLocalEngines()),
      captureRuntimeSource(() => fetchLlmEvalProofRuns(10)),
    ]);

    return {
      dashboard: readRuntimeSourceData(dashboard, null),
      timeline: readRuntimeSourceData(timeline, null),
      health: readRuntimeSourceData(health, null),
      cost: readRuntimeSourceData(cost, null),
      daemon: readRuntimeSourceData(daemon, null),
      backups: readRuntimeSourceData(backups, { items: [] }).items,
      sessions: readRuntimeSourceData(sessions, { items: [] }).items,
      mcpServers: readRuntimeSourceData(mcpServers, { items: [] }).items,
      runtimeMeasurements: readRuntimeSourceData(runtimeMeasurements, { items: [] }).items,
      localEngines: readRuntimeSourceData(localEngines, { items: [] }).items,
      evalProofRuns: readRuntimeSourceData(evalProofRuns, { items: [] }).items,
      sourceStatus: {
        dashboard: readRuntimeSourceStatus(dashboard),
        timeline: readRuntimeSourceStatus(timeline),
        health: readRuntimeSourceStatus(health),
        cost: readRuntimeSourceStatus(cost),
        daemon: readRuntimeSourceStatus(daemon),
        backups: readRuntimeSourceStatus(backups),
        sessions: readRuntimeSourceStatus(sessions),
        mcpServers: readRuntimeSourceStatus(mcpServers),
        runtimeMeasurements: readRuntimeSourceStatus(runtimeMeasurements),
        localEngines: readRuntimeSourceStatus(localEngines),
        evalProofRuns: readRuntimeSourceStatus(evalProofRuns),
      },
    } satisfies RuntimeSnapshotData;
  }, []);

  const reload = useCallback(async () => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setError(null);
    try {
      const next = await load();
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setData(next);
      setLastFetchedAt(Date.now());
      setIsStale(false);
    } catch (loadError) {
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setError(getErrorMessage(loadError));
    }
  }, [load]);

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
        setData(next);
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
  }, [load]);

  // Mirror the polling pattern used by `useApprovalQueue`: subscribe to the
  // shared refresh bus so realtime events trigger an immediate refetch, and
  // fall back to a 15s interval poll if no signal arrives. `useRefreshSubscription`
  // already pauses the fallback poll while `document.hidden` is true and resumes
  // on visibility change, so SR users and the activity feed never get stuck on
  // stale data after the tab refocuses.
  useRefreshSubscription(
    "system",
    async () => {
      await reload();
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
        setData((current) =>
          current
            ? {
                ...current,
                daemon: response.status,
                sourceStatus: {
                  ...current.sourceStatus,
                  daemon: { status: "ok" },
                },
              }
            : current,
        );
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

  return {
    loading,
    error,
    notice,
    daemonBusy,
    data,
    lastFetchedAt,
    isStale,
    reload,
    runDaemonAction,
    clearNotice: () => setNotice(null),
  };
}

type RuntimeSourceResult<T> = { ok: true; data: T } | { ok: false; message: string };

async function captureRuntimeSource<T>(load: () => Promise<T>): Promise<RuntimeSourceResult<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

function readRuntimeSourceData<T, Fallback>(source: RuntimeSourceResult<T>, fallback: Fallback): T | Fallback {
  return source.ok ? source.data : fallback;
}

function readRuntimeSourceStatus(source: RuntimeSourceResult<unknown>): RuntimeSnapshotSourceStatus {
  return source.ok ? { status: "ok" } : { status: "error", message: source.message };
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
