import type { ChatMode } from "@goatcitadel/contracts";
import { StatusChip } from "../../components/StatusChip";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function MissionControlSurfaceHeader({
  mode,
  sessionTitle,
  summary,
  status,
  providerLabel,
  modelLabel,
  dockOpen,
  onToggleDock,
}: {
  mode: ChatMode;
  sessionTitle: string;
  summary: string;
  status?: string | null;
  providerLabel?: string;
  modelLabel?: string;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  const config = getMissionControlSurfaceConfig(mode);

  return (
    <header className={`mission-surface-header mode-${mode}`}>
      <div className="mission-surface-header-copy">
        <p className="mission-surface-header-kicker">{config.label}</p>
        <h2>{sessionTitle}</h2>
        <p>{summary}</p>
      </div>
      <div className="mission-surface-header-actions">
        <StatusChip tone={mode === "chat" ? "live" : mode === "cowork" ? "warning" : "critical"}>
          {config.stageTitle}
        </StatusChip>
        {status ? <StatusChip tone="muted">{status}</StatusChip> : null}
        {providerLabel ? <StatusChip tone="muted">{providerLabel}</StatusChip> : null}
        {modelLabel ? <StatusChip tone="muted">{modelLabel}</StatusChip> : null}
        <button type="button" className="gc-nav-pill mission-surface-dock-toggle" onClick={onToggleDock}>
          {dockOpen ? "Hide context" : "Show context"}
        </button>
      </div>
    </header>
  );
}
