import type { ComposerProps } from "./ChatTextComposer.types";
export type { ComposerProps } from "./ChatTextComposer.types";
import { getWorkflowSkillCaptureDisplay } from "@goatcitadel/mission-control-shared/components/chat/workflow-skill-capture-display";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../../ui/Button";
import { ChatComposerPhoneActions, ChatComposerTools, composerControlsProps } from "./ChatComposerTools";
import { ChatModelOptionsButton, type ModelOptionsRequest } from "./ChatComposerControls";
import { ChatComposerModePills, ChatComposerPlusMenu } from "./ChatComposerPlusMenu";
import { ChatComposerPalette } from "./ChatComposerPalette";
import { channelReplyBlock, channelReplyPlaceholder, channelReplySubmitLabel } from "./channel-composer";
import { ChatRunVariables } from "./ChatRunVariables";
import { committedCommandDraft, composerSendBlock, type ComposerSendBlock } from "./composer-send-block";
import { isImeEnter } from "./ime";
import { useProjectSwitchReview } from "../../../features/threaded-surface/useProjectSwitchReview";
import { useChatSelectionReview } from "./use-chat-owner-navigation";
import { SessionControlBanner } from "../../../features/threaded-surface/SessionControlBanner";
import { useAutoGrowTextarea } from "../../../features/threaded-surface/useAutoGrowTextarea";
import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import { ChatLegacyInputNotice } from "./ChatLegacyInputNotice";
import { Dialog } from "../../ui/Dialog";
import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { ChatLongInputNotice } from "./ChatLongInputNotice";
import { useCoarsePointer } from "../../lib/use-coarse-pointer";

const REASON_ID = "cockpit-chat-send-reason";
/** Short route checks are not worth announcing; only a check that outlasts this delay is shown. */
export const ROUTE_CHECK_HINT_DELAY_MS = 700;

export function cockpitSendBlockReason(props: ComposerProps): string | null {
  return composerSendBlock(props)?.message ?? null;
}

