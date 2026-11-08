import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import {
  createDeferredDialogRuntime,
  useDeferredDialogRuntime,
} from "@goatcitadel/mission-control-shared/components/ui/deferred-dialog";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDeferredOverlay } from "../../ui/deferred-overlay-owner";
import { ListPlus, SendHorizontal, SlidersHorizontal, Square } from "lucide-react";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { IconButton } from "../../ui/IconButton";
import { Sheet } from "../../ui/Sheet";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ChatComposerNotices } from "./ChatComposerControls";
import { loadChatComposerSources } from "./load-chat-composer-sources";
import type { ComposerProps } from "./ChatTextComposer.types";

const phoneOptionsRuntime = createDeferredDialogRuntime(() => import("./ChatComposerPhoneOptions"));

export function useComposerSources(scopeKey: string, panelId: string, attachmentCount: number | undefined) {
  const [attachIntent, setAttachIntent] = useState<{ owner: object; token: number }>();
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) setAttachIntent(undefined);
  }, []);
  const view = useDeferredOverlay({ scopeKey, load: loadChatComposerSources, onOpenChange });
  const [warmOwner, setWarmOwner] = useState<typeof view.owner>();
  const nextToken = useRef(0);
  useEffect(() => {
    if (view.open && view.runtime) setWarmOwner(view.owner);
  }, [view.open, view.owner, view.runtime]);
  const consume = useCallback((token: number) => {
    setAttachIntent((pending) => (pending?.token === token ? undefined : pending));
  }, []);
  const open = () => {
    const active = document.activeElement;
    view.trigger.current = active instanceof HTMLElement ? active : null;
    view.request(true);
  };
  const openPicker = () => {
    setAttachIntent({ owner: view.owner, token: ++nextToken.current });
    open();
  };
  const close = () => {
    setAttachIntent(undefined);
    view.close(true);
  };
  return {
    open: view.open,
    panelId,
    openToken: attachIntent?.owner === view.owner && view.open ? attachIntent.token : 0,
    onToggle: () => {
      if (view.open || attachmentCount === undefined) close();
      else if (attachmentCount === 0) openPicker();
      else open();
    },
    openPicker,
    close,
    consume,
    view,
    Strip: view.open || warmOwner === view.owner ? view.runtime?.ExternalSourceStrip : undefined,
  };
}
export type ComposerSources = ReturnType<typeof useComposerSources>;

/** Attach and the other controls stay usable while an attachment uploads; only an actual send locks them. */
export const composerControlsProps = (props: ComposerProps): ComposerProps =>
  props.attachmentUpload?.pending ? { ...props, sending: false } : props;

/**
 * Everything above the draft: sources, queue, notices and upload status. Wider layouts keep the controls in the draft
 * box's own row (the + panel, mode pills, model chip and Send). On a phone the controls move into one
 * "Message options" sheet so the transcript keeps the screen.
 */
