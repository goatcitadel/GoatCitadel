import type { ChatMode, ChatThreadResponse, RoutingPreflightResult } from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "../../components/ChatModelPicker";
import type { ChatStreamStatus } from "../../components/chat/ChatStreamStatusBar";
import type { ActiveChatDelegationRun } from "./useChatDelegationPolicyActions";
import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";
import type { EventStreamStatus } from "../../api/shell-client";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui";
import { GeneratedArtifactViewer } from "../../components/chat/GeneratedArtifactViewer";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { ChatComposerShell } from "./ChatComposerShell";
import { ChatThreadShell } from "./ChatThreadShell";
import { MissionControlSurfaceHeader } from "./MissionControlSurfaceHeader";
import { getMissionControlSurfaceConfig } from "./surface-config";
import type { WorkTrustDescriptor } from "./work-trust";

export interface MissionControlActiveSessionSurfaceProps {
  mode: ChatMode;
  sessionTitle: string;
  summary: string;
  trust: WorkTrustDescriptor;
  providerOptions: ChatModelProviderOption[];
  selectedProviderId?: string;
  selectedModel?: string;
  modelSwitchDisabled: boolean;
  dockOpen: boolean;
  onToggleDock: () => void;
  onNavigateSurface: (surface: ChatMode) => void;
  onRequestProviderChange: (providerId: string) => void;
  onRequestModelChange: (model: string) => void;
  loading: boolean;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  delegationRun: ActiveChatDelegationRun | null;
  notices: ChatThreadNotice[];
  followOutput: boolean;
  streamStatus: ChatStreamStatus;
  queuedCount: number;
  streamError: string | null;
  pendingApproval: Parameters<typeof ChatThreadShell>[0]["pendingApproval"];
  pendingUserInput: Parameters<typeof ChatThreadShell>[0]["pendingUserInput"];
  workspaceId: string;
  approvalPending: boolean;
  userInputPending: boolean;
  eventStreamStatus: EventStreamStatus;
  onBottomStateChange: (next: boolean) => void;
  onSelectTurn: (turnId: string | null) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
  onApprovePending: (allowScope: "once" | "session" | "workspace") => void;
  onDenyPending: () => void;
  onSubmitUserInput: Parameters<typeof ChatThreadShell>[0]["onSubmitUserInput"];
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
  pendingAttachmentModes: Parameters<typeof ChatComposerShell>[0]["pendingAttachmentModes"];
  threadKnowledgeAttachments: Parameters<typeof ChatComposerShell>[0]["threadKnowledgeAttachments"];
  presetOptions: Parameters<typeof ChatComposerShell>[0]["presetOptions"];
  selectedPresetId: Parameters<typeof ChatComposerShell>[0]["selectedPresetId"];
  presetApplyWarning: Parameters<typeof ChatComposerShell>[0]["presetApplyWarning"];
  selectedTurnRecovery: Parameters<typeof ChatComposerShell>[0]["selectedTurnRecovery"];
  selectedTurn: Parameters<typeof ChatComposerShell>[0]["selectedTurn"];
  selectedSessionId: string | null;
  currentWebMode: Parameters<typeof ChatComposerShell>[0]["currentWebMode"];
  routePreflight: RoutingPreflightResult | null;
  routeBoundaryAckRequired: boolean;
  routeBoundaryAcknowledged: boolean;
  sending: boolean;
  canSend: boolean;
  hasActiveStream: boolean;
  activeStreamTurnAssigned: boolean;
  composerRef: Parameters<typeof ChatComposerShell>[0]["composerRef"];
  fileInputRef: Parameters<typeof ChatComposerShell>[0]["fileInputRef"];
  audioInputRef: Parameters<typeof ChatComposerShell>[0]["audioInputRef"];
  onDragEnter: React.DragEventHandler<HTMLElement>;
  onDragOver: React.DragEventHandler<HTMLElement>;
  onDragLeave: React.DragEventHandler<HTMLElement>;
  onDrop: React.DragEventHandler<HTMLElement>;
  onResumeAll: () => void;
  onRemoveQueuedItem: (id: string) => void;
  onCancelEdit: () => void;
  onDismissError: () => void;
  onAcknowledgeRouteBoundary: () => void;
  onSetDeepMode: () => void;
  onReviewRunDetails: () => void;
  onDraftChange: (next: string) => void;
  onComposerKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onComposerPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onApplyDraftCommand: (command: string) => void;
  onPresetChange: Parameters<typeof ChatComposerShell>[0]["onPresetChange"];
  onApplyPreset: Parameters<typeof ChatComposerShell>[0]["onApplyPreset"];
  onDismissPresetWarning: Parameters<typeof ChatComposerShell>[0]["onDismissPresetWarning"];
  onSetAttachmentMode: Parameters<typeof ChatComposerShell>[0]["onSetAttachmentMode"];
  onRemoveThreadKnowledgeAttachment: Parameters<typeof ChatComposerShell>[0]["onRemoveThreadKnowledgeAttachment"];
  knowledgeUrlDraft: Parameters<typeof ChatComposerShell>[0]["knowledgeUrlDraft"];
  knowledgeUrlMode: Parameters<typeof ChatComposerShell>[0]["knowledgeUrlMode"];
  onKnowledgeUrlDraftChange: Parameters<typeof ChatComposerShell>[0]["onKnowledgeUrlDraftChange"];
  onKnowledgeUrlModeChange: Parameters<typeof ChatComposerShell>[0]["onKnowledgeUrlModeChange"];
  onAttachKnowledgeUrl: Parameters<typeof ChatComposerShell>[0]["onAttachKnowledgeUrl"];
  onRemoveAttachment: (attachmentId: string) => void;
  onAttachFiles: () => void;
  onUploadFiles: (files: FileList | null) => void;
  onRunQuickResearch: () => void;
  voiceBusy: Parameters<typeof ChatComposerShell>[0]["voiceBusy"];
  voiceInputAvailable: Parameters<typeof ChatComposerShell>[0]["voiceInputAvailable"];
  voiceOutputAvailable: Parameters<typeof ChatComposerShell>[0]["voiceOutputAvailable"];
  voiceTalkActive: Parameters<typeof ChatComposerShell>[0]["voiceTalkActive"];
  voiceStatusLabel: Parameters<typeof ChatComposerShell>[0]["voiceStatusLabel"];
  voiceUnavailableReason: Parameters<typeof ChatComposerShell>[0]["voiceUnavailableReason"];
  speakResponsesEnabled: Parameters<typeof ChatComposerShell>[0]["speakResponsesEnabled"];
  imageBusy: Parameters<typeof ChatComposerShell>[0]["imageBusy"];
  imageGenerationAvailable: Parameters<typeof ChatComposerShell>[0]["imageGenerationAvailable"];
  imageEditAvailable: Parameters<typeof ChatComposerShell>[0]["imageEditAvailable"];
  imageRouteLabel: Parameters<typeof ChatComposerShell>[0]["imageRouteLabel"];
  onToggleVoiceTalk: Parameters<typeof ChatComposerShell>[0]["onToggleVoiceTalk"];
  onOpenAudioTranscribe: Parameters<typeof ChatComposerShell>[0]["onOpenAudioTranscribe"];
  onAudioFileSelected: Parameters<typeof ChatComposerShell>[0]["onAudioFileSelected"];
  onToggleSpeakResponses: Parameters<typeof ChatComposerShell>[0]["onToggleSpeakResponses"];
  onGenerateImage: Parameters<typeof ChatComposerShell>[0]["onGenerateImage"];
  onEditImage: Parameters<typeof ChatComposerShell>[0]["onEditImage"];
  activeGeneratedArtifact?: import("@goatcitadel/contracts").ChatGeneratedArtifactRecord | null;
  onCloseGeneratedArtifact?: () => void;
  onStopActiveTurn: () => void;
  onSend: () => void;
}

