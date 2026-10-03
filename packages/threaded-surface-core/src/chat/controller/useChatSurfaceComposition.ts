import { isBackgroundChatUserInputPrompt } from "@goatcitadel/contracts";
import type { ChatAttachmentRecord, ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { controlAgenticRun, type AgenticRunTreeResponse } from "@goatcitadel/mission-control-shared/api/agentic";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import { pageCopy } from "@goatcitadel/mission-control-shared/content/copy";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useCallback, useEffect, useMemo } from "react";
import { type CoworkAgenticControlItem } from "../../cowork-view-model";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { describeChatUiError } from "../chat-error-copy";
import { buildSuggestionSyncKey } from "../chat-page-pure-helpers";
import { requiresBoundaryAcknowledgment } from "../mission-threaded-controller-helpers";
import { useChatCapabilityProfileInspection } from "../useChatCapabilityProfileInspection";
import { useChatDockWorkbenchController } from "../useChatDockWorkbenchController";
import { useChatRunPresentation } from "../useChatRunPresentation";
import { resolveOutboundDraftContent } from "../useChatSurfaceOrchestration";
import { useMissionControlSurfaceState } from "../useMissionControlSurfaceState";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatOneShotContext } from "./useChatOneShotContext";
import { useChatOutboundComposition } from "./useChatOutboundComposition";
import { useChatSessionComposition } from "./useChatSessionComposition";
import { useChatSessionSelection } from "./useChatSessionSelection";
import { useChatSubmissionComposition } from "./useChatSubmissionComposition";

type Input = {
  session: Pick<
    ReturnType<typeof useChatSessionComposition>,
    | "sessionData"
    | "threadController"
    | "resolveAgenticRunTree"
    | "externalControl"
    | "externalSourceAttachments"
    | "documentContext"
  >;
  lockSurface: NonNullable<MissionThreadedControllerHostProps["lockSurface"]>;
  surface: MissionThreadedControllerHostProps["surface"];
  selectedTurnId: string | null;
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedProjectId" | "selectedSessionId">;
  execution: Pick<
    ReturnType<typeof useChatOutboundComposition>,
    "contextActions" | "setCapabilitySuggestions" | "setSpecialistSuggestions" | "outbound"
  >;
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  coordination: Pick<
    ReturnType<typeof useChatControllerCoordination>,
    "lastCapabilitySuggestionSyncKeyRef" | "lastSpecialistSuggestionSyncKeyRef"
  >;
  workbenchRequested: boolean;
  localNotices: ChatThreadNotice[];
  agenticRunTree: AgenticRunTreeResponse | null;
  setAgenticControlStatus: React.Dispatch<React.SetStateAction<string | null>>;
  setAgenticControlPending: React.Dispatch<React.SetStateAction<string | null>>;
  setAgenticRunTree: React.Dispatch<React.SetStateAction<AgenticRunTreeResponse | null>>;
  pushLocalNotice: ReturnType<typeof useChatNoticesAndPresetRefresh>["pushLocalNotice"];
  compactSurfaceLayout: ReturnType<typeof useMediaQuery>;
  sessionRailOpen: boolean;
  setSessionRailOpen: React.Dispatch<React.SetStateAction<boolean>>;
  submission: Pick<
    ReturnType<typeof useChatSubmissionComposition>,
    | "providerRouting"
    | "currentRoutePreflight"
    | "routePreflight"
    | "orchestration"
    | "currentRouteBoundaryAcknowledged"
  >;
  workTrust: MissionThreadedControllerHostProps["workTrust"];
  workspaceName: NonNullable<MissionThreadedControllerHostProps["workspaceName"]>;
  gatewayStatus: MissionThreadedControllerHostProps["gatewayStatus"];
  approvalsCount: NonNullable<MissionThreadedControllerHostProps["approvalsCount"]>;
  draft: string;
  pendingAttachments: ChatAttachmentRecord[];
  sending: boolean;
  oneShotContext: Pick<ReturnType<typeof useChatOneShotContext>, "modelCouncilEnabled" | "workspaceSnapshotRequest">;
};

