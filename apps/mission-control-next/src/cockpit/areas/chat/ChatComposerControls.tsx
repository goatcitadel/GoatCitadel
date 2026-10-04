import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";

type Controls = Pick<MissionThreadedActiveSessionSurfaceProps,
  | "providerOptions" | "selectedProviderId" | "selectedModel" | "modelSwitchDisabled"
  | "onRequestProviderChange" | "onRequestModelChange" | "currentThinkingLevel" | "onSetThinkingLevel"
  | "activePersonality" | "onOpenPersonalitiesSettings" | "planningMode" | "onTogglePlanningMode"
  | "currentWebMode" | "onToggleResearchMode" | "currentReviewDepth" | "onToggleReviewMode"
  | "pendingAttachments" | "onRemoveAttachment" | "fileInputRef" | "onAttachFiles" | "onUploadFiles"
  | "historicalReadOnly" | "sending" | "routeBoundaryAckRequired" | "routeBoundaryAcknowledged"
  | "onAcknowledgeRouteBoundary"
>;

const THINKING_LEVELS = ["off", "minimal", "standard", "extended", "deep", "max", "ultra"] as const;
const OPTIONS_ID = "cockpit-chat-composer-options";

export function ChatComposerControls({ props }: { props: Controls }) {
  const selectedProvider = props.providerOptions.find((provider) => provider.providerId === props.selectedProviderId);
  const disabled = props.historicalReadOnly || props.sending;
  // Phones keep Attach visible and fold the route and mode controls behind one toggle, so they
  // do not wrap into three rows above the draft.
  const phone = useMediaQuery("(max-width: 639px)");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsSummary = [props.selectedModel || "No model", humanizeToken(props.currentThinkingLevel)].join(" · ");
  const options = <>
    <label className="flex items-center gap-1">Provider
      <select aria-label="Provider" value={props.selectedProviderId ?? ""} disabled={disabled || props.modelSwitchDisabled} onChange={(event) => props.onRequestProviderChange(event.target.value)} className="max-w-32 rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-none">
        <option value="">Choose</option>
        {props.selectedProviderId && !selectedProvider ? <option value={props.selectedProviderId}>{props.selectedProviderId} · current, catalog unavailable</option> : null}
        {props.providerOptions.map((provider) => <option key={provider.providerId} value={provider.providerId} disabled={provider.disabled}>{provider.label}{provider.availabilityLabel ? ` · ${provider.availabilityLabel}` : ""}</option>)}
      </select>
    </label>
    <label className="flex items-center gap-1">Model
      <select aria-label="Model" value={props.selectedModel ?? ""} disabled={disabled || props.modelSwitchDisabled || !selectedProvider} onChange={(event) => props.onRequestModelChange(event.target.value)} className="max-w-36 rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11 max-sm:max-w-none">
        <option value="">Choose</option>
        {props.selectedModel && !selectedProvider?.models.includes(props.selectedModel) ? <option value={props.selectedModel}>{props.selectedModel} · current, unverified</option> : null}
        {selectedProvider?.models.map((model) => <option key={model} value={model}>{model}</option>)}
      </select>
    </label>
    <label className="flex items-center gap-1">Effort
      <select aria-label="Thinking effort" value={props.currentThinkingLevel} disabled={disabled} onChange={(event) => props.onSetThinkingLevel(event.target.value as Controls["currentThinkingLevel"])} className="rounded-md border border-line bg-canvas px-1 py-1 text-fg max-sm:min-h-11">
        {THINKING_LEVELS.map((level) => <option key={level} value={level}>{humanizeToken(level)}</option>)}
      </select>
    </label>
    <button type="button" aria-label="Open personality settings" onClick={props.onOpenPersonalitiesSettings}
      disabled={!props.onOpenPersonalitiesSettings} className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-line-strong max-sm:min-h-11">
      {props.activePersonality?.name ?? "Personality"}
    </button>
    <button type="button" aria-pressed={props.planningMode === "advisory"} disabled={disabled} onClick={props.onTogglePlanningMode} className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11">Plan</button>
    <button type="button" aria-pressed={props.currentWebMode !== "off"} disabled={disabled} onClick={props.onToggleResearchMode} className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11">Web</button>
    <button type="button" aria-pressed={props.currentReviewDepth !== "off"} disabled={disabled} onClick={props.onToggleReviewMode} className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-accent aria-[pressed=true]:border-accent max-sm:min-h-11">Review</button>
    {selectedProvider?.contextWindowTokens ? <span className="ml-auto">{new Intl.NumberFormat().format(selectedProvider.contextWindowTokens)} token context limit</span> : null}
  </>;
  return <>
    {props.pendingAttachments.length ? <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached files">
      {props.pendingAttachments.map((attachment) => <span key={attachment.attachmentId} className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken px-2 py-1 text-xs text-fg-secondary">
        <span className="max-w-36 truncate">{attachment.fileName}</span>
        <button type="button" aria-label={`Remove ${attachment.fileName}`} disabled={disabled} onClick={() => props.onRemoveAttachment(attachment.attachmentId)} className="rounded-full px-1 text-fg-muted hover:text-fg">×</button>
      </span>)}
    </div> : null}
    {props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged ? <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-status-waiting bg-sunken p-2 text-xs text-fg-secondary">
      <span>The selected route may continue on another runtime if it fails.</span>
      <button type="button" onClick={props.onAcknowledgeRouteBoundary} className="font-semibold text-accent underline-offset-2 hover:underline">Acknowledge fallback</button>
    </div> : null}
    <input ref={props.fileInputRef} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Choose files to attach" onChange={(event) => {
      props.onUploadFiles(event.target.files);
      event.target.value = "";
    }} />
    <div aria-label="Composer controls" className="cockpit-chat-controls flex min-w-0 flex-wrap items-center gap-2 pb-1 text-xs text-fg-muted sm:flex-nowrap sm:overflow-x-auto">
      <button type="button" disabled={disabled} onClick={props.onAttachFiles} className="rounded-md border border-line px-2 py-1 text-fg-secondary hover:border-line-strong max-sm:min-h-11 max-sm:px-3" aria-label="Attach files">+ Attach</button>
      {phone ? <button type="button" aria-expanded={optionsOpen} aria-controls={OPTIONS_ID} onClick={() => setOptionsOpen((open) => !open)}
        className="inline-flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border border-line px-3 text-left text-fg-secondary hover:border-line-strong aria-[expanded=true]:border-accent">
        <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />
        <span className="font-medium text-fg">Options</span>
        <span aria-hidden="true" className="min-w-0 truncate text-fg-muted">{optionsSummary}</span>
      </button> : options}
    </div>
    {phone && optionsOpen ? <div id={OPTIONS_ID} aria-label="Model and mode options" role="group" className="mb-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      {options}
    </div> : null}
  </>;
}
