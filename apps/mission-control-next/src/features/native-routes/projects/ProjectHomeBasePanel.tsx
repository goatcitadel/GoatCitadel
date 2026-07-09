import {
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Code2,
  FileText,
  ListChecks,
  MessageSquarePlus,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { ChatMode } from "@goatcitadel/contracts";
import { EmptyState, NativeButton } from "../primitives";
import { ProjectHomeMetric } from "./ProjectsRoutePage.components";
import {
  SURFACES,
  PROJECT_INTAKE_MODES,
  countHomeArtifacts,
  formatDateTime,
  labelForMode,
  normalizeMode,
  type ProjectHome,
  type ProjectIntakeMode,
  type ProjectIntakeModeId,
} from "./ProjectsRoutePage.helpers";

export function ProjectHomeBasePanel({
  home,
  pendingApprovals,
  projectName,
  onContinue,
  onStartIntake,
  onOpenMemory,
  onOpenArtifacts,
}: {
  home: ProjectHome;
  pendingApprovals: number;
  projectName: string;
  onContinue: (mode: ChatMode) => void;
  onStartIntake: (intent: ProjectIntakeMode) => void;
  onOpenMemory: () => void;
  onOpenArtifacts: () => void;
}) {
  return (
    <section className="mc-next-project-home-base" aria-label="Project overview">
      <div className="mc-next-project-home-head">
        <div>
          <span>Project overview</span>
          <strong>{home.healthLabel}</strong>
        </div>
        <p>{home.healthDetail}</p>
      </div>

      <div className="mc-next-project-intake-panel" aria-label="Project intake modes">
        <div className="mc-next-project-intake-head">
          <strong>Start from intent</strong>
          <span>Ask / plan / implement / proof in Chat</span>
        </div>
        <div className="mc-next-project-intake-grid">
          {PROJECT_INTAKE_MODES.map((intent) => {
            const Icon = iconForIntake(intent.id);
            return (
              <button
                key={intent.id}
                type="button"
                className={`mc-next-project-intake-card is-${intent.mode}`}
                aria-label={`Start ${intent.label} for ${projectName}`}
                onClick={() => onStartIntake(intent)}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{labelForMode(intent.mode)}</span>
                <strong>{intent.label}</strong>
                <p>{intent.detail}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mc-next-project-home-metrics">
        <ProjectMetric label="Active threads" value={String(home.activeCount)} detail="Chat work still in motion." />
        <ProjectMetric
          label="Artifacts"
          value={String(home.artifactCount)}
          detail={
            home.artifactCountSource === "records"
              ? "Generated outputs with project ownership recorded."
              : "Generated outputs referenced by project threads."
          }
        />
        <ProjectMetric label="Approvals" value={String(pendingApprovals)} detail="Workspace-wide approval queue." />
        <ProjectMetric
          label="Last activity"
          value={home.lastActivityLabel}
          detail="Most recent project thread update."
        />
      </div>

      <div className="mc-next-project-continue-row">
        {SURFACES.map((surface) => (
          <NativeButton key={surface.mode} onClick={() => onContinue(surface.mode)}>
            <MessageSquarePlus className="h-4 w-4" />
            {home.latestByMode[surface.mode] ? `Continue ${surface.label}` : `Start ${surface.label}`}
          </NativeButton>
        ))}
      </div>

      <div className="mc-next-project-lane-resume-shell">
        <div className="mc-next-directory-lane-head">
          <strong>Latest continuation</strong>
          <span>Chat</span>
        </div>
        <div className="mc-next-project-lane-resume-list" aria-label="Latest project continuation points">
          {SURFACES.map((surface) => {
            const latest = home.latestByMode[surface.mode];
            return (
              <button
                key={`latest-${surface.mode}`}
                type="button"
                className={`mc-next-project-lane-resume is-${surface.mode}`}
                onClick={() => onContinue(surface.mode)}
              >
                <span>{surface.label}</span>
                <strong>{latest ? latest.title?.trim() || latest.sessionKey : `Start ${surface.label}`}</strong>
                <p>
                  {latest
                    ? `${formatDateTime(latest.lastActivityAt)} · ${latest.lifecycleStatus} · ${countHomeArtifacts(home, latest)} artifacts`
                    : "No continuation point yet."}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mc-next-project-readiness-list">
        {home.readiness.map((item) => (
          <div key={item.id} className={`mc-next-project-readiness-item is-${item.status}`}>
            {item.status === "ready" ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mc-next-project-recent-list">
        <div className="mc-next-directory-lane-head">
          <strong>Recent work</strong>
          <span>{home.recentSessions.length}</span>
        </div>
        {home.recentSessions.length ? (
          home.recentSessions.map((session) => (
            <div key={session.sessionId} className="mc-next-project-recent-item">
              <span>{labelForMode(normalizeMode(session.mode))}</span>
              <strong>{session.title?.trim() || session.sessionKey}</strong>
              <p>
                {formatDateTime(session.lastActivityAt)} · {countHomeArtifacts(home, session)} artifacts
              </p>
            </div>
          ))
        ) : (
          <EmptyState size="compact" title="No recent project threads yet." />
        )}
      </div>

      <div className="mc-next-settings-button-row">
        <button type="button" className="mc-next-settings-filter" onClick={onOpenMemory}>
          Review memory and provenance
        </button>
        <button type="button" className="mc-next-settings-filter" onClick={onOpenArtifacts}>
          Reopen project artifacts
        </button>
      </div>
    </section>
  );
}

function ProjectMetric(props: { label: string; value: string; detail: string }) {
  return <ProjectHomeMetric {...props} />;
}

function iconForIntake(id: ProjectIntakeModeId) {
  switch (id) {
    case "ask":
      return MessageSquarePlus;
    case "plan":
      return ListChecks;
    case "implement":
      return Code2;
    case "review":
      return ClipboardCheck;
    case "research":
      return Search;
    case "summarize":
      return FileText;
    case "release-proof":
      return ShieldCheck;
    default:
      return MessageSquarePlus;
  }
}
