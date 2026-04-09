import { PageGuideCard } from "../../components/PageGuideCard";
import { PageHeader } from "../../components/PageHeader";
import { StatusChip } from "../../components/StatusChip";
import { OfficeKpiGrid } from "./OfficeKpiGrid";

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
  guide,
  error,
  activeAgents,
  hotAgents,
  readyAgents,
  eventFlow,
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
              <button type="button" className="active" aria-pressed="true">
                Immersive
              </button>
              <button type="button" onClick={onOpenLab} aria-pressed="false">
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
            <StatusChip tone={priorityAgents > 0 ? "critical" : watchAgents > 0 ? "warning" : "success"}>
              {priorityAgents} priority · {watchAgents} watch
            </StatusChip>
          </div>
        }
      />
      <PageGuideCard pageId="office" what={guide.what} when={guide.when} actions={guide.actions} terms={guide.terms} />
      {error ? (
        <div className="office-stream-banner">
          <strong>Command feed degraded.</strong>
          <span>The office shell stays interactive while GoatCitadel reconnects. {error}</span>
        </div>
      ) : null}

      <OfficeKpiGrid
        activeAgents={activeAgents}
        hotAgents={hotAgents}
        readyAgents={readyAgents}
        eventFlow={eventFlow}
        pendingApprovalsCount={pendingApprovalsCount}
        streamHealthy={streamHealthy}
      />
    </>
  );
}
