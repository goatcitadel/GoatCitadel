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
  const routingSummary =
    trust.effectiveProviderModelSummary ??
    trust.requestedProviderModelSummary ??
    trust.providerModelSummary ??
    "Provider routing pending";

  return (
    <header className={`mission-surface-header mode-${mode}`} aria-label={`${trust.activeModeLabel} session surface`}>
      <div className="mission-surface-header-copy">
        <h2>{sessionTitle}</h2>
        <p className="mission-surface-header-posture">{summary}</p>
        <div className="mission-surface-summary-row" aria-label="Surface summary">
          <span>{trust.workspaceLabel}</span>
          <span>{routingSummary}</span>
          {trust.selectionSourceSummary ? <span>{trust.selectionSourceSummary}</span> : null}
        </div>
      </div>
      <div className="mission-surface-header-actions">
        <button
          type="button"
          className="gc-nav-button gc-nav-tier-chip mission-surface-dock-toggle"
          onClick={onToggleDock}
          aria-expanded={dockOpen}
        >
          {dockOpen ? "Hide context" : "Show context"}
        </button>
      </div>
    </header>
  );
}
