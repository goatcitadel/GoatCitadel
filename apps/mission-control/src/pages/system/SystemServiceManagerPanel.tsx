import type { fetchDaemonStatus } from "../../api/client";
import { ActionButton } from "../../components/ActionButton";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";

interface SystemServiceManagerPanelProps {
  daemonStatus: Awaited<ReturnType<typeof fetchDaemonStatus>> | null;
  daemonStateTone: "success" | "warning";
  daemonControlSupported: boolean;
  daemonBusy: boolean;
  daemonLogs: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRefresh: () => void;
}

export function SystemServiceManagerPanel({
  daemonStatus,
  daemonStateTone,
  daemonControlSupported,
  daemonBusy,
  daemonLogs,
  onStart,
  onStop,
  onRestart,
  onRefresh,
}: SystemServiceManagerPanelProps) {
  return (
    <Panel
      title="Service Manager"
      subtitle={
        <>
          Manage the local GoatCitadel daemon lifecycle and inspect recent service events.
          <HelpHint
            label="Service manager help"
            text="Use Start, Stop, Restart, and Refresh to control the local daemon process. Refresh only reloads status and recent logs."
          />
        </>
      }
      actions={
        <div className="workflow-summary-strip">
          <StatusChip tone={daemonStateTone}>{daemonStatus?.state ?? "unknown"}</StatusChip>
          <StatusChip tone="muted">PID {daemonStatus?.pid ?? 0}</StatusChip>
          <StatusChip tone="muted">{Math.round(daemonStatus?.uptimeSeconds ?? 0)}s uptime</StatusChip>
        </div>
      }
    >
      <div className="row-actions">
        <ActionButton
          label="Start"
          onClick={onStart}
          disabled={daemonBusy || !daemonControlSupported || daemonStatus?.running}
        />
        <ActionButton
          label="Stop"
          onClick={onStop}
          disabled={daemonBusy || !daemonControlSupported || !daemonStatus?.running}
        />
        <ActionButton label="Restart" onClick={onRestart} disabled={daemonBusy || !daemonControlSupported} />
        <ActionButton label="Refresh" onClick={onRefresh} disabled={daemonBusy} />
      </div>
      {daemonStatus?.controlMessage ? <p className="office-subtitle">{daemonStatus.controlMessage}</p> : null}
      {daemonLogs.length > 0 ? (
        <pre>
          {daemonLogs.map((entry) => `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`).join("\n")}
        </pre>
      ) : (
        <p className="office-subtitle">No daemon log events yet.</p>
      )}
    </Panel>
  );
}
