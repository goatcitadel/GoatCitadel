import { useId, useRef, type ReactNode } from "react";
import { useDeferredOverlay } from "../../ui/deferred-overlay-owner";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Paperclip, SlidersHorizontal } from "lucide-react";
import { ChatAttachmentChips } from "./ChatAttachmentChips";
import type { ChatCompletionReasoningEffort, ChatWebMode, RoutingPreflightRuntimeClass } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useModelLabel } from "../../data/use-model-label";
import { presentThinkingLevel } from "./chat-vocabulary";

type Controls = Pick<
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

const WEB_MODES: readonly { value: ChatWebMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "quick", label: "Quick" },
  { value: "deep", label: "Deep" },
];

/** Plain consequence of sending through the fallback route, by where it runs. */
const RUNTIME_CLASS_LABELS: Record<RoutingPreflightRuntimeClass, string> = {
  local: "It runs on this computer.",
  cloud: "It is a cloud model, so this conversation would leave this computer.",
  unknown: "It is not recorded whether it runs on this computer or in the cloud, so this conversation may leave it.",
};

type ModelPopover = typeof import("./ChatModelOptionsPopover");
let modelPopoverLoad: Promise<ModelPopover> | undefined;
const PLAN_HELP = "Plan before acting. GoatCitadel still governs every tool and approval.";
const REVIEW_HELP = "Request review of the answer before completion; availability follows the runtime.";

const loadModelPopover = () =>
  (modelPopoverLoad ??= import("./ChatModelOptionsPopover").catch((cause) => {
    modelPopoverLoad = undefined;
    throw cause;
  }));

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
  const options = useDeferredOverlay({ scopeKey, load: loadModelPopover });
  const contentId = useId();
  const modeHelpId = useId();
  const reloadCancel = useRef<HTMLButtonElement>(null);
  const ModelPopover = options.runtime?.ChatModelOptionsPopover;
  const modelLabel = useModelLabel(
    props.selectedProviderId,
    props.selectedModel ?? undefined,
    Boolean(props.selectedModel),
  );
  const optionsSummary = [
    props.selectedModel ? modelLabel : "Choose model",
    presentThinkingLevel(props.currentThinkingLevel),
  ].join(" · ");
  const modeOptions = (
    <>
      {" "}
      <button
        type="button"
        title={PLAN_HELP}
        aria-pressed={props.planningMode === "advisory"}
        aria-describedby={`${modeHelpId}-plan`}
        disabled={disabled}
        onClick={props.onTogglePlanningMode}
        className="rounded-md border border-line-control px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
      >
        Plan first
      </button>
      <label className="flex items-center gap-1">
        Web
        <select
          aria-label="Web search"
          title="Off disables web preference; Auto chooses when useful; Quick and Deep request search depth. GoatCitadel policy and available tools still apply."
          value={props.currentWebMode}
          disabled={disabled || !props.onSetWebMode}
          onChange={(event) => props.onSetWebMode?.(event.target.value as ChatWebMode)}
          className="rounded-md border border-line-control bg-canvas px-1 py-1 text-fg max-sm:min-h-11"
        >
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
        className="rounded-md border border-line-control px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
      >
        Review answer
      </button>
      {/* Hover keeps the tooltip; screen readers and touch get the same explanation through aria-describedby. */}
      <span id={`${modeHelpId}-plan`} className="sr-only">
        {PLAN_HELP}
      </span>
      <span id={`${modeHelpId}-review`} className="sr-only">
        {REVIEW_HELP}
      </span>
    </>
  );
  return (
    <>
      {notices ? <ChatComposerNotices props={props} onChooseModel={() => options.request(true)} /> : null}
      <div
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
        <button
          ref={(element) => {
            options.trigger.current = element;
          }}
          type="button"
          aria-label="Model and reasoning options"
          aria-haspopup="dialog"
          aria-expanded={options.open}
          aria-controls={options.open ? contentId : undefined}
          aria-busy={options.loading || undefined}
          data-state={options.open ? "open" : "closed"}
          onClick={() => options.request(!options.open)}
          className="inline-flex min-h-9 min-w-0 max-w-64 items-center gap-2 max-sm:max-w-full max-sm:basis-1/2 max-sm:flex-1 rounded-md border border-line-control px-2 text-left text-fg-secondary hover:border-line-strong max-sm:min-h-11"
        >
          <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{optionsSummary}</span>
        </button>
        {options.loading || options.failure ? (
          <span ref={options.status} role="status" className="text-xs text-fg-muted">
            {options.failure ? (
              <>
                {"Model options could not load. "}
                <Button
                  size="sm"
                  className="cockpit-deferred-recovery-control min-h-8 max-sm:min-h-11"
                  onClick={(event) => options.requestReload(event.currentTarget)}
                >
                  Reload app
                </Button>
              </>
            ) : (
              "Loading model options…"
            )}{" "}
            <button
              type="button"
              className="cockpit-deferred-recovery-control min-h-8 px-2 max-sm:min-h-11"
              onClick={() => options.close(true)}
            >
              Cancel model options
            </button>
          </span>
        ) : null}
        {ModelPopover ? (
          <ModelPopover
            props={props}
            reasoningEfforts={reasoningEfforts}
            open={options.open}
            onOpenChange={(open) => options.request(open)}
            trigger={options.trigger}
            contentRef={options.content}
            contentId={contentId}
            ownsFocus={() =>
              Boolean(
                options.intent.current &&
                options.isCurrent(options.intent.current.owner) &&
                options.ownsFocus(options.intent.current),
              )
            }
            isCurrent={options.isCurrent}
            onOutside={() => {
              if (options.intent.current) options.intent.current.restore = false;
            }}
            canRestore={() =>
              Boolean(
                options.intent.current &&
                options.isCurrent(options.intent.current.owner) &&
                options.intent.current.restore &&
                options.ownsFocus(options.intent.current),
              )
            }
          />
        ) : null}
        <Dialog
          open={Boolean(options.reloadReview && options.reloadCurrent(options.reloadReview))}
          onOpenChange={(open) => {
            if (!open) options.cancelReload(options.reloadReview);
          }}
          title="Reload app?"
          description="Reloading keeps the recorded conversation. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (options.reloadReview && options.reloadCurrent(options.reloadReview))
              reloadCancel.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            options.restoreReloadFocus();
          }}
        >
          <div ref={options.registerRecoveryHost} className="flex justify-end gap-2">
            <Button ref={reloadCancel} onClick={() => options.cancelReload(options.reloadReview)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!options.reloadReview || !options.reloadCurrent(options.reloadReview)}
              onClick={() => options.confirmReload(options.reloadReview)}
            >
              Reload app
            </Button>
          </div>
        </Dialog>
        {modeOptions}
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
    Boolean(props.routeBoundaryAckRequired && (route?.effectiveProviderId || route?.effectiveModel)),
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
