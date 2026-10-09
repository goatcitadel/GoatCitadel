import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { useCallback, useRef } from "react";
import { getGatewayAccessRevision, getGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { detectImageGenerationIntent } from "../chat-image-intent";
import { parseBtwCommand, parseQueueCommand, resolveMidTurnDisposition } from "../chat-page-pure-helpers";
import { useBtwSideChatController } from "../useBtwSideChatController";
import { useChatDocuments } from "../useChatDocuments";
import { useChatGoalActions } from "../useChatGoalActions";
import { useChatKnowledgeAttachments } from "../useChatKnowledgeAttachments";
import { useChatMultimodalControls } from "../useChatMultimodalControls";
import { useChatSessionData } from "../useChatSessionData";
import { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { useExternalSourceAttachments } from "../useExternalSourceAttachments";
import { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import { useRunVariablePanel } from "../useRunVariablePanel";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatConversationContext } from "./useChatConversationContext";
import { useChatErrorState } from "./useChatErrorState";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatOneShotContext } from "./useChatOneShotContext";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  workspaceId: string;
  profileDependentAdmissionBlockReason:
    | "Model council is temporarily unavailable. Turn Council off to send."
    | "Workspace snapshots are temporarily unavailable. Remove the snapshot to send."
    | "Routed external sources are temporarily unavailable. Clear the source selection to send."
    | "Routed documents are temporarily unavailable. Remove the document selection to send."
    | undefined;
  notices: Pick<ReturnType<typeof useChatNoticesAndPresetRefresh>, "pushLocalNotice">;
  setFollowThreadOutput: React.Dispatch<React.SetStateAction<boolean>>;
  knowledgeActions: Pick<
    ReturnType<typeof useChatKnowledgeAttachments>,
    "requiresThreadKnowledge" | "attachPendingKnowledgeSources"
  >;
  orchestration: Pick<
    ReturnType<typeof useChatSurfaceOrchestration>,
    "handleSend" | "setQueuedOutbound" | "editingTurnId"
  >;
  scopedErrors: Pick<ReturnType<typeof useChatScopedErrors>, "setUiError">;
  draft: string;
  openBtwSideChat: ReturnType<typeof useBtwSideChatController>["openSideChat"];
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  coordination: Pick<ReturnType<typeof useChatControllerCoordination>, "activeStreamRef">;
  goalActions: Pick<ReturnType<typeof useChatGoalActions>, "handleSteerMidTurn">;
  oneShotContext: Pick<
    ReturnType<typeof useChatOneShotContext>,
    "consumeModelCouncilArming" | "modelCouncilEnabledRef"
  >;
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  pendingAttachments: ChatAttachmentRecord[];
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "prefs">;
  conversationContext: Pick<ReturnType<typeof useChatConversationContext>, "activeOutboundContext">;
  externalSourceAttachments: Pick<ReturnType<typeof useExternalSourceAttachments>, "selectedAttachmentIds">;
  pendingDocumentContextRefs: Pick<ReturnType<typeof useChatDocuments>["pendingDocumentContextRefs"], "length">;
  knowledgeUrlDraft: string;
  runVariables: Pick<ReturnType<typeof useRunVariablePanel>, "pendingTemplateInvocation">;
  surfaceState: Pick<ReturnType<typeof useMissionControlSurfaceState>, "messageMode">;
  planningMode: import("@goatcitadel/contracts").ChatPlanningMode;
  multimodal: Pick<
    ReturnType<typeof useChatMultimodalControls>,
    "imageBusy" | "imageGenerationAvailable" | "handleGenerateImage"
  >;
  errorState: Pick<ReturnType<typeof useChatErrorState>, "setFailedAutoImageRecovery" | "failedAutoImageRecovery">;
};

