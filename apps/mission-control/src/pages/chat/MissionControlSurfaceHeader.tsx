import type { ChatMode } from "@goatcitadel/contracts";
import { StatusChip } from "../../components/StatusChip";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function MissionControlSurfaceHeader({
  mode,
  sessionTitle,
  summary,
  status,
  dockOpen,
  onToggleDock,
}: {
  mode: ChatMode;
  sessionTitle: string;
  summary: string;
  status?: string | null;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  const config = getMissionControlSurfaceConfig(mode);

  return (
    <header className={`mission-surface-header mode-${mode}`}>
      <div className="mission-surface-header-copy">
        <p className="mission-surface-header-kicker">{config.shellEyebrow}</p>
        <h2>{sessionTitle}</h2>
        <p>{summary}</p>
      </div>
      <div className="mission-surface-header-actions">
        <StatusChip tone={mode === "chat" ? "live" : mode === "cowork" ? "warning" : "critical"}>
          {config.label}
        </StatusChip>
        {status ? <StatusChip tone="muted">{status}</StatusChip> : null}
        <button type="button" className="mission-surface-dock-toggle" onClick={onToggleDock}>
          {dockOpen ? "Hide context" : "Show context"}
        </button>
      </div>
    </header>
  );
}
