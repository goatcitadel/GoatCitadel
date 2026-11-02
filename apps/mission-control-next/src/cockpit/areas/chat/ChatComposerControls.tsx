import { useId, useRef, type ReactNode } from "react";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Paperclip } from "lucide-react";
import { ChatAttachmentChips } from "./ChatAttachmentChips";
import type { ChatCompletionReasoningEffort, ChatWebMode, RoutingPreflightRuntimeClass } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useModelLabel } from "../../data/use-model-label";
import { presentPreflightReason } from "./chat-model-reason";
import { PLAN_HELP, REVIEW_HELP, WEB_HELP } from "./chat-vocabulary";
import { ChatModelOptionsButton, routeMatchesSelection, type ModelOptionsRequest } from "./ChatModelOptionsButton";

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
  | "currentThinkingLevel"
  | "onSetThinkingLevel"
  | "activePersonality"
  | "onOpenPersonalitiesSettings"
  | "historicalReadOnly"
  | "sending"
>;

/** Quick is no longer offered: it only shrank the search budget and never forced a search, so it read as Auto. */
export const WEB_MODES: readonly { value: ChatWebMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "deep", label: "Deep" },
];

/** Plain consequence of sending through the fallback route, by where it runs. */
const RUNTIME_CLASS_LABELS: Record<RoutingPreflightRuntimeClass, string> = {
  local: "It runs on this computer.",
  cloud: "It is a cloud model, so this conversation would leave this computer.",
  unknown: "It is not recorded whether it runs on this computer or in the cloud, so this conversation may leave it.",
};

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
      {/* Hover keeps the tooltip, the options popover shows the same help as text, and screen readers get it here. */}
      <span id={`${modeHelpId}-plan`} className="sr-only">
        {PLAN_HELP}
      </span>
      <span id={`${modeHelpId}-review`} className="sr-only">
        {REVIEW_HELP}
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

/** Attached files, the route fallback acknowledgement and the file input stay beside the draft at every width. */
export function ChatComposerNotices({ props, onChooseModel }: { props: Controls; onChooseModel?: () => void }) {
  const route = props.routePreflight;
  const routeLabel = useModelLabel(
    route?.effectiveProviderId,
    route?.effectiveModel,
    Boolean(route?.effectiveProviderId || route?.effectiveModel),
  );
  return (
    <>
      <ChatAttachmentChips
        attachments={props.pendingAttachments}
        disabled={props.historicalReadOnly || props.sending}
        onRemove={props.onRemoveAttachment}
      />
      {props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged ? (
        <div className="mb-2 space-y-2 rounded-md border border-status-waiting bg-sunken p-2 text-xs text-fg-secondary">
          <p>
            {"This message would go to "}
            {route?.effectiveProviderId || route?.effectiveModel ? routeLabel : "a fallback model (not recorded)"}
            {" instead of your chosen model. "}
            {RUNTIME_CLASS_LABELS[route?.runtimeClass ?? "unknown"] ?? RUNTIME_CLASS_LABELS.unknown}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onClick={props.onAcknowledgeRouteBoundary}>
              Acknowledge fallback
            </Button>
            {onChooseModel ? (
              <Button size="sm" disabled={props.historicalReadOnly || props.sending} onClick={onChooseModel}>
                Choose another model
              </Button>
            ) : null}
          </div>
          {route?.degradedReason || route?.normalizationReason ? (
            <TechnicalDetails label="Fallback technical details">
              <p className="font-mono wrap-anywhere">{route?.degradedReason ?? route?.normalizationReason}</p>
            </TechnicalDetails>
          ) : null}
        </div>
      ) : null}
      {/* Uses the preflight already fetched for the composer; the notice above explains a fallback on its own. When the
          route is simply the model on the chip, the chip's tooltip carries the reason and this line stays away. */}
      {route?.effectiveModel && !props.routeBoundaryAckRequired && !routeMatchesSelection(props) ? (
        <p className="mb-1 text-xs text-fg-muted">
          Will use {routeLabel} — {presentPreflightReason(route)}
        </p>
      ) : null}
      {/* Not a live region: preflight re-runs while the draft changes, so it would re-announce on every keystroke. */}
      {route?.fileOutputNotice ? (
        <div className="mb-2 space-y-2 rounded-md border border-status-waiting bg-sunken p-2 text-xs text-fg-secondary">
          <p>{route.fileOutputNotice.message}</p>
          {route.fileOutputNotice.alternatives.length > 0 ? (
            <p>
              {"Can create files: "}
              {route.fileOutputNotice.alternatives.map((alternative) => alternative.label).join(", ")}
            </p>
          ) : null}
          {onChooseModel ? (
            <Button size="sm" disabled={props.historicalReadOnly || props.sending} onClick={onChooseModel}>
              Choose another model
            </Button>
          ) : null}
        </div>
      ) : null}
      <input
        ref={props.fileInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose files to attach"
        onChange={(event) => {
          props.onUploadFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}
