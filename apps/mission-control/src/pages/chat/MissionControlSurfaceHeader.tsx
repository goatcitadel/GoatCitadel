import type { ChatMode } from "@goatcitadel/contracts";
import { StatusChip } from "../../components/StatusChip";
import { getMissionControlSurfaceConfig } from "./surface-config";
import type { WorkTrustDescriptor } from "./work-trust";

export function MissionControlSurfaceHeader({
  mode,
  sessionTitle,
  summary,
  trust,
  dockOpen,
  onToggleDock,
}: {
  mode: ChatMode;
  sessionTitle: string;
  summary: string;
  trust: WorkTrustDescriptor;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  const config = getMissionControlSurfaceConfig(mode);

  return (
    <header className={`mission-surface-header mode-${mode}`} aria-label={`${trust.activeModeLabel} session surface`}>
      <div className="mission-surface-header-copy">
        <p className="mission-surface-header-kicker">{config.label}</p>
        <h2>{sessionTitle}</h2>
        <p className="mission-surface-header-posture">{summary}</p>
      </div>
      <div className="mission-surface-header-actions">
        <StatusChip tone={mode === "chat" ? "live" : mode === "cowork" ? "warning" : "critical"}>
          {config.stageTitle}
        </StatusChip>
        <button
          type="button"
          className="gc-nav-button gc-nav-tier-chip mission-surface-dock-toggle"
          onClick={onToggleDock}
        >
          {dockOpen ? "Hide context" : "Show context"}
        </button>
      </div>
    </header>
  );
}
