import { useEffect, useState } from "react";
import {
  fetchDaemonLogs,
  fetchDaemonStatus,
  fetchSystemVitals,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type SystemVitalsResponse,
} from "../api/client";
import { FieldHelp } from "../components/FieldHelp";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { StatusChip } from "../components/StatusChip";
import { pageCopy } from "../content/copy";
import { SystemHostVitalsGrid } from "./system/SystemHostVitalsGrid";
import { SystemServiceManagerPanel } from "./system/SystemServiceManagerPanel";
import { normalizeSystemVitals } from "./system-page-normalizers";

type DaemonLogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
};

export function SystemPage() {
  const [vitals, setVitals] = useState<SystemVitalsResponse | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<Awaited<ReturnType<typeof fetchDaemonStatus>> | null>(null);
  const [daemonLogs, setDaemonLogs] = useState<DaemonLogEntry[]>([]);
  const [daemonBusy, setDaemonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDaemon = async () => {
    const [status, logs] = await Promise.all([fetchDaemonStatus(), fetchDaemonLogs(100)]);
    setDaemonStatus(status);
    setDaemonLogs(logs.items);
  };

  useEffect(() => {
    void Promise.all([fetchSystemVitals(), fetchDaemonStatus(), fetchDaemonLogs(100)])
      .then(([nextVitals, nextDaemonStatus, nextDaemonLogs]) => {
        setVitals(normalizeSystemVitals(nextVitals));
        setDaemonStatus(nextDaemonStatus);
        setDaemonLogs(nextDaemonLogs.items);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const daemonStateTone = daemonStatus?.running ? "success" : "warning";
  const daemonControlSupported = daemonStatus?.controllable ?? false;

  if (error) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Observability"
          title={pageCopy.system.title}
          subtitle={pageCopy.system.subtitle}
          hint="Inspect local runtime health, daemon lifecycle, and recent service events from one place."
        />
        <p className="error">{error}</p>
      </section>
    );
  }

  if (!vitals) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Observability"
          title={pageCopy.system.title}
          subtitle={pageCopy.system.subtitle}
          hint="Inspect local runtime health, daemon lifecycle, and recent service events from one place."
        />
        <p>Loading system vitals...</p>
      </section>
    );
  }

  const onDaemonStart = async () => {
    setDaemonBusy(true);
    try {
      const response = await startDaemon();
      setDaemonStatus(response.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDaemonBusy(false);
    }
  };

  const onDaemonStop = async () => {
    setDaemonBusy(true);
    try {
      const response = await stopDaemon();
      setDaemonStatus(response.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDaemonBusy(false);
    }
  };

  const onDaemonRestart = async () => {
    setDaemonBusy(true);
    try {
      const response = await restartDaemon();
      setDaemonStatus(response.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDaemonBusy(false);
    }
  };

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Observability"
        title={pageCopy.system.title}
        subtitle={pageCopy.system.subtitle}
        hint="Use this surface when you need to confirm local runtime health, inspect the current gateway process, or review recent service events."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">
              {vitals.platform} {vitals.release}
            </StatusChip>
            <StatusChip tone={daemonStateTone}>{daemonStatus?.state ?? "unknown"}</StatusChip>
            <StatusChip tone={daemonStateTone}>
              {daemonStatus?.running ? "Gateway process running" : "Gateway process unavailable"}
            </StatusChip>
          </div>
        }
      />
      <PageGuideCard
        pageId="system"
        what={pageCopy.system.guide?.what ?? ""}
        when={pageCopy.system.guide?.when ?? ""}
        actions={pageCopy.system.guide?.actions ?? []}
      />
      <div className="workflow-status-stack">
        <FieldHelp>
          This page reports the live gateway process. Process lifecycle control must happen in your external service
          manager; Mission Control cannot start or stop the process directly.
        </FieldHelp>
      </div>
      <SystemHostVitalsGrid vitals={vitals} />
      <SystemServiceManagerPanel
        daemonStatus={daemonStatus}
        daemonStateTone={daemonStateTone}
        daemonControlSupported={daemonControlSupported}
        daemonBusy={daemonBusy}
        daemonLogs={daemonLogs}
        onStart={onDaemonStart}
        onStop={onDaemonStop}
        onRestart={onDaemonRestart}
        onRefresh={() => void refreshDaemon()}
      />
    </section>
  );
}