export function ChatComposerTools({
  props,
  phone,
  reasoningEfforts,
  sources,
  optionsOpen,
  onOptionsOpenChange,
  onChooseModel,
}: {
  props: ComposerProps;
  phone: boolean;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
  sources: ComposerSources;
  optionsOpen: boolean;
  onOptionsOpenChange: (open: boolean) => void;
  /** Wider layouts: opens the model chip's popover from a notice's "Choose another model". */
  onChooseModel?: () => void;
}) {
  const controlsProps = composerControlsProps(props);
  // A channel conversation sends through its own route and never offers model, media, or source controls here.
  const channelConversation = Boolean(props.channelReply || props.channelCheck);
  const { runtime: phoneOptions, failed: phoneOptionsFailed } = useDeferredDialogRuntime(
    phone && optionsOpen && !channelConversation,
    phoneOptionsRuntime,
  );
  const { Strip, view } = sources;
  const reloadCancel = useRef<HTMLButtonElement>(null);
  const sourcesPanel = props.externalSourceControls ? (
    <div
      id={sources.panelId}
      hidden={!sources.open}
      ref={(element) => {
        view.content.current = element;
      }}
    >
      {view.loading || view.failure ? (
        <span ref={view.status} role="status" className="text-sm text-fg-muted">
          {view.failure ? (
            <>
              Sources could not load.{" "}
              <Button
                size="sm"
                className="cockpit-deferred-recovery-control min-h-8 max-sm:min-h-11"
                onClick={(event) => view.requestReload(event.currentTarget)}
              >
                Reload app
              </Button>{" "}
              <Button size="sm" className="min-h-8 max-sm:min-h-11" onClick={sources.close}>
                Cancel Sources
              </Button>
            </>
          ) : (
            "Loading sources…"
          )}
        </span>
      ) : null}
      <Dialog
        open={Boolean(view.reloadReview && view.reloadCurrent(view.reloadReview))}
        onOpenChange={(open) => {
          if (!open) view.cancelReload(view.reloadReview);
        }}
        title="Reload app?"
        description="Reloading keeps the recorded conversation. Unsent question answers and unsaved edits may be lost."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (view.reloadReview && view.reloadCurrent(view.reloadReview))
            reloadCancel.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          view.restoreReloadFocus();
        }}
      >
        <div ref={view.registerRecoveryHost} className="flex justify-end gap-2">
          <Button ref={reloadCancel} onClick={() => view.cancelReload(view.reloadReview)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!view.reloadReview || !view.reloadCurrent(view.reloadReview)}
            onClick={() => view.confirmReload(view.reloadReview)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
      {Strip ? (
        <Strip
          controls={props.externalSourceControls}
          disabled={props.historicalReadOnly || Boolean(props.sessionControlBanner)}
          openAttachFormToken={sources.openToken}
          onAttachIntentHandled={sources.consume}
          onOpenLibrary={props.onOpenLibraryImports}
          onRestoreFocus={() => props.composerRef.current?.focus()}
        />
      ) : null}
    </div>
  ) : null;
  const queue = (
    <ChatQueueBar
      items={props.queueItems ?? []}
      title="Queued messages"
      onResumeAll={props.onResumeAll}
      onRemove={props.onRemoveQueuedItem}
    />
  );
  if (!phone)
    return (
      <>
        {channelConversation ? null : sourcesPanel}
        {queue}
        <ChatComposerNotices props={controlsProps} onChooseModel={channelConversation ? undefined : onChooseModel} />
        <ChatUploadStatus upload={props.attachmentUpload} />
      </>
    );
  return (
    <>
      {queue}
      <ChatComposerNotices
        props={controlsProps}
        onChooseModel={channelConversation ? undefined : () => onOptionsOpenChange(true)}
      />
      <ChatUploadStatus upload={props.attachmentUpload} />
      <Sheet open={optionsOpen} onOpenChange={onOptionsOpenChange} title="Message options">
        <div className="space-y-3">
          {channelConversation ? null : (
            <>
              {phoneOptions ? (
                <phoneOptions.ChatComposerPhoneOptions
                  props={controlsProps}
                  reasoningEfforts={reasoningEfforts}
                  sources={sources}
                />
              ) : phoneOptionsFailed ? (
                <p role="alert" className="text-sm text-status-failed">
                  Message options could not load. Close the sheet and try again, or reload the app.
                </p>
              ) : (
                <p aria-busy="true" className="text-sm text-fg-muted">
                  Loading message options…
                </p>
              )}
              {sourcesPanel}
              {phoneOptions ? <phoneOptions.ChatMediaControls props={props} /> : null}
            </>
          )}
          <Button
            className="h-11"
            disabled={!props.composerPalette?.enabled}
            onClick={() => {
              onOptionsOpenChange(false);
              props.composerPalette?.onOpen();
            }}
          >
            Commands and context
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/**
 * The phone row beside the draft: one Options button and icon send/stop buttons. Each keeps the accessible name of
 * the wider layout's text button, so "Send" is still the Send button.
 */
export function ChatComposerPhoneActions({
  props,
  canSubmit,
  submitLabel,
  optionsOpen,
  onOpenOptions,
}: {
  props: ComposerProps;
  canSubmit: boolean;
  submitLabel: string;
  optionsOpen: boolean;
  onOpenOptions: () => void;
}) {
  const submitIcon = props.hasActiveStream ? (
    <ListPlus aria-hidden="true" className="size-5" />
  ) : (
    <SendHorizontal aria-hidden="true" className="size-5" />
  );
  return (
    <div role="group" aria-label="Composer controls" className="flex shrink-0 items-center gap-1">
      <IconButton
        label="Options"
        aria-haspopup="dialog"
        aria-expanded={optionsOpen}
        icon={<SlidersHorizontal aria-hidden="true" className="size-5" />}
        className="size-11 border border-line-control"
        onClick={onOpenOptions}
      />
      {props.hasActiveStream ? (
        <IconButton
          label={props.isStopPending ? "Stopping…" : "Stop response"}
          icon={<Square aria-hidden="true" className="size-4" />}
          className="size-11 border border-line-control"
          disabled={props.isStopPending}
          onClick={() => {
            props.onStopActiveTurn();
            props.composerRef.current?.focus();
          }}
        />
      ) : null}
      <Button type="submit" variant="primary" className="size-11 px-0" disabled={!canSubmit} title={submitLabel}>
        {submitIcon}
        <span className="sr-only">{submitLabel}</span>
      </Button>
    </div>
  );
}

function ChatUploadStatus({ upload }: { upload: ComposerProps["attachmentUpload"] }) {
  return (
    <>
      {upload?.pending ? (
        <p role="status" className="text-sm text-fg-secondary">
          Uploading {plural(upload.pending, "attachment")}…
        </p>
      ) : null}
      {upload?.error ? (
        <div role="alert" className="text-sm text-status-failed">
          <p>The attachment didn’t upload. Select the file again to retry.</p>
          <TechnicalDetails>
            <p className="font-mono text-xs wrap-anywhere">{upload.error}</p>
          </TechnicalDetails>
        </div>
      ) : null}
    </>
  );
}
