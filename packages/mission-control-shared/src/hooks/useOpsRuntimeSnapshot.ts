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
};

type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

export function useOpsRuntimeSnapshot() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [daemonBusy, setDaemonBusy] = useState<null | "start" | "restart" | "stop">(null);
  const [data, setData] = useState<RuntimeSnapshotData | null>(null);

  const load = useCallback(async () => {
    const [dashboard, timeline, health, cost, daemon, backups, sessions, mcpServers] = await Promise.all([
      fetchDashboardState().catch(() => null),
      fetchTimelineSummary().catch(() => null),
      fetchHealthSummary().catch(() => null),
      fetchCostSummary("day").catch(() => null),
      fetchDaemonStatus().catch(() => null),
      listBackups(10).catch(() => ({ items: [] })),
      fetchSessions().catch(() => ({ items: [] })),
      fetchMcpServers().catch(() => ({ items: [] })),
    ]);

    return {
      dashboard,
      timeline,
      health,
      cost,
      daemon,
      backups: backups.items,
      sessions: sessions.items,
      mcpServers: mcpServers.items,
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