/** Keeps plain Chat, knowledge commands and explicit image generation on their existing admission paths. */
export function useChatComposerSendIntent({
  workspaceId,
  profileDependentAdmissionBlockReason,
  notices,
  setFollowThreadOutput,
  knowledgeActions,
  orchestration,
  scopedErrors,
  draft,
  openBtwSideChat,
  setDraft,
  coordination,
  goalActions,
  oneShotContext,
  selection,
  pendingAttachments,
  setPendingAttachments,
  sessionData,
  conversationContext,
  externalSourceAttachments,
  pendingDocumentContextRefs,
  knowledgeUrlDraft,
  runVariables,
  surfaceState,
  planningMode,
  multimodal,
  errorState,
}: Input) {
  const access = getGatewayAccessRevision(); const caller = getGatewayCallerScope(); const gateway = getGatewayApiBaseUrl();
  const identity = JSON.stringify([workspaceId, selection.selectedSessionId, gateway, access, caller]);
  const scopeRef = useRef({ identity });
  if (scopeRef.current.identity !== identity) scopeRef.current = { identity };
  const scope = scopeRef.current;
  const { pushLocalNotice } = notices;
  const { attachPendingKnowledgeSources } = knowledgeActions;
  const { handleSend } = orchestration;
  const { setUiError } = scopedErrors;
  const { handleSteerMidTurn } = goalActions;
  const { consumeModelCouncilArming } = oneShotContext;
  const { setQueuedOutbound } = orchestration;
  const { setFailedAutoImageRecovery } = errorState;
  const { handleGenerateImage } = multimodal;

  const sendDraftAsChat = useCallback(async () => {
    if (profileDependentAdmissionBlockReason) {
      pushLocalNotice(profileDependentAdmissionBlockReason, "warning");
      return;
    }
    try {
      // Sending a message is an explicit "show me the answer" intent: re-arm
      // auto-follow so the new turn and its streamed response stay in view
      // even if the operator had scrolled up earlier in the session.
      setFollowThreadOutput(true);
      // Keep ordinary submission inside the click's synchronous update batch.
      // Awaiting an empty preparation step can defer optimistic feedback past
      // the next frame. Real knowledge attachment still completes before send.
      if (knowledgeActions.requiresThreadKnowledge) await attachPendingKnowledgeSources();
      await handleSend();
    } catch (cause) {
      setUiError(cause instanceof Error ? cause.message : "Unable to prepare thread knowledge.");
    }
  }, [
    attachPendingKnowledgeSources,
    handleSend,
    profileDependentAdmissionBlockReason,
    pushLocalNotice,
    knowledgeActions.requiresThreadKnowledge,
    setFollowThreadOutput,
    setUiError,
  ]);

  const handleSendWithKnowledge = useCallback(async () => {
    const queueCommand = parseQueueCommand(draft);
    const btwCommand = parseBtwCommand(draft);
    if (btwCommand) {
      const isCurrent = () => scopeRef.current === scope && getGatewayAccessRevision() === access && getGatewayCallerScope() === caller && getGatewayApiBaseUrl() === gateway;
      if (!isCurrent()) return;
      // Consume only the submitted command synchronously. Child creation/inline
      // side sends may finish after the operator has authored a new parent draft.
      setDraft((current) => isCurrent() && current === draft ? "" : current);
      await openBtwSideChat(btwCommand.text);
      return;
    }
    const disposition = resolveMidTurnDisposition({
      hasActiveStream: Boolean(coordination.activeStreamRef.current),
      draft,
    });
    const trimmedDraft = draft.trimStart();
    const explicitSteerCommand = /^\/(?:steer|queue\s+steer)\b/i.test(trimmedDraft);
    const localSlashCommand = trimmedDraft.startsWith("/");
    if (disposition === "steer" && (!localSlashCommand || explicitSteerCommand)) {
      const stripped =
        queueCommand?.kind === "steer" ? queueCommand.text : draft.trimStart().replace(/^\/steer\s*/i, "");
      if (stripped) {
        setFollowThreadOutput(true);
        await handleSteerMidTurn(stripped);
        setDraft("");
        return;
      }
    }
    if (profileDependentAdmissionBlockReason) {
      pushLocalNotice(profileDependentAdmissionBlockReason, "warning");
      return;
    }
    if (queueCommand?.kind === "followup" || queueCommand?.kind === "collect") {
      if (!queueCommand.text) {
        pushLocalNotice(`Usage: /queue ${queueCommand.kind} <message>`, "warning");
        return;
      }
      const modelCouncil = consumeModelCouncilArming();
      setQueuedOutbound((current) => [
        ...current,
        {
          id: `queue-${Date.now()}`,
          action: "send",
          sessionId: selection.selectedSessionId ?? undefined,
          content: queueCommand.text,
          attachments: pendingAttachments,
          createdAt: new Date().toISOString(),
          paused: queueCommand.kind === "collect",
          ...(modelCouncil ? { modelCouncil } : {}),
        },
      ]);
      setDraft("");
      setPendingAttachments([]);
      pushLocalNotice(
        queueCommand.kind === "collect" ? "Message collected in the queue." : "Follow-up queued for the next turn.",
        "success",
      );
      return;
    }

    const webMode = sessionData.prefs?.webMode ?? "auto";
    const researchModeActive = webMode === "quick" || webMode === "deep";
    const reviewModeActive = (sessionData.prefs?.orchestrationReviewDepth ?? "off") !== "off";
    const hasArmedPerTurnContext =
      Boolean(conversationContext.activeOutboundContext) ||
      externalSourceAttachments.selectedAttachmentIds.length > 0 ||
      pendingDocumentContextRefs.length > 0 ||
      knowledgeUrlDraft.trim().length > 0 ||
      Boolean(
        runVariables.pendingTemplateInvocation &&
        runVariables.pendingTemplateInvocation.resolvedContent.trim() === draft.trim(),
      );
    const shouldAutoGenerateImage =
      surfaceState.messageMode === "chat" &&
      planningMode !== "advisory" &&
      !researchModeActive &&
      !reviewModeActive &&
      !oneShotContext.modelCouncilEnabledRef.current &&
      !orchestration.editingTurnId &&
      pendingAttachments.length === 0 &&
      !hasArmedPerTurnContext &&
      detectImageGenerationIntent(draft);
    if (shouldAutoGenerateImage) {
      if (multimodal.imageBusy) {
        setFailedAutoImageRecovery({ prompt: draft, sessionId: selection.selectedSessionId });
        setUiError("Image generation is already running.", "image_generate");
        return;
      }
      if (!multimodal.imageGenerationAvailable) {
        setFailedAutoImageRecovery({ prompt: draft, sessionId: selection.selectedSessionId });
        setUiError("This looks like an image request, but no image generation route is available.", "image_generate");
        return;
      }
      const generated = await handleGenerateImage({
        clearDraftOnSuccess: true,
        trigger: "auto_send",
      });
      if (generated) {
        setFailedAutoImageRecovery(null);
        return;
      }
      setFailedAutoImageRecovery({ prompt: draft, sessionId: selection.selectedSessionId });
      return;
    }

    await sendDraftAsChat();
  }, [
    scope, access, caller, gateway,
    consumeModelCouncilArming,
    draft,
    orchestration.editingTurnId,
    conversationContext.activeOutboundContext,
    externalSourceAttachments.selectedAttachmentIds.length,
    handleGenerateImage,
    handleSteerMidTurn,
    multimodal.imageBusy,
    multimodal.imageGenerationAvailable,
    knowledgeUrlDraft,
    surfaceState.messageMode,
    openBtwSideChat,
    pendingAttachments,
    pendingDocumentContextRefs.length,
    runVariables.pendingTemplateInvocation,
    planningMode,
    profileDependentAdmissionBlockReason,
    sessionData.prefs?.orchestrationReviewDepth,
    sessionData.prefs?.webMode,
    pushLocalNotice,
    selection.selectedSessionId,
    sendDraftAsChat,
    setDraft,
    setPendingAttachments,
    setQueuedOutbound,
    setUiError,
    coordination.activeStreamRef,
    oneShotContext.modelCouncilEnabledRef,
    setFailedAutoImageRecovery,
    setFollowThreadOutput,
  ]);

  const handleSendRetainedPromptAsChat = useCallback(async () => {
    if (
      !errorState.failedAutoImageRecovery ||
      errorState.failedAutoImageRecovery.sessionId !== selection.selectedSessionId ||
      errorState.failedAutoImageRecovery.prompt !== draft
    ) {
      return;
    }
    setFailedAutoImageRecovery(null);
    setUiError(null);
    await sendDraftAsChat();
  }, [
    draft,
    errorState.failedAutoImageRecovery,
    selection.selectedSessionId,
    sendDraftAsChat,
    setUiError,
    setFailedAutoImageRecovery,
  ]);

  return { handleSendWithKnowledge, handleSendRetainedPromptAsChat };
}
