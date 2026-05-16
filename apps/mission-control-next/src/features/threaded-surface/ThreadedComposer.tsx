import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { buildGatewayUrl, readGatewayAuthHeaders } from "@goatcitadel/mission-control-shared/api/client-core";
import { ChatAttachmentActions } from "@goatcitadel/mission-control-shared/components/chat/ChatAttachmentActions";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { ChatComposerPlusMenu } from "@goatcitadel/mission-control-shared/components/ChatComposerPlusMenu";
import { ChatQueueBar } from "@goatcitadel/mission-control-shared/components/chat/ChatQueueBar";
import { Paperclip } from "lucide-react";
import { useEffect, useState } from "react";
import { ContextStrip, type ContextStripMode } from "../native-routes/primitives";
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

function getSendLabel(props: MissionThreadedActiveSessionSurfaceProps): string {
  if (props.mode === "cowork") {
    if (
      props.selectedTurn?.trace.status === "waiting_for_approval" ||
      props.selectedTurn?.trace.status === "waiting_for_user_input"
    ) {
      return "Resolve blocker";
    }
    if (props.editingTurnId) {
      return "Edit and delegate";
    }
    return props.sending ? "Delegating..." : "Delegate";
  }

  if (props.mode === "code") {
    if (props.editingTurnId) {
      return "Edit and implement";
    }
    return props.sending ? "Implementing..." : "Implement";
  }

  if (props.editingTurnId) {
    return "Edit and resend";
  }
  return props.sending ? "Sending..." : "Send";
}

function computeUsageTotals(thread: MissionThreadedActiveSessionSurfaceProps["thread"]) {
  return (thread?.turns ?? []).reduce(
    (next, turn) => {
      const messages = [turn.userMessage, turn.assistantMessage].filter(Boolean);
      for (const message of messages) {
        next.tokens += (message?.tokenInput ?? 0) + (message?.tokenOutput ?? 0);
        next.costUsd += message?.costUsd ?? 0;
      }
      return next;
    },
    { tokens: 0, costUsd: 0 },
  );
}

function formatTokenLabel(tokens: number): string {
  return `${new Intl.NumberFormat("en-US").format(tokens)} tokens`;
}

function formatCostLabel(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? "<$0.01" : `$${costUsd.toFixed(costUsd >= 10 ? 1 : 2)}`;
}

function formatUsageLabel(thread: MissionThreadedActiveSessionSurfaceProps["thread"]): string {
  const totals = computeUsageTotals(thread);
  return `${formatTokenLabel(totals.tokens)} / ${formatCostLabel(totals.costUsd)}`;
}

const COMPOSER_KILL_SWITCH_KEY = "mc-next:composer-v2";
const COMPOSER_KILL_SWITCH_FALSE_VALUES = new Set(["off", "false", "0", "no", "disabled"]);
const IN_PROGRESS_MEMORY_TRACE_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "streaming",
  "in_progress",
  "waiting_for_approval",
  "waiting_for_user_input",
]);

function readComposerV2(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const value = window.localStorage.getItem(COMPOSER_KILL_SWITCH_KEY)?.trim().toLowerCase();
    return !value || !COMPOSER_KILL_SWITCH_FALSE_VALUES.has(value);
  } catch {
    return true;
  }
}

function useComposerV2Enabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => readComposerV2());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    const handle = () => setEnabled(readComposerV2());
    window.addEventListener("storage", handle);
    return () => window.removeEventListener("storage", handle);
  }, []);
  return enabled;
}

