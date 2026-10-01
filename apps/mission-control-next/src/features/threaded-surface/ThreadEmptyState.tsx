import type { ChatMode } from "@goatcitadel/contracts";
import type {
  MissionThreadedDropTargetProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { EMPTY_STATE_GUIDANCE, MODE_META } from "./threaded-surface-model";

export function ThreadEmptyState({
  surface,
  helper,
  input,
  dropTarget,
}: {
  surface: ChatMode;
  helper: string;
  input: MissionThreadedRenderSurfaceInput;
  dropTarget: MissionThreadedDropTargetProps;
}) {
  void surface;
  const Icon = MODE_META.chat.icon;
  const guidance = EMPTY_STATE_GUIDANCE.chat;
  return (
    <section
      className={`mc-next-threaded-empty mc-next-threaded-dropzone${dropTarget.isDragActive ? " drop-active" : ""}`}
      onDragEnter={dropTarget.onDragEnter}
      onDragOver={dropTarget.onDragOver}
      onDragLeave={dropTarget.onDragLeave}
      onDrop={dropTarget.onDrop}
    >
      {dropTarget.isDragActive ? (
        <div className="mc-next-threaded-drop-overlay">Drop files to start a thread with attachments</div>
      ) : null}
      <div className="mc-next-threaded-empty-icon">
        <Icon size={22} />
      </div>
      <p className="mc-next-threaded-empty-kicker">{input.emptyStateProps.workspaceName}</p>
      <h2>{guidance.title}</h2>
      <p>{guidance.body}</p>
      <p className="mc-next-threaded-empty-support">{helper}</p>
      <div className="mc-next-threaded-empty-guidance" aria-label="Chat starting points">
        {guidance.cards.map((card) => (
          <div key={card.title} className="mc-next-threaded-empty-card">
            <strong>{card.title}</strong>
            <span>{card.body}</span>
          </div>
        ))}
      </div>
      <div className="mc-next-threaded-empty-facts" aria-label="Workspace readiness">
        <span>
          <strong>{input.emptyStateProps.sessionCount}</strong>
          <span>Sessions</span>
        </span>
        <span>
          <strong>{input.emptyStateProps.projectCount}</strong>
          <span>Projects</span>
        </span>
        <span>
          <strong>{input.emptyStateProps.approvalsCount}</strong>
          <span>Approvals</span>
        </span>
      </div>
      <div className="mc-next-threaded-empty-actions">
        <button type="button" className="mc-next-threaded-primary" onClick={input.emptyStateProps.onCreateSession}>
          {guidance.startLabel}
        </button>
        {input.emptyStateProps.onOpenStartHere ? (
          <button
            type="button"
            className="mc-next-threaded-secondary mc-next-threaded-start-here"
            onClick={input.emptyStateProps.onOpenStartHere}
          >
            {guidance.startHereLabel}
          </button>
        ) : null}
        <button type="button" className="mc-next-threaded-secondary" onClick={dropTarget.onAttachFiles}>
          Attach files
        </button>
        {input.emptyStateProps.approvalsCount > 0 ? (
          <button
            type="button"
            className="mc-next-threaded-secondary"
            onClick={() => input.emptyStateProps.onOpenApprovals()}
          >
            Approvals ({input.emptyStateProps.approvalsCount})
          </button>
        ) : null}
      </div>
    </section>
  );
}
