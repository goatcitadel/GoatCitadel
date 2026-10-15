import { useId, useRef } from "react";
import { useDeferredOverlay } from "../../ui/deferred-overlay-owner";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { SlidersHorizontal } from "lucide-react";
import type { ChatCompletionReasoningEffort, ChatWebMode } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

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

type ModelPopover = typeof import("./ChatModelOptionsPopover");
let modelPopoverLoad: Promise<ModelPopover> | undefined;
const loadModelPopover = () =>
  (modelPopoverLoad ??= import("./ChatModelOptionsPopover").catch((cause) => {
    modelPopoverLoad = undefined;
    throw cause;
  }));

export function ChatComposerControls({
  props,
  reasoningEfforts,
  scopeKey = "",
}: {
  props: Controls;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
  scopeKey?: string;
}) {
  const disabled = props.historicalReadOnly || props.sending;
  const options = useDeferredOverlay({ scopeKey, load: loadModelPopover });
  const contentId = useId();
  const reloadCancel = useRef<HTMLButtonElement>(null);
  const ModelPopover = options.runtime?.ChatModelOptionsPopover;
  const optionsSummary = [props.selectedModel || "Choose model", humanizeToken(props.currentThinkingLevel)].join(" · ");
  const modeOptions = (
    <>
      {" "}
      <button
        type="button"
        title="Plan before acting. The Gateway still governs every tool and approval."
        aria-pressed={props.planningMode === "advisory"}
        disabled={disabled}
        onClick={props.onTogglePlanningMode}
        className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
      >
        Plan {props.planningMode === "advisory" ? "on" : "off"}
      </button>
      <label className="flex items-center gap-1">
        Web
        <select
          aria-label="Web search"
          title="Off disables web preference; Auto chooses when useful; Quick and Deep request search depth. Gateway policy and available tools still apply."
          value={props.currentWebMode}
          disabled={disabled || !props.onSetWebMode}
          onChange={(event) => props.onSetWebMode?.(event.target.value as ChatWebMode)}
          className="rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11"
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
        title="Request review of the answer before completion; availability follows the runtime."
        aria-pressed={props.currentReviewDepth !== "off"}
        disabled={disabled}
        onClick={props.onToggleReviewMode}
        className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11"
      >
        Review {props.currentReviewDepth === "off" ? "off" : "on"}
      </button>
    </>
  );
  return (
    <>
      {props.pendingAttachments.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached files">
          {props.pendingAttachments.map((attachment) => (
            <span
              key={attachment.attachmentId}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken px-2 py-1 text-xs text-fg-secondary"
            >
              <span className="max-w-36 truncate">{attachment.fileName}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.fileName}`}
                disabled={disabled}
                onClick={() => props.onRemoveAttachment(attachment.attachmentId)}
                className="rounded-full px-1 text-fg-muted hover:text-fg"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-status-waiting bg-sunken p-2 text-xs text-fg-secondary">
          <span>
            {"Route: "}
            {props.routePreflight?.effectiveProviderId ?? "provider unrecorded"}
            {" / "}
            {props.routePreflight?.effectiveModel ?? "model unrecorded"}
            {" · "}
            {humanizeToken(props.routePreflight?.runtimeClass ?? "unknown")}
            {". Fallback may send conversation content to another runtime, including outside this computer. "}
            {props.routePreflight?.degradedReason ?? props.routePreflight?.normalizationReason}
          </span>
          <button
            type="button"
            onClick={props.onAcknowledgeRouteBoundary}
            className="font-semibold text-accent underline-offset-2 hover:underline"
          >
            Acknowledge fallback
          </button>
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
      <div
        aria-label="Composer controls"
        className="cockpit-chat-controls flex min-w-0 flex-wrap items-center gap-2 pb-1 text-xs text-fg-muted"
      >
        <button
          type="button"
          disabled={disabled}
          onClick={props.onAttachFiles}
          className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-line-strong max-sm:min-h-11 max-sm:px-3"
          aria-label="Attach files"
        >
          + Attach
        </button>
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
          className="inline-flex min-h-9 min-w-0 max-w-64 items-center gap-2 max-sm:max-w-full max-sm:basis-1/2 max-sm:flex-1 rounded-md border border-line px-2 text-left text-fg-secondary hover:border-line-strong max-sm:min-h-11"
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
