import type {
  ChatAttachmentRecord,
  ChatMode,
  ChatThreadResponse,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject } from "react";
import { ChatComposerPlusMenu } from "../../components/ChatComposerPlusMenu";
import { ChatQueueBar, type ChatQueueItemView } from "../../components/chat/ChatQueueBar";
import { StatusChip } from "../../components/StatusChip";
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

export function ChatComposerShell(props: {
  mode: ChatMode;
  isDragActive: boolean;
  queueItems: ChatQueueItemView[];
  editingTurnId: string | null;
  planningMode: "off" | "advisory";
  effectiveToolAutonomy?: string;
  error: string | null;
  draft: string;
  commandSuggestions: Array<{ key: string; command: string; description: string; applyValue: string }>;
  commandIndex: number;
  pendingAttachments: ChatAttachmentRecord[];
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
  onRemoveAttachment: (attachmentId: string) => void;
  onAttachFiles: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onRunQuickResearch: () => void;
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
    draft,
    commandSuggestions,
    commandIndex,
    pendingAttachments,
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
    onRemoveAttachment,
    onAttachFiles,
    onUploadFiles,
    onRunQuickResearch,
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
  const mappedError = describeChatUiError(error);
  const currentRouteLabel = routePreflight
    ? [routePreflight.effectiveProviderId, routePreflight.effectiveModel].filter(Boolean).join(" / ")
    : null;

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
        <p className="chat-v11-composer-kicker">{surfaceConfig.label}</p>
        <span>{surfaceConfig.stageSummary}</span>
      </div>
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
            <button
              key={item.attachmentId}
              type="button"
              className="gc-button chat-attachment-chip"
              onClick={() => onRemoveAttachment(item.attachmentId)}
              aria-label={`Remove attachment ${item.fileName}`}
            >
              {item.fileName} ×
            </button>
          ))}
        </div>
      ) : null}
      <div className="chat-v11-composer-actions">
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
        <p>{helperCopy}</p>
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
  );
}
