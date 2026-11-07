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
import {
  activateImportedAgentCatalogEntry,
  createChatSpecialistCandidate,
  fetchChatSpecialistCandidates,
  fetchMcpServers,
  fetchMcpTemplates,
  updateChatSpecialistCandidate,
} from "@goatcitadel/mission-control-shared/api/client";
import { loadConfirmedCapabilitySuggestionAction } from "./load-confirmed-capability-suggestion-action";
import { getCapabilitySuggestionConfirmationCopy } from "./chat-page-pure-helpers";
import { useChatContextMutationOwner } from "./useChatContextMutationOwner";
import { assertContextRecord } from "./context-mutation-evidence";
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
  const handleCreateSpecialistDraft = useCallback(
    async (suggestion: ChatSpecialistCandidateSuggestionRecord): Promise<void> => {
      if (!selectedSession || sending) return;
      await runSpecialistMutation(
        "specialist-draft",
        () =>
          createChatSpecialistCandidate(selectedSession.sessionId, {
            turnId: selectedTurnId ?? undefined,
            suggestion,
          }),
        (created) => [assertContextRecord(created, selectedSession.sessionId, workspaceId, "candidateId")],
        (created, publicationCurrent) => {
          setSpecialistCandidates((current) =>
            publicationCurrent()
              ? [created, ...current.filter((item) => item.candidateId !== created.candidateId)]
              : current,
          );
          setSpecialistSuggestions((current) =>
            publicationCurrent()
              ? current.filter((item) => JSON.stringify(item) !== JSON.stringify(suggestion))
              : current,
          );
          pushLocalNotice(`Drafted specialist candidate: ${created.title}.`, "success", publicationCurrent);
        },
        { begin: () => setSending(true), end: () => setSending(false) },
      );
    },
    [
      selectedSession,
      selectedTurnId,
      sending,
      workspaceId,
      runSpecialistMutation,
      setSending,
      setSpecialistCandidates,
      pushLocalNotice,
    ],
  );
  const handleSpecialistCandidatePatch = useCallback(
    async (candidateId: string, patch: ChatSpecialistCandidatePatchInput, notice: string): Promise<void> => {
      if (!selectedSession || sending) return;
      await runSpecialistMutation(
        "specialist-patch",
        () => updateChatSpecialistCandidate(selectedSession.sessionId, candidateId, patch),
        (updated) => [assertContextRecord(updated, selectedSession.sessionId, workspaceId, "candidateId", candidateId)],
        (updated, publicationCurrent) => {
          setSpecialistCandidates((current) =>
            publicationCurrent()
              ? current.map((item) => (item.candidateId === updated.candidateId ? updated : item))
              : current,
          );
          pushLocalNotice(notice, "success", publicationCurrent);
        },
        { begin: () => setSending(true), end: () => setSending(false) },
      );
    },
    [
      selectedSession,
      sending,
      workspaceId,
      runSpecialistMutation,
      setSending,
      setSpecialistCandidates,
      pushLocalNotice,
    ],
  );
  const handleActivateCatalogSpecialist = useCallback(
    async (suggestion: ChatSpecialistCandidateSuggestionRecord): Promise<void> => {
      if (!selectedSession || sending) return;
      if (!suggestion.candidateId) {
        setError("Catalog suggestion is missing its entry identifier.");
        return;
      }
      await runSpecialistMutation(
        "specialist-activation",
        () => activateImportedAgentCatalogEntry(suggestion.candidateId, { sessionId: selectedSession.sessionId }),
        (activated) => {
          const id = assertContextRecord(activated.specialist, selectedSession.sessionId, workspaceId, "candidateId");
          if (
            activated.catalogEntry.entryId !== suggestion.candidateId ||
            activated.specialist.routingMode !== "manual_only" ||
            activated.specialist.status !== "active"
          )
            throw new TypeError("The activation receipt does not confirm the reviewed manual-only specialist.");
          return [activated.catalogEntry.entryId, id];
        },
        (activated, publicationCurrent) => {
          setSpecialistCandidates((current) =>
            publicationCurrent()
              ? [
                  activated.specialist,
                  ...current.filter((item) => item.candidateId !== activated.specialist.candidateId),
                ]
              : current,
          );
          setSpecialistSuggestions((current) =>
            publicationCurrent() ? current.filter((item) => item.candidateId !== suggestion.candidateId) : current,
          );
          pushLocalNotice(
            `Activated ${activated.catalogEntry.definition.frontmatter.name} for this session as a manual-only specialist.`,
            "success",
            publicationCurrent,
          );
        },
        { begin: () => setSending(true), end: () => setSending(false) },
      );
    },
    [
      selectedSession,
      sending,
      workspaceId,
      runSpecialistMutation,
      setError,
      setSending,
      setSpecialistCandidates,
      pushLocalNotice,
    ],
  );
  const handleInspectSpecialists = useCallback(async (): Promise<void> => {
    if (!selectedSession) return;
    await inspectSpecialistMutation(
      () => fetchChatSpecialistCandidates(selectedSession.sessionId, 500),
      (result) => {
        if (!Array.isArray(result.items)) throw new TypeError("The Gateway returned no specialist candidates.");
        result.items.forEach((item) =>
          assertContextRecord(item, selectedSession.sessionId, workspaceId, "candidateId"),
        );
      },
      (result, publicationCurrent) =>
        setSpecialistCandidates((current) => (publicationCurrent() ? result.items : current)),
    );
  }, [selectedSession, workspaceId, inspectSpecialistMutation, setSpecialistCandidates]);

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

  const isSpecialistCurrent = specialistProjection.isCurrent;
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
          setMcpServers(await fetchMcpServers().then((result) => result.items));
          setMcpTemplates(await fetchMcpTemplates().then((result) => result.items));
          window.location.hash = "mcp";
          dismissCapabilitySuggestion(suggestion);
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
