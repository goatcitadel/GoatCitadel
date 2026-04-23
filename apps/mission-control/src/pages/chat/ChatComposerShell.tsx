import type {
  ChatAttachmentRecord,
  ChatMode,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeRetrievalMode,
  ChatThreadResponse,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import type { ChatErrorSource } from "@goatcitadel/threaded-surface-core";
import { useEffect, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject } from "react";
import { buildGatewayUrl, readGatewayAuthHeaders } from "../../api/client-core";
import { ChatModelPicker, type ChatModelProviderOption } from "../../components/ChatModelPicker";
import { ChatComposerPlusMenu } from "../../components/ChatComposerPlusMenu";
import { ChatQueueBar, type ChatQueueItemView } from "../../components/chat/ChatQueueBar";
import { StatusChip } from "../../components/StatusChip";
import { ChatPresetPicker } from "./ChatPresetPicker";
import { describeChatUiError } from "./chat-error-copy";
import { getMissionControlSurfaceConfig } from "./surface-config";

function getCoworkComposerLabel(input: {
  selectedTurn: ChatThreadResponse["turns"][number] | null;
  editingTurnId: string | null;
  sending: boolean;
}): string {
  if (input.sending) {
    return "Sending...";
  }
  if (input.editingTurnId) {
    return "Edit and resend";
  }
  if (
    input.selectedTurn?.trace.status === "waiting_for_approval" ||
    input.selectedTurn?.trace.status === "waiting_for_user_input"
  ) {
    return "Resolve blocker";
  }
  if (!input.selectedTurn?.trace.orchestration && !input.selectedTurn?.trace.executionPlan) {
    return "Start Cowork run";
  }
  return "Send instruction";
}

function isDocumentAttachment(attachment: ChatAttachmentRecord): boolean {
  const mimeType = attachment.mimeType.toLowerCase();
  if (attachment.mediaType === "image" || attachment.mediaType === "audio" || attachment.mediaType === "video") {
    return false;
  }
  return (
    attachment.mediaType === "text" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("pdf") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("yaml") ||
    mimeType.includes("csv") ||
    mimeType.includes("markdown") ||
    Boolean(attachment.extractPreview?.trim()) ||
    Boolean(attachment.ocrText?.trim()) ||
    Boolean(attachment.transcriptText?.trim())
  );
}

function isImageAttachment(attachment: ChatAttachmentRecord): boolean {
  const mediaType = typeof attachment.mediaType === "string" ? attachment.mediaType.trim().toLowerCase() : "";
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
  const fileName = attachment.fileName.trim().toLowerCase();
  return (
    mediaType === "image" ||
    mediaType.includes("image") ||
    mimeType.startsWith("image/") ||
    mimeType.includes("image") ||
    /\.(png|apng|jpe?g|gif|webp|avif|bmp|svg)$/i.test(fileName)
  );
}

function canReadAttachmentInFull(attachment: ChatAttachmentRecord): boolean {
  return (
    attachment.extractStatus === "ready" ||
    Boolean(attachment.extractPreview?.trim()) ||
    Boolean(attachment.ocrText?.trim()) ||
    Boolean(attachment.transcriptText?.trim())
  );
}

function PendingImageAttachmentPreview({ attachment }: { attachment: ChatAttachmentRecord }) {
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
      <div className="chat-v11-pending-image-preview-shell">
        <img
          src={previewUrl}
          alt={attachment.fileName}
          className="chat-v11-pending-image-preview"
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
    <div className="chat-v11-pending-image-preview-shell loading">
      <p className="chat-v11-pending-image-preview-copy muted">
        {fallbackLoading ? "Loading image preview..." : `Preview unavailable: ${error}`}
      </p>
    </div>
  );
}

