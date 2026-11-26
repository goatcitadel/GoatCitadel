import { useId, useRef, type ReactNode } from "react";
import { Paperclip } from "lucide-react";
import type { ChatCompletionReasoningEffort, ChatWebMode } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { COUNCIL_HELP, PLAN_HELP, REVIEW_HELP, SNAPSHOT_HELP, WEB_HELP } from "./chat-optional-vocabulary";
import { ChatModelOptionsButton, type ModelOptionsRequest } from "./ChatModelOptionsButton";
import { ChatComposerNotices } from "./ChatComposerNotices";
import { WEB_MODES } from "./chat-composer-web-modes";

export { ChatModelOptionsButton, routeMatchesSelection, type ModelOptionsRequest } from "./ChatModelOptionsButton";

export type Controls = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "routePreflight"
  | "providerOptions"
  | "selectedProviderId"
  | "selectedModel"
  | "modelSwitchDisabled"
  | "onRequestProviderChange"
  | "onRequestModelChange"
  | "onRequestModelChoice"
  | "reasoningEffortsFor"
  | "currentThinkingLevel"
  | "onSetThinkingLevel"
  | "activePersonality"
  | "onOpenPersonalitiesSettings"
  | "planningMode"
  | "onTogglePlanningMode"
  | "currentWebMode"
  | "onSetWebMode"
  | "currentReviewDepth"
  | "onToggleReviewMode"
  | "modelCouncilEnabled"
  | "modelCouncilAvailable"
  | "onToggleModelCouncil"
  | "workspaceSnapshotAvailable"
  | "workspaceSnapshotRequest"
  | "onToggleWorkspaceSnapshot"
  | "pendingAttachments"
  | "onRemoveAttachment"
  | "fileInputRef"
  | "onAttachFiles"
  | "onUploadFiles"
  | "historicalReadOnly"
  | "sending"
  | "routeBoundaryAckRequired"
  | "routeBoundaryAcknowledged"
  | "onAcknowledgeRouteBoundary"
>;

export type ChatModelOptionsControls = Pick<
  Controls,
  | "providerOptions"
  | "selectedProviderId"
  | "selectedModel"
  | "modelSwitchDisabled"
  | "onRequestProviderChange"
  | "onRequestModelChange"
  | "onRequestModelChoice"
  | "reasoningEffortsFor"
  | "currentThinkingLevel"
  | "onSetThinkingLevel"
  | "activePersonality"
  | "onOpenPersonalitiesSettings"
  | "historicalReadOnly"
  | "sending"
>;

/** Plan first, Web search and Review answer. The desktop + panel and the phone options sheet both show these. */
export function ChatComposerModeOptions({ props, disabled }: { props: Controls; disabled: boolean }) {
  const modeHelpId = useId();
  return (
    <>
      <button
        type="button"
        title={PLAN_HELP}
        aria-pressed={props.planningMode === "advisory"}
        aria-describedby={`${modeHelpId}-plan`}
        disabled={disabled}
        onClick={props.onTogglePlanningMode}
        className="inline-flex min-h-8 items-center rounded-md border border-line-control px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
      >
        Plan first
      </button>
      <label className="flex items-center gap-1">
        Web
        <select
          aria-label="Web search"
          title={WEB_HELP}
          value={props.currentWebMode}
          disabled={disabled || !props.onSetWebMode}
          onChange={(event) => props.onSetWebMode?.(event.target.value as ChatWebMode)}
          className="rounded-md border border-line-control bg-canvas px-1 py-1 text-fg max-sm:min-h-11"
        >
          {/* A conversation saved with Quick still runs it until another mode is chosen, so it says so. */}
          {props.currentWebMode === "quick" ? (
            <option value="quick" disabled>
              Quick (retired)
            </option>
          ) : null}
          {WEB_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        title={REVIEW_HELP}
        aria-pressed={props.currentReviewDepth !== "off"}
        aria-describedby={`${modeHelpId}-review`}
        disabled={disabled}
        onClick={props.onToggleReviewMode}
        className="inline-flex min-h-8 items-center rounded-md border border-line-control px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
      >
        Review answer
      </button>
      {/* Shown only while GoatCitadel reports each available, or while a stale arming still needs turning off. */}
      {props.modelCouncilAvailable || props.modelCouncilEnabled ? (
        <button
          type="button"
          title={COUNCIL_HELP}
          aria-pressed={Boolean(props.modelCouncilEnabled)}
          aria-describedby={`${modeHelpId}-council`}
          disabled={disabled || !props.onToggleModelCouncil}
          onClick={props.onToggleModelCouncil}
          className="inline-flex min-h-8 items-center rounded-md border border-line-control px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
        >
          Model council
        </button>
      ) : null}
      {props.workspaceSnapshotAvailable || props.workspaceSnapshotRequest ? (
        <button
          type="button"
          title={SNAPSHOT_HELP}
          aria-pressed={Boolean(props.workspaceSnapshotRequest)}
          aria-describedby={`${modeHelpId}-summary`}
          disabled={disabled}
          onClick={props.onToggleWorkspaceSnapshot}
          className="inline-flex min-h-8 items-center rounded-md border border-line-control px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
        >
          Project summary
        </button>
      ) : null}
      {/* Hover keeps the tooltip, the options popover shows the same help as text, and screen readers get it here. */}
      <span id={`${modeHelpId}-plan`} className="sr-only">
        {PLAN_HELP}
      </span>
      <span id={`${modeHelpId}-review`} className="sr-only">
        {REVIEW_HELP}
      </span>
      <span id={`${modeHelpId}-council`} className="sr-only">
        {COUNCIL_HELP}
      </span>
      <span id={`${modeHelpId}-summary`} className="sr-only">
        {SNAPSHOT_HELP}
      </span>
    </>
  );
}

/**
 * Every control in one wrapping row: attach, sources, model and modes. The phone options sheet uses it; wider layouts
 * put attach, sources and modes behind the composer's + panel and keep only the model chip beside Send.
 */
export function ChatComposerControls({
  props,
  reasoningEfforts,
  scopeKey = "",
  sourcesChip,
  notices = true,
}: {
  props: Controls;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
  scopeKey?: string;
  /** The read-only sources chip; it sits beside Attach because both add material to the next message. */
  sourcesChip?: ReactNode;
  /** False inside the phone options sheet, where the composer itself keeps the notices and the file input. */
  notices?: boolean;
}) {
  const disabled = props.historicalReadOnly || props.sending;
  const requestModelOptions: ModelOptionsRequest = useRef(null);
  return (
    <>
      {notices ? <ChatComposerNotices props={props} onChooseModel={() => requestModelOptions.current?.()} /> : null}
      <div
        role="group"
        aria-label="Composer controls"
        className="cockpit-chat-controls flex min-w-0 flex-wrap items-center gap-2 pb-1 text-xs text-fg-muted"
      >
        <button
          type="button"
          disabled={disabled}
          onClick={props.onAttachFiles}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line-control px-2 text-fg-secondary hover:border-fg max-sm:min-h-11 max-sm:px-3"
          aria-label="Attach files"
        >
          <Paperclip aria-hidden="true" className="size-4 shrink-0" />
          Attach
        </button>
        {sourcesChip}
        <ChatModelOptionsButton
          props={props}
          reasoningEfforts={reasoningEfforts}
          scopeKey={scopeKey}
          requestRef={requestModelOptions}
        />{" "}
        <ChatComposerModeOptions props={props} disabled={disabled} />
      </div>
    </>
  );
}