const GATEWAY_UNAVAILABLE_BLOCK: ComposerSendBlock = {
  kind: "blocked",
  message: "GoatCitadel is unavailable. Your draft is preserved; send resumes when the connection returns.",
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
  useAutoGrowTextarea(props.composerRef, props.draft, { minLines: 2, maxLines: 8 });
  const [externalSourceOpenToken, setExternalSourceOpenToken] = useState(0);
  // Read-only sources stay behind a toolbar chip; the panel and its explainer show only once opened.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourcesPanelId = useId();
  // Phones fold the mode, model, attach, sources and voice controls into one sheet; touch keyboards have no Shift.
  const phone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  const coarse = useCoarsePointer();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const modelOptionsRequest: ModelOptionsRequest = useRef(null);
  const channelConversation = Boolean(props.channelReply || props.channelCheck);
  const openSourcePicker = () => {
    setSourcesOpen(true);
    if (phone) setOptionsOpen(true);
    setExternalSourceOpenToken((token) => token + 1);
  };
  const toggleSources = () => {
    const sources = props.externalSourceControls;
    if (sourcesOpen || !sources) return setSourcesOpen(false);
    // With nothing attached the panel has nothing to list, so opening goes straight to the source picker.
    if (sources.attachments.length === 0) openSourcePicker();
    else setSourcesOpen(true);
  };
  const sources = {
    open: sourcesOpen,
    panelId: sourcesPanelId,
    openToken: externalSourceOpenToken,
    onToggle: toggleSources,
  };
  const controlsProps = composerControlsProps(props);
  const [composing, setComposing] = useState(false);
  const projectReview = useProjectSwitchReview(props, composing);
  const reviewTransition = useChatSelectionReview(projectReview.identity);
  const selectPaletteItem = (item: ComposerProps["commandSuggestions"][number]) => {
    if (projectReview.begin(item)) return;
    if (item.action?.type === "launch_external_source") {
      props.composerPalette?.onClose();
      if (props.externalSourceControls) openSourcePicker();
      else props.onOpenLibraryImports?.();
      return;
    }
    props.composerPalette?.onSelect(item);
  };
  const command = props.draft.trim().toLowerCase();
  // Escape hides the slash menu for the current draft and leaves the draft alone; the next keystroke brings it back.
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const slashDismissed = !props.composerPalette?.globalOpen && dismissedDraft === props.draft;
  const commandSuggestions = slashDismissed ? [] : props.commandSuggestions;
  // While the global palette is open, its search input owns the suggestions listbox.
  const ownsSuggestions = !props.composerPalette?.globalOpen && commandSuggestions.length > 0;
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
  const sendAllowed = props.canSend || Boolean(props.hasActiveStream && props.canSendWhileRunning);
  const block = gatewayUnavailable
    ? GATEWAY_UNAVAILABLE_BLOCK
    : localReady
      ? null
      : composerSendBlock({ ...props, canSend: sendAllowed });
  const routeChecking = block?.kind === "route-checking";
  // The controller performs a fresh, authoritative preflight before dispatch. Let an explicit
  // send start that path while the display preflight is still debouncing this draft.
  const routeCheckingSend = routeChecking && !props.sending && !props.hasActiveStream;
  const canSubmit = Boolean(
    localReady ||
    (Boolean(props.draft.trim() || props.pendingAttachments.length) && ((sendAllowed && !block) || routeCheckingSend)),
  );
  // A route check that settles quickly never flashes or re-announces its hint.
  const showRouteHint = useSettled(routeChecking, ROUTE_CHECK_HINT_DELAY_MS);
  const visibleReason = block && (!routeChecking || showRouteHint) ? block : null;
  const submitLabel = props.hasActiveStream
    ? props.midTurnDisposition === "steer"
      ? "Steer response"
      : "Queue message"
    : localReady
      ? command === "/schedule"
        ? "Open schedules"
        : command === "/timer"
          ? "Open timer"
          : "Show status"
      : props.sending
        ? "Sending…"
        : props.editingTurnId
          ? "Send edited message"
          : channelReplySubmitLabel(props.channelReply);
  // On wider layouts a plain "why not" sits beside Send, where the eye already is; the long form keeps its own line.
  const reasonBesideSend = !phone && visibleReason !== null && visibleReason.kind !== "historical";
  const reasonNode = visibleReason ? (
    <div
      id={REASON_ID}
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-secondary${reasonBesideSend ? " ml-auto justify-end text-right" : ""}`}
    >
      <p className="min-w-0">{visibleReason.message}</p>
      {visibleReason.kind === "historical" && props.onReturnToLatest ? (
        <Button size="sm" onClick={props.onReturnToLatest}>
          Back to latest
        </Button>
      ) : null}
    </div>
  ) : null;
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
      // A committed command (`/help`, `/help args`) sends; only a partial token applies the highlighted suggestion.
      const applies =
        commandSuggestions.length && !localReady && !committedCommandDraft(props.draft, commandSuggestions);
      // On touch, a plain Enter is a new line and Send is the button; Ctrl or Cmd+Enter still sends.
      if (coarse && !applies && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (applies) {
        const selected = commandSuggestions[props.commandIndex];
        if (selected) {
          if (props.composerPalette?.enabled) selectPaletteItem(selected);
          else props.onApplyDraftCommand(selected.applyValue);
        }
      } else send();
      return;
    }
    if (!isImeEnter(event)) {
      if (event.key === "Escape" && ownsSuggestions) setDismissedDraft(props.draft);
      // A dismissed menu takes no navigation keys; the controller would still move through its hidden items. A later
      // Escape isn't forwarded either: the controller would swallow it (preventDefault) for the hidden menu, so it
      // could never reach document handlers such as stopping a stream.
      if (slashDismissed && ["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(event.key)) return;
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
      className={`border-t bg-raised p-3 max-sm:px-2 max-sm:py-2 ${props.isDragActive ? "border-accent" : "border-line-subtle"}`}
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
        <ChatLegacyInputNotice
          workspaceId={props.projectSwitchContext?.workspaceId}
          sessionId={props.selectedSessionId}
          draft={props.draft}
          onRestore={props.onDraftChange}
          disabled={props.historicalReadOnly || props.sending || Boolean(props.sessionControlBanner)}
        />
        <ChatLongInputNotice draft={props.draft} />
        <ChatRunVariables panel={props.runVariablePanel} />
        <ChatComposerPalette
          props={slashDismissed ? { ...props, commandSuggestions } : props}
          onSelect={selectPaletteItem}
        />
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
        <ChatComposerTools
          props={props}
          phone={phone}
          reasoningEfforts={reasoningEfforts}
          sources={sources}
          optionsOpen={optionsOpen}
          onOptionsOpenChange={setOptionsOpen}
          onChooseModel={() => modelOptionsRequest.current?.()}
        />
        <label htmlFor="cockpit-chat-draft" className="sr-only">
          Message
        </label>
        <div
          className={
            phone
              ? "mt-2 flex items-end gap-1"
              : "mt-2 rounded-md border border-line-control bg-canvas focus-within:border-accent"
          }
        >
          <textarea
            id="cockpit-chat-draft"
            ref={props.composerRef}
            rows={2}
            aria-autocomplete="list"
            aria-controls={ownsSuggestions ? "cockpit-composer-suggestions" : undefined}
            aria-activedescendant={
              ownsSuggestions && commandSuggestions[props.commandIndex]
                ? `cockpit-suggestion-${props.commandIndex}`
                : undefined
            }
            value={capture?.summary ?? props.draft}
            readOnly={Boolean(capture)}
            // A removed or switched-off channel takes no reply, so its box is off and its placeholder says why.
            disabled={
              props.historicalReadOnly ||
              Boolean(props.sessionControlBanner) ||
              channelReplyBlock(props.channelReply) !== null
            }
            aria-describedby={visibleReason ? REASON_ID : undefined}
            onChange={(event) => {
              setDismissedDraft(null);
              props.onDraftChange(event.target.value);
            }}
            onKeyDown={keyDown}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onPaste={props.onComposerPaste}
            placeholder={`${channelReplyPlaceholder(props.channelReply, props.channelCheck)}${
              coarse || channelConversation ? "" : " Shift+Enter for a new line."
            }`}
            className={`cockpit-chat-draft block min-h-16 resize-none field-sizing-content px-3 py-2 text-md text-fg outline-none placeholder:text-fg-muted disabled:opacity-60 ${phone ? "min-w-0 flex-1 rounded-md border border-line-control bg-canvas focus:border-accent" : "w-full rounded-t-md bg-transparent"}`}
          />
          {phone ? (
            <ChatComposerPhoneActions
              props={props}
              canSubmit={canSubmit}
              submitLabel={submitLabel}
              optionsOpen={optionsOpen}
              onOpenOptions={() => setOptionsOpen(true)}
            />
          ) : (
            <div
              role="group"
              aria-label="Composer controls"
              className="flex flex-wrap items-center gap-2 px-2 pb-2 text-xs text-fg-muted"
            >
              <ChatComposerPlusMenu props={controlsProps} channelConversation={channelConversation} sources={sources} />
              {channelConversation ? null : <ChatComposerModePills props={controlsProps} sources={sources} />}
              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                {reasonBesideSend ? reasonNode : null}
                {channelConversation ? null : (
                  <ChatModelOptionsButton
                    props={controlsProps}
                    reasoningEfforts={reasoningEfforts}
                    scopeKey={props.selectedSessionId ?? ""}
                    requestRef={modelOptionsRequest}
                  />
                )}
                {props.hasActiveStream ? (
                  <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
                    {submitLabel}
                  </Button>
                ) : null}
                {props.hasActiveStream ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={props.isStopPending}
                    onClick={() => {
                      props.onStopActiveTurn();
                      props.composerRef.current?.focus();
                    }}
                  >
                    {props.isStopPending ? "Stopping…" : "Stop response"}
                  </Button>
                ) : (
                  <Button type="submit" variant="primary" size="sm" className="max-w-64" disabled={!canSubmit}>
                    <span className="truncate">{submitLabel}</span>
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        {capture ? (
          <section
            aria-label="Review captured workflow"
            className="my-3 space-y-2 rounded-md border border-line p-3 text-sm"
          >
            <p>
              Review the captured task before sending. Sending generates instructions; saving and activation have
              separate reviews.
            </p>
            <details>
              <summary>Captured task and result</summary>
              <p className="whitespace-pre-wrap">{capture.request}</p>
              <p className="whitespace-pre-wrap">{capture.result}</p>
            </details>
            <Button
              type="button"
              variant="secondary"
              disabled={props.sending || props.historicalReadOnly || Boolean(props.sessionControlBanner)}
              onClick={() => props.onDraftChange("")}
            >
              Clear captured workflow
            </Button>
          </section>
        ) : null}
        {/* A phone keeps no empty reserved line under the draft; wider layouts keep it so the row never jumps. */}
        <div className={phone ? "mt-1 empty:hidden" : "mt-2 min-h-5"}>
          {localReady ? (
            <p role="status" className="text-xs text-fg-secondary">
              {command === "/schedule"
                ? "Open Work schedules to review and create a scheduled job."
                : command === "/timer"
                  ? "Open a reminder that stays with this conversation."
                  : "Show the current status of this conversation."}{" "}
              Nothing is sent to the model.
            </p>
          ) : null}
          {reasonBesideSend ? null : reasonNode}
        </div>
      </div>
    </form>
  );
}
