import type { ChatMode } from "@goatcitadel/contracts";
import type { WorkTrustDescriptor } from "./work-trust";

export function MissionControlSurfaceHeader({
  mode,
  sessionTitle,
  summary,
  trust,
  dockOpen,
  onToggleDock,
  onNavigateSurface,
}: {
  mode: ChatMode;
  sessionTitle: string;
  summary: string;
  trust: WorkTrustDescriptor;
  dockOpen: boolean;
  onToggleDock: () => void;
  onNavigateSurface?: (surface: ChatMode) => void;
}) {
  const routingSummary =
    trust.effectiveProviderModelSummary ??
    trust.requestedProviderModelSummary ??
    trust.providerModelSummary ??
    "Provider routing pending";

  return (
    <header className={`mission-surface-header mode-${mode}`} aria-label={`${trust.activeModeLabel} session surface`}>
      <div className="mission-surface-header-copy">
        <p className="mission-surface-header-kicker">{trust.activeModeLabel}</p>
        <h2>{sessionTitle}</h2>
        <p className="mission-surface-header-posture">{summary}</p>
        <div className="mission-surface-summary-row" aria-label="Surface summary">
          <span>{trust.workspaceLabel}</span>
          <span>{routingSummary}</span>
          {trust.selectionSourceSummary ? <span>{trust.selectionSourceSummary}</span> : null}
        </div>
        <div className="mission-surface-trust-row" aria-label="Trust summary">
          {trust.runStateSummary ? <span>{trust.runStateSummary}</span> : null}
          <span>{trust.approvalsSummary}</span>
          {trust.fallbackSummary ? <span>{trust.fallbackSummary}</span> : null}
          <span>{trust.runtimeSummary}</span>
        </div>
      </div>
      <div className="mission-surface-header-actions">
        {mode !== "chat" ? (
          <button
            type="button"
            className="gc-nav-button gc-nav-tier-chip mission-surface-route-button"
            onClick={() => onNavigateSurface?.("chat")}
          >
            Return to Chat
          </button>
        ) : null}
        {mode !== "cowork" ? (
          <button
            type="button"
            className="gc-nav-button gc-nav-tier-chip mission-surface-route-button"
            onClick={() => onNavigateSurface?.("cowork")}
          >
            Continue in Cowork
          </button>
        ) : null}
        {mode !== "code" ? (
          <button
            type="button"
            className="gc-nav-button gc-nav-tier-chip mission-surface-route-button"
            onClick={() => onNavigateSurface?.("code")}
          >
            Open in Code
          </button>
        ) : null}
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
