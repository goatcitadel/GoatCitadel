import type { ChatMode } from "@goatcitadel/contracts";
import { StatusChip } from "../../components/StatusChip";
import type { WorkTrustDescriptor } from "./work-trust";

function inferApprovalsTone(summary: string): "muted" | "warning" {
  return /\b(clear|none|0)\b/i.test(summary) ? "muted" : "warning";
}

function renderTrustField(label: string, value: string) {
  return (
    <div key={`${label}-${value}`} className="mission-surface-trust-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

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
  const requestedSummary = trust.requestedProviderModelSummary ?? trust.providerModelSummary;
  const effectiveSummary = trust.effectiveProviderModelSummary ?? trust.providerModelSummary;
  const trustFields = [
    requestedSummary ? renderTrustField("Requested", requestedSummary) : null,
    effectiveSummary ? renderTrustField("Effective", effectiveSummary) : null,
    trust.selectionSourceSummary ? renderTrustField("Source", trust.selectionSourceSummary) : null,
  ].filter(Boolean);

  return (
    <header className={`mission-surface-header mode-${mode}`} aria-label={`${trust.activeModeLabel} session surface`}>
      <div className="mission-surface-header-copy">
        <h2>{sessionTitle}</h2>
        <p className="mission-surface-header-posture">{summary}</p>
        <div className="mission-surface-trust-strip" aria-label="Operator trust strip">
          <StatusChip tone={trust.gatewayTone}>{trust.gatewayLabel}</StatusChip>
          <StatusChip tone={inferApprovalsTone(trust.approvalsSummary)}>{trust.approvalsSummary}</StatusChip>
          {trust.fallbackSummary ? (
            <StatusChip tone={trust.fallbackTone ?? "muted"}>{trust.fallbackSummary}</StatusChip>
          ) : null}
          {trust.runtimeSummary ? (
            <StatusChip tone={trust.runtimeTone ?? "muted"}>{trust.runtimeSummary}</StatusChip>
          ) : null}
          {trustFields}
        </div>
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
