import { isBackgroundChatUserInputPrompt } from "@goatcitadel/contracts";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { setDevDiagnosticsActiveChatSession } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { useEffect, useRef } from "react";
import { useChatApprovalController } from "../useChatApprovalController";
import { useChatContextActions } from "../useChatContextActions";
import { useChatOutboundExecution } from "../useChatOutboundExecution";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatErrorState } from "./useChatErrorState";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatOneShotContext } from "./useChatOneShotContext";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionComposition } from "./useChatSessionComposition";
import { useChatSessionSelection } from "./useChatSessionSelection";
import { useChatStreamPreferences } from "./useChatStreamPreferences";
import { useChatSubmissionComposition } from "./useChatSubmissionComposition";

type Input = {
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  session: Pick<
    ReturnType<typeof useChatSessionComposition>,
    | "threadController"
    | "sessionData"
    | "loadSidebar"
    | "refreshChatSessionAggregate"
    | "sessionControls"
    | "loadSessionCoreState"
    | "handleOutboundExternalContextSent"
    | "setPendingDocumentContextRefs"
    | "runVariables"
  >;
  selectedTurnId: string | null;
  draft: string;
  submission: Pick<
    ReturnType<typeof useChatSubmissionComposition>,
    | "providerRouting"
    | "executionSurfaceMode"
    | "orchestration"
    | "outboundSurfaceMode"
    | "commands"
    | "ensureFreshPreflight"
    | "acknowledgedRoutePreflightHashes"
    | "operatorPromptSettersRef"
  >;
  oneShotContext: Pick<ReturnType<typeof useChatOneShotContext>, "fullWebAccess">;
  sending: boolean;
  streamPreferences: Pick<ReturnType<typeof useChatStreamPreferences>, "streamEnabled" | "visualStreamMode">;
  setUiError: ReturnType<typeof useChatScopedErrors>["setUiError"];
  setSending: React.Dispatch<React.SetStateAction<boolean>>;
  pushLocalNotice: ReturnType<typeof useChatNoticesAndPresetRefresh>["pushLocalNotice"];
  coordination: Pick<
    ReturnType<typeof useChatControllerCoordination>,
    | "lastLocalPrefMutationAtRef"
    | "executeOutboundItemRef"
    | "tryBeginOutboundExecutionRef"
    | "activeStreamRef"
    | "applyFetchedThreadRef"
    | "messageMutationVersionRef"
  >;
  errorState: Pick<ReturnType<typeof useChatErrorState>, "error" | "errorSource">;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  restoreWorkspaceSnapshotRequest: ReturnType<typeof useChatOneShotContext>["restoreWorkspaceSnapshotRequest"];
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  setLocalNotices: React.Dispatch<React.SetStateAction<ChatThreadNotice[]>>;
};

