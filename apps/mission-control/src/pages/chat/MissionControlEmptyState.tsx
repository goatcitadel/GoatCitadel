import type { ChatMode } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { getMissionControlSurfaceConfig } from "./surface-config";

function formatCount(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function MissionControlEmptyState({
  mode,
  sessionCount,
  projectCount,
  workspaceName,
  approvalsCount,
  onCreateSession,
  onOpenCowork,
  onOpenCode,
  onOpenTasks,
  onOpenApprovals,
}: {
  mode: ChatMode;
  sessionCount: number;
  projectCount: number;
  workspaceName: string;
  approvalsCount: number;
  onCreateSession: () => void;
  onOpenCowork: () => void;
  onOpenCode: () => void;
  onOpenTasks: () => void;
  onOpenApprovals: () => void;
}) {
  const config = getMissionControlSurfaceConfig(mode);
  const secondaryActions =
    mode === "chat"
      ? [
          { label: "Open Cowork", onClick: onOpenCowork },
          { label: "Open Code", onClick: onOpenCode },
        ]
      : mode === "cowork"
        ? [
            { label: "Open Tasks", onClick: onOpenTasks },
            { label: "Review Approvals", onClick: onOpenApprovals },
          ]
        : [
            { label: "Open Tasks", onClick: onOpenTasks },
            { label: "Open Cowork", onClick: onOpenCowork },
          ];
  const visiblePrompts = mode === "chat" ? config.emptyPrompts.slice(0, 2) : [];
  const summaryLine = `${formatCount(projectCount, "project")} • ${formatCount(sessionCount, "session")}`;

  return (
    <article className={`card chat-v11-empty-shell mission-empty-shell mode-${mode}`}>
      <div className="mission-empty-shell-copy">
        <p className="mission-empty-shell-kicker">{config.shellEyebrow}</p>
        <h3>{config.emptyTitle}</h3>
        <p className="office-subtitle">{config.emptyBody}</p>
      </div>
      <div className="mission-empty-shell-actions">
        <ActionButton
          label={
            mode === "code"
              ? "Start code session"
              : mode === "chat"
                ? "Start chat"
                : `Start ${config.label.toLowerCase()} session`
          }
          onClick={onCreateSession}
        />
        <p className="mission-empty-shell-summary">
          {summaryLine} · <span>{approvalsCount > 0 ? `${approvalsCount} approvals waiting` : "Approvals clear"}</span>
        </p>
      </div>
      <div className="mission-empty-shell-context">
        <div className="mission-empty-shell-context-copy">
          <p className="mission-empty-shell-kicker">Current workspace</p>
          <strong>{workspaceName}</strong>
        </div>
      </div>
      <div className="mission-empty-shell-jump-grid">
        {secondaryActions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="gc-nav-button gc-nav-tier-section mission-empty-shell-jump"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
      {visiblePrompts.length > 0 ? (
        <div className="mission-empty-shell-prompts">
          {visiblePrompts.map((prompt) => (
            <div key={prompt} className="mission-empty-shell-prompt">
              {prompt}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
