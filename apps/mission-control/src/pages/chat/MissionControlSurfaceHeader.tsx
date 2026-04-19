import type { ChatMode } from "@goatcitadel/contracts";
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
  return (
    <header className={`mission-surface-header mode-${mode}`} aria-label={`${trust.activeModeLabel} session surface`}>
      <div className="mission-surface-header-copy">
        <h2>{sessionTitle}</h2>
        <p className="mission-surface-header-posture">{summary}</p>
      </div>
      <div className="mission-surface-header-actions">
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
