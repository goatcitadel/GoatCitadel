import type { FormEvent, KeyboardEvent } from "react";
import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { resolveChatRouteReadiness } from "../../../features/threaded-surface/chat-route-readiness";
import { useCockpitShellSwitch } from "../../app/use-cockpit-shell-switch";
import { Button } from "../../ui/Button";
import { ChatComposerControls } from "./ChatComposerControls";
import { ChatComposerPalette } from "./ChatComposerPalette";
import { ChatRunVariables } from "./ChatRunVariables";

export type ComposerProps = Pick<MissionThreadedActiveSessionSurfaceProps,
  | "draft" | "onDraftChange" | "onSend" | "onStopActiveTurn" | "canSend" | "sending"
  | "hasActiveStream" | "isStopPending" | "historicalReadOnly" | "sessionControlBanner"
  | "pendingApproval" | "pendingUserInput" | "pendingAttachments" | "editingTurnId" | "onCancelEdit"
  | "runVariablePanel" | "composerPalette" | "routeBoundaryAckRequired"
  | "routeBoundaryAcknowledged" | "composerRef" | "selectedSessionId"
  | "profileDependentAdmissionBlockReason" | "routePreflight" | "routePreflightError"
  | "routePreflightLoading" | "providerOptions" | "selectedProviderId" | "selectedModel"
  | "modelSwitchDisabled" | "onRequestProviderChange" | "onRequestModelChange"
  | "currentThinkingLevel" | "onSetThinkingLevel" | "activePersonality" | "onOpenPersonalitiesSettings"
  | "planningMode" | "onTogglePlanningMode" | "currentWebMode" | "onToggleResearchMode"
  | "currentReviewDepth" | "onToggleReviewMode" | "onRemoveAttachment" | "fileInputRef"
  | "onAttachFiles" | "onUploadFiles" | "onAcknowledgeRouteBoundary" | "commandSuggestions"
  | "commandIndex" | "onApplyDraftCommand" | "onComposerKeyDown" | "onComposerPaste"
  | "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop" | "isDragActive"
  | "chatTimerPanel" | "sessionStatusPanel"
>;

export function cockpitSendBlockReason(props: ComposerProps): string | null {
  if (props.historicalReadOnly) return "This historical view is read-only. Return to the latest conversation in current Chat.";
  if (props.sessionControlBanner) return "Another client controls this conversation. Open current Chat for its status.";
  if (props.pendingApproval || props.pendingUserInput) return "A decision or response is pending. Resolve it in current Chat.";
  if (props.runVariablePanel?.open) return "Apply or close the run variables before sending.";
  if (props.composerPalette?.globalOpen) return "Choose a palette item before sending.";
  if (props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged) return "Acknowledge the route fallback before sending.";
  if (getWorkflowSkillCaptureDisplay(props.draft)) return "This captured workflow needs review in current Chat.";
  if (props.commandSuggestions.length && /^\s*[/@$]/.test(props.draft)) return "Choose a suggestion before sending.";
  if (!props.canSend && props.draft.trim()) return props.profileDependentAdmissionBlockReason
    ?? resolveChatRouteReadiness(props).sendHint
    ?? "Sending is unavailable. Open current Chat for the reason.";
  return null;
}

export function ChatTextComposer({ props, onOpenSchedules }: { props: ComposerProps; onOpenSchedules?: () => void }) {
  const shellSwitch = useCockpitShellSwitch(props.selectedSessionId);
  const command = props.draft.trim().toLowerCase();
  const localCommand = !props.editingTurnId && !props.composerPalette?.globalOpen && !props.pendingAttachments.length && (
    (command === "/schedule" && Boolean(onOpenSchedules)) ||
    (command === "/timer" && Boolean(props.chatTimerPanel)) ||
    (command === "/status" && Boolean(props.sessionStatusPanel))
  );
  const localReady = localCommand && !props.sending && !props.hasActiveStream && !props.historicalReadOnly && !props.sessionControlBanner;
  const reason = localReady ? null : cockpitSendBlockReason(props);
  const canSubmit = Boolean(localReady || (Boolean(props.draft.trim() || props.pendingAttachments.length)
    && props.canSend && !props.sending && !props.hasActiveStream && !reason));
  const send = () => {
    if (!canSubmit) return;
    if (localReady && command === "/schedule") { props.onDraftChange(""); onOpenSchedules?.(); return; }
    props.onSend();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing || (event.shiftKey && !event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      if (props.commandSuggestions.length && !localReady) {
        const selected = props.commandSuggestions[props.commandIndex];
        if (selected) {
          if (props.composerPalette?.enabled) props.composerPalette.onSelect(selected);
          else props.onApplyDraftCommand(selected.applyValue);
        }
      } else send();
      return;
    }
    props.onComposerKeyDown(event);
  };

  return <form onSubmit={submit} onDragEnter={props.onDragEnter} onDragOver={props.onDragOver} onDragLeave={props.onDragLeave} onDrop={props.onDrop}
    className={`border-t bg-raised p-3 ${props.isDragActive ? "border-accent" : "border-line-subtle"}`}>
    <div className="mx-auto max-w-3xl">
      {props.editingTurnId ? <div role="status" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-xs text-fg-secondary">
        <span>Editing a new branch from this turn.</span>
        <button type="button" onClick={props.onCancelEdit} className="font-medium text-accent hover:underline">Cancel branch</button>
      </div> : null}
      <ChatRunVariables panel={props.runVariablePanel} />
      <ChatComposerPalette props={props} />
      <ChatComposerControls props={props} />
      <label htmlFor="cockpit-chat-draft" className="sr-only">Message</label>
      <textarea id="cockpit-chat-draft" ref={props.composerRef} rows={1} value={props.draft}
        disabled={props.historicalReadOnly || Boolean(props.sessionControlBanner)}
        onChange={(event) => props.onDraftChange(event.target.value)}
        onKeyDown={keyDown} onPaste={props.onComposerPaste}
        placeholder="Message GoatCitadel…"
        className="cockpit-chat-draft mt-2 block min-h-10 w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent disabled:opacity-60"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-fg-muted"><button type="button" onClick={() => props.composerPalette?.onOpen()} disabled={!props.composerPalette?.enabled} className="font-medium text-accent hover:underline disabled:text-fg-muted">Commands and context</button> · <button type="button" onClick={shellSwitch.request} className="font-medium text-accent hover:underline">More controls</button></p>
        {props.hasActiveStream ? <Button type="button" variant="secondary" size="sm" disabled={props.isStopPending} onClick={props.onStopActiveTurn}>{props.isStopPending ? "Stopping…" : "Stop response"}</Button>
          : <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>{localReady ? command === "/schedule" ? "Open schedules" : command === "/timer" ? "Open timer" : "Show status" : props.sending ? "Sending…" : props.editingTurnId ? "Send branch" : "Send"}</Button>}
      </div>
      {localReady ? <p role="status" className="mt-2 text-xs text-fg-secondary">{command === "/schedule" ? "Open Work schedules to review and create a scheduled job." : command === "/timer" ? "Open a durable reminder for this conversation." : "Read the current session state from the Gateway."} No model turn is sent.</p> : null}
      {reason ? <p role="status" className="mt-2 text-xs text-fg-secondary">{reason}</p> : null}
    </div>
    {shellSwitch.feedback}
  </form>;
}
