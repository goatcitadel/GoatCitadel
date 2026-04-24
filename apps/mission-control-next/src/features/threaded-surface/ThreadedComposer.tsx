import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { buildGatewayUrl, readGatewayAuthHeaders } from "@goatcitadel/mission-control-shared/api/client-core";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { ChatComposerPlusMenu } from "@goatcitadel/mission-control-shared/components/ChatComposerPlusMenu";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import { useEffect, useState } from "react";
import { describeThreadedUiError } from "./threaded-error-copy";

type PendingAttachment = MissionThreadedActiveSessionSurfaceProps["pendingAttachments"][number];

function getSurfaceLabel(mode: MissionThreadedActiveSessionSurfaceProps["mode"]): string {
  if (mode === "code") {
    return "Code";
  }
  if (mode === "cowork") {
    return "Cowork";
  }
  return "Chat";
}

function getPlaceholder(mode: MissionThreadedActiveSessionSurfaceProps["mode"]): string {
  if (mode === "code") {
    return "Describe the implementation task, constraints, or review goal…";
  }
  if (mode === "cowork") {
    return "Describe the work to coordinate, research, or move forward…";
  }
  return "Ask GoatCitadel anything…";
}

function isImageAttachment(attachment: PendingAttachment): boolean {
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
  const fileName = attachment.fileName.trim().toLowerCase();
  return (
    mimeType.startsWith("image/") ||
    mimeType.includes("image") ||
    /\.(png|apng|jpe?g|gif|webp|avif|bmp|svg)$/i.test(fileName)
  );
}

