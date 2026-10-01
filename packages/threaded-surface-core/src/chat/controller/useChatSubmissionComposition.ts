import type { ChatAttachmentRecord, ChatMode } from "@goatcitadel/contracts";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import { resolveOutboundSurfaceMode } from "../../pure-helpers";
import { isLocalChatStatusCommand, isLocalChatTimerCommand } from "../chat-page-pure-helpers";
import { resolveExecutionRoutePrefs } from "../mission-threaded-controller-helpers";
import { useBtwSideChatController } from "../useBtwSideChatController";
import { useChatChangePlanState } from "../useChatChangePlanState";
import { abortActiveChatStream } from "../useChatOutboundExecution";
import { useChatProviderRoutingController } from "../useChatProviderRoutingController";
import { useChatRoutePreflight } from "../useChatRoutePreflight";
import { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { formatWorkProviderModelSummary } from "../work-trust";
import { useChatCommandExecution } from "./useChatCommandExecution";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatOneShotContext } from "./useChatOneShotContext";
import { useChatPaletteAndQueuePreferences } from "./useChatPaletteAndQueuePreferences";
import { useChatPresetCatalogState } from "./useChatPresetCatalogState";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionComposition } from "./useChatSessionComposition";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  draft: string;
  pendingAttachments: ChatAttachmentRecord[];
  session: Pick<
    ReturnType<typeof useChatSessionComposition>,
    | "conversationContext"
    | "sessionData"
    | "captureOutboundExternalContextRefs"
    | "documentContext"
    | "runVariables"
    | "sessionStatusEnabled"
    | "refresh"
    | "chatTimersEnabled"
    | "openChatTimerPanel"
    | "threadController"
    | "externalSourceAttachments"
    | "typedRunVariablesEnabled"
    | "documentEditingEnabled"
    | "sessionControls"
  >;
  selection: ReturnType<typeof useChatSessionSelection>;
  sending: boolean;
  coordination: ReturnType<typeof useChatControllerCoordination>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  setUiError: ReturnType<typeof useChatScopedErrors>["setUiError"];
  oneShotContext: ReturnType<typeof useChatOneShotContext>;
  providerCatalog: Pick<
    ReturnType<typeof useProviderModelCatalog>,
    "config" | "providers" | "getCachedModels" | "loadModelsForProvider"
  >;
  composerPaletteGlobalOpen: boolean;
  composerPaletteQuery: string;
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  presetCatalog: ReturnType<typeof useChatPresetCatalogState>;
  selectedTurnId: string | null;
  setComposerPaletteGlobalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerPaletteQuery: React.Dispatch<React.SetStateAction<string>>;
  lockSurface: NonNullable<MissionThreadedControllerHostProps["lockSurface"]>;
  surface: MissionThreadedControllerHostProps["surface"];
  pushLocalNotice: ReturnType<typeof useChatNoticesAndPresetRefresh>["pushLocalNotice"];
  onWorkTrustSummaryChange: MissionThreadedControllerHostProps["onWorkTrustSummaryChange"];
  notices: ReturnType<typeof useChatNoticesAndPresetRefresh>;
  scopedErrors: ReturnType<typeof useChatScopedErrors>;
  changePlanState: ReturnType<typeof useChatChangePlanState>;
};

