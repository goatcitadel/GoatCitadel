import type { ChatMode, ChatThreadResponse } from "@goatcitadel/contracts";
import type { ChatStreamStatus } from "../../components/chat/ChatStreamStatusBar";
import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";
import type { EventStreamStatus } from "../../api/shell-client";
import { ChatComposerShell } from "./ChatComposerShell";
import { ChatThreadShell } from "./ChatThreadShell";
import { MissionControlSurfaceHeader } from "./MissionControlSurfaceHeader";

export interface MissionControlActiveSessionSurfaceProps {
  mode: ChatMode;
  sessionTitle: string;
  summary: string;
  status: string | null;
  providerLabel: string;
  modelLabel: string;
  dockOpen: boolean;
  onToggleDock: () => void;
  loading: boolean;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  notices: ChatThreadNotice[];
  followOutput: boolean;
  streamStatus: ChatStreamStatus;
  queuedCount: number;
  streamError: string | null;
  pendingApproval: Parameters<typeof ChatThreadShell>[0]["pendingApproval"];
  workspaceId: string;
  approvalPending: boolean;
  eventStreamStatus: EventStreamStatus;
  onBottomStateChange: (next: boolean) => void;
  onSelectTurn: (turnId: string | null) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onApprovePending: (allowScope: "once" | "session" | "workspace") => void;
  onDenyPending: () => void;
  onRefreshThread: () => void;
  isDragActive: boolean;
  queueItems: Parameters<typeof ChatComposerShell>[0]["queueItems"];
  editingTurnId: string | null;
  planningMode: Parameters<typeof ChatComposerShell>[0]["planningMode"];
  effectiveToolAutonomy?: string;
  draft: string;
  commandSuggestions: Parameters<typeof ChatComposerShell>[0]["commandSuggestions"];
  commandIndex: number;
  pendingAttachments: Parameters<typeof ChatComposerShell>[0]["pendingAttachments"];
  selectedTurnRecovery: Parameters<typeof ChatComposerShell>[0]["selectedTurnRecovery"];
  selectedTurn: Parameters<typeof ChatComposerShell>[0]["selectedTurn"];
  selectedSessionId: string | null;
  currentWebMode: Parameters<typeof ChatComposerShell>[0]["currentWebMode"];
  sending: boolean;
  canSend: boolean;
  hasActiveStream: boolean;
  activeStreamTurnAssigned: boolean;
  composerRef: Parameters<typeof ChatComposerShell>[0]["composerRef"];
  fileInputRef: Parameters<typeof ChatComposerShell>[0]["fileInputRef"];
  onDragEnter: React.DragEventHandler<HTMLElement>;
  onDragOver: React.DragEventHandler<HTMLElement>;
  onDragLeave: React.DragEventHandler<HTMLElement>;
  onDrop: React.DragEventHandler<HTMLElement>;
  onResumeAll: () => void;
  onRemoveQueuedItem: (id: string) => void;
  onCancelEdit: () => void;
  onDismissError: () => void;
  onSetDeepMode: () => void;
  onReviewRunDetails: () => void;
  onDraftChange: (next: string) => void;
  onComposerKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onComposerPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onApplyDraftCommand: (command: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onAttachFiles: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onRunQuickResearch: () => void;
  onStopActiveTurn: () => void;
  onSend: () => void;
}

export function MissionControlActiveSessionSurface({
  mode,
  sessionTitle,
  summary,
  status,
  providerLabel,
  modelLabel,
  dockOpen,
  onToggleDock,
  loading,
  thread,
  selectedTurnId,
  notices,
  followOutput,
  streamStatus,
  queuedCount,
  streamError,
  pendingApproval,
  workspaceId,
  approvalPending,
  eventStreamStatus,
  onBottomStateChange,
  onSelectTurn,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onApprovePending,
  onDenyPending,
  onRefreshThread,
  isDragActive,
  queueItems,
  editingTurnId,
  planningMode,
  effectiveToolAutonomy,
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
}: MissionControlActiveSessionSurfaceProps) {
  return (
    <>
      <MissionControlSurfaceHeader
        mode={mode}
        sessionTitle={sessionTitle}
        summary={summary}
        status={status}
        providerLabel={providerLabel}
        modelLabel={modelLabel}
        dockOpen={dockOpen}
        onToggleDock={onToggleDock}
      />
      <article className={`panel gc-surface-card chat-v11-thread mode-${mode}`}>
        <ChatThreadShell
          mode={mode}
          loading={loading}
          thread={thread}
          selectedTurnId={selectedTurnId}
          notices={notices}
          followOutput={followOutput}
          streamStatus={streamStatus}
          queuedCount={queuedCount}
          streamError={streamError}
          pendingApproval={pendingApproval}
          workspaceId={workspaceId}
          approvalPending={approvalPending}
          eventStreamStatus={eventStreamStatus}
          onBottomStateChange={onBottomStateChange}
          onSelectTurn={onSelectTurn}
          onSwitchBranch={onSwitchBranch}
          onRetryTurn={onRetryTurn}
          onEditTurn={onEditTurn}
          onApprovePending={onApprovePending}
          onDenyPending={onDenyPending}
          onRefresh={onRefreshThread}
        />
        <ChatComposerShell
          mode={mode}
          isDragActive={isDragActive}
          queueItems={queueItems}
          editingTurnId={editingTurnId}
          planningMode={planningMode}
          effectiveToolAutonomy={effectiveToolAutonomy}
          error={null}
          draft={draft}
          commandSuggestions={commandSuggestions}
          commandIndex={commandIndex}
          pendingAttachments={pendingAttachments}
          selectedTurnRecovery={selectedTurnRecovery}
          selectedTurn={selectedTurn}
          selectedSessionId={selectedSessionId}
          currentWebMode={currentWebMode}
          sending={sending}
          canSend={canSend}
          hasActiveStream={hasActiveStream}
          activeStreamTurnAssigned={activeStreamTurnAssigned}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onResumeAll={onResumeAll}
          onRemoveQueuedItem={onRemoveQueuedItem}
          onCancelEdit={onCancelEdit}
          onDismissError={onDismissError}
          onRetryTurn={onRetryTurn}
          onSetDeepMode={onSetDeepMode}
          onReviewRunDetails={onReviewRunDetails}
          onDraftChange={onDraftChange}
          onComposerKeyDown={onComposerKeyDown}
          onComposerPaste={onComposerPaste}
          onApplyDraftCommand={onApplyDraftCommand}
          onRemoveAttachment={onRemoveAttachment}
          onAttachFiles={onAttachFiles}
          onUploadFiles={onUploadFiles}
          onRunQuickResearch={onRunQuickResearch}
          onStopActiveTurn={onStopActiveTurn}
          onSend={onSend}
        />
      </article>
    </>
  );
}