/** Composes outbound and approval owners, publishing execution and blocker refs before restoration runs. */
export function useChatOutboundComposition({
  selection,
  session,
  selectedTurnId,
  draft,
  submission,
  oneShotContext,
  sending,
  streamPreferences,
  setUiError,
  setSending,
  pushLocalNotice,
  coordination,
  errorState,
  setDraft,
  setPendingAttachments,
  restoreWorkspaceSnapshotRequest,
  setSelectedTurnId,
  setLocalNotices,
}: Input) {
  const { ensureFreshPreflight } = submission;
  const { handleOutboundExternalContextSent } = session;
  const { setPendingDocumentContextRefs } = session;

  const runtimeBlockerActiveRef = useRef(false);
  const contextActions = useChatContextActions({
    selectedSessionId: selection.selectedSessionId,
    selectedSession: session.threadController.selectedSession,
    selectedTurnId,
    thread: session.sessionData.thread,
    draft,
    messages: session.threadController.messages,
    prefs: session.sessionData.prefs,
    selectedProviderId: submission.providerRouting.selectedProviderId,
    selectedModel: submission.providerRouting.selectedModel,
    surfaceMode: submission.executionSurfaceMode,
    fullWebAccess: oneShotContext.fullWebAccess,
    sending,
    streamEnabled: streamPreferences.streamEnabled,
    codeModeNeedsProjectBinding: false,
    loadSidebar: session.loadSidebar,
    refreshSessionAggregate: session.refreshChatSessionAggregate,
    ensureSession: session.sessionControls.ensureSession,
    setError: setUiError,
    setSending,
    setPrefs: session.sessionData.setPrefs,
    setProactiveStatus: session.sessionData.setProactiveStatus,
    setProactiveRuns: session.sessionData.setProactiveRuns,
    learnedMemory: session.sessionData.learnedMemory,
    setLearnedMemory: session.sessionData.setLearnedMemory,
    specialistCandidates: session.sessionData.specialistCandidates,
    setSpecialistCandidates: session.sessionData.setSpecialistCandidates,
    setInstalledSkills: session.sessionData.setInstalledSkills,
    setMcpServers: session.sessionData.setMcpServers,
    setMcpTemplates: session.sessionData.setMcpTemplates,
    pushLocalNotice: pushLocalNotice,
    lastLocalPrefMutationAtRef: coordination.lastLocalPrefMutationAtRef,
    runtimeBlockerActiveRef,
    executeOutboundItemRef: coordination.executeOutboundItemRef,
    tryBeginOutboundExecutionRef: coordination.tryBeginOutboundExecutionRef,
    setQueuedOutbound: submission.orchestration.setQueuedOutbound,
  });
  const { setCapabilitySuggestions } = contextActions;
  const { setSpecialistSuggestions } = contextActions;

  const outbound = useChatOutboundExecution({
    sessionConfig: {
      surfaceMode: submission.outboundSurfaceMode,
      selectedSessionId: selection.selectedSessionId,
      selectedSession: session.threadController.selectedSession,
      prefs: session.sessionData.prefs,
      fullWebAccess: oneShotContext.fullWebAccess,
      selectedProviderId: submission.providerRouting.selectedProviderId,
      selectedModel: submission.providerRouting.selectedModel,
    },
    streamConfig: {
      streamEnabled: streamPreferences.streamEnabled,
      visualStreamMode: streamPreferences.visualStreamMode,
      activeStreamRef: coordination.activeStreamRef,
    },
    stateConfig: {
      sending,
      error: errorState.error,
      errorSource: errorState.errorSource,
      queuedOutbound: submission.orchestration.queuedOutbound,
      thread: session.sessionData.thread,
      messages: session.threadController.messages,
    },
    stateSetters: {
      setThread: session.sessionData.setThread,
      setError: setUiError,
      setSending,
      setDraft,
      setPendingAttachments,
      setEditingTurnId: submission.orchestration.setEditingTurnId,
      setCapabilitySuggestions: setCapabilitySuggestions,
      setSpecialistSuggestions: setSpecialistSuggestions,
    },
    operations: {
      loadSidebar: session.loadSidebar,
      loadSessionCoreState: session.loadSessionCoreState,
      ensureSession: session.sessionControls.ensureSession,
      pushLocalNotice: pushLocalNotice,
      handleCommandExecution: submission.commands.handleCommandExecution,
    },
    refs: {
      executeOutboundItemRef: coordination.executeOutboundItemRef,
      tryBeginOutboundExecutionRef: coordination.tryBeginOutboundExecutionRef,
      applyFetchedThreadRef: coordination.applyFetchedThreadRef,
      messageMutationVersionRef: coordination.messageMutationVersionRef,
    },
    routing: {
      ensureFreshRoutePreflight: (next) => ensureFreshPreflight(next),
      isRoutePreflightAcknowledged: (hash) => Boolean(submission.acknowledgedRoutePreflightHashes[hash]),
    },
    externalContext: {
      onExternalContextSent: (item) => {
        handleOutboundExternalContextSent(item);
        const sentDocuments = new Set(
          (item.externalContextRefs ?? [])
            .filter((ref) => ref.kind === "personal_note" || ref.kind === "generated_artifact")
            .map((ref) => `${ref.kind}:${ref.ref}`),
        );
        if (sentDocuments.size > 0) {
          setPendingDocumentContextRefs((current) =>
            current.filter((ref) => !sentDocuments.has(`${ref.kind}:${ref.ref}`)),
          );
        }
      },
      onTemplateInvocationSent: session.runVariables.clearPendingTemplateInvocation,
      onWorkspaceSnapshotFailed: (item) => restoreWorkspaceSnapshotRequest(item.workspaceSnapshot),
    },
  });
  submission.operatorPromptSettersRef.current = {
    setPendingApproval: outbound.setPendingApproval,
    setPendingUserInput: outbound.setPendingUserInput,
  };
  runtimeBlockerActiveRef.current = Boolean(
    outbound.pendingApproval ||
    (outbound.pendingUserInput && !isBackgroundChatUserInputPrompt(outbound.pendingUserInput)),
  );

  useChatApprovalController({
    selectedSessionId: selection.selectedSessionId,
    activeStreamRef: coordination.activeStreamRef,
    setPendingAttachments,
    setEditingTurnId: submission.orchestration.setEditingTurnId,
    setPendingApproval: outbound.setPendingApproval,
    setPendingUserInput: outbound.setPendingUserInput,
    setDelegationSuggestion: contextActions.setDelegationSuggestion,
    setCapabilitySuggestions: setCapabilitySuggestions,
    setSpecialistSuggestions: setSpecialistSuggestions,
    setSelectedTurnId,
    setLocalNotices,
    pushLocalNotice: pushLocalNotice,
  });

  useEffect(() => {
    setDevDiagnosticsActiveChatSession(selection.selectedSessionId ?? undefined);
  }, [selection.selectedSessionId]);

  return { contextActions, setCapabilitySuggestions, setSpecialistSuggestions, outbound };
}