function PendingImagePreview({ attachment }: { attachment: PendingAttachment }) {
  const contentPath = `/api/v1/chat/attachments/${encodeURIComponent(attachment.attachmentId)}/content?disposition=inline`;
  const directPreviewUrl = buildGatewayUrl(contentPath);
  const [blobPreviewUrl, setBlobPreviewUrl] = useState<string | null>(null);
  const [loadWithAuthHeaders, setLoadWithAuthHeaders] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBlobPreviewUrl(null);
    setLoadWithAuthHeaders(false);
    setError(null);
  }, [attachment.attachmentId]);

  useEffect(() => {
    if (!loadWithAuthHeaders || blobPreviewUrl) {
      return;
    }
    let active = true;
    let objectUrl: string | null = null;

    async function loadPreview(): Promise<void> {
      try {
        setError(null);
        const response = await fetch(directPreviewUrl, {
          headers: readGatewayAuthHeaders(contentPath),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API error ${response.status}: ${text}`);
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setBlobPreviewUrl(objectUrl);
      } catch (nextError) {
        if (active) {
          setError((nextError as Error).message);
          setBlobPreviewUrl(null);
        }
      }
    }

    void loadPreview();
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [blobPreviewUrl, contentPath, directPreviewUrl, loadWithAuthHeaders]);

  const previewUrl = blobPreviewUrl ?? directPreviewUrl;
  const fallbackLoading = loadWithAuthHeaders && !blobPreviewUrl && !error;
  const showImage = !error && !fallbackLoading;

  if (showImage) {
    return (
      <div className="mc-next-composer-image-shell">
        <img
          src={previewUrl}
          alt={attachment.fileName}
          className="mc-next-composer-image-preview"
          onError={() => {
            if (blobPreviewUrl) {
              setError("Preview unavailable.");
              return;
            }
            setLoadWithAuthHeaders(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mc-next-composer-image-shell loading">
      <p>{fallbackLoading ? "Loading image preview..." : `Preview unavailable: ${error}`}</p>
    </div>
  );
}

export function ThreadedComposer({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const threadKnowledgeAttachments = props.threadKnowledgeAttachments ?? [];
  const presetOptions = props.presetOptions ?? [];
  const knowledgeUrlDraft = props.knowledgeUrlDraft ?? "";
  const knowledgeUrlMode = props.knowledgeUrlMode ?? "retrieval";
  const mappedError = describeThreadedUiError(props.streamError, props.streamErrorSource ?? "other");
  const currentRouteLabel = props.routePreflight
    ? [props.routePreflight.effectiveProviderId, props.routePreflight.effectiveModel].filter(Boolean).join(" / ")
    : null;
  const sessionStateLabel = props.selectedSessionId ? "Thread ready" : "New thread";
  const webModeLabel =
    props.currentWebMode === "off"
      ? null
      : props.currentWebMode === "deep"
        ? "Deep web"
        : props.currentWebMode === "quick"
          ? "Quick web"
          : "Web auto";
  const helperCopy =
    props.mode === "code"
      ? "Paste larger prompts, drag files, and keep heavier implementation context in one place."
      : props.mode === "cowork"
        ? "Queue follow-up work while a run streams so Cowork can keep momentum without losing context."
        : "Drag files here, paste screenshots, and queue the next prompt while a turn is still streaming.";

  return (
    <div className="mc-next-composer">
      <ChatQueueBar
        items={props.queueItems}
        title={props.mode === "cowork" ? "Queued messages" : "Queue"}
        onResumeAll={props.onResumeAll}
        onRemove={props.onRemoveQueuedItem}
      />

      {props.editingTurnId ? (
        <div className="mc-next-composer-banner">
          Editing branch from turn {props.editingTurnId.slice(-6)}.
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onCancelEdit}>
            Cancel edit
          </button>
        </div>
      ) : null}

      {props.planningMode === "advisory" ? (
        <div className="mc-next-composer-banner planning">
          Planning mode is on. GoatCitadel will respond with a plan/spec instead of executing tool work automatically.
        </div>
      ) : null}

      {props.streamError ? (
        <div className="mc-next-composer-banner error" role="alert">
          <div>
            <strong>{mappedError?.summary ?? props.streamError}</strong>
            {mappedError?.raw ? <p>{mappedError.raw}</p> : null}
          </div>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {props.presetApplyWarning ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone="warning">Preset</StatusChip>
          <p>{props.presetApplyWarning}</p>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onDismissPresetWarning}>
            Dismiss
          </button>
        </div>
      ) : null}

      {props.routePreflightLoading && !props.routePreflight ? (
        <div className="mc-next-composer-banner info">
          <StatusChip tone="muted">Route</StatusChip>
          <p>Checking the selected provider/model route before send.</p>
        </div>
      ) : null}

      {props.routePreflight?.blockedReason || props.routePreflightError ? (
        <div className="mc-next-composer-banner error" role="alert">
          <StatusChip tone="critical">Route blocked</StatusChip>
          <p>{props.routePreflight?.blockedReason ?? props.routePreflightError}</p>
        </div>
      ) : null}

      {props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone="warning">Confirm</StatusChip>
          <p>If the primary route fails, this run may continue on another runtime boundary.</p>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onAcknowledgeRouteBoundary}>
            Acknowledge fallback
          </button>
        </div>
      ) : null}

      <div className="mc-next-composer-head">
        <div>
          <p className="mc-next-composer-kicker">{getSurfaceLabel(props.mode)}</p>
          <h3>{props.selectedTurnRecovery?.label ?? "Send the next instruction"}</h3>
        </div>
        <div className="mc-next-composer-chip-row">
          <span className="mc-next-composer-chip">{sessionStateLabel}</span>
          {webModeLabel ? <span className="mc-next-composer-chip subtle">{webModeLabel}</span> : null}
          {currentRouteLabel ? <span className="mc-next-composer-chip subtle">{currentRouteLabel}</span> : null}
        </div>
      </div>

      {props.selectedTurnRecovery ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone={props.selectedTurn?.trace.status === "failed" ? "critical" : "warning"}>
            {props.selectedTurn?.trace.status ?? "recovery"}
          </StatusChip>
          <p>{props.selectedTurnRecovery.summary}</p>
          <div className="mc-next-composer-action-row">
            {props.selectedTurn &&
            (props.selectedTurnRecovery.action === "retry" ||
              props.selectedTurnRecovery.action === "retry_narrower") ? (
              <button
                type="button"
                className="mc-next-composer-inline-button"
                onClick={() => props.onRetryTurn(props.selectedTurn!.turnId)}
              >
                {props.mode === "cowork" ? "Retry run step" : "Retry turn"}
              </button>
            ) : null}
            {props.selectedTurnRecovery.action === "switch_to_deep_mode" && props.currentWebMode !== "deep" ? (
              <button type="button" className="mc-next-composer-inline-button" onClick={props.onSetDeepMode}>
                Set Deep mode
              </button>
            ) : null}
            {props.onReviewRunDetails ? (
              <button type="button" className="mc-next-composer-inline-button" onClick={props.onReviewRunDetails}>
                Review run details
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mc-next-composer-input-shell">
        <textarea
          ref={props.composerRef}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={props.onComposerKeyDown}
          onPaste={props.onComposerPaste}
          placeholder={getPlaceholder(props.mode)}
          rows={4}
        />
      </div>

      {props.commandSuggestions.length > 0 ? (
        <div className="mc-next-command-popover" role="listbox" aria-label="Slash command suggestions">
          {props.commandSuggestions.map((item, index) => (
            <button
              key={item.key}
              type="button"
              className={`mc-next-command-item${index === props.commandIndex ? " active" : ""}`}
              onClick={() => props.onApplyDraftCommand(item.applyValue)}
            >
              <strong>{item.command}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
      ) : null}

      {props.pendingAttachments.length > 0 ? (
        <div className="mc-next-composer-attachments">
          {props.pendingAttachments.map((item) => (
            <div key={item.attachmentId} className="mc-next-composer-attachment">
              <div className="mc-next-composer-attachment-body">
                <div>
                  <strong>{item.fileName}</strong>
                  <p>
                    {item.mimeType} · {Math.max(1, Math.round(item.sizeBytes / 1024))} KB
                  </p>
                </div>
                {isImageAttachment(item) ? <PendingImagePreview attachment={item} /> : null}
              </div>
              <button
                type="button"
                className="mc-next-composer-inline-button"
                onClick={() => props.onRemoveAttachment(item.attachmentId)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {threadKnowledgeAttachments.length > 0 ? (
        <div className="mc-next-composer-knowledge-strip">
          {threadKnowledgeAttachments.map((attachment) => (
            <div key={attachment.attachmentId} className="mc-next-composer-knowledge-chip">
              <div>
                <strong>{attachment.title}</strong>
                <p>
                  {attachment.retrievalMode === "full_text" ? "Read in full" : "Retrieval"} · {attachment.ingestStatus}
                </p>
              </div>
              <button
                type="button"
                className="mc-next-composer-inline-button"
                onClick={() => props.onRemoveThreadKnowledgeAttachment?.(attachment.attachmentId)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mc-next-composer-controls">
        <div className="mc-next-composer-controls-start">
          <ChatComposerPlusMenu
            disabled={props.sending}
            onAttachFiles={props.onAttachFiles}
            onRunQuickResearch={props.onRunQuickResearch}
          />
          <input
            ref={props.audioInputRef}
            type="file"
            accept="audio/*"
            className="mc-next-hidden-file"
            onChange={(event) => props.onAudioFileSelected?.(event.target.files)}
          />
          {presetOptions.length > 0 ? (
            <div className="mc-next-composer-preset-row">
              <select value={props.selectedPresetId} onChange={(event) => props.onPresetChange?.(event.target.value)}>
                <option value="">Preset</option>
                {presetOptions.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="mc-next-composer-inline-button"
                disabled={!props.selectedPresetId}
                onClick={() => props.onApplyPreset?.()}
              >
                Apply
              </button>
            </div>
          ) : null}
          <div className="mc-next-composer-multimodal-row">
            <button
              type="button"
              className={`mc-next-composer-inline-button${props.voiceTalkActive ? " active" : ""}`}
              disabled={!props.voiceInputAvailable || props.voiceBusy || props.sending}
              onClick={props.onToggleVoiceTalk}
            >
              {props.voiceBusy ? "Voice…" : props.voiceTalkActive ? "Stop talk" : "Start talk"}
            </button>
            <button
              type="button"
              className="mc-next-composer-inline-button"
              disabled={!props.voiceInputAvailable || props.voiceBusy || props.sending}
              onClick={props.onOpenAudioTranscribe}
            >
              Transcript
            </button>
            {props.voiceOutputAvailable ? (
              <button
                type="button"
                className={`mc-next-composer-inline-button${props.speakResponsesEnabled ? " active" : ""}`}
                onClick={() => props.onToggleSpeakResponses?.()}
              >
                {props.speakResponsesEnabled ? "Speak on" : "Speak off"}
              </button>
            ) : null}
            <button
              type="button"
              className="mc-next-composer-inline-button"
              disabled={
                !props.imageGenerationAvailable || props.imageBusy || props.sending || props.draft.trim().length === 0
              }
              onClick={() => props.onGenerateImage?.()}
            >
              {props.imageBusy ? "Imaging…" : "Create image"}
            </button>
            {props.imageEditAvailable ? (
              <button
                type="button"
                className="mc-next-composer-inline-button"
                disabled={props.imageBusy || props.sending || props.draft.trim().length === 0}
                onClick={() => props.onEditImage?.()}
              >
                {props.imageBusy ? "Imaging…" : "Edit image"}
              </button>
            ) : null}
          </div>
          <div className="mc-next-composer-knowledge-url-row">
            <input
              value={knowledgeUrlDraft}
              onChange={(event) => props.onKnowledgeUrlDraftChange?.(event.target.value)}
              placeholder="Attach a URL to thread knowledge"
            />
            <select
              value={knowledgeUrlMode}
              onChange={(event) => props.onKnowledgeUrlModeChange?.(event.target.value as typeof knowledgeUrlMode)}
            >
              <option value="retrieval">Use retrieval</option>
              <option value="full_text">Read in full</option>
            </select>
            <button
              type="button"
              className="mc-next-composer-inline-button"
              disabled={!knowledgeUrlDraft.trim()}
              onClick={() => props.onAttachKnowledgeUrl?.()}
            >
              Attach source
            </button>
          </div>
        </div>
        <p className="mc-next-composer-helper">{helperCopy}</p>
        <div className="mc-next-composer-controls-end">
          {props.sending && props.hasActiveStream ? (
            <button type="button" className="mc-next-composer-primary" onClick={props.onStopActiveTurn}>
              {props.activeStreamTurnAssigned ? "Stop turn" : "Stop stream"}
            </button>
          ) : (
            <button type="button" className="mc-next-composer-primary" disabled={!props.canSend} onClick={props.onSend}>
              {props.mode === "cowork"
                ? props.selectedTurn?.trace.status === "waiting_for_approval" ||
                  props.selectedTurn?.trace.status === "waiting_for_user_input"
                  ? "Resolve blocker"
                  : props.editingTurnId
                    ? "Edit and resend"
                    : "Send instruction"
                : props.sending
                  ? "Sending…"
                  : props.editingTurnId
                    ? "Edit and resend"
                    : "Send message"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