/** Composes display, workbench and admission evidence without changing runtime authority. */
export function useChatSurfaceComposition({
  session,
  lockSurface,
  surface,
  selectedTurnId,
  selection,
  execution,
  activeGeneratedArtifact,
  workspaceId,
  coordination,
  workbenchRequested,
  localNotices,
  agenticRunTree,
  setAgenticControlStatus,
  setAgenticControlPending,
  setAgenticRunTree,
  pushLocalNotice,
  compactSurfaceLayout,
  sessionRailOpen,
  setSessionRailOpen,
  submission,
  workTrust,
  workspaceName,
  gatewayStatus,
  approvalsCount,
  draft,
  pendingAttachments,
  sending,
  oneShotContext,
}: Input) {
  const { setCapabilitySuggestions } = execution;
  const { setSpecialistSuggestions } = execution;
  const { resolveAgenticRunTree } = session;

  const planningMode = session.sessionData.prefs?.planningMode ?? "off";
  const proactiveSuggestionCount = useMemo(
    () => session.sessionData.proactiveRuns.filter((run) => run.status === "suggested").length,
    [session.sessionData.proactiveRuns],
  );
  const surfaceProjectSummaries = useMemo(
    () => (session.sessionData.projects?.items ?? []).map((item) => ({ projectId: item.projectId, name: item.name })),
    [session.sessionData.projects?.items],
  );
  const activeSpecialistCandidateCount = useMemo(
    () => session.sessionData.specialistCandidates.filter((item) => item.status !== "retired").length,
    [session.sessionData.specialistCandidates],
  );
  const surfaceState = useMissionControlSurfaceState({
    lockSurface,
    surface,
    prefs: session.sessionData.prefs,
    selectedTurnId,
    thread: session.sessionData.thread,
    selectedSession: session.threadController.selectedSession,
    selectedProjectId: selection.selectedProjectId,
    projects: surfaceProjectSummaries,
    projectsCount: session.sessionData.projects?.items.length ?? 0,
    missionSessionCount: session.threadController.missionSessions.length,
    externalSessionCount: session.threadController.externalSessions.length,
    boundMissionSessionCount: session.threadController.boundMissionSessionCount,
    planningMode,
    chatSubtitle: pageCopy.chat.subtitle ?? "Fast conversation, drafting, and lightweight help.",
    capabilitySuggestionCount: execution.contextActions.capabilitySuggestions.length,
    specialistSuggestionCount: execution.contextActions.specialistSuggestions.length,
    specialistCandidateCount: activeSpecialistCandidateCount,
    proactiveSuggestionCount,
    hasDelegationSuggestion: Boolean(execution.contextActions.delegationSuggestion),
    learnedMemoryCount: session.sessionData.learnedMemory.length,
    hasGeneratedArtifact: Boolean(activeGeneratedArtifact),
  });
  const capabilityProfileInspection = useChatCapabilityProfileInspection({
    sessionId: selection.selectedSessionId,
    workspaceId: session.threadController.selectedSession?.workspaceId ?? workspaceId,
    turn: surfaceState.selectedTurn,
  });

  useEffect(() => {
    const capabilitySuggestions = surfaceState.selectedTurn?.trace.capabilityUpgradeSuggestions ?? [];
    const specialistSuggestions = surfaceState.selectedTurn?.trace.specialistCandidateSuggestions ?? [];
    const capabilitySyncKey = buildSuggestionSyncKey(surfaceState.selectedTurn?.turnId, capabilitySuggestions);
    const specialistSyncKey = buildSuggestionSyncKey(surfaceState.selectedTurn?.turnId, specialistSuggestions);

    if (coordination.lastCapabilitySuggestionSyncKeyRef.current !== capabilitySyncKey) {
      coordination.lastCapabilitySuggestionSyncKeyRef.current = capabilitySyncKey;
      setCapabilitySuggestions(capabilitySuggestions);
    }

    if (coordination.lastSpecialistSuggestionSyncKeyRef.current !== specialistSyncKey) {
      coordination.lastSpecialistSuggestionSyncKeyRef.current = specialistSyncKey;
      setSpecialistSuggestions(specialistSuggestions);
    }
  }, [
    surfaceState.selectedTurn,
    setCapabilitySuggestions,
    setSpecialistSuggestions,
    coordination.lastCapabilitySuggestionSyncKeyRef,
    coordination.lastSpecialistSuggestionSyncKeyRef,
  ]);
  const workbenchController = useChatDockWorkbenchController({
    workbenchEnabled: workbenchRequested,
    messageMode: surfaceState.messageMode,
    selectedSessionId: selection.selectedSessionId,
    selectedSession: session.threadController.selectedSession,
    selectedTurn: surfaceState.selectedTurn,
    thread: session.sessionData.thread,
    messages: session.threadController.messages,
    localNotices,
    dockSectionOrder: surfaceState.dockSectionOrder,
  });
  const { refreshOrchestrationRun } = workbenchController;
  const { setDockOpen } = workbenchController;

  const handleAgenticControl = useCallback(
    async (control: CoworkAgenticControlItem) => {
      if (!agenticRunTree?.runId || !control.enabled) {
        return;
      }
      if (!Number.isInteger(agenticRunTree.taskRevision) || Number(agenticRunTree.taskRevision) < 1) {
        setAgenticControlStatus("Canonical task revision is unavailable. Refresh the run before applying a control.");
        return;
      }
      setAgenticControlPending(control.action);
      setAgenticControlStatus(null);
      try {
        const response = await controlAgenticRun(
          agenticRunTree.runId,
          {
            action: control.action,
            expectedRevision: agenticRunTree.taskRevision!,
            controlId: `${agenticRunTree.runId}:${control.action}:${Date.now()}`,
            reason: "Mission Control operator action.",
          },
          { workspaceId },
        );
        const refreshedTree = await resolveAgenticRunTree();
        setAgenticRunTree(refreshedTree);
        await refreshOrchestrationRun();
        setAgenticControlStatus(response.message);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          const refreshedTree = await resolveAgenticRunTree().catch(() => null);
          setAgenticRunTree(refreshedTree);
          const message =
            "The run changed. Canonical state was refreshed; review it, then retry the control explicitly.";
          setAgenticControlStatus(message);
          pushLocalNotice(message, "warning");
          return;
        }
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = describeChatUiError(rawMessage, "refresh")?.summary ?? rawMessage;
        setAgenticControlStatus(message);
        pushLocalNotice(message, "warning");
      } finally {
        setAgenticControlPending(null);
      }
    },
    [
      agenticRunTree?.runId,
      agenticRunTree?.taskRevision,
      pushLocalNotice,
      refreshOrchestrationRun,
      resolveAgenticRunTree,
      workspaceId,
      setAgenticControlPending,
      setAgenticControlStatus,
      setAgenticRunTree,
    ],
  );
  useEffect(() => {
    if (!compactSurfaceLayout && sessionRailOpen) {
      setSessionRailOpen(false);
    }
  }, [compactSurfaceLayout, sessionRailOpen, setSessionRailOpen]);

  useEffect(() => {
    if (compactSurfaceLayout && sessionRailOpen && workbenchController.dockOpen) {
      setDockOpen(false);
    }
  }, [compactSurfaceLayout, workbenchController.dockOpen, sessionRailOpen, setDockOpen]);
  const runPresentation = useChatRunPresentation({
    providerOptions: submission.providerRouting.providerOptions,
    selectedProviderLabel: submission.providerRouting.selectedProviderLabel,
    selectedModelLabel: submission.providerRouting.selectedModelLabel,
    requestedProviderLabel: submission.providerRouting.requestedProviderLabel,
    requestedModelLabel: submission.providerRouting.requestedModelLabel,
    selectionSourceLabel: submission.providerRouting.selectionSourceLabel,
    runtimeSummary: submission.providerRouting.runtimeSummary,
    runtimeTone: submission.providerRouting.runtimeTone,
    workbenchController,
    currentRoutePreflight: submission.currentRoutePreflight,
    activeDelegationRun: execution.contextActions.activeDelegationRun,
    selectedTurn: surfaceState.selectedTurn,
    selectedSessionId: selection.selectedSessionId,
    pushLocalNotice: pushLocalNotice,
    agenticRunTree,
    workTrust,
    workspaceName,
    gatewayStatus,
    approvalsCount,
    activeModePreset: surfaceState.activeModePreset,
  });
  const routeBlocked = submission.currentRoutePreflight?.blockedReason ?? undefined;
  const routeBoundaryAckRequired = requiresBoundaryAcknowledgment(submission.currentRoutePreflight);
  const routePreflightPending =
    Boolean(selection.selectedSessionId) && submission.routePreflight.loading && !submission.currentRoutePreflight;
  const routePreflightUnavailable = Boolean(selection.selectedSessionId) && Boolean(submission.routePreflight.error);
  const historicalTargetIsSelected =
    session.sessionData.historicalWindowTarget?.workspaceId === workspaceId &&
    session.sessionData.historicalWindowTarget.sessionId === selection.selectedSessionId;
  const historicalModeActive =
    historicalTargetIsSelected &&
    Boolean(
      session.sessionData.historicalWindow ||
      session.sessionData.historicalWindowLoading ||
      session.sessionData.historicalWindowError,
    );
  const canSend =
    Boolean(
      resolveOutboundDraftContent(
        draft,
        pendingAttachments.length,
        submission.orchestration.editingTurnId ? "edit" : "send",
      ),
    ) &&
    !sending &&
    !execution.outbound.pendingApproval &&
    !(execution.outbound.pendingUserInput && !isBackgroundChatUserInputPrompt(execution.outbound.pendingUserInput)) &&
    !routeBlocked &&
    !routePreflightPending &&
    !routePreflightUnavailable &&
    !historicalModeActive &&
    // HX-411: external control owns the mutation generation → operator send fails closed.
    !session.externalControl.sessionControlSendLocked &&
    !oneShotContext.modelCouncilEnabled &&
    !oneShotContext.workspaceSnapshotRequest &&
    session.externalSourceAttachments.selectedAttachmentIds.length === 0 &&
    session.documentContext.pendingDocumentContextRefs.length === 0 &&
    (!routeBoundaryAckRequired || submission.currentRouteBoundaryAcknowledged);
  const profileDependentAdmissionBlockReason = oneShotContext.modelCouncilEnabled
    ? "Model council is temporarily unavailable. Turn Council off to send."
    : oneShotContext.workspaceSnapshotRequest
      ? "Workspace snapshots are temporarily unavailable. Remove the snapshot to send."
      : session.externalSourceAttachments.selectedAttachmentIds.length > 0
        ? "Routed external sources are temporarily unavailable. Clear the source selection to send."
        : session.documentContext.pendingDocumentContextRefs.length > 0
          ? "Routed documents are temporarily unavailable. Remove the document selection to send."
          : undefined;
  const blockHistoricalMutation = useCallback(() => {
    if (!historicalModeActive) return false;
    pushLocalNotice("Return to the latest conversation before changing or sending anything.", "warning");
    return true;
  }, [historicalModeActive, pushLocalNotice]);

  return {
    surfaceState,
    workbenchController,
    setDockOpen,
    planningMode,
    profileDependentAdmissionBlockReason,
    historicalModeActive,
    runPresentation,
    blockHistoricalMutation,
    historicalTargetIsSelected,
    capabilityProfileInspection,
    routeBoundaryAckRequired,
    canSend,
    handleAgenticControl,
    proactiveSuggestionCount,
  } as const;
}
