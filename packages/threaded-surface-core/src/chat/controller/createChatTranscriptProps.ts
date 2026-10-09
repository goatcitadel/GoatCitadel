import type { ChatStreamStatus } from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { useEventStreamStatus } from "@goatcitadel/mission-control-shared/hooks/useEventStreamStatus";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import type { ChatVisualStreamMode } from "../chat-streaming-preview";
import type { MissionControlActiveSessionSurfaceProps } from "../MissionControlActiveSessionSurface";
import type { useChatContextActions } from "../useChatContextActions";
import { useChatDockWorkbenchController } from "../useChatDockWorkbenchController";
import { useChatExportActions } from "../useChatExportActions";
import type { useChatGeneratedArtifactActions } from "../useChatGeneratedArtifactActions";
import type { useChatOutboundExecution } from "../useChatOutboundExecution";
import { useChatRunPresentation } from "../useChatRunPresentation";
import type { useChatSessionData } from "../useChatSessionData";
import type { useChatSessionStatus } from "../useChatSessionStatus";
import type { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { useChatThreadController } from "../useChatThreadController";
import { useChatTimerPanel } from "../useChatTimerPanel";
import { useRunVariablePanel } from "../useRunVariablePanel";
import type { useChatConversationContext } from "./useChatConversationContext";
import type { useChatConversationFork } from "./useChatConversationFork";
import type { useChatErrorState } from "./useChatErrorState";

type Input = {
  historicalTargetIsSelected: boolean;
  historicalModeActive: boolean;
  selectedTurnId: string | null;
  selectedContextTurnIds: string[];
  visibleDelegationRun: ReturnType<typeof useChatRunPresentation>["visibleDelegationRun"];
  threadNotices: import("@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives").ChatThreadNotice[];
  sessionStatusEnabled: boolean;
  chatTimerPanel: ReturnType<typeof useChatTimerPanel>["chatTimerPanel"];
  typedRunVariablesEnabled: boolean;
  runVariablePanel: ReturnType<typeof useRunVariablePanel>["runVariablePanel"];
  followThreadOutput: boolean;
  visualStreamMode: ChatVisualStreamMode;
  selectedSession: NonNullable<ReturnType<typeof useChatThreadController>["selectedSession"]>;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  approvalsCount: NonNullable<MissionThreadedControllerHostProps["approvalsCount"]>;
  eventStreamStatus: ReturnType<typeof useEventStreamStatus>;
  setFollowThreadOutput: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  blockHistoricalMutation: () => boolean;
  setForkConfirm: React.Dispatch<
    React.SetStateAction<{
      turnId: string;
      turnCount: number;
      attachmentCount: number;
      artifactCount: number;
    } | null>
  >;
  handleSelectBranchTurnAndSync: (turnId: string) => Promise<void>;
  dockOpen: ReturnType<typeof useChatDockWorkbenchController>["dockOpen"];
  handleDockOpenChange: (next: boolean) => void;
  handleExportRunBundle: ReturnType<typeof useChatExportActions>["handleExportRunBundle"];
  onOpenPersonalitiesSettings: NonNullable<MissionThreadedControllerHostProps["onOpenPersonalitiesSettings"]>;
  onOpenProviderSettings: NonNullable<MissionThreadedControllerHostProps["onOpenProviderSettings"]>;
  onOpenLocalAiSettings: NonNullable<MissionThreadedControllerHostProps["onOpenLocalAiSettings"]>;
  onOpenLibraryArtifacts: NonNullable<MissionThreadedControllerHostProps["onOpenLibraryArtifacts"]>;
  onOpenLibraryImports: NonNullable<MissionThreadedControllerHostProps["onOpenLibraryImports"]>;
  onOpenOpsRuntime: NonNullable<MissionThreadedControllerHostProps["onOpenOpsRuntime"]>;
  pushLocalNotice: (content: string, tone?: "warning" | "critical" | "success" | "neutral") => void;
  onOpenApprovals: NonNullable<MissionThreadedControllerHostProps["onOpenApprovals"]>;
  sessionData: Pick<
    ReturnType<typeof useChatSessionData>,
    | "messagesLoading"
    | "historicalWindow"
    | "historicalWindowLoading"
    | "historicalWindowError"
    | "returnToLatest"
    | "historicalContinuationLoading"
    | "historicalContinuationError"
    | "loadHistoricalContinuation"
    | "thread"
  >;
  contextActions: Pick<ReturnType<typeof useChatContextActions>, "delegationSuggestion" | "setDelegationSuggestion">;
  sessionStatus: Pick<ReturnType<typeof useChatSessionStatus>, "panel" | "refresh" | "stopFanout" | "close">;
  outbound: Pick<
    ReturnType<typeof useChatOutboundExecution>,
    | "streamStatus"
    | "streamingPreview"
    | "activeStreamingTurnId"
    | "optimisticUserMessage"
    | "pendingApproval"
    | "pendingUserInput"
    | "approvalPending"
    | "userInputPending"
    | "handleApprovePending"
    | "handleDenyPending"
    | "handleSubmitUserInput"
    | "refreshThreadAndApprovals"
  >;
  orchestration: Pick<
    ReturnType<typeof useChatSurfaceOrchestration>,
    "queuedOutbound" | "handleRetryTurn" | "handleBeginEditTurn"
  >;
  artifactActions: Pick<
    ReturnType<typeof useChatGeneratedArtifactActions>,
    "handleOpenGeneratedArtifactFromTurn" | "handleCreateGeneratedArtifactFromTurn"
  >;
  conversationContext: Pick<
    ReturnType<typeof useChatConversationContext>,
    "activeOutboundContext" | "contextSelection"
  >;
  errorState: Pick<ReturnType<typeof useChatErrorState>, "error" | "errorSource">;
  conversationFork: Pick<
    ReturnType<typeof useChatConversationFork>,
    "handleToggleContextTurn" | "handleClearContextSelection"
  >;
};

/** Builds transcript, history and approval controls from their existing owners. */
export function createChatTranscriptProps({
  historicalTargetIsSelected,
  historicalModeActive,
  selectedTurnId,
  selectedContextTurnIds,
  visibleDelegationRun,
  threadNotices,
  sessionStatusEnabled,
  chatTimerPanel,
  typedRunVariablesEnabled,
  runVariablePanel,
  followThreadOutput,
  visualStreamMode,
  selectedSession,
  workspaceId,
  approvalsCount,
  eventStreamStatus,
  setFollowThreadOutput,
  setSelectedTurnId,
  blockHistoricalMutation,
  setForkConfirm,
  handleSelectBranchTurnAndSync,
  dockOpen,
  handleDockOpenChange,
  handleExportRunBundle,
  onOpenPersonalitiesSettings,
  onOpenProviderSettings,
  onOpenLocalAiSettings,
  onOpenLibraryArtifacts,
  onOpenLibraryImports,
  onOpenOpsRuntime,
  pushLocalNotice,
  onOpenApprovals,
  sessionData,
  contextActions,
  sessionStatus,
  outbound,
  orchestration,
  artifactActions,
  conversationContext,
  errorState,
  conversationFork,
}: Input): Pick<
  MissionControlActiveSessionSurfaceProps,
  | "loading"
  | "historicalWindow"
  | "historicalWindowLoading"
  | "historicalWindowError"
  | "onReturnToLatest"
  | "historicalContinuationLoading"
  | "historicalContinuationError"
  | "onLoadHistoricalContinuation"
  | "historicalReadOnly"
  | "thread"
  | "selectedTurnId"
  | "selectedContextTurnIds"
  | "outboundContext"
  | "contextSelection"
  | "delegationRun"
  | "delegationSuggestion"
  | "notices"
  | "sessionStatusPanel"
  | "chatTimerPanel"
  | "runVariablePanel"
  | "followOutput"
  | "streamStatus"
  | "visualStreamMode"
  | "streamingPreview"
  | "activeStreamingTurnId"
  | "optimisticUserMessage"
  | "queuedCount"
  | "streamError"
  | "streamErrorSource"
  | "pendingApproval"
  | "pendingUserInput"
  | "workspaceId"
  | "approvalPending"
  | "approvalsCount"
  | "userInputPending"
  | "eventStreamStatus"
  | "onBottomStateChange"
  | "onSelectTurn"
  | "onToggleContextTurn"
  | "onClearContextSelection"
  | "onStartNewThreadFromTurn"
  | "onSwitchBranch"
  | "onRetryTurn"
  | "onEditTurn"
  | "onOpenRunDetails"
  | "onExportRunBundle"
  | "onOpenGeneratedArtifact"
  | "onCreateGeneratedArtifact"
  | "onCreateGeneratedArtifactVersion"
  | "onOpenPersonalitiesSettings"
  | "onOpenProviderSettings"
  | "onOpenLocalAiSettings"
  | "onOpenLibraryArtifacts"
  | "onOpenLibraryImports"
  | "onOpenOpsRuntime"
  | "onAcceptDelegation"
  | "onDismissDelegationSuggestion"
  | "onApprovePending"
  | "onDenyPending"
  | "onOpenApprovals"
  | "onSubmitUserInput"
  | "onRefreshThread"
> {
  const { loadHistoricalContinuation } = sessionData;
  const { refresh } = sessionStatus;
  const { stopFanout } = sessionStatus;
  const { handleRetryTurn } = orchestration;
  const { handleBeginEditTurn } = orchestration;
  const { handleOpenGeneratedArtifactFromTurn } = artifactActions;
  const { handleCreateGeneratedArtifactFromTurn } = artifactActions;
  const { setDelegationSuggestion } = contextActions;
  const { handleApprovePending } = outbound;
  const { handleDenyPending } = outbound;
  const { handleSubmitUserInput } = outbound;

  return {
    loading: sessionData.messagesLoading,
    historicalWindow: historicalTargetIsSelected ? sessionData.historicalWindow : null,
    historicalWindowLoading: historicalTargetIsSelected && sessionData.historicalWindowLoading,
    historicalWindowError: historicalTargetIsSelected ? sessionData.historicalWindowError : null,
    onReturnToLatest: sessionData.returnToLatest,
    historicalContinuationLoading: historicalTargetIsSelected ? sessionData.historicalContinuationLoading : null,
    historicalContinuationError: historicalTargetIsSelected ? sessionData.historicalContinuationError : null,
    onLoadHistoricalContinuation: (direction) => void loadHistoricalContinuation(direction),
    historicalReadOnly: historicalModeActive,
    thread: sessionData.thread,
    selectedTurnId,
    selectedContextTurnIds,
    outboundContext: conversationContext.activeOutboundContext,
    contextSelection: conversationContext.contextSelection,
    delegationRun: visibleDelegationRun,
    delegationSuggestion: contextActions.delegationSuggestion,
    notices: threadNotices,
    sessionStatusPanel: sessionStatusEnabled
      ? {
          ...sessionStatus.panel,
          onRefresh: () => void refresh(),
          onStopFanout: (invocationId) => void stopFanout(invocationId),
          onClose: sessionStatus.close,
        }
      : undefined,
    chatTimerPanel,
    runVariablePanel: typedRunVariablesEnabled ? runVariablePanel : undefined,
    followOutput: followThreadOutput,
    streamStatus: outbound.streamStatus as ChatStreamStatus,
    visualStreamMode,
    streamingPreview: outbound.streamingPreview,
    activeStreamingTurnId: outbound.activeStreamingTurnId,
    optimisticUserMessage:
      !outbound.optimisticUserMessage?.sessionId ||
      outbound.optimisticUserMessage.sessionId === selectedSession.sessionId
        ? outbound.optimisticUserMessage
        : null,
    queuedCount: orchestration.queuedOutbound.length,
    streamError: errorState.error,
    streamErrorSource: errorState.errorSource,
    pendingApproval: outbound.pendingApproval,
    pendingUserInput: outbound.pendingUserInput,
    workspaceId: selectedSession.workspaceId ?? workspaceId,
    approvalPending: outbound.approvalPending,
    approvalsCount,
    userInputPending: outbound.userInputPending,
    eventStreamStatus,
    onBottomStateChange: setFollowThreadOutput,
    onSelectTurn: (turnId) => {
      setSelectedTurnId(turnId);
    },
    onToggleContextTurn: conversationFork.handleToggleContextTurn,
    onClearContextSelection: conversationFork.handleClearContextSelection,
    onStartNewThreadFromTurn: (turnId) => {
      if (blockHistoricalMutation()) return;
      const byId = new Map((sessionData.thread?.turns ?? []).map((turn) => [turn.turnId, turn]));
      const path = [];
      let cursor = byId.get(turnId);
      while (cursor) {
        path.push(cursor);
        cursor = cursor.parentTurnId ? byId.get(cursor.parentTurnId) : undefined;
      }
      setForkConfirm({
        turnId,
        turnCount: path.length,
        attachmentCount: path.reduce(
          (count, turn) =>
            count + (turn.userMessage.attachments?.length ?? 0) + (turn.assistantMessage?.attachments?.length ?? 0),
          0,
        ),
        artifactCount: path.reduce((count, turn) => count + (turn.generatedArtifacts?.length ?? 0), 0),
      });
    },
    onSwitchBranch: (turnId) => {
      if (!blockHistoricalMutation()) void handleSelectBranchTurnAndSync(turnId);
    },
    onRetryTurn: (turnId) => {
      if (!blockHistoricalMutation()) void handleRetryTurn(turnId);
    },
    onEditTurn: (turnId) => {
      if (!blockHistoricalMutation()) handleBeginEditTurn(turnId);
    },
    onOpenRunDetails: (turnId) => {
      if (dockOpen && selectedTurnId === turnId) {
        handleDockOpenChange(false);
        return;
      }
      setSelectedTurnId(turnId);
      handleDockOpenChange(true);
    },
    onExportRunBundle: () => void handleExportRunBundle(),
    onOpenGeneratedArtifact: (turnId, artifactId) => handleOpenGeneratedArtifactFromTurn(turnId, artifactId),
    onCreateGeneratedArtifact: (turnId) => {
      if (!blockHistoricalMutation()) void handleCreateGeneratedArtifactFromTurn(turnId);
    },
    onCreateGeneratedArtifactVersion: (turnId) => {
      if (!blockHistoricalMutation()) {
        void handleCreateGeneratedArtifactFromTurn(turnId, { supersedeLatest: true });
      }
    },
    onOpenPersonalitiesSettings,
    onOpenProviderSettings,
    onOpenLocalAiSettings,
    onOpenLibraryArtifacts,
    onOpenLibraryImports,
    onOpenOpsRuntime,
    onAcceptDelegation: async () => {
      if (!blockHistoricalMutation()) pushLocalNotice("Subagent delegation is temporarily unavailable.", "warning");
    },
    onDismissDelegationSuggestion: () => setDelegationSuggestion(null),
    // Historical transcript reads are mutation-locked. Only stop/cancel
    // controls remain live as safety escapes; approvals and input do not.
    onApprovePending: (allowScope) => {
      if (!blockHistoricalMutation()) void handleApprovePending(allowScope);
    },
    onDenyPending: () => {
      if (!blockHistoricalMutation()) void handleDenyPending();
    },
    onOpenApprovals,
    onSubmitUserInput: (response) => {
      if (!blockHistoricalMutation()) void handleSubmitUserInput(response);
    },
    onRefreshThread: () => void outbound.refreshThreadAndApprovals(),
  };
}
