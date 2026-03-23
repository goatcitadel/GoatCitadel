import type { ChatAttachmentRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject } from "react";
import { ChatComposerPlusMenu } from "../../components/ChatComposerPlusMenu";
import { ChatQueueBar, type ChatQueueItemView } from "../../components/chat/ChatQueueBar";

export function ChatComposerShell(props: {
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
  sending: boolean;
  canSend: boolean;
  hasActiveStream: boolean;
  activeStreamTurnAssigned: boolean;
  composerRef: RefObject<HTMLTextAreaElement>;
  fileInputRef: RefObject<HTMLInputElement>;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onResumeAll: () => void;
  onRemoveQueuedItem: (id: string) => void;
  onCancelEdit: () => void;
  onDismissError: () => void;
  onRetryTurn: (turnId: string) => void;
  onSetDeepMode: () => void;
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
    onRetryTurn,
    onSetDeepMode,
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

  return (
    <div
      className={`chat-v11-composer ${isDragActive ? "drop-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragActive ? <div className="chat-drop-overlay">Drop files to attach</div> : null}
      <ChatQueueBar items={queueItems} onResumeAll={onResumeAll} onRemove={onRemoveQueuedItem} />
      {editingTurnId ? (
        <div className="chat-v11-composer-banner">
          Editing branch from turn {editingTurnId.slice(-6)}.
          <button type="button" onClick={onCancelEdit}>Cancel edit</button>
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
          {error}
          <button type="button" onClick={onDismissError}>Dismiss</button>
        </div>
      ) : null}
      {selectedTurnRecovery && selectedTurn && selectedTurn.trace.status !== "waiting_for_approval" ? (
        <div className="chat-v11-composer-banner recovery">
          Next step: <strong>{selectedTurnRecovery.label}.</strong> {selectedTurnRecovery.summary}
          {selectedTurnRecovery.action === "retry" || selectedTurnRecovery.action === "retry_narrower" ? (
            <button type="button" disabled={sending} onClick={() => onRetryTurn(selectedTurn.turnId)}>
              Retry turn
            </button>
          ) : null}
          {selectedTurnRecovery.action === "switch_to_deep_mode" && currentWebMode !== "deep" ? (
            <button type="button" disabled={!selectedSessionId || sending} onClick={onSetDeepMode}>
              Set Deep mode
            </button>
          ) : null}
        </div>
      ) : null}
      <textarea
        ref={composerRef}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onComposerKeyDown}
        onPaste={onComposerPaste}
        placeholder="Ask GoatCitadel anything... Try /help"
        rows={4}
      />
      {commandSuggestions.length > 0 ? (
        <div className="chat-v11-command-popover" role="listbox" aria-label="Slash command suggestions">
          {commandSuggestions.map((item, index) => (
            <button key={item.key} type="button" className={index === commandIndex ? "active" : ""} onClick={() => onApplyDraftCommand(item.applyValue)}>
              <strong>{item.command}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      {pendingAttachments.length > 0 ? (
        <div className="chat-v11-pending-attachments">
          {pendingAttachments.map((item) => (
            <button key={item.attachmentId} type="button" className="chat-attachment-chip" onClick={() => onRemoveAttachment(item.attachmentId)}>
              {item.fileName} ×
            </button>
          ))}
        </div>
      ) : null}
      <div className="chat-v11-composer-actions">
        <ChatComposerPlusMenu disabled={sending} onAttachFiles={onAttachFiles} onRunQuickResearch={onRunQuickResearch} />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="chat-v11-hidden-file"
          onChange={(event) => onUploadFiles(event.target.files)}
        />
        <p>Tip: drag files here, paste screenshots, press Enter to send, or queue the next prompt while a turn is still streaming.</p>
        {sending && hasActiveStream ? (
          <button type="button" onClick={onStopActiveTurn}>
            {activeStreamTurnAssigned ? "Stop turn" : "Stop stream"}
          </button>
        ) : (
          <button type="button" disabled={!canSend} onClick={onSend}>
            {sending ? "Sending..." : editingTurnId ? "Edit and resend" : "Send message"}
          </button>
        )}
      </div>
    </div>
  );
}
