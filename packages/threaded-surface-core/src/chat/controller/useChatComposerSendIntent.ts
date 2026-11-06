import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayAccessRevision, getGatewayCallerScope, getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
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
    | "consumeModelCouncilArming"
    | "modelCouncilEnabledRef"
    | "consumeWorkspaceSnapshotRequest"
    | "workspaceSnapshotRequestRef"
  >;
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId"> & {
    selectedSessionRevisionRef?: { readonly current: number };
  };
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
  > & { imageRouteLabel?: string | null };
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
  const access = getGatewayAccessRevision();
  const caller = getGatewayCallerScope();
  const gateway = getGatewayApiBaseUrl();
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
  const { consumeWorkspaceSnapshotRequest } = oneShotContext;
  const { setQueuedOutbound } = orchestration;
  const { setFailedAutoImageRecovery } = errorState;
  const { handleGenerateImage } = multimodal;

  type AutoImageAttempt = { generation: number; base: string; revision: number; selectedId: string | null;
    prompt: string; destination?: string; selectionSeen: boolean; revoked: boolean; running: boolean };
  const autoRevision = selection.selectedSessionRevisionRef?.current ?? 0;
  const autoBase = JSON.stringify([workspaceId, gateway, access, getGatewayCallerScopeRevision(), multimodal.imageRouteLabel]);
  const autoKey = JSON.stringify([autoBase, selection.selectedSessionId, autoRevision]);
  const autoOwnerRef = useRef({ key: autoKey, generation: 0 });
  const autoAttemptRef = useRef<AutoImageAttempt | null>(null);
  const autoMountedRef = useRef(true);
  const [, refreshAutoMountGeneration] = useState(0);
  const autoLatestRef = useRef({ draft, selectedId: selection.selectedSessionId, revisionRef: selection.selectedSessionRevisionRef });
  autoLatestRef.current = { draft, selectedId: selection.selectedSessionId, revisionRef: selection.selectedSessionRevisionRef };
  if (autoOwnerRef.current.key !== autoKey) {
    const generation = autoOwnerRef.current.generation + 1;
    const attempt = autoAttemptRef.current;
    if (attempt) {
      const waitingForOwnSelection = Boolean(attempt.destination && !attempt.selectionSeen &&
        selection.selectedSessionId === null && autoRevision === attempt.revision);
      const allowed = !attempt.revoked && attempt.base === autoBase && (waitingForOwnSelection ||
        (selection.selectedSessionId === (attempt.destination ?? attempt.selectedId) &&
          autoRevision === attempt.revision + (attempt.destination ? 1 : 0)));
      if (allowed) {
        attempt.generation = generation;
        if (!waitingForOwnSelection && attempt.destination) attempt.selectionSeen = true;
      } else attempt.revoked = true;
    }
    autoOwnerRef.current = { key: autoKey, generation };
  }
  const autoGeneration = autoOwnerRef.current.generation;
  const renderedAutoGenerationRef = useRef(autoGeneration);
  renderedAutoGenerationRef.current = autoGeneration;
  const currentAutoAttempt = useCallback((attempt: AutoImageAttempt) => {
    const revision = autoLatestRef.current.revisionRef?.current ?? autoRevision;
    return autoMountedRef.current && autoAttemptRef.current === attempt && !attempt.revoked &&
      attempt.generation === autoOwnerRef.current.generation && attempt.base === JSON.stringify([workspaceId,
        getGatewayApiBaseUrl(), getGatewayAccessRevision(), getGatewayCallerScopeRevision(), multimodal.imageRouteLabel]) &&
      (revision === attempt.revision + (attempt.destination ? 1 : 0) ||
        Boolean(attempt.destination && !attempt.selectionSeen && revision === attempt.revision));
  }, [autoRevision, multimodal.imageRouteLabel, workspaceId]);
  useEffect(() => {
    autoMountedRef.current = true;
    if (autoOwnerRef.current.generation !== renderedAutoGenerationRef.current) refreshAutoMountGeneration((value) => value + 1);
    return () => { autoMountedRef.current = false; autoOwnerRef.current.generation += 1; if (autoAttemptRef.current) autoAttemptRef.current.revoked = true; };
  }, []);

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
      const isCurrent = () =>
        scopeRef.current === scope &&
        getGatewayAccessRevision() === access &&
        getGatewayCallerScope() === caller &&
        getGatewayApiBaseUrl() === gateway;
      if (!isCurrent()) return;
      // Consume only the submitted command synchronously. Child creation/inline
      // side sends may finish after the operator has authored a new parent draft.
      setDraft((current) => (isCurrent() && current === draft ? "" : current));
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
      // Freeze an armed snapshot with the queued send, as handleSend does, so it cannot leak into a later turn.
      const workspaceSnapshot = consumeWorkspaceSnapshotRequest();
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
          ...(workspaceSnapshot ? { workspaceSnapshot } : {}),
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
      !oneShotContext.workspaceSnapshotRequestRef.current &&
      !orchestration.editingTurnId &&
      pendingAttachments.length === 0 &&
      !hasArmedPerTurnContext &&
      detectImageGenerationIntent(draft);
    if (shouldAutoGenerateImage) {
      if (!autoMountedRef.current || autoBase !== JSON.stringify([workspaceId, getGatewayApiBaseUrl(),
        getGatewayAccessRevision(), getGatewayCallerScopeRevision(), multimodal.imageRouteLabel]) ||
        autoOwnerRef.current.generation !== autoGeneration ||
        (selection.selectedSessionRevisionRef?.current ?? autoRevision) !== autoRevision) return;
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
      if (autoAttemptRef.current?.running && currentAutoAttempt(autoAttemptRef.current)) return;
      const attempt: AutoImageAttempt = { generation: autoGeneration, base: autoBase, revision: autoRevision,
        selectedId: selection.selectedSessionId, prompt: draft, selectionSeen: false, revoked: false, running: true };
      autoAttemptRef.current = attempt;
      const generated = await handleGenerateImage({
        clearDraftOnSuccess: true,
        trigger: "auto_send",
        ...(attempt.selectedId === null && selection.selectedSessionRevisionRef ? { onCreatedSession: (created: { workspaceId: string; sessionId: string }) => {
          if (!attempt.running || !currentAutoAttempt(attempt) || attempt.destination || attempt.selectedId !== null ||
            !selection.selectedSessionRevisionRef || created.workspaceId !== workspaceId || !created.sessionId.trim() ||
            autoLatestRef.current.draft !== attempt.prompt) { attempt.revoked = true; return false; }
          attempt.destination = created.sessionId;
          return true;
        } } : {}),
      });
      attempt.running = false;
      if (!currentAutoAttempt(attempt)) return;
      if (generated) { setFailedAutoImageRecovery(null); return; }
      if (autoLatestRef.current.draft !== attempt.prompt) return;
      const recoverySessionId = attempt.destination ?? attempt.selectedId;
      if (autoLatestRef.current.selectedId !== recoverySessionId ||
        (selection.selectedSessionRevisionRef?.current ?? autoRevision) !== attempt.revision + (attempt.destination ? 1 : 0)) return;
      setFailedAutoImageRecovery({ prompt: attempt.prompt, sessionId: recoverySessionId });
      return;
    }

    await sendDraftAsChat();
  }, [
    autoGeneration, autoRevision, autoBase, workspaceId, selection.selectedSessionRevisionRef,
    currentAutoAttempt, multimodal.imageRouteLabel,
    scope,
    access,
    caller,
    gateway,
    consumeModelCouncilArming,
    consumeWorkspaceSnapshotRequest,
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
    oneShotContext.workspaceSnapshotRequestRef,
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