export function ChatComposerShell(props: {
  mode: ChatMode;
  isDragActive: boolean;
  queueItems: ChatQueueItemView[];
  editingTurnId: string | null;
  planningMode: "off" | "advisory";
  effectiveToolAutonomy?: string;
  error: string | null;
  errorSource?: ChatErrorSource | null;
  draft: string;
  commandSuggestions: Array<{ key: string; command: string; description: string; applyValue: string }>;
  commandIndex: number;
  pendingAttachments: ChatAttachmentRecord[];
  pendingAttachmentModes?: Record<string, "message" | ThreadKnowledgeRetrievalMode>;
  threadKnowledgeAttachments?: ThreadKnowledgeAttachmentRecord[];
  presetOptions?: Array<{
    value: string;
    label: string;
    summary?: string;
    routeHint?: ChatMode;
    toolsPosture?: "safe_auto" | "manual";
  }>;
  selectedPresetId?: string;
  presetApplyWarning?: string | null;
  selectedTurnRecovery: {
    action?: string;
    label: string;
    summary: string;
  } | null;
  selectedTurn: ChatThreadResponse["turns"][number] | null;
  selectedSessionId: string | null;
  currentWebMode: "auto" | "off" | "quick" | "deep";
  routePreflight: RoutingPreflightResult | null;
  routeBoundaryAckRequired: boolean;
  routeBoundaryAcknowledged: boolean;
  sending: boolean;
  canSend: boolean;
  hasActiveStream: boolean;
  activeStreamTurnAssigned: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  audioInputRef?: RefObject<HTMLInputElement | null>;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onResumeAll: () => void;
  onRemoveQueuedItem: (id: string) => void;
  onCancelEdit: () => void;
  onDismissError: () => void;
  onAcknowledgeRouteBoundary: () => void;
  onRetryTurn: (turnId: string) => void;
  onSetDeepMode: () => void;
  onReviewRunDetails?: () => void;
  onDraftChange: (value: string) => void;
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onComposerPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onApplyDraftCommand: (value: string) => void;
  onPresetChange?: (value: string) => void;
  onApplyPreset?: () => void;
  onDismissPresetWarning?: () => void;
  onSetAttachmentMode?: (attachmentId: string, mode: "message" | ThreadKnowledgeRetrievalMode) => void;
  onRemoveThreadKnowledgeAttachment?: (attachmentId: string) => void;
  knowledgeUrlDraft?: string;
  knowledgeUrlMode?: ThreadKnowledgeRetrievalMode;
  onKnowledgeUrlDraftChange?: (value: string) => void;
  onKnowledgeUrlModeChange?: (value: ThreadKnowledgeRetrievalMode) => void;
  onAttachKnowledgeUrl?: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onAttachFiles: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onRunQuickResearch: () => void;
  voiceBusy?: boolean;
  voiceInputAvailable?: boolean;
  voiceOutputAvailable?: boolean;
  voiceTalkActive?: boolean;
  voiceStatusLabel?: string;
  voiceUnavailableReason?: string | null;
  speakResponsesEnabled?: boolean;
  imageBusy?: boolean;
  imageGenerationAvailable?: boolean;
  imageEditAvailable?: boolean;
  imageProviderOptions?: ChatModelProviderOption[];
  selectedImageProviderId?: string;
  selectedImageModel?: string;
  imageRouteSwitchDisabled?: boolean;
  imageRouteLabel?: string | null;
  onRequestImageProviderChange?: (providerId: string) => void;
  onRequestImageModelChange?: (model: string) => void;
  onToggleVoiceTalk?: () => void;
  onOpenAudioTranscribe?: () => void;
  onAudioFileSelected?: (files: FileList | null) => void;
  onToggleSpeakResponses?: () => void;
  onGenerateImage?: () => void;
  onEditImage?: () => void;
  onStopActiveTurn: () => void;
  onSend: () => void;
}) {
  const {
    mode,
    isDragActive,
    queueItems,
    editingTurnId,
    planningMode,
    effectiveToolAutonomy,
    error,
    errorSource = null,
    draft,
    commandSuggestions,
    commandIndex,
    pendingAttachments,
    pendingAttachmentModes = {},
    threadKnowledgeAttachments = [],
    presetOptions = [],
    selectedPresetId = "",
    presetApplyWarning = null,
    selectedTurnRecovery,
    selectedTurn,
    selectedSessionId,
    currentWebMode,
    routePreflight,
    routeBoundaryAckRequired,
    routeBoundaryAcknowledged,
    sending,
    canSend,
    hasActiveStream,
    activeStreamTurnAssigned,
    composerRef,
    fileInputRef,
    audioInputRef,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onResumeAll,
    onRemoveQueuedItem,
    onCancelEdit,
    onDismissError,
    onAcknowledgeRouteBoundary,
    onRetryTurn,
    onSetDeepMode,
    onReviewRunDetails,
    onDraftChange,
    onComposerKeyDown,
    onComposerPaste,
    onApplyDraftCommand,
    onPresetChange = () => undefined,
    onApplyPreset = () => undefined,
    onDismissPresetWarning = () => undefined,
    onSetAttachmentMode = () => undefined,
    onRemoveThreadKnowledgeAttachment = () => undefined,
    knowledgeUrlDraft = "",
    knowledgeUrlMode = "retrieval",
    onKnowledgeUrlDraftChange = () => undefined,
    onKnowledgeUrlModeChange = () => undefined,
    onAttachKnowledgeUrl = () => undefined,
    onRemoveAttachment,
    onAttachFiles,
    onUploadFiles,
    onRunQuickResearch,
    voiceBusy = false,
    voiceInputAvailable = false,
    voiceOutputAvailable = false,
    voiceTalkActive = false,
    voiceStatusLabel = "Voice unavailable",
    voiceUnavailableReason = null,
    speakResponsesEnabled = false,
    imageBusy = false,
    imageGenerationAvailable = false,
    imageEditAvailable = false,
    imageProviderOptions = [],
    selectedImageProviderId,
    selectedImageModel,
    imageRouteSwitchDisabled = false,
    imageRouteLabel = null,
    onRequestImageProviderChange = () => undefined,
    onRequestImageModelChange = () => undefined,
    onToggleVoiceTalk = () => undefined,
    onOpenAudioTranscribe = () => undefined,
    onAudioFileSelected = () => undefined,
    onToggleSpeakResponses = () => undefined,
    onGenerateImage = () => undefined,
    onEditImage = () => undefined,
    onStopActiveTurn,
    onSend,
  } = props;
  const surfaceConfig = getMissionControlSurfaceConfig(mode);
  const placeholder =
    mode === "code"
      ? "Describe the implementation task, constraints, or review goal..."
      : mode === "cowork"
        ? "Describe the work to coordinate, research, or move forward..."
        : "Ask GoatCitadel anything... Try /help";
  const helperCopy =
    mode === "code"
      ? "Paste larger prompts, drag files, and keep heavier implementation context in one place."
      : mode === "cowork"
        ? "Queue follow-up work while a run streams so Cowork can keep momentum without losing context."
        : "Drag files here, paste screenshots, and queue the next prompt while a turn is still streaming.";
  const mappedError = describeChatUiError(error, errorSource);
  const currentRouteLabel = routePreflight
    ? [routePreflight.effectiveProviderId, routePreflight.effectiveModel].filter(Boolean).join(" / ")
    : null;
  const sessionStateLabel = selectedSessionId ? "Thread ready" : "New thread";
  const webModeLabel =
    currentWebMode === "off"
      ? null
      : currentWebMode === "deep"
        ? "Deep web"
        : currentWebMode === "quick"
          ? "Quick web"
          : "Web auto";

  return (
    <div
      className={`chat-v11-composer mode-${mode} ${isDragActive ? "drop-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragActive ? <div className="chat-drop-overlay">Drop files to attach</div> : null}
      <ChatQueueBar
        items={queueItems}
        title={mode === "cowork" ? "Queued messages" : "Queue"}
        onResumeAll={onResumeAll}
        onRemove={onRemoveQueuedItem}
      />
      {editingTurnId ? (
        <div className="chat-v11-composer-banner">
          Editing branch from turn {editingTurnId.slice(-6)}.
          <button type="button" onClick={onCancelEdit} className="gc-button">
            Cancel edit
          </button>
        </div>
      ) : null}
      {planningMode === "advisory" ? (
        <div className="chat-v11-composer-banner planning">
          Planning mode is on. GoatCitadel will respond with a plan/spec instead of executing tool work automatically.
          {effectiveToolAutonomy === "manual" ? " Manual tool execution is enforced for this turn." : ""}
        </div>
      ) : null}
      {error ? (
        <div className="chat-v11-composer-banner error" role="alert">
          <div className="chat-v11-recovery-copy">
            <strong>{mappedError?.summary ?? error}</strong>
            {mappedError?.raw ? (
              <details>
                <summary>Raw details</summary>
                <p>{mappedError.raw}</p>
              </details>
            ) : null}
          </div>
          <button type="button" onClick={onDismissError} className="gc-button">
            Dismiss
          </button>
        </div>
      ) : null}
      {presetApplyWarning ? (
        <div className="chat-v11-composer-banner recovery">
          <div className="chat-v11-recovery-copy">
            <div className="chat-v11-recovery-head">
              <StatusChip tone="warning">preset</StatusChip>
              <strong>Preset applied with skipped defaults</strong>
            </div>
            <p>{presetApplyWarning}</p>
          </div>
          <button type="button" onClick={onDismissPresetWarning} className="gc-button">
            Dismiss
          </button>
        </div>
      ) : null}
      {mode === "cowork" && routePreflight?.normalizationReason ? (
        <div className="chat-v11-composer-banner recovery">
          <div className="chat-v11-recovery-copy">
            <div className="chat-v11-recovery-head">
              <StatusChip tone="warning">routing</StatusChip>
              <strong>Model normalized before execution</strong>
            </div>
            <p>{routePreflight.normalizationReason}</p>
          </div>
        </div>
      ) : null}
      {mode === "cowork" && routePreflight?.blockedReason ? (
        <div className="chat-v11-composer-banner error" role="alert">
          <div className="chat-v11-recovery-copy">
            <strong>{routePreflight.blockedReason}</strong>
          </div>
        </div>
      ) : null}
      {mode === "cowork" && routePreflight?.degradedReason && !routePreflight.blockedReason ? (
        <div className="chat-v11-composer-banner recovery">
          <div className="chat-v11-recovery-copy">
            <div className="chat-v11-recovery-head">
              <StatusChip tone="warning">degraded</StatusChip>
              <strong>{currentRouteLabel ? `Will use ${currentRouteLabel}` : "Route preflight warning"}</strong>
            </div>
            <p>{routePreflight.degradedReason}</p>
          </div>
        </div>
      ) : null}
      {mode === "cowork" && routeBoundaryAckRequired && !routeBoundaryAcknowledged ? (
        <div className="chat-v11-composer-banner recovery">
          <div className="chat-v11-recovery-copy">
            <div className="chat-v11-recovery-head">
              <StatusChip tone="warning">confirm</StatusChip>
              <strong>Fallback can cross the current runtime boundary</strong>
            </div>
            <p>
              If the primary route fails, Cowork may continue on a different runtime boundary. Acknowledge that fallback
              before continuing.
            </p>
          </div>
          <div className="chat-v11-recovery-actions">
            <button type="button" onClick={onAcknowledgeRouteBoundary} className="gc-button">
              Acknowledge fallback
            </button>
          </div>
        </div>
      ) : null}
      {selectedTurnRecovery &&
      selectedTurn &&
      selectedTurn.trace.status !== "waiting_for_approval" &&
      selectedTurn.trace.status !== "waiting_for_user_input" ? (
        <div className="chat-v11-composer-banner recovery">
          <div className="chat-v11-recovery-copy">
            <div className="chat-v11-recovery-head">
              <StatusChip tone={selectedTurn.trace.status === "failed" ? "critical" : "warning"}>
                {selectedTurn.trace.status}
              </StatusChip>
              <strong>{selectedTurnRecovery.label}</strong>
            </div>
            <p>{selectedTurnRecovery.summary}</p>
          </div>
          <div className="chat-v11-recovery-actions">
            {selectedTurnRecovery.action === "retry" || selectedTurnRecovery.action === "retry_narrower" ? (
              <button
                type="button"
                disabled={sending}
                onClick={() => onRetryTurn(selectedTurn.turnId)}
                className="gc-button"
              >
                {mode === "cowork" ? "Retry run step" : "Retry turn"}
              </button>
            ) : null}
            {selectedTurnRecovery.action === "switch_to_deep_mode" && currentWebMode !== "deep" ? (
              <button
                type="button"
                disabled={!selectedSessionId || sending}
                onClick={onSetDeepMode}
                className="gc-button"
              >
                Set Deep mode
              </button>
            ) : null}
            {onReviewRunDetails ? (
              <button type="button" onClick={onReviewRunDetails} className="gc-button">
                {mode === "cowork" ? "Open run details" : "Review run details"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="chat-v11-composer-headline">
        <div className="chat-v11-composer-heading-row">
          <div className="chat-v11-composer-title-stack">
            <p className="chat-v11-composer-kicker">{surfaceConfig.label}</p>
            <span>{surfaceConfig.stageSummary}</span>
          </div>
          <div className="chat-v11-composer-chip-row" aria-label="Composer posture">
            <span className="chat-v11-composer-chip">{sessionStateLabel}</span>
            {webModeLabel ? <span className="chat-v11-composer-chip subtle">{webModeLabel}</span> : null}
          </div>
        </div>
      </div>
      <div className="chat-v11-composer-input-shell">
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onComposerKeyDown}
          onPaste={onComposerPaste}
          placeholder={placeholder}
          aria-label={`${surfaceConfig.label} message`}
          rows={4}
        />
      </div>
      {commandSuggestions.length > 0 ? (
        <div className="chat-v11-command-popover" role="listbox" aria-label="Slash command suggestions">
          {commandSuggestions.map((item, index) => (
            <button
              key={item.key}
              type="button"
              className={["gc-button", index === commandIndex ? "active" : ""].filter(Boolean).join(" ")}
              onClick={() => onApplyDraftCommand(item.applyValue)}
            >
              <strong>{item.command}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      {pendingAttachments.length > 0 ? (
        <div className="chat-v11-pending-attachments">
          {pendingAttachments.map((item) => (
            <div key={item.attachmentId} className="chat-v11-pending-attachment-card">
              <div className="chat-v11-pending-attachment-head">
                <div>
                  <strong>{item.fileName}</strong>
                  <p className="chat-v11-pending-attachment-meta">
                    {item.mimeType} · {Math.max(1, Math.round(item.sizeBytes / 1024))} KB
                  </p>
                </div>
                <button
                  type="button"
                  className="gc-button chat-attachment-chip"
                  onClick={() => onRemoveAttachment(item.attachmentId)}
                  aria-label={`Remove attachment ${item.fileName}`}
                >
                  Remove
                </button>
              </div>
              {isImageAttachment(item) ? <PendingImageAttachmentPreview attachment={item} /> : null}
              {isDocumentAttachment(item) ? (
                <div className="chat-v11-attachment-mode-row" aria-label={`Attachment mode for ${item.fileName}`}>
                  <button
                    type="button"
                    className={[
                      "gc-button",
                      (pendingAttachmentModes[item.attachmentId] ?? "message") === "message" ? "active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => onSetAttachmentMode(item.attachmentId, "message")}
                  >
                    Message only
                  </button>
                  <button
                    type="button"
                    className={["gc-button", pendingAttachmentModes[item.attachmentId] === "full_text" ? "active" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    disabled={!canReadAttachmentInFull(item)}
                    onClick={() => onSetAttachmentMode(item.attachmentId, "full_text")}
                    title={
                      canReadAttachmentInFull(item)
                        ? "Keep this document in direct full-text context for later turns."
                        : "Full-text context will unlock when extraction is ready."
                    }
                  >
                    Read in full
                  </button>
                  <button
                    type="button"
                    className={["gc-button", pendingAttachmentModes[item.attachmentId] === "retrieval" ? "active" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => onSetAttachmentMode(item.attachmentId, "retrieval")}
                  >
                    Use retrieval
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {threadKnowledgeAttachments.length > 0 ? (
        <div className="chat-v11-thread-knowledge-strip" aria-label="Thread knowledge sources">
          {threadKnowledgeAttachments.map((attachment) => (
            <div key={attachment.attachmentId} className="chat-v11-thread-knowledge-chip">
              <div>
                <strong>{attachment.title}</strong>
                <p>
                  {attachment.retrievalMode === "full_text" ? "Read in full" : "Retrieval"} · {attachment.ingestStatus}
                </p>
                {attachment.errorMessage ? <p>{attachment.errorMessage}</p> : null}
              </div>
              <button
                type="button"
                className="gc-button"
                onClick={() => onRemoveThreadKnowledgeAttachment(attachment.attachmentId)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {voiceUnavailableReason ? (
        <div className="chat-v11-composer-banner recovery">
          <div className="chat-v11-recovery-copy">
            <div className="chat-v11-recovery-head">
              <StatusChip tone="warning">voice</StatusChip>
              <strong>{voiceStatusLabel}</strong>
            </div>
            <p>{voiceUnavailableReason}</p>
          </div>
        </div>
      ) : null}
      <div className="chat-v11-composer-actions">
        <div className="chat-v11-composer-actions-start">
          <ChatComposerPlusMenu
            disabled={sending}
            onAttachFiles={onAttachFiles}
            onRunQuickResearch={onRunQuickResearch}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="chat-v11-hidden-file"
            onChange={(event) => onUploadFiles(event.target.files)}
          />
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            className="chat-v11-hidden-file"
            onChange={(event) => onAudioFileSelected(event.target.files)}
          />
          {presetOptions.length > 0 ? (
            <div className="chat-v11-composer-preset-row">
              <ChatPresetPicker
                presets={presetOptions}
                selectedPresetId={selectedPresetId}
                onPresetChange={onPresetChange}
                onApplyPreset={onApplyPreset}
              />
            </div>
          ) : null}
          {imageProviderOptions.length > 0 ? (
            <div className="chat-v11-composer-image-route" aria-label="Image generation route">
              <span className="chat-v11-composer-kicker">Image route</span>
              <ChatModelPicker
                providers={imageProviderOptions}
                providerId={selectedImageProviderId}
                model={selectedImageModel}
                disabled={imageRouteSwitchDisabled || imageBusy}
                onChangeProvider={onRequestImageProviderChange}
                onChangeModel={onRequestImageModelChange}
              />
            </div>
          ) : null}
          <div className="chat-v11-composer-multimodal-row" aria-label="Multimodal tools">
            <button
              type="button"
              className={`gc-button ${voiceTalkActive ? "active" : ""}`.trim()}
              disabled={!voiceInputAvailable || voiceBusy || sending}
              title={
                voiceInputAvailable ? "Start or stop push-to-talk." : (voiceUnavailableReason ?? "Voice unavailable")
              }
              onClick={onToggleVoiceTalk}
            >
              {voiceBusy ? "Voice..." : voiceTalkActive ? "Stop talk" : "Start talk"}
            </button>
            <button
              type="button"
              className="gc-button"
              disabled={!voiceInputAvailable || voiceBusy || sending}
              title={
                voiceInputAvailable
                  ? "Insert a transcript from an audio file."
                  : (voiceUnavailableReason ?? "Voice unavailable")
              }
              onClick={onOpenAudioTranscribe}
            >
              Insert transcript
            </button>
            {voiceOutputAvailable ? (
              <button
                type="button"
                className={`gc-button ${speakResponsesEnabled ? "active" : ""}`.trim()}
                onClick={onToggleSpeakResponses}
                title="Toggle spoken assistant replies."
              >
                {speakResponsesEnabled ? "Speak replies on" : "Speak replies off"}
              </button>
            ) : null}
            <button
              type="button"
              className="gc-button"
              disabled={!imageGenerationAvailable || imageBusy || sending || draft.trim().length === 0}
              title={
                imageGenerationAvailable
                  ? `Create an image from the current prompt${imageRouteLabel ? ` via ${imageRouteLabel}` : ""}.`
                  : "Image generation is unavailable on the current route."
              }
              onClick={onGenerateImage}
            >
              {imageBusy ? "Imaging..." : "Create image"}
            </button>
            {imageEditAvailable ? (
              <button
                type="button"
                className="gc-button"
                disabled={imageBusy || sending || draft.trim().length === 0}
                title={
                  imageRouteLabel
                    ? `Edit the latest attached image via ${imageRouteLabel}.`
                    : "Edit the latest attached image."
                }
                onClick={onEditImage}
              >
                {imageBusy ? "Imaging..." : "Edit image"}
              </button>
            ) : null}
          </div>
          <div className="chat-v11-composer-helper-pills" aria-label="Composer tools">
            <span className="chat-v11-composer-helper-pill">Slash commands</span>
            {pendingAttachments.length > 0 ? (
              <span className="chat-v11-composer-helper-pill">
                {pendingAttachments.length} file{pendingAttachments.length === 1 ? "" : "s"} attached
              </span>
            ) : null}
            {currentRouteLabel ? <span className="chat-v11-composer-helper-pill">{currentRouteLabel}</span> : null}
            <span className="chat-v11-composer-helper-pill">{voiceStatusLabel}</span>
            {imageRouteLabel ? <span className="chat-v11-composer-helper-pill subtle">{imageRouteLabel}</span> : null}
          </div>
          <div className="chat-v11-knowledge-url-row">
            <input
              value={knowledgeUrlDraft}
              onChange={(event) => onKnowledgeUrlDraftChange(event.target.value)}
              placeholder="Attach a URL to thread knowledge"
              aria-label="Thread knowledge URL"
            />
            <div className="chat-v11-attachment-mode-row">
              <button
                type="button"
                className={["gc-button", knowledgeUrlMode === "full_text" ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => onKnowledgeUrlModeChange("full_text")}
              >
                Read in full
              </button>
              <button
                type="button"
                className={["gc-button", knowledgeUrlMode === "retrieval" ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => onKnowledgeUrlModeChange("retrieval")}
              >
                Use retrieval
              </button>
            </div>
            <button
              type="button"
              className="gc-button"
              disabled={!knowledgeUrlDraft.trim()}
              onClick={onAttachKnowledgeUrl}
            >
              Attach source
            </button>
          </div>
        </div>
        <p>{helperCopy}</p>
        <div className="chat-v11-composer-actions-end">
          {sending && hasActiveStream ? (
            <button type="button" onClick={onStopActiveTurn} className="gc-button">
              {activeStreamTurnAssigned ? "Stop turn" : "Stop stream"}
            </button>
          ) : (
            <button type="button" disabled={!canSend} onClick={onSend} className="gc-button">
              {mode === "cowork"
                ? getCoworkComposerLabel({ selectedTurn, editingTurnId, sending })
                : sending
                  ? "Sending..."
                  : editingTurnId
                    ? "Edit and resend"
                    : "Send message"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