/** Composes queue admission, routing, preflight and local commands; preserves render-time preference publication. */
export function useChatSubmissionComposition({
  draft,
  pendingAttachments,
  session,
  selection,
  sending,
  coordination,
  setDraft,
  setPendingAttachments,
  setUiError,
  oneShotContext,
  providerCatalog,
  composerPaletteGlobalOpen,
  composerPaletteQuery,
  workspaceId,
  presetCatalog,
  selectedTurnId,
  setComposerPaletteGlobalOpen,
  setComposerPaletteQuery,
  lockSurface,
  surface,
  pushLocalNotice,
  onWorkTrustSummaryChange,
  notices,
  scopedErrors,
  changePlanState,
}: Input) {
  const { captureOutboundExternalContextRefs } = session;
  const { refresh } = session;
  const { openChatTimerPanel } = session;

  const operatorPromptSettersRef = useRef<{
    setPendingApproval: (value: null) => void;
    setPendingUserInput: (value: null) => void;
  } | null>(null);
  const orchestration = useChatSurfaceOrchestration({
    draft,
    pendingAttachments,
    outboundContext: session.conversationContext.activeOutboundContext,
    selectedSessionId: selection.selectedSessionId,
    thread: session.sessionData.thread,
    sending,
    composerRef: coordination.composerRef,
    activeStreamRef: coordination.activeStreamRef,
    tryBeginOutboundExecutionRef: coordination.tryBeginOutboundExecutionRef,
    executeOutboundItemRef: coordination.executeOutboundItemRef,
    pushLocalNoticeRef: coordination.pushLocalNoticeRef,
    setDraft,
    setPendingAttachments,
    setPendingApproval: (value) => operatorPromptSettersRef.current?.setPendingApproval(value),
    setPendingUserInput: (value) => operatorPromptSettersRef.current?.setPendingUserInput(value),
    setError: setUiError,
    onOutboundContextConsumed: session.conversationContext.handleOutboundContextConsumed,
    consumeModelCouncilArming: oneShotContext.consumeModelCouncilArming,
    captureOutboundRequestPrefs: () => coordination.outboundRequestPrefsSnapshotRef.current,
    captureOutboundExternalContextRefs: () => [
      ...captureOutboundExternalContextRefs(),
      ...session.documentContext.pendingDocumentContextRefs.map((ref) => ({ ...ref })),
    ],
    captureOutboundTemplateInvocation: () => {
      if (
        !session.runVariables.pendingTemplateInvocation ||
        session.runVariables.pendingTemplateInvocation.resolvedContent.trim() !== draft.trim()
      ) {
        return undefined;
      }
      return session.runVariables.pendingTemplateInvocation.invocation;
    },
    consumeWorkspaceSnapshotRequest: oneShotContext.consumeWorkspaceSnapshotRequest,
    loadSessionCoreStateRef: coordination.loadSessionCoreStateRef,
    abortActiveChatStream,
  });
  const composerSendHandlerRef = useRef<() => Promise<void>>(orchestration.handleSend);

  const handleComposerSend = useCallback(() => {
    // Fail closed: an external controller owns this session's mutation authority.
    // The server also rejects this send; the UI must never present a send that 403s.
    if (coordination.sessionControlSendLockedRef.current) {
      coordination.pushLocalNoticeRef.current(
        "This session is controlled by an external client. Revoke or take over before sending.",
        "warning",
      );
      return Promise.resolve();
    }
    if (session.sessionStatusEnabled && selection.selectedSessionId && isLocalChatStatusCommand(draft)) {
      setDraft("");
      void refresh();
      return Promise.resolve();
    }
    if (session.chatTimersEnabled && selection.selectedSessionId && isLocalChatTimerCommand(draft)) {
      setDraft("");
      openChatTimerPanel();
      return Promise.resolve();
    }
    return composerSendHandlerRef.current();
  }, [
    session.chatTimersEnabled,
    draft,
    openChatTimerPanel,
    refresh,
    selection.selectedSessionId,
    session.sessionStatusEnabled,
    coordination.pushLocalNoticeRef,
    coordination.sessionControlSendLockedRef,
    setDraft,
  ]);

  useEffect(() => {
    coordination.queuedOutboundSetterRef.current = orchestration.setQueuedOutbound;
  }, [orchestration.setQueuedOutbound, coordination.queuedOutboundSetterRef]);
  const providerRouting = useChatProviderRoutingController({
    runtimeLlmConfig: providerCatalog.config,
    runtimeProviderCatalog: providerCatalog.providers,
    getCachedModels: providerCatalog.getCachedModels,
    loadModelsForProvider: providerCatalog.loadModelsForProvider,
    prefs: session.sessionData.prefs,
    settings: session.sessionData.settings,
    draft,
    commandCatalog: session.sessionData.commandCatalog,
    installedSkills: session.sessionData.installedSkills,
    mcpServers: session.sessionData.mcpServers,
    mcpTemplates: session.sessionData.mcpTemplates,
  });
  const palette = useChatPaletteAndQueuePreferences({
    sessionData: session.sessionData,
    draft,
    composerPaletteGlobalOpen,
    composerPaletteQuery,
    selection,
    workspaceId,
    threadController: session.threadController,
    providerRouting,
    presetCatalog,
    externalSourceAttachments: session.externalSourceAttachments,
    selectedTurnId,
    typedRunVariablesEnabled: session.typedRunVariablesEnabled,
    documentEditingEnabled: session.documentEditingEnabled,
    setComposerPaletteGlobalOpen,
    setComposerPaletteQuery,
    coordination,
    oneShotContext,
  });
  const executionSurfaceMode: ChatMode = "chat";
  const outboundSurfaceMode = resolveOutboundSurfaceMode({
    lockSurface,
    surface,
    modeOverride: selection.modeOverride,
  });
  const executionRoutePrefs = useMemo(
    () =>
      resolveExecutionRoutePrefs(
        session.sessionData.prefs,
        executionSurfaceMode,
        providerRouting.selectedProviderId,
        providerRouting.selectedModel,
      ),
    [
      executionSurfaceMode,
      session.sessionData.prefs,
      providerRouting.selectedModel,
      providerRouting.selectedProviderId,
    ],
  );
  const routePreflight = useChatRoutePreflight({
    sessionId: selection.selectedSessionId,
    prefs: executionRoutePrefs,
    content: draft,
    surfaceMode: executionSurfaceMode,
    fullWebAccess: oneShotContext.fullWebAccess,
    displayAction: orchestration.editingTurnId ? "edit" : "send",
    displayTurnId: orchestration.editingTurnId,
    enabled: Boolean(selection.selectedSessionId),
    workspaceSnapshot: orchestration.editingTurnId ? undefined : oneShotContext.workspaceSnapshotRequest,
  });
  const { ensureFreshPreflight } = routePreflight;

  const [acknowledgedRoutePreflightHashes, setAcknowledgedRoutePreflightHashes] = useState<Record<string, true>>({});
  const currentRoutePreflight = routePreflight.result;
  const currentRoutePreflightHash = routePreflight.resultHash;
  const btwSideChat = useBtwSideChatController({
    workspaceId,
    selectedSession: session.threadController.selectedSession,
    selectedSessionId: selection.selectedSessionId,
    selectedTurnId,
    currentSurface: executionSurfaceMode,
    prefs: executionRoutePrefs,
    selectedProviderId: providerRouting.selectedProviderId,
    selectedModel: providerRouting.selectedModel,
    fullWebAccess: oneShotContext.fullWebAccess,
    ensureSession: session.sessionControls.ensureSession,
    pushLocalNotice: pushLocalNotice,
    setUiError: setUiError,
  });
  const currentRouteBoundaryAcknowledged = Boolean(
    currentRoutePreflightHash && acknowledgedRoutePreflightHashes[currentRoutePreflightHash],
  );
  const acknowledgeCurrentRouteBoundary = useCallback(() => {
    if (!currentRoutePreflightHash) {
      return;
    }
    setAcknowledgedRoutePreflightHashes((current) => ({
      ...current,
      [currentRoutePreflightHash]: true,
    }));
  }, [currentRoutePreflightHash]);

  useEffect(() => {
    if (!lockSurface) {
      if (coordination.lastPublishedWorkTrustSummaryRef.current !== null) {
        coordination.lastPublishedWorkTrustSummaryRef.current = null;
        onWorkTrustSummaryChange?.(null);
      }
      return;
    }
    const nextSummary = formatWorkProviderModelSummary(
      providerRouting.selectedProviderLabel,
      providerRouting.selectedModelLabel,
    );
    if (coordination.lastPublishedWorkTrustSummaryRef.current === nextSummary) {
      return;
    }
    coordination.lastPublishedWorkTrustSummaryRef.current = nextSummary;
    onWorkTrustSummaryChange?.(nextSummary);
  }, [
    lockSurface,
    onWorkTrustSummaryChange,
    providerRouting.selectedModelLabel,
    providerRouting.selectedProviderLabel,
    coordination.lastPublishedWorkTrustSummaryRef,
  ]);

  useEffect(
    () => () => {
      if (coordination.lastPublishedWorkTrustSummaryRef.current !== null) {
        coordination.lastPublishedWorkTrustSummaryRef.current = null;
        onWorkTrustSummaryChange?.(null);
      }
    },
    [onWorkTrustSummaryChange, coordination.lastPublishedWorkTrustSummaryRef],
  );
  const commands = useChatCommandExecution({
    openBtwSideChat: btwSideChat.openSideChat,
    notices,
    scopedErrors,
    orchestration,
    sessionData: session.sessionData,
    selectedTurnId,
    executionSurfaceMode,
    changePlanState,
    selection,
  });

  return {
    providerRouting,
    executionSurfaceMode,
    orchestration,
    outboundSurfaceMode,
    commands,
    ensureFreshPreflight,
    acknowledgedRoutePreflightHashes,
    operatorPromptSettersRef,
    currentRoutePreflight,
    routePreflight,
    currentRouteBoundaryAcknowledged,
    palette,
    handleComposerSend,
    btwSideChat,
    composerSendHandlerRef,
    acknowledgeCurrentRouteBoundary,
  };
}
