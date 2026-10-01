import type { ThreadKnowledgeRetrievalMode } from "@goatcitadel/contracts";
import type { MissionControlActiveSessionSurfaceProps } from "../MissionControlActiveSessionSurface";
import type { useChatComposerInteractions } from "../useChatComposerInteractions";
import { useChatContextActions } from "../useChatContextActions";
import type { useChatKnowledgeAttachments } from "../useChatKnowledgeAttachments";
import { useChatModelChangePlans } from "../useChatModelChangePlans";
import { useChatMultimodalControls } from "../useChatMultimodalControls";
import { useChatPreferenceMutations } from "../useChatPreferenceMutations";
import { useChatPresetActions } from "../useChatPresetActions";
import type { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import type { useChatControllerCoordination } from "./useChatControllerCoordination";
import type { useChatExternalSessionControl } from "./useChatExternalSessionControl";
import type { useChatOneShotContext } from "./useChatOneShotContext";
import type { useChatPlanningPreferences } from "./useChatPlanningPreferences";

type Input = {
  audioInputRef: ReturnType<typeof useChatMultimodalControls>["audioInputRef"];
  blockHistoricalMutation: () => boolean;
  handleDismissError: () => void;
  failedAutoImageRecovery: {
    prompt: string;
    sessionId: string | null;
  } | null;
  selectedSessionId: string | null;
  draft: string;
  handleSendRetainedPromptAsChat: () => Promise<void>;
  acknowledgeCurrentRouteBoundary: () => void;
  requestThreadModelPatch: ReturnType<typeof useChatModelChangePlans>["requestThreadModelPatch"];
  handlePrefPatch: ReturnType<typeof useChatPreferenceMutations>["handlePrefPatch"];
  handleRevealSelectedTurnDetails: () => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setSelectedPresetId: React.Dispatch<React.SetStateAction<string>>;
  handleApplyPreset: ReturnType<typeof useChatPresetActions>["handleApplyPreset"];
  setPresetApplyWarning: React.Dispatch<React.SetStateAction<string | null>>;
  handleRemoveThreadKnowledge: (attachmentId: string) => Promise<void>;
  knowledgeUrlDraft: string;
  knowledgeUrlMode: ThreadKnowledgeRetrievalMode;
  setKnowledgeUrlDraft: React.Dispatch<React.SetStateAction<string>>;
  setKnowledgeUrlMode: React.Dispatch<React.SetStateAction<ThreadKnowledgeRetrievalMode>>;
  handleRunQuickResearch: ReturnType<typeof useChatContextActions>["handleRunQuickResearch"];
  composerInteractions: Pick<
    ReturnType<typeof useChatComposerInteractions>,
    | "handleDragEnter"
    | "handleDragOver"
    | "handleDragLeave"
    | "handleDrop"
    | "handleCancelEdit"
    | "handleSetDeepMode"
    | "handleComposerKeyDown"
    | "handleComposerPaste"
    | "handleApplyDraftCommand"
    | "handleRemoveAttachment"
    | "handleUploadFiles"
  >;
  orchestration: Pick<ReturnType<typeof useChatSurfaceOrchestration>, "handleResumeQueue" | "handleRemoveQueuedItem">;
  knowledgeActions: Pick<
    ReturnType<typeof useChatKnowledgeAttachments>,
    "handleSetPendingAttachmentMode" | "handleAttachKnowledgeUrl"
  >;
  externalControl: Pick<
    ReturnType<typeof useChatExternalSessionControl>,
    | "sessionControlBannerModel"
    | "handleSessionControlRevoke"
    | "handleSessionControlEmergencyTakeover"
    | "sessionControlActionPending"
    | "sessionControlActionError"
    | "sessionControlStatus"
  >;
  coordination: Pick<
    ReturnType<typeof useChatControllerCoordination>,
    "activeStreamRef" | "composerRef" | "fileInputRef"
  >;
  planningPreferences: Pick<
    ReturnType<typeof useChatPlanningPreferences>,
    "handleTogglePlanningMode" | "handleToggleResearchMode" | "handleToggleReviewMode"
  >;
  oneShotContext: Pick<
    ReturnType<typeof useChatOneShotContext>,
    | "modelCouncilEnabledRef"
    | "setModelCouncilEnabled"
    | "workspaceSnapshotRequestRef"
    | "setWorkspaceSnapshotRequest"
    | "setFullWebAccess"
  >;
};

/** Keeps historical mutation guards on composer actions and preserves stop controls. */
export function createChatComposerActionProps({
  audioInputRef,
  blockHistoricalMutation,
  handleDismissError,
  failedAutoImageRecovery,
  selectedSessionId,
  draft,
  handleSendRetainedPromptAsChat,
  acknowledgeCurrentRouteBoundary,
  requestThreadModelPatch,
  handlePrefPatch,
  handleRevealSelectedTurnDetails,
  setDraft,
  setSelectedPresetId,
  handleApplyPreset,
  setPresetApplyWarning,
  handleRemoveThreadKnowledge,
  knowledgeUrlDraft,
  knowledgeUrlMode,
  setKnowledgeUrlDraft,
  setKnowledgeUrlMode,
  handleRunQuickResearch,
  composerInteractions,
  orchestration,
  knowledgeActions,
  externalControl,
  coordination,
  planningPreferences,
  oneShotContext,
}: Input): Pick<
  MissionControlActiveSessionSurfaceProps,
  | "sessionControlBanner"
  | "hasActiveStream"
  | "activeStreamTurnAssigned"
  | "composerRef"
  | "fileInputRef"
  | "audioInputRef"
  | "onDragEnter"
  | "onDragOver"
  | "onDragLeave"
  | "onDrop"
  | "onResumeAll"
  | "onRemoveQueuedItem"
  | "onCancelEdit"
  | "onDismissError"
  | "onSendRetainedPromptAsChat"
  | "onAcknowledgeRouteBoundary"
  | "onTogglePlanningMode"
  | "onToggleResearchMode"
  | "onToggleReviewMode"
  | "onToggleModelCouncil"
  | "onToggleWorkspaceSnapshot"
  | "onRefreshWorkspaceSnapshot"
  | "onSetDeepMode"
  | "onFullWebAccessChange"
  | "onSetThinkingLevel"
  | "onSetSpeedMode"
  | "onSetSubagentPolicy"
  | "onReviewRunDetails"
  | "onDraftChange"
  | "onComposerKeyDown"
  | "onComposerPaste"
  | "onApplyDraftCommand"
  | "onPresetChange"
  | "onApplyPreset"
  | "onDismissPresetWarning"
  | "onSetAttachmentMode"
  | "onRemoveThreadKnowledgeAttachment"
  | "knowledgeUrlDraft"
  | "knowledgeUrlMode"
  | "onKnowledgeUrlDraftChange"
  | "onKnowledgeUrlModeChange"
  | "onAttachKnowledgeUrl"
  | "onRemoveAttachment"
  | "onAttachFiles"
  | "onUploadFiles"
  | "onRunQuickResearch"
> {
  const { handleDrop } = composerInteractions;
  const { handleResumeQueue } = orchestration;
  const { handleRemoveQueuedItem } = orchestration;
  const { handleTogglePlanningMode } = planningPreferences;
  const { handleToggleResearchMode } = planningPreferences;
  const { handleToggleReviewMode } = planningPreferences;
  const { setModelCouncilEnabled } = oneShotContext;
  const { setWorkspaceSnapshotRequest } = oneShotContext;
  const { handleSetDeepMode } = composerInteractions;
  const { setFullWebAccess } = oneShotContext;
  const { handleComposerKeyDown } = composerInteractions;
  const { handleComposerPaste } = composerInteractions;
  const { handleApplyDraftCommand } = composerInteractions;
  const { handleSetPendingAttachmentMode } = knowledgeActions;
  const { handleAttachKnowledgeUrl } = knowledgeActions;
  const { handleRemoveAttachment } = composerInteractions;
  const { handleUploadFiles } = composerInteractions;

  return {
    sessionControlBanner: externalControl.sessionControlBannerModel.externalControlActive
      ? {
          model: externalControl.sessionControlBannerModel,
          onRevoke: externalControl.handleSessionControlRevoke,
          onEmergencyTakeover: externalControl.handleSessionControlEmergencyTakeover,
          actionPending: externalControl.sessionControlActionPending,
          actionError: externalControl.sessionControlActionError,
          statusError: externalControl.sessionControlStatus.error,
        }
      : null,
    hasActiveStream: Boolean(coordination.activeStreamRef.current),
    activeStreamTurnAssigned: Boolean(coordination.activeStreamRef.current?.turnId),
    composerRef: coordination.composerRef,
    fileInputRef: coordination.fileInputRef,
    audioInputRef,
    onDragEnter: composerInteractions.handleDragEnter,
    onDragOver: composerInteractions.handleDragOver,
    onDragLeave: composerInteractions.handleDragLeave,
    onDrop: (event) => {
      if (blockHistoricalMutation()) {
        event.preventDefault();
        return;
      }
      handleDrop(event as Parameters<typeof composerInteractions.handleDrop>[0]);
    },
    onResumeAll: () => {
      if (!blockHistoricalMutation()) handleResumeQueue();
    },
    onRemoveQueuedItem: (id) => {
      if (!blockHistoricalMutation()) handleRemoveQueuedItem(id);
    },
    onCancelEdit: composerInteractions.handleCancelEdit,
    onDismissError: handleDismissError,
    onSendRetainedPromptAsChat:
      failedAutoImageRecovery?.sessionId === selectedSessionId && failedAutoImageRecovery.prompt === draft
        ? () => {
            if (!blockHistoricalMutation()) void handleSendRetainedPromptAsChat();
          }
        : undefined,
    onAcknowledgeRouteBoundary: acknowledgeCurrentRouteBoundary,
    onTogglePlanningMode: () => {
      if (!blockHistoricalMutation()) handleTogglePlanningMode();
    },
    onToggleResearchMode: () => {
      if (!blockHistoricalMutation()) handleToggleResearchMode();
    },
    onToggleReviewMode: () => {
      if (!blockHistoricalMutation()) handleToggleReviewMode();
    },
    onToggleModelCouncil: () => {
      if (!blockHistoricalMutation()) {
        oneShotContext.modelCouncilEnabledRef.current = false;
        setModelCouncilEnabled(false);
      }
    },
    onToggleWorkspaceSnapshot: () => {
      if (blockHistoricalMutation()) return;
      if (oneShotContext.workspaceSnapshotRequestRef.current) {
        oneShotContext.workspaceSnapshotRequestRef.current = undefined;
        setWorkspaceSnapshotRequest(undefined);
      }
    },
    onRefreshWorkspaceSnapshot: () => {},
    onSetDeepMode: () => {
      if (!blockHistoricalMutation()) handleSetDeepMode();
    },
    onFullWebAccessChange: (value) => {
      if (!blockHistoricalMutation()) setFullWebAccess(value);
    },
    onSetThinkingLevel: (level) => {
      if (!blockHistoricalMutation()) requestThreadModelPatch({ thinkingLevel: level });
    },
    onSetSpeedMode: (mode) => {
      if (!blockHistoricalMutation()) void handlePrefPatch({ speedMode: mode });
    },
    onSetSubagentPolicy: (policy) => {
      if (!blockHistoricalMutation()) void handlePrefPatch({ subagentPolicy: policy });
    },
    onReviewRunDetails: handleRevealSelectedTurnDetails,
    onDraftChange: (value) => {
      if (!blockHistoricalMutation()) setDraft(value);
    },
    onComposerKeyDown: (event) => {
      if (blockHistoricalMutation()) {
        event.preventDefault();
        return;
      }
      handleComposerKeyDown(event);
    },
    onComposerPaste: (event) => {
      if (blockHistoricalMutation()) {
        event.preventDefault();
        return;
      }
      handleComposerPaste(event);
    },
    onApplyDraftCommand: (command) => {
      if (!blockHistoricalMutation()) handleApplyDraftCommand(command);
    },
    onPresetChange: (value) => {
      if (!blockHistoricalMutation()) setSelectedPresetId(value);
    },
    onApplyPreset: () => {
      if (!blockHistoricalMutation()) void handleApplyPreset();
    },
    onDismissPresetWarning: () => setPresetApplyWarning(null),
    onSetAttachmentMode: (attachmentId, mode) => {
      if (!blockHistoricalMutation()) handleSetPendingAttachmentMode(attachmentId, mode);
    },
    onRemoveThreadKnowledgeAttachment: (attachmentId) => {
      if (!blockHistoricalMutation()) void handleRemoveThreadKnowledge(attachmentId);
    },
    knowledgeUrlDraft,
    knowledgeUrlMode,
    onKnowledgeUrlDraftChange: (value) => {
      if (!blockHistoricalMutation()) setKnowledgeUrlDraft(value);
    },
    onKnowledgeUrlModeChange: (value) => {
      if (!blockHistoricalMutation()) setKnowledgeUrlMode(value);
    },
    onAttachKnowledgeUrl: () => {
      if (!blockHistoricalMutation()) void handleAttachKnowledgeUrl();
    },
    onRemoveAttachment: (attachmentId) => {
      if (!blockHistoricalMutation()) handleRemoveAttachment(attachmentId);
    },
    onAttachFiles: () => {
      if (!blockHistoricalMutation()) coordination.fileInputRef.current?.click();
    },
    onUploadFiles: (files) => {
      if (!blockHistoricalMutation()) handleUploadFiles(files);
    },
    onRunQuickResearch: () => {
      if (!blockHistoricalMutation()) void handleRunQuickResearch();
    },
  };
}