function toContextStripMode(mode: MissionThreadedActiveSessionSurfaceProps["mode"]): ContextStripMode {
  return mode === "code" || mode === "cowork" ? mode : "chat";
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

function formatHistoricalMemoryLabel(thread: MissionThreadedActiveSessionSurfaceProps["thread"]): string | undefined {
  const lastTurn = thread?.turns?.at(-1);
  const memoryMode = lastTurn?.trace?.memoryMode?.trim();
  if (!memoryMode || memoryMode === "off") {
    return undefined;
  }
  const status = lastTurn?.trace?.status;
  if (status && IN_PROGRESS_MEMORY_TRACE_STATUSES.has(status)) {
    return undefined;
  }
  return `Last turn: ${memoryMode}`;
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
  const thinkingLabel = `Think ${props.currentThinkingLevel}`;
  const speedLabel = props.currentSpeedMode === "fast" ? "Fast" : "Standard";
  const helperCopy =
    props.mode === "code"
      ? "Paste larger prompts, drag files, and keep heavier implementation context in one place."
      : props.mode === "cowork"
        ? "Queue follow-up work while a run streams so Cowork can keep momentum without losing context."
        : "Drag files here, paste screenshots, and queue the next prompt while a turn is still streaming.";
  const planningEnabled = props.planningMode === "advisory";
  const routeLabel =
    props.routePreflightLoading && !currentRouteLabel
      ? "Route checking"
      : currentRouteLabel
        ? currentRouteLabel
        : (props.trust?.providerModelSummary ?? "Provider routing pending");
  const sendLabel = getSendLabel(props);
  const usageLabel = formatUsageLabel(props.thread);
  const usageTotals = computeUsageTotals(props.thread);
  const composerV2Enabled = useComposerV2Enabled();
  const contextStripMode = toContextStripMode(props.mode);
  const contextStripModel = currentRouteLabel ?? props.trust?.providerModelSummary ?? "Routing pending";
  const memoryLabel = formatHistoricalMemoryLabel(props.thread);
  const plusActions = [
    {
      label: props.voiceBusy ? "Voice listening..." : props.voiceTalkActive ? "Stop voice talk" : "Start voice talk",
      disabled: !props.voiceInputAvailable || props.voiceBusy || props.sending,
      active: Boolean(props.voiceTalkActive),
      onSelect: () => props.onToggleVoiceTalk?.(),
    },
    {
      label: "Transcribe audio",
      disabled: !props.voiceInputAvailable || props.voiceBusy || props.sending,
      onSelect: () => props.onOpenAudioTranscribe?.(),
    },
    ...(props.voiceOutputAvailable
      ? [
          {
            label: props.speakResponsesEnabled ? "Stop speaking replies" : "Speak replies",
            active: Boolean(props.speakResponsesEnabled),
            onSelect: () => props.onToggleSpeakResponses?.(),
          },
        ]
      : []),
    {
      label: props.imageBusy ? "Creating image..." : "Create image",
      disabled: !props.imageGenerationAvailable || props.imageBusy || props.sending || props.draft.trim().length === 0,
      onSelect: () => props.onGenerateImage?.(),
    },
    ...(props.imageEditAvailable
      ? [
          {
            label: props.imageBusy ? "Editing image..." : "Edit image",
            disabled: props.imageBusy || props.sending || props.draft.trim().length === 0,
            onSelect: () => props.onEditImage?.(),
          },
        ]
      : []),
    {
      label: "Quick web research",
      onSelect: props.onRunQuickResearch,
    },
  ];

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
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onTogglePlanningMode}>
            Turn planning off
          </button>
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

      {composerV2Enabled ? (
        <ContextStrip
          model={contextStripModel}
          mode={contextStripMode}
          memory={memoryLabel}
          tokens={formatTokenLabel(usageTotals.tokens)}
          cost={formatCostLabel(usageTotals.costUsd)}
        />
      ) : null}

      <div className="mc-next-composer-head">
        <div className="mc-next-composer-title">
          <p className="mc-next-composer-kicker">{getSurfaceLabel(props.mode)}</p>
          <h3>{props.selectedTurnRecovery?.label ?? "Send the next instruction"}</h3>
        </div>
        <div className="mc-next-composer-chip-row">
          <span className="mc-next-composer-chip">{sessionStateLabel}</span>
          {webModeLabel ? <span className="mc-next-composer-chip subtle">{webModeLabel}</span> : null}
          <span className="mc-next-composer-chip subtle">{thinkingLabel}</span>
          <span className="mc-next-composer-chip subtle">{speedLabel}</span>
          <span className="mc-next-composer-chip subtle">{routeLabel}</span>
          <span className="mc-next-composer-chip subtle">{usageLabel}</span>
          {props.pinnedGoal ? <span className="mc-next-composer-chip emphasis">Goal: {props.pinnedGoal}</span> : null}
          {props.hasActiveStream && props.midTurnDisposition === "steer" ? (
            <span className="mc-next-composer-chip emphasis">Steering</span>
          ) : null}
          {props.hasActiveStream && props.midTurnDisposition === "queue" ? (
            <span className="mc-next-composer-chip subtle">Queued</span>
          ) : null}
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
        <div className="mc-next-command-popover" role="listbox" aria-label="Composer suggestions">
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
              <ChatAttachmentActions
                attachmentId={item.attachmentId}
                fileName={item.fileName}
                className="mc-next-composer-attachment-actions"
                buttonClassName="mc-next-composer-inline-button"
                statusClassName="mc-next-composer-attachment-action-status"
              >
                <button
                  type="button"
                  className="mc-next-composer-inline-button"
                  onClick={() => props.onRemoveAttachment(item.attachmentId)}
                >
                  Remove
                </button>
              </ChatAttachmentActions>
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
          <ChatComposerPlusMenu disabled={props.sending} actions={plusActions}>
            {presetOptions.length > 0 ? (
              <div className="mc-next-composer-plus-section">
                <label htmlFor="threaded-composer-preset">Preset</label>
                <div className="mc-next-composer-preset-row">
                  <select
                    id="threaded-composer-preset"
                    value={props.selectedPresetId}
                    onChange={(event) => props.onPresetChange?.(event.target.value)}
                  >
                    <option value="">Choose preset</option>
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
              </div>
            ) : null}
            <div className="mc-next-composer-plus-section">
              <label htmlFor="threaded-composer-knowledge-url">Knowledge URL</label>
              <div className="mc-next-composer-knowledge-url-row">
                <input
                  id="threaded-composer-knowledge-url"
                  value={knowledgeUrlDraft}
                  onChange={(event) => props.onKnowledgeUrlDraftChange?.(event.target.value)}
                  placeholder="Attach a URL"
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
          </ChatComposerPlusMenu>
          <button
            type="button"
            className="mc-next-composer-icon-button"
            disabled={props.sending}
            onClick={props.onAttachFiles}
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip aria-hidden="true" size={17} strokeWidth={2} />
          </button>
          <input
            ref={props.audioInputRef}
            type="file"
            accept="audio/*"
            className="mc-next-hidden-file"
            onChange={(event) => props.onAudioFileSelected?.(event.target.files)}
          />
          <div className="mc-next-composer-multimodal-row">
            <select
              className="mc-next-composer-inline-select"
              value={props.currentThinkingLevel}
              onChange={(event) =>
                props.onSetThinkingLevel(event.target.value as "off" | "minimal" | "standard" | "extended" | "deep")
              }
              aria-label="Thinking level"
            >
              <option value="off">No thinking</option>
              <option value="minimal">Minimal</option>
              <option value="standard">Standard</option>
              <option value="extended">Extended</option>
              <option value="deep">Deep</option>
            </select>
            <select
              className="mc-next-composer-inline-select"
              value={props.currentSpeedMode}
              onChange={(event) => props.onSetSpeedMode(event.target.value as "standard" | "fast")}
              aria-label="Speed mode"
            >
              <option value="standard">Standard</option>
              <option value="fast">Fast</option>
            </select>
            <select
              className="mc-next-composer-inline-select"
              value={props.currentSubagentPolicy}
              onChange={(event) =>
                props.onSetSubagentPolicy(event.target.value as "off" | "ask_when_useful" | "auto_when_useful")
              }
              aria-label="Subagent policy"
            >
              <option value="off">No subagents</option>
              <option value="ask_when_useful">Ask for subagents</option>
              <option value="auto_when_useful">Auto subagents</option>
            </select>
            <button
              type="button"
              className={`mc-next-composer-inline-button${planningEnabled ? " active" : ""}`}
              aria-pressed={planningEnabled}
              title="Shift+Tab"
              onClick={props.onTogglePlanningMode}
            >
              {planningEnabled ? "Plan on" : "Plan"}
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
              {sendLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
