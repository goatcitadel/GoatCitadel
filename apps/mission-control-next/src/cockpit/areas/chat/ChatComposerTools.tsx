import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { ExternalSourceStrip } from "../../../features/threaded-surface/ThreadedExternalSourceStrip";
import { ListPlus, SendHorizontal, SlidersHorizontal, Square } from "lucide-react";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Sheet } from "../../ui/Sheet";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ChatComposerControls, ChatComposerNotices } from "./ChatComposerControls";
import { ChatMediaControls } from "./ChatMediaControls";
import { ChatSourcesChip } from "./ChatSourcesChip";
import type { ComposerProps } from "./ChatTextComposer.types";

export type ComposerSources = {
  open: boolean;
  panelId: string;
  openToken: number;
  onToggle: () => void;
};

/**
 * Everything between the composer notices and the draft: sources, queue, mode and model controls, uploads and media.
 * Wider layouts show it inline, as before. On a phone the queue, attachments, route acknowledgement and upload status
 * stay beside the draft, and the controls move into one "Message options" sheet so the transcript keeps the screen.
 */
export function ChatComposerTools({
  props,
  phone,
  reasoningEfforts,
  sources,
  optionsOpen,
  onOptionsOpenChange,
}: {
  props: ComposerProps;
  phone: boolean;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
  sources: ComposerSources;
  optionsOpen: boolean;
  onOptionsOpenChange: (open: boolean) => void;
}) {
  const controlsProps = props.attachmentUpload?.pending ? { ...props, sending: false } : props;
  const sourcesPanel = props.externalSourceControls ? (
    <div id={sources.panelId} hidden={!sources.open}>
      <ExternalSourceStrip
        controls={props.externalSourceControls}
        disabled={props.historicalReadOnly || Boolean(props.sessionControlBanner)}
        openAttachFormToken={sources.openToken}
        onOpenLibrary={props.onOpenLibraryImports}
        onRestoreFocus={() => props.composerRef.current?.focus()}
      />
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
  const controls = (
    <ChatComposerControls
      props={controlsProps}
      reasoningEfforts={reasoningEfforts}
      scopeKey={props.selectedSessionId ?? ""}
      notices={!phone}
      sourcesChip={
        props.externalSourceControls ? (
          <ChatSourcesChip
            controls={props.externalSourceControls}
            open={sources.open}
            panelId={sources.panelId}
            onToggle={sources.onToggle}
          />
        ) : null
      }
    />
  );
  // A channel conversation answers on its own route and takes no sources or files from here, so the model, mode,
  // sources and attachment tools stay out of it, also while its channel is still being resolved. Queued messages,
  // route notices and commands remain.
  const channelConversation = Boolean(props.channelReply || props.channelCheck);
  if (!phone)
    return (
      <>
        {channelConversation ? null : sourcesPanel}
        {queue}
        {channelConversation ? <ChatComposerNotices props={controlsProps} /> : controls}
        <ChatUploadStatus upload={props.attachmentUpload} />
        {channelConversation ? null : <ChatMediaControls props={props} />}
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
              {controls}
              {sourcesPanel}
              <ChatMediaControls props={props} />
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
