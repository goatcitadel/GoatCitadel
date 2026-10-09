import { useState } from "react";
import { Popover } from "radix-ui";
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

const WEB_MODES: readonly { value: ChatWebMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "quick", label: "Quick" },
  { value: "deep", label: "Deep" },
];

export function ChatComposerControls({ props, reasoningEfforts }: { props: Controls; reasoningEfforts?: ChatCompletionReasoningEffort[] }) {
  const supported = reasoningEfforts?.length ? [...new Set<Controls["currentThinkingLevel"]>([...reasoningEfforts.map((effort) => ({ none: "off", low: "minimal", medium: "standard", high: "extended", xhigh: "deep", max: "max", ultra: "ultra" } as const)[effort])])] : null;
  const selectedProvider = props.providerOptions.find((provider) => provider.providerId === props.selectedProviderId);
  const disabled = props.historicalReadOnly || props.sending;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsSummary = [props.selectedModel || "Choose model", humanizeToken(props.currentThinkingLevel)].join(" · ");
  const modelOptions = (
    <>
      <label className="flex items-center gap-1">
        Provider
        <select
          aria-label="Provider"
          value={props.selectedProviderId ?? ""}
          disabled={disabled || props.modelSwitchDisabled}
          onChange={(event) => { if (event.target.value) props.onRequestProviderChange(event.target.value); }}
          className="max-w-32 rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-full"
        >
          <option value="">Choose</option>
          {props.selectedProviderId && !selectedProvider ? (
            <option value={props.selectedProviderId}>{props.selectedProviderId} · current, catalog unavailable</option>
          ) : null}
          {props.providerOptions.map((provider) => (
            <option key={provider.providerId} value={provider.providerId} disabled={provider.disabled}>
              {provider.label}
              {provider.availabilityLabel ? ` · ${provider.availabilityLabel}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Model
        <select
          aria-label="Model"
          value={props.selectedModel ?? ""}
          disabled={disabled || props.modelSwitchDisabled || !selectedProvider}
          onChange={(event) => { if (event.target.value) props.onRequestModelChange(event.target.value); }}
          className="max-w-36 rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-full"
        >
          <option value="">Choose</option>
          {props.selectedModel && !selectedProvider?.models.includes(props.selectedModel) ? (
            <option value={props.selectedModel}>{props.selectedModel} · current, unverified</option>
          ) : null}
          {selectedProvider?.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Effort
        <select
          aria-label="Thinking effort"
          value={props.currentThinkingLevel}
          disabled={disabled || !supported}
          onChange={(event) => { const level = event.target.value as Controls["currentThinkingLevel"]; if (supported?.includes(level)) props.onSetThinkingLevel(level); }}
          className="rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11"
        >
          {supported && !supported.includes(props.currentThinkingLevel) ? <option value={props.currentThinkingLevel} disabled>{humanizeToken(props.currentThinkingLevel)} · current, unsupported by this model</option> : null}
          {(supported ?? [props.currentThinkingLevel]).map((level) => (
            <option key={level} value={level}>
              {humanizeToken(level)}{!supported ? " · support unverified" : ""}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-label="Open personality settings"
        onClick={props.onOpenPersonalitiesSettings}
        disabled={!props.onOpenPersonalitiesSettings}
        className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-line-strong max-sm:min-h-11"
      >
        {props.activePersonality?.name ?? "Personality"}
      </button>
      {selectedProvider?.contextWindowTokens ? (
        <span className="ml-auto">
          {new Intl.NumberFormat().format(selectedProvider.contextWindowTokens)} token context limit
        </span>
      ) : null}
    </>
  );
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
          <span>Route: {props.routePreflight?.effectiveProviderId ?? "provider unrecorded"} / {props.routePreflight?.effectiveModel ?? "model unrecorded"} · {humanizeToken(props.routePreflight?.runtimeClass ?? "unknown")}. Fallback may send conversation content to another runtime, including outside this computer. {props.routePreflight?.degradedReason ?? props.routePreflight?.normalizationReason}</span>
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
        <Popover.Root open={optionsOpen} onOpenChange={setOptionsOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label="Model and reasoning options"
              className="inline-flex min-h-9 min-w-0 max-w-64 items-center gap-2 max-sm:max-w-full max-sm:basis-1/2 max-sm:flex-1 rounded-md border border-line px-2 text-left text-fg-secondary hover:border-line-strong max-sm:min-h-11"
            >
              <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{optionsSummary}</span>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              side="top"
              align="start"
              sideOffset={8}
              className="z-50 w-80 max-w-full space-y-3 rounded-lg border border-line bg-overlay p-3 text-xs text-fg shadow-overlay"
            >
              <h3 className="text-sm font-semibold">Model and reasoning</h3>
              <div className="flex flex-wrap items-center gap-3">{modelOptions}</div>
              <p className="text-fg-muted">Effort support depends on the selected model.</p>
              <Popover.Close className="min-h-9 rounded-md border border-line px-3" type="button">
                Done
              </Popover.Close>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {modeOptions}
      </div>
    </>
  );
}
