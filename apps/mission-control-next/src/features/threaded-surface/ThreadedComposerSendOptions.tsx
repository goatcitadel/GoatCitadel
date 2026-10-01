import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";

interface SendOptionsProps {
  props: MissionThreadedActiveSessionSurfaceProps;
  composerActionDisabled: boolean | undefined;
  researchArmed: boolean;
  reviewArmed: boolean;
  contextArmed: boolean;
}

export function ThreadedComposerSendOptions({
  props,
  composerActionDisabled,
  researchArmed,
  reviewArmed,
  contextArmed,
}: SendOptionsProps) {
  return (
    <div className="mc-next-composer-suggestion-row" aria-label="Composer send options">
      <button
        type="button"
        className="mc-next-composer-suggestion"
        aria-pressed={props.planningMode === "advisory"}
        disabled={composerActionDisabled}
        onClick={props.onTogglePlanningMode}
        title={props.planningMode === "advisory" ? "Planning is armed for Send" : "Plan before sending"}
      >
        Plan
      </button>
      <button
        type="button"
        className="mc-next-composer-suggestion"
        aria-pressed={researchArmed}
        disabled={composerActionDisabled}
        onClick={props.onToggleResearchMode}
        title={researchArmed ? "Research is armed for Send" : "Use research with the next send"}
      >
        Research
      </button>
      <button
        type="button"
        className="mc-next-composer-suggestion"
        aria-pressed={reviewArmed}
        disabled={composerActionDisabled}
        onClick={props.onToggleReviewMode}
        title={reviewArmed ? "Review is armed for Send" : "Request review posture with the next send"}
      >
        Review
      </button>
      <button
        type="button"
        className="mc-next-composer-suggestion"
        aria-pressed={Boolean(props.modelCouncilEnabled)}
        disabled={composerActionDisabled || !props.onToggleModelCouncil || !props.modelCouncilEnabled}
        onClick={props.onToggleModelCouncil}
        title={
          props.modelCouncilEnabled
            ? "Model council is temporarily unavailable; click to turn it off"
            : "Model council is temporarily unavailable"
        }
      >
        Council
      </button>
      <button
        type="button"
        className="mc-next-composer-suggestion"
        aria-pressed={contextArmed}
        disabled={composerActionDisabled}
        onClick={props.onAttachFiles}
        title={contextArmed ? "Context is attached for Send" : "Attach files or context before sending"}
      >
        Attach context
      </button>
    </div>
  );
}
