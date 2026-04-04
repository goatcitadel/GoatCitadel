import type { ChatMode } from "@goatcitadel/contracts";
import { ActionButton } from "../../components/ActionButton";
import { StatusChip } from "../../components/StatusChip";
import { getMissionControlSurfaceConfig } from "./surface-config";

export function MissionControlEmptyState({
  mode,
  sessionCount,
  projectCount,
  onCreateSession,
}: {
  mode: ChatMode;
  sessionCount: number;
  projectCount: number;
  onCreateSession: () => void;
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
        </div>
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
