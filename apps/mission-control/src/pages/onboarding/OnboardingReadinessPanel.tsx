interface OnboardingReadinessPanelProps {
  daemonReady: boolean;
  completedChecklistItems: number;
  totalChecklistItems: number;
  wizardCompleted: boolean;
  daemonStatus: {
    host?: string;
    state: string;
    pid?: number;
    uptimeSeconds?: number;
    controlMessage?: string;
  } | null;
  daemonBusy: "start" | "restart" | null;
  daemonControlSupported: boolean;
  onDaemonAction: (action: "start" | "restart") => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function OnboardingReadinessPanel(props: OnboardingReadinessPanelProps) {
  const {
    daemonReady,
    completedChecklistItems,
    totalChecklistItems,
    wizardCompleted,
    daemonStatus,
    daemonBusy,
    daemonControlSupported,
    onDaemonAction,
    onRefresh,
  } = props;

  return (
    <article className="card">
      <h3>Launch Readiness</h3>
      <div className="token-row">
        <span className={`token-chip ${daemonReady ? "token-chip-active" : ""}`}>
          Gateway {daemonReady ? "running" : "unavailable"}
        </span>
        <span className={`token-chip ${completedChecklistItems === totalChecklistItems ? "token-chip-active" : ""}`}>
          Checklist {completedChecklistItems}/{totalChecklistItems}
        </span>
        <span className={`token-chip ${wizardCompleted ? "token-chip-active" : ""}`}>
          Wizard {wizardCompleted ? "complete" : "in progress"}
        </span>
        {daemonStatus?.host ? <span className="token-chip">Host {daemonStatus.host}</span> : null}
      </div>
      <div className="controls-row">
        <button
          type="button"
          onClick={() => void onDaemonAction("start")}
          disabled={daemonBusy !== null || daemonReady || !daemonControlSupported}
         className="gc-button">
          {daemonBusy === "start" ? "Starting..." : daemonReady ? "Gateway running" : "Start daemon"}
        </button>
        <button
          type="button"
          onClick={() => void onDaemonAction("restart")}
          disabled={daemonBusy !== null || !daemonControlSupported}
         className="gc-button">
          {daemonBusy === "restart" ? "Restarting..." : "Restart daemon"}
        </button>
        <button type="button" onClick={() => void onRefresh()} className="gc-button">
          Refresh readiness
        </button>
      </div>
      {daemonStatus ? (
        <p className="office-subtitle">
          State: {daemonStatus.state}
          {daemonStatus.pid ? ` · pid ${daemonStatus.pid}` : ""}
          {daemonStatus.uptimeSeconds ? ` · uptime ${Math.floor(daemonStatus.uptimeSeconds)}s` : ""}
        </p>
      ) : (
        <p className="office-subtitle">Daemon status is unavailable right now.</p>
      )}
      {daemonStatus?.controlMessage ? <p className="office-subtitle">{daemonStatus.controlMessage}</p> : null}
    </article>
  );
}
