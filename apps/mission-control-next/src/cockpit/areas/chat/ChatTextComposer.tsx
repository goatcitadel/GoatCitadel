import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { useCockpitShellSwitch } from "../../app/use-cockpit-shell-switch";
import { Button } from "../../ui/Button";
import { ChatComposerControls } from "./ChatComposerControls";
import { ChatComposerPalette } from "./ChatComposerPalette";
import { ChatRunVariables } from "./ChatRunVariables";
import { composerSendBlock, type ComposerSendBlock } from "./composer-send-block";
import { isImeEnter } from "./ime";
import { useProjectSwitchReview } from "../../../features/threaded-surface/useProjectSwitchReview";
import { useChatSelectionReview } from "./use-chat-owner-navigation";
import { SessionControlBanner } from "../../../features/threaded-surface/SessionControlBanner";
import { useAutoGrowTextarea } from "../../../features/threaded-surface/useAutoGrowTextarea";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import { ExternalSourceStrip } from "../../../features/threaded-surface/ThreadedExternalSourceStrip";
import { ChatMediaControls, type ChatMediaProps } from "./ChatMediaControls";
import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import { ChatLegacyInputNotice } from "./ChatLegacyInputNotice";
import { Dialog } from "../../ui/Dialog";

export type ComposerProps = ChatMediaProps & Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "queueItems" | "onResumeAll" | "onRemoveQueuedItem" | "midTurnDisposition"
  | "externalSourceControls" | "onOpenLibraryImports"
  | "attachmentUpload"
  | "draft"
  | "onDraftChange"
  | "onSend"
  | "onStopActiveTurn"
  | "canSend" | "canSendWhileRunning"
  | "sending"
  | "hasActiveStream"
  | "isStopPending"
  | "historicalReadOnly"
  | "onReturnToLatest"
  | "sessionControlBanner"
  | "pendingApproval"
  | "pendingUserInput"
  | "pendingAttachments"
  | "editingTurnId"
  | "onCancelEdit"
  | "runVariablePanel"
  | "composerPalette"
  | "routeBoundaryAckRequired"
  | "routeBoundaryAcknowledged"
  | "composerRef"
  | "selectedSessionId"
  | "profileDependentAdmissionBlockReason"
  | "routePreflight"
  | "routePreflightError"
  | "routePreflightLoading"
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
  | "onRemoveAttachment"
  | "fileInputRef"
  | "onAttachFiles"
  | "onUploadFiles"
  | "onAcknowledgeRouteBoundary"
  | "commandSuggestions"
  | "commandIndex"
  | "onApplyDraftCommand"
  | "onComposerKeyDown"
  | "onComposerPaste"
  | "onDragEnter"
  | "onDragOver"
  | "onDragLeave"
  | "onDrop"
  | "isDragActive"
  | "chatTimerPanel"
  | "sessionStatusPanel"
  | "projectSwitchContext"
>;

const REASON_ID = "cockpit-chat-send-reason";
/** Short route checks are not worth announcing; only a check that outlasts this delay is shown. */
export const ROUTE_CHECK_HINT_DELAY_MS = 700;

export function cockpitSendBlockReason(props: ComposerProps): string | null {
  return composerSendBlock(props)?.message ?? null;
}

const GATEWAY_UNAVAILABLE_BLOCK: ComposerSendBlock = {
  kind: "blocked",
  message: "Gateway unavailable. Your draft is preserved; send resumes when the connection returns.",
};

/** True only once `active` has stayed true for `delayMs`. */
function useSettled(active: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setSettled(true), delayMs);
    return () => {
      window.clearTimeout(timer);
      setSettled(false);
    };
  }, [active, delayMs]);
  return active && settled;
}

