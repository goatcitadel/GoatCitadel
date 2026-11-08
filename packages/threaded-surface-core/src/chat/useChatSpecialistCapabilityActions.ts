import type {
  ChatCapabilityUpgradeSuggestion,
  ChatMode,
  ChatSessionRecord,
  ChatSpecialistCandidatePatchInput,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  McpServerRecord,
  McpServerTemplateRecord,
  SkillListItem,
} from "@goatcitadel/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { loadSpecialistActionCode } from "./load-specialist-action-code";
import type { SpecialistAction } from "./specialist-action-code";
import { loadConfirmedCapabilitySuggestionAction } from "./load-confirmed-capability-suggestion-action";
import { getCapabilitySuggestionConfirmationCopy } from "./chat-page-pure-helpers";
import { useChatContextMutationOwner } from "./useChatContextMutationOwner";
import type { OutboundQueueItem } from "./useChatSurfaceOrchestration";

export function useChatSpecialistCapabilityActions(input: {
  workspaceId?: string;
  historicalRevisionRef?: { readonly current: number };
  historicalReadOnly?: boolean;

  selectionRevisionRef?: { readonly current: number };
  turnRevisionRef?: { readonly current: number };
  sendingRevisionRef?: { readonly current: number };
  selectedSessionId: string | null;
  selectedSession: ChatSessionRecord | null;
  selectedTurnId: string | null;
  surfaceMode: ChatMode;
  sending: boolean;
  setError: (value: string | null) => void;
  setSending: (value: boolean) => void;
  setSpecialistCandidates: React.Dispatch<React.SetStateAction<ChatSpecialistCandidateRecord[]>>;
  setInstalledSkills: React.Dispatch<React.SetStateAction<SkillListItem[]>>;
  setMcpServers: React.Dispatch<React.SetStateAction<McpServerRecord[]>>;
  setMcpTemplates: React.Dispatch<React.SetStateAction<Array<McpServerTemplateRecord & { installed: boolean }>>>;
  pushLocalNotice: (
    content: string,
    tone?: "neutral" | "success" | "warning",
    publicationCurrent?: () => boolean,
  ) => void;
  executeOutboundItemRef: MutableRefObject<(item: OutboundQueueItem) => Promise<void>>;
  tryBeginOutboundExecutionRef: MutableRefObject<() => boolean>;
  setQueuedOutbound: React.Dispatch<React.SetStateAction<OutboundQueueItem[]>>;
}) {
  const {
    selectedSessionId,
    selectedSession,
    selectedTurnId,
    surfaceMode,
    sending,
    setError,
    setSending,
    setSpecialistCandidates,
    setInstalledSkills,
    setMcpServers,
    setMcpTemplates,
    pushLocalNotice,
    executeOutboundItemRef,
    tryBeginOutboundExecutionRef,
    setQueuedOutbound,
  } = input;

  const [capabilitySuggestions, setCapabilitySuggestions] = useState<ChatCapabilityUpgradeSuggestion[]>([]);
  const [specialistSuggestions, setSpecialistSuggestions] = useState<ChatSpecialistCandidateSuggestionRecord[]>([]);
  const [capabilitySuggestionConfirm, setCapabilitySuggestionConfirm] =
    useState<ChatCapabilityUpgradeSuggestion | null>(null);
  const [capabilitySuggestionPending, setCapabilitySuggestionPending] = useState(false);

  const capabilityConfirmationCopy = useMemo(
    () => (capabilitySuggestionConfirm ? getCapabilitySuggestionConfirmationCopy(capabilitySuggestionConfirm) : null),
    [capabilitySuggestionConfirm],
  );

  const specialistMutationOwner = useChatContextMutationOwner({
    family: "specialists",
    workspaceId: input.workspaceId ?? selectedSession?.workspaceId ?? "default",
    sessionId: selectedSession?.sessionId ?? null,
    sessionWorkspaceId: selectedSession?.workspaceId,
    historicalRevisionRef: input.historicalRevisionRef,
    historicalReadOnly: input.historicalReadOnly,
    selectionRevisionRef: input.selectionRevisionRef,
    turnRevisionRef: input.turnRevisionRef,
    sendingRevisionRef: input.sendingRevisionRef,
    setError,
  });
  const {
    run: runSpecialistMutation,
    inspect: inspectSpecialistMutation,
    projection: specialistProjection,
  } = specialistMutationOwner;
  const workspaceId = input.workspaceId ?? selectedSession?.workspaceId ?? "default";
  const actionView = useMemo(
    () => ({ selectedSessionId, selectedTurnId, surfaceMode, sending, scope: specialistProjection.scopeIdentity }),
    [selectedSessionId, selectedTurnId, surfaceMode, sending, specialistProjection.scopeIdentity],
  );
  const committedActionView = useRef(actionView);
  const confirmedAction = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    committedActionView.current = actionView;
    confirmedAction.current = null;
    setCapabilitySuggestionPending(false);
    setCapabilitySuggestionConfirm(null);
  }, [actionView]);
  const isSpecialistCurrent = specialistProjection.isCurrent;
  const invokeSpecialistAction = useCallback(
    async (action: SpecialistAction) => {
      if (!selectedSession || (action.kind !== "inspect" && sending)) return;
      const sendingRevision = input.sendingRevisionRef?.current;
      const callerRevision = getGatewayCallerScopeRevision();
      const current = () =>
        committedActionView.current === actionView &&
        isSpecialistCurrent() &&
        getGatewayCallerScopeRevision() === callerRevision &&
        input.sendingRevisionRef?.current === sendingRevision;
      if (!current()) return;
      let actions: Awaited<ReturnType<typeof loadSpecialistActionCode>>;
      try {
        actions = await loadSpecialistActionCode();
      } catch (error) {
        if (current()) setError(errorMessage(error));
        return;
      }
      // Request evidence is captured synchronously by the shared owner. Resolve
      // the code first, then enter that owner only if this intent is still current.
      if (!current()) return;
      await actions.runSpecialistAction(
        {
          sessionId: selectedSession.sessionId,
          workspaceId,
          run: runSpecialistMutation,
          inspect: inspectSpecialistMutation,
          setSending,
          setCandidates: setSpecialistCandidates,
          setSuggestions: setSpecialistSuggestions,
          pushLocalNotice,
        },
        action,
      );
    },
    [
      selectedSession,
      sending,
      actionView,
      isSpecialistCurrent,
      input.sendingRevisionRef,
      setError,
      workspaceId,
      runSpecialistMutation,
      inspectSpecialistMutation,
      setSending,
      setSpecialistCandidates,
      pushLocalNotice,
    ],
  );
  const handleCreateSpecialistDraft = useCallback(
    (suggestion: ChatSpecialistCandidateSuggestionRecord) =>
      invokeSpecialistAction({ kind: "draft", suggestion, turnId: selectedTurnId }),
    [invokeSpecialistAction, selectedTurnId],
  );
  const handleSpecialistCandidatePatch = useCallback(
    (candidateId: string, patch: ChatSpecialistCandidatePatchInput, notice: string) =>
      invokeSpecialistAction({ kind: "patch", candidateId, patch, notice }),
    [invokeSpecialistAction],
  );
  const handleActivateCatalogSpecialist = useCallback(
    async (suggestion: ChatSpecialistCandidateSuggestionRecord) => {
      if (!selectedSession || sending) return;
      if (!suggestion.candidateId) {
        setError("Catalog suggestion is missing its entry identifier.");
        return;
      }
      await invokeSpecialistAction({ kind: "activate", entryId: suggestion.candidateId });
    },
    [invokeSpecialistAction, selectedSession, sending, setError],
  );
  const handleInspectSpecialists = useCallback(
    () => invokeSpecialistAction({ kind: "inspect" }),
    [invokeSpecialistAction],
  );

  const dismissCapabilitySuggestion = useCallback((suggestion: ChatCapabilityUpgradeSuggestion) => {
    setCapabilitySuggestions((current) =>
      current.filter(
        (item) =>
          item.kind !== suggestion.kind ||
          (item.candidateId ?? item.title) !== (suggestion.candidateId ?? suggestion.title),
      ),
    );
  }, []);

  const resumeCapabilitySuggestionTurn = useCallback(async () => {
    if (!selectedTurnId) {
      pushLocalNotice("Capability upgraded, but there is no failed turn selected to resume yet.", "warning");
      return;
    }
    const nextItem: OutboundQueueItem = {
      id: `queue-${Date.now()}`,
      action: "retry",
      sessionId: selectedSessionId ?? undefined,
      targetTurnId: selectedTurnId,
      content: "",
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    if (!tryBeginOutboundExecutionRef.current()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      pushLocalNotice("Capability upgraded. The original request has been queued to resume automatically.");
      return;
    }
    await executeOutboundItemRef.current(nextItem);
  }, [
    executeOutboundItemRef,
    pushLocalNotice,
    selectedSessionId,
    selectedTurnId,
    setQueuedOutbound,
    tryBeginOutboundExecutionRef,
  ]);

  const runCapabilitySuggestionAction = useCallback(
    async (suggestion: ChatCapabilityUpgradeSuggestion) => {
      const sendingRevision = input.sendingRevisionRef?.current;
      const current = () =>
        committedActionView.current === actionView &&
        isSpecialistCurrent() &&
        input.sendingRevisionRef?.current === sendingRevision;
      try {
        setError(null);
        if (getCapabilitySuggestionConfirmationCopy(suggestion)) {
          if (!current()) return;
          const actions = await loadConfirmedCapabilitySuggestionAction();
          if (!current()) return;
          await actions.runConfirmedCapabilitySuggestionAction({
            suggestion,
            workspaceId: selectedSession?.workspaceId,
            selectedSessionId,
            selectedTurnId,
            surfaceMode,
            current,
            setError,
            setInstalledSkills,
            pushLocalNotice,
            dismissCapabilitySuggestion,
            resumeCapabilitySuggestionTurn,
          });
          return;
        }

        if (
          suggestion.recommendedAction === "review_tool_access" ||
          suggestion.recommendedAction === "switch_tool_profile"
        ) {
          window.location.hash = "permissions";
          dismissCapabilitySuggestion(suggestion);
          return;
        }

        if (suggestion.recommendedAction === "connect_mcp") {
          if (!current()) return;
          const { openMcpSuggestion } = await loadSpecialistActionCode();
          if (await openMcpSuggestion(current, setMcpServers, setMcpTemplates)) {
            if (current()) dismissCapabilitySuggestion(suggestion);
          }
          return;
        }

        throw new Error(`Unsupported capability action: ${suggestion.recommendedAction}`);
      } catch (err) {
        if (current()) setError(errorMessage(err));
      }
    },
    [
      dismissCapabilitySuggestion,
      pushLocalNotice,
      resumeCapabilitySuggestionTurn,
      selectedSession?.workspaceId,
      selectedSessionId,
      selectedTurnId,
      setError,
      setInstalledSkills,
      setMcpServers,
      setMcpTemplates,
      surfaceMode,
      isSpecialistCurrent,
      input.sendingRevisionRef,
      actionView,
    ],
  );

  const handleCapabilitySuggestionAction = useCallback(
    (suggestion: ChatCapabilityUpgradeSuggestion) => {
      const confirmation = getCapabilitySuggestionConfirmationCopy(suggestion);
      if (confirmation) {
        setCapabilitySuggestionConfirm(suggestion);
        return;
      }
      void runCapabilitySuggestionAction(suggestion);
    },
    [runCapabilitySuggestionAction],
  );

  const confirmCapabilitySuggestionAction = useCallback(async () => {
    if (!capabilitySuggestionConfirm || confirmedAction.current) {
      return;
    }
    const attempt = Symbol();
    confirmedAction.current = attempt;
    setCapabilitySuggestionPending(true);
    try {
      await runCapabilitySuggestionAction(capabilitySuggestionConfirm);
    } finally {
      if (confirmedAction.current === attempt) {
        confirmedAction.current = null;
        setCapabilitySuggestionPending(false);
        setCapabilitySuggestionConfirm(null);
      }
    }
  }, [capabilitySuggestionConfirm, runCapabilitySuggestionAction]);

  return {
    capabilitySuggestions,
    setCapabilitySuggestions,
    specialistSuggestions,
    setSpecialistSuggestions,
    capabilitySuggestionConfirm,
    setCapabilitySuggestionConfirm,
    capabilitySuggestionPending,
    capabilityConfirmationCopy,
    specialistMutation: { ...specialistProjection, onInspect: handleInspectSpecialists },
    handleCreateSpecialistDraft,
    handleActivateCatalogSpecialist,
    handleSpecialistCandidatePatch,
    handleCapabilitySuggestionAction,
    dismissCapabilitySuggestion,
    confirmCapabilitySuggestionAction,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
