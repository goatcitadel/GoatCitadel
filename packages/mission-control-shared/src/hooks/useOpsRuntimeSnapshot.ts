import { useCallback, useEffect, useState } from "react";
import {
  fetchCostSummary,
  fetchDaemonStatus,
  fetchDashboardState,
  fetchHealthSummary,
  fetchMcpServers,
  fetchSessions,
  fetchTimelineSummary,
  listBackups,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from "../api/client";

type RuntimeSnapshotData = {
  dashboard: Awaited<ReturnType<typeof fetchDashboardState>> | null;
  timeline: Awaited<ReturnType<typeof fetchTimelineSummary>> | null;
  health: Awaited<ReturnType<typeof fetchHealthSummary>> | null;
  cost: Awaited<ReturnType<typeof fetchCostSummary>> | null;
  daemon: Awaited<ReturnType<typeof fetchDaemonStatus>> | null;
  backups: Awaited<ReturnType<typeof listBackups>>["items"];
  sessions: Awaited<ReturnType<typeof fetchSessions>>["items"];
  mcpServers: Awaited<ReturnType<typeof fetchMcpServers>>["items"];
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
  | "mcpServers";

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

  const load = useCallback(async () => {
    const [dashboard, timeline, health, cost, daemon, backups, sessions, mcpServers] = await Promise.all([
      captureRuntimeSource(() => fetchDashboardState()),
      captureRuntimeSource(() => fetchTimelineSummary()),
      captureRuntimeSource(() => fetchHealthSummary()),
      captureRuntimeSource(() => fetchCostSummary("day")),
      captureRuntimeSource(() => fetchDaemonStatus()),
      captureRuntimeSource(() => listBackups(10)),
      captureRuntimeSource(() => fetchSessions()),
      captureRuntimeSource(() => fetchMcpServers()),
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
      sourceStatus: {
        dashboard: readRuntimeSourceStatus(dashboard),
        timeline: readRuntimeSourceStatus(timeline),
        health: readRuntimeSourceStatus(health),
        cost: readRuntimeSourceStatus(cost),
        daemon: readRuntimeSourceStatus(daemon),
        backups: readRuntimeSourceStatus(backups),
        sessions: readRuntimeSourceStatus(sessions),
        mcpServers: readRuntimeSourceStatus(mcpServers),
      },
    } satisfies RuntimeSnapshotData;
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await load();
      setData(next);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load()
      .then((next) => {
        if (cancelled) {
          return;
        }
        setData(next);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

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