export function ChatTextComposer({
  props,
  onOpenSchedules,
  gatewayUnavailable = false,
  reasoningEfforts,
}: {
  props: ComposerProps;
  onOpenSchedules?: () => void;
  gatewayUnavailable?: boolean;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
}) {
  const capture = getWorkflowSkillCaptureDisplay(props.draft);
  const shellSwitch = useCockpitShellSwitch(props.selectedSessionId);
  useAutoGrowTextarea(props.composerRef, props.draft, { minLines: 1, maxLines: 8 });
  const [externalSourceOpenToken, setExternalSourceOpenToken] = useState(0);
  const [composing, setComposing] = useState(false);
  const projectReview = useProjectSwitchReview(props, composing);
  const reviewTransition = useChatSelectionReview(projectReview.identity);
  const selectPaletteItem = (item: ComposerProps["commandSuggestions"][number]) => {
    if (projectReview.begin(item)) return;
    if (item.action?.type === "launch_external_source") {
      props.composerPalette?.onClose();
      if (props.externalSourceControls) setExternalSourceOpenToken((token) => token + 1);
      else props.onOpenLibraryImports?.();
      return;
    }
    props.composerPalette?.onSelect(item);
  };
  const command = props.draft.trim().toLowerCase();
  const localCommand =
    !props.editingTurnId &&
    !props.composerPalette?.globalOpen &&
    !props.pendingAttachments.length &&
    ((command === "/schedule" && Boolean(onOpenSchedules)) ||
      (command === "/timer" && Boolean(props.chatTimerPanel)) ||
      (command === "/status" && Boolean(props.sessionStatusPanel)));
  const localReady =
    localCommand &&
    !gatewayUnavailable &&
    !props.sending &&
    !props.hasActiveStream &&
    !props.historicalReadOnly &&
    !props.sessionControlBanner;
  const admitted = props.canSend || Boolean(props.hasActiveStream && props.canSendWhileRunning);
  const block = gatewayUnavailable ? GATEWAY_UNAVAILABLE_BLOCK : localReady ? null : composerSendBlock({ ...props, canSend: admitted });
  const routeChecking = block?.kind === "route-checking";
  // The controller performs a fresh, authoritative preflight before dispatch. Let an explicit
  // send start that path while the display preflight is still debouncing this draft.
  const routeCheckingSend = routeChecking && !props.sending && !props.hasActiveStream;
  const canSubmit = Boolean(
    localReady ||
    (Boolean(props.draft.trim() || props.pendingAttachments.length) &&
      ((admitted && !block) || routeCheckingSend)),
  );
  // A route check that settles quickly never flashes or re-announces its hint.
  const showRouteHint = useSettled(routeChecking, ROUTE_CHECK_HINT_DELAY_MS);
  const visibleReason = block && (!routeChecking || showRouteHint) ? block : null;
  const send = () => {
    if (!canSubmit) return;
    if (localReady && command === "/schedule") {
      props.onDraftChange("");
      onOpenSchedules?.();
      return;
    }
    props.onSend();
    props.composerRef.current?.focus();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter") {
      if (isImeEnter(event) || (event.shiftKey && !event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      if (props.commandSuggestions.length && !localReady) {
        const selected = props.commandSuggestions[props.commandIndex];
        if (selected) {
          if (props.composerPalette?.enabled) selectPaletteItem(selected);
          else props.onApplyDraftCommand(selected.applyValue);
        }
      } else send();
      return;
    }
    props.onComposerKeyDown(event);
  };

  return (
    <form
      onSubmit={submit}
      onDragEnter={props.onDragEnter}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      className={`border-t bg-raised p-3 ${props.isDragActive ? "border-accent" : "border-line-subtle"}`}
    >
      {props.sessionControlBanner ? <SessionControlBanner {...props.sessionControlBanner} /> : null}
      <div className="mx-auto max-w-3xl">
        {props.editingTurnId ? (
          <div
            role="status"
            className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-xs text-fg-secondary"
          >
            <span>Editing a new version of this message.</span>
            <button type="button" onClick={props.onCancelEdit} className="font-medium text-accent hover:underline">
              Cancel edit
            </button>
          </div>
        ) : null}
        <ChatLegacyInputNotice workspaceId={props.projectSwitchContext?.workspaceId} sessionId={props.selectedSessionId} draft={props.draft} onRestore={props.onDraftChange} disabled={props.historicalReadOnly || props.sending || Boolean(props.sessionControlBanner)} />
        <ChatRunVariables panel={props.runVariablePanel} />
        <ChatComposerPalette props={props} onSelect={selectPaletteItem} />
        {projectReview.notice ? (
          <p role="status" className="mb-2 text-sm text-fg-secondary">
            {projectReview.notice}
          </p>
        ) : null}
        <Dialog
          open={projectReview.candidate !== null}
          onOpenChange={(open) => {
            if (!open) projectReview.cancel();
          }}
          title="Switch this Chat to another project?"
          description={projectReview.candidate?.message}
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={projectReview.cancel}>
              Cancel
            </Button>
            <Button type="button" onClick={() => projectReview.confirm(reviewTransition)}>
              Switch project
            </Button>
          </div>
        </Dialog>
        {props.externalSourceControls ? <ExternalSourceStrip controls={props.externalSourceControls}
          disabled={props.historicalReadOnly || Boolean(props.sessionControlBanner)} openAttachFormToken={externalSourceOpenToken}
          onOpenLibrary={props.onOpenLibraryImports} onRestoreFocus={() => props.composerRef.current?.focus()} /> : null}
        <ChatQueueBar items={props.queueItems ?? []} title="Queued messages" onResumeAll={props.onResumeAll} onRemove={props.onRemoveQueuedItem} />
        <ChatComposerControls props={props.attachmentUpload?.pending ? { ...props, sending: false } : props} reasoningEfforts={reasoningEfforts} />
        {props.attachmentUpload?.pending ? <p role="status" className="text-sm text-fg-secondary">Uploading {props.attachmentUpload.pending} attachment(s)…</p> : null}
        {props.attachmentUpload?.error ? <p role="status" className="text-sm text-status-failed">Attachment upload failed: {props.attachmentUpload.error}. Select the file again to retry.</p> : null}
        <ChatMediaControls props={props} />
        <label htmlFor="cockpit-chat-draft" className="sr-only">
          Message
        </label>
        <textarea
          id="cockpit-chat-draft"
          ref={props.composerRef}
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={props.commandSuggestions.length > 0}
          aria-controls={props.commandSuggestions.length ? "cockpit-composer-suggestions" : undefined}
          aria-activedescendant={props.commandSuggestions[props.commandIndex] ? `cockpit-suggestion-${props.commandIndex}` : undefined}
          value={capture?.summary ?? props.draft}
          readOnly={Boolean(capture)}
          disabled={props.historicalReadOnly || Boolean(props.sessionControlBanner)}
          aria-describedby={visibleReason ? REASON_ID : undefined}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={keyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onPaste={props.onComposerPaste}
          placeholder="Message GoatCitadel…"
          className="cockpit-chat-draft mt-2 block min-h-10 w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent disabled:opacity-60"
        />
        {capture ? <section aria-label="Review captured workflow" className="my-3 space-y-2 rounded-md border border-line p-3 text-sm"><p>Review the captured task before sending. Sending generates instructions; saving and activation have separate reviews.</p><details><summary>Captured task and result</summary><p className="whitespace-pre-wrap">{capture.request}</p><p className="whitespace-pre-wrap">{capture.result}</p></details><Button type="button" variant="secondary" disabled={props.sending || props.historicalReadOnly || Boolean(props.sessionControlBanner)} onClick={() => props.onDraftChange("")}>Clear captured workflow</Button></section> : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-fg-muted">
            <button
              type="button"
              onClick={() => props.composerPalette?.onOpen()}
              disabled={!props.composerPalette?.enabled}
              className="inline-flex min-h-8 items-center font-medium text-accent hover:underline disabled:text-fg-muted max-sm:min-h-11"
            >
              Commands and context
            </button>{" "}
            · Shift+Enter for a new line ·{" "}
            <button
              type="button"
              onClick={shellSwitch.visit}
              className="inline-flex min-h-8 items-center font-medium text-accent hover:underline max-sm:min-h-11"
            >
              Open classic view
            </button>
          </p>
          {props.hasActiveStream ? <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
            {props.midTurnDisposition === "steer" ? "Steer response" : "Queue message"}
          </Button> : null}
          {props.hasActiveStream ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="max-sm:h-11 max-sm:px-4"
              disabled={props.isStopPending}
              onClick={() => { props.onStopActiveTurn(); props.composerRef.current?.focus(); }}
            >
              {props.isStopPending ? "Stopping…" : "Stop response"}
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="sm" className="max-sm:h-11 max-sm:px-4" disabled={!canSubmit}>
              {localReady
                ? command === "/schedule"
                  ? "Open schedules"
                  : command === "/timer"
                    ? "Open timer"
                    : "Show status"
                : props.sending
                  ? "Sending…"
                  : props.editingTurnId
                    ? "Send edited message"
                    : "Send"}
            </Button>
          )}
        </div>
        {localReady ? (
          <p role="status" className="mt-2 text-xs text-fg-secondary">
            {command === "/schedule"
              ? "Open Work schedules to review and create a scheduled job."
              : command === "/timer"
                ? "Open a reminder that stays with this conversation."
                : "Read the current session state from the Gateway."}{" "}
            Nothing is sent to the model.
          </p>
        ) : null}
        {visibleReason ? (
          <div
            id={REASON_ID}
            role="status"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-secondary"
          >
            <p className="min-w-0">{visibleReason.message}</p>
            {visibleReason.kind === "historical" && props.onReturnToLatest ? (
              <Button size="sm" onClick={props.onReturnToLatest}>
                Back to latest
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {shellSwitch.feedback}
    </form>
  );
}
