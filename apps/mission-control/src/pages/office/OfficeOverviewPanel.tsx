import { PageHeader } from "../../components/PageHeader";
import { StatusChip } from "../../components/StatusChip";

interface OfficeGuideTerm {
  term: string;
  meaning: string;
}

interface OfficeOverviewPanelProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
  hint?: string;
  onOpenLab?: () => void;
  streamHealthy: boolean;
  pendingApprovalsCount: number;
  blockedAgents: number;
  priorityAgents: number;
  watchAgents: number;
  guide: {
    what: string;
    when: string;
    actions: string[];
    terms?: OfficeGuideTerm[];
  };
  error: string | null;
  activeAgents: number;
  hotAgents: number;
  readyAgents: number;
  eventFlow: number;
}

export function OfficeOverviewPanel({
  eyebrow,
  title,
  subtitle,
  hint,
  onOpenLab,
  streamHealthy,
  pendingApprovalsCount,
  blockedAgents,
  priorityAgents,
  watchAgents,
  eventFlow,
  error,
}: OfficeOverviewPanelProps) {
  return (
    <>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        subtitle={subtitle}
        hint={hint}
        className="page-header-citadel"
        actions={
          <div className="office-page-actions">
            <div className="office-surface-switch" role="tablist" aria-label="Office surface views">
              <button type="button" className="gc-button active" aria-pressed="true">
                Immersive
              </button>
              <button type="button" onClick={onOpenLab} aria-pressed="false" className="gc-button">
                Pixel Lab
              </button>
            </div>
            <StatusChip tone={streamHealthy ? "live" : "warning"}>
              Stream {streamHealthy ? "live" : "resyncing"}
            </StatusChip>
            <StatusChip tone={pendingApprovalsCount > 0 ? "warning" : "muted"}>
              {pendingApprovalsCount} approvals
            </StatusChip>
            <StatusChip tone={blockedAgents > 0 ? "critical" : "success"}>{blockedAgents} blocked</StatusChip>
            <StatusChip tone="muted">{`${eventFlow.toFixed(1)} /min`}</StatusChip>
            <StatusChip tone={priorityAgents > 0 ? "critical" : watchAgents > 0 ? "warning" : "success"}>
              {priorityAgents} priority · {watchAgents} watch
            </StatusChip>
          </div>
        }
      />
      {error ? (
        <div className="office-stream-banner">
          <strong>Command feed degraded.</strong>
          <span>The office shell stays interactive while GoatCitadel reconnects. {error}</span>
        </div>
      ) : null}
    </>
  );
}
