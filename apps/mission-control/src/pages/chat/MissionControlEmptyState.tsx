import type { ChatMode } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { StatusChip } from "../../components/StatusChip";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function MissionControlEmptyState({
  mode,
  sessionCount,
  projectCount,
  workspaceName,
  approvalsCount,
  modelLabel,
  providerLabel,
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
  modelLabel?: string;
  providerLabel?: string;
  onCreateSession: () => void;
  onOpenCowork: () => void;
  onOpenCode: () => void;
  onOpenTasks: () => void;
  onOpenApprovals: () => void;
}) {
  const config = getMissionControlSurfaceConfig(mode);

  return (
    <article className={`card chat-v11-empty-shell mission-empty-shell mode-${mode}`}>
      <div className="mission-empty-shell-copy">
        <p className="mission-empty-shell-kicker">{config.shellEyebrow}</p>
        <h3>{config.emptyTitle}</h3>
        <p className="office-subtitle">{config.emptyBody}</p>
      </div>
      <div className="mission-empty-shell-actions">
        <ActionButton
          label={mode === "code" ? "Start code session" : `Start ${config.label.toLowerCase()} session`}
          onClick={onCreateSession}
        />
        <div className="mission-empty-shell-stats">
          <StatusChip tone="muted">{sessionCount} sessions</StatusChip>
          <StatusChip tone="muted">{projectCount} projects</StatusChip>
          <StatusChip tone={approvalsCount > 0 ? "warning" : "success"}>
            {approvalsCount > 0 ? `${approvalsCount} approvals waiting` : "Approvals clear"}
          </StatusChip>
        </div>
      </div>
      <div className="mission-empty-shell-context">
        <div className="mission-empty-shell-context-copy">
          <p className="mission-empty-shell-kicker">Current workspace</p>
          <strong>{workspaceName}</strong>
        </div>
        <div className="mission-empty-shell-context-chips">
          {providerLabel ? <StatusChip tone="muted">{providerLabel}</StatusChip> : null}
          {modelLabel ? <StatusChip tone="muted">{modelLabel}</StatusChip> : null}
        </div>
      </div>
      <div className="mission-empty-shell-jump-grid">
        <button type="button" className="gc-nav-pill mission-empty-shell-jump" onClick={onOpenCowork}>
          Open Cowork
        </button>
        <button type="button" className="gc-nav-pill mission-empty-shell-jump" onClick={onOpenCode}>
          Open Code
        </button>
        <button type="button" className="gc-nav-pill mission-empty-shell-jump" onClick={onOpenTasks}>
          Open Tasks
        </button>
        <button type="button" className="gc-nav-pill mission-empty-shell-jump" onClick={onOpenApprovals}>
          Review Approvals
        </button>
      </div>
      <div className="mission-empty-shell-prompts">
        {config.emptyPrompts.map((prompt) => (
          <div key={prompt} className="mission-empty-shell-prompt">
            {prompt}
          </div>
        ))}
      </div>
    </article>
  );
}