export function MissionControlActiveSessionSurface({
  mode,
  sessionTitle,
  summary,
  trust,
  providerOptions,
  selectedProviderId,
  selectedModel,
  modelSwitchDisabled,
  dockOpen,
  onToggleDock,
  onNavigateSurface,
  onRequestProviderChange,
  onRequestModelChange,
  loading,
  thread,
  selectedTurnId,
  delegationRun,
  notices,
  followOutput,
  streamStatus,
  queuedCount,
  streamError,
  pendingApproval,
  pendingUserInput,
  workspaceId,
  approvalPending,
  userInputPending,
  eventStreamStatus,
  onBottomStateChange,
  onSelectTurn,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
  onCreateGeneratedArtifact,
  onCreateGeneratedArtifactVersion,
  onApprovePending,
  onDenyPending,
  onSubmitUserInput,
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
  pendingAttachmentModes,
  threadKnowledgeAttachments,
  presetOptions,
  selectedPresetId,
  presetApplyWarning,
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
  onSetDeepMode,
  onReviewRunDetails,
  onDraftChange,
  onComposerKeyDown,
  onComposerPaste,
  onApplyDraftCommand,
  onPresetChange,
  onApplyPreset,
  onDismissPresetWarning,
  onSetAttachmentMode,
  onRemoveThreadKnowledgeAttachment,
  knowledgeUrlDraft,
  knowledgeUrlMode,
  onKnowledgeUrlDraftChange,
  onKnowledgeUrlModeChange,
  onAttachKnowledgeUrl,
  onRemoveAttachment,
  onAttachFiles,
  onUploadFiles,
  onRunQuickResearch,
  voiceBusy,
  voiceInputAvailable,
  voiceOutputAvailable,
  voiceTalkActive,
  voiceStatusLabel,
  voiceUnavailableReason,
  speakResponsesEnabled,
  imageBusy,
  imageGenerationAvailable,
  imageEditAvailable,
  imageRouteLabel,
  onToggleVoiceTalk,
  onOpenAudioTranscribe,
  onAudioFileSelected,
  onToggleSpeakResponses,
  onGenerateImage,
  onEditImage,
  activeGeneratedArtifact,
  onCloseGeneratedArtifact,
  onStopActiveTurn,
  onSend,
}: MissionControlActiveSessionSurfaceProps) {
  const threadPanelRank = getMissionControlSurfaceConfig(mode).layout.threadPanelRank;
  const compactArtifactSheet = useMediaQuery("(max-width: 840px)");

  return (
    <>
      <MissionControlSurfaceHeader
        mode={mode}
        sessionTitle={sessionTitle}
        summary={summary}
        trust={trust}
        providerOptions={providerOptions}
        selectedProviderId={selectedProviderId}
        selectedModel={selectedModel}
        modelSwitchDisabled={modelSwitchDisabled}
        dockOpen={dockOpen}
        onToggleDock={onToggleDock}
        onNavigateSurface={onNavigateSurface}
        onRequestProviderChange={onRequestProviderChange}
        onRequestModelChange={onRequestModelChange}
      />
      <article
        className={`panel panel-${threadPanelRank} chat-v11-thread mode-${mode}`}
        data-thread-rank={threadPanelRank}
      >
        <ChatThreadShell
          mode={mode}
          loading={loading}
          thread={thread}
          selectedTurnId={selectedTurnId}
          delegationRun={delegationRun}
          notices={notices}
          followOutput={followOutput}
          streamStatus={streamStatus}
          queuedCount={queuedCount}
          streamError={streamError}
          pendingApproval={pendingApproval}
          pendingUserInput={pendingUserInput}
          workspaceId={workspaceId}
          approvalPending={approvalPending}
          userInputPending={userInputPending}
          eventStreamStatus={eventStreamStatus}
          onBottomStateChange={onBottomStateChange}
          onSelectTurn={onSelectTurn}
          onSwitchBranch={onSwitchBranch}
          onRetryTurn={onRetryTurn}
          onEditTurn={onEditTurn}
          onOpenRunDetails={onOpenRunDetails}
          onOpenGeneratedArtifact={onOpenGeneratedArtifact}
          onCreateGeneratedArtifact={onCreateGeneratedArtifact}
          onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
          onApprovePending={onApprovePending}
          onDenyPending={onDenyPending}
          onSubmitUserInput={onSubmitUserInput}
          onRefresh={onRefreshThread}
        />
        <ChatComposerShell
          mode={mode}
          isDragActive={isDragActive}
          queueItems={queueItems}
          editingTurnId={editingTurnId}
          planningMode={planningMode}
          effectiveToolAutonomy={effectiveToolAutonomy}
          error={streamError}
          draft={draft}
          commandSuggestions={commandSuggestions}
          commandIndex={commandIndex}
          pendingAttachments={pendingAttachments}
          pendingAttachmentModes={pendingAttachmentModes}
          threadKnowledgeAttachments={threadKnowledgeAttachments}
          presetOptions={presetOptions}
          selectedPresetId={selectedPresetId}
          presetApplyWarning={presetApplyWarning}
          selectedTurnRecovery={selectedTurnRecovery}
          selectedTurn={selectedTurn}
          selectedSessionId={selectedSessionId}
          currentWebMode={currentWebMode}
          routePreflight={routePreflight}
          routeBoundaryAckRequired={routeBoundaryAckRequired}
          routeBoundaryAcknowledged={routeBoundaryAcknowledged}
          sending={sending}
          canSend={canSend}
          hasActiveStream={hasActiveStream}
          activeStreamTurnAssigned={activeStreamTurnAssigned}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          audioInputRef={audioInputRef}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onResumeAll={onResumeAll}
          onRemoveQueuedItem={onRemoveQueuedItem}
          onCancelEdit={onCancelEdit}
          onDismissError={onDismissError}
          onAcknowledgeRouteBoundary={onAcknowledgeRouteBoundary}
          onRetryTurn={onRetryTurn}
          onSetDeepMode={onSetDeepMode}
          onReviewRunDetails={onReviewRunDetails}
          onDraftChange={onDraftChange}
          onComposerKeyDown={onComposerKeyDown}
          onComposerPaste={onComposerPaste}
          onApplyDraftCommand={onApplyDraftCommand}
          onPresetChange={onPresetChange}
          onApplyPreset={onApplyPreset}
          onDismissPresetWarning={onDismissPresetWarning}
          onSetAttachmentMode={onSetAttachmentMode}
          onRemoveThreadKnowledgeAttachment={onRemoveThreadKnowledgeAttachment}
          knowledgeUrlDraft={knowledgeUrlDraft}
          knowledgeUrlMode={knowledgeUrlMode}
          onKnowledgeUrlDraftChange={onKnowledgeUrlDraftChange}
          onKnowledgeUrlModeChange={onKnowledgeUrlModeChange}
          onAttachKnowledgeUrl={onAttachKnowledgeUrl}
          onRemoveAttachment={onRemoveAttachment}
          onAttachFiles={onAttachFiles}
          onUploadFiles={onUploadFiles}
          onRunQuickResearch={onRunQuickResearch}
          voiceBusy={voiceBusy}
          voiceInputAvailable={voiceInputAvailable}
          voiceOutputAvailable={voiceOutputAvailable}
          voiceTalkActive={voiceTalkActive}
          voiceStatusLabel={voiceStatusLabel}
          voiceUnavailableReason={voiceUnavailableReason}
          speakResponsesEnabled={speakResponsesEnabled}
          imageBusy={imageBusy}
          imageGenerationAvailable={imageGenerationAvailable}
          imageEditAvailable={imageEditAvailable}
          imageRouteLabel={imageRouteLabel}
          onToggleVoiceTalk={onToggleVoiceTalk}
          onOpenAudioTranscribe={onOpenAudioTranscribe}
          onAudioFileSelected={onAudioFileSelected}
          onToggleSpeakResponses={onToggleSpeakResponses}
          onGenerateImage={onGenerateImage}
          onEditImage={onEditImage}
          onStopActiveTurn={onStopActiveTurn}
          onSend={onSend}
        />
      </article>
      {compactArtifactSheet && activeGeneratedArtifact ? (
        <Sheet open onOpenChange={(nextOpen) => !nextOpen && onCloseGeneratedArtifact?.()}>
          <SheetContent side="bottom" className="generated-artifact-sheet">
            <SheetHeader>
              <SheetTitle>{activeGeneratedArtifact.title}</SheetTitle>
              <SheetDescription>
                Generated {activeGeneratedArtifact.kind} artifact from {activeGeneratedArtifact.sourceSurface}.
              </SheetDescription>
            </SheetHeader>
            <GeneratedArtifactViewer artifact={activeGeneratedArtifact} compact />
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
