import type { ChatAttachmentRecord, ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatSessionGoal } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import {
  chatSessionCreationKey,
  readChatSessionCreation,
  useChatSessionCreation,
  type ChatSessionCreation,
} from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { setDevDiagnosticsLatestTraceSummary } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { useEffect, useMemo, useRef } from "react";
import type { MissionThreadedControllerHostProps } from "../../MissionThreadedControllerHost.types";
import {
  mergeHydratedOutboundQueue,
  parseHydratedChatAttachments,
  parseHydratedOutboundQueue,
} from "../hydrated-storage";
import { isWithinStorageBudget, MAX_HYDRATED_MESSAGE_CHARS } from "../hydrated-storage-validation";
import {
  reconcilePendingAttachmentModes,
  VISUAL_STREAM_MODE_PREF_KEY,
  type PendingAttachmentDocumentMode,
} from "../mission-threaded-controller-helpers";
import {
  createAttachmentStorageKey,
  createDraftStorageKey,
  createQueueStorageKey,
  useDebouncedLocalStoragePersistence,
} from "../useChatLocalPersistence";
import { useChatSessionData } from "../useChatSessionData";
import type { InitialOutboundSessionCreation } from "../useChatSessionControls";
import { useChatSurfaceOrchestration } from "../useChatSurfaceOrchestration";
import { useChatThreadController } from "../useChatThreadController";
import { useChatMetadataDraftState } from "./useChatMetadataDraftState";
import { useChatSessionSelection } from "./useChatSessionSelection";
import { useChatStreamPreferences } from "./useChatStreamPreferences";

type Input = {
  workspaceId: NonNullable<MissionThreadedControllerHostProps["workspaceId"]>;
  selection: Pick<ReturnType<typeof useChatSessionSelection>, "selectedSessionId">;
  orchestration: Pick<ReturnType<typeof useChatSurfaceOrchestration>, "queuedOutbound" | "setQueuedOutbound">;
  setPinnedGoal: React.Dispatch<React.SetStateAction<string | undefined>>;
  restorePinnedGoal?: boolean;
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "thread" | "generatedArtifacts">;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachmentRecord[]>>;
  setPendingAttachmentModes: React.Dispatch<React.SetStateAction<Record<string, PendingAttachmentDocumentMode>>>;
  pendingAttachments: ChatAttachmentRecord[];
  activeGeneratedArtifact: ChatGeneratedArtifactRecord | null;
  setActiveGeneratedArtifact: React.Dispatch<React.SetStateAction<ChatGeneratedArtifactRecord | null>>;
  draft: string;
  STREAM_PREF_KEY: "goatcitadel.chat.agent.stream.enabled";
  streamPreferences: Pick<ReturnType<typeof useChatStreamPreferences>, "streamEnabled" | "visualStreamMode">;
  metadataDraft: Pick<
    ReturnType<typeof useChatMetadataDraftState>,
    "sessionMetadataConflictDraftRef" | "setFolderName" | "setTagsValue"
  >;
  threadController: Pick<ReturnType<typeof useChatThreadController>, "selectedSession">;
  setRenameTitle: React.Dispatch<React.SetStateAction<string>>;
  initialOutboundSessionCreationRef?: React.MutableRefObject<InitialOutboundSessionCreation | null>;
};

type DraftOwner = { key: string; workspaceId: string; caller: string };
/** The box as New started: one attempt, one conversation key, nothing in it, nothing stored for it. */
type CreationStart = { attempt: ChatSessionCreation; key: string; settled: boolean };

function nothingStoredFor(key: string): boolean {
  try {
    return !window.localStorage.getItem(key);
  } catch {
    return false;
  }
}

/**
 * Whether the draft typed so far moves into the conversation that was just created. Only when the selection goes
 * directly from the conversation New started in to the one that New created, for the same caller and workspace; the
 * start is dropped on any other key change, so nothing carries later.
 */
function carriedDraft(
  previous: DraftOwner | null,
  next: DraftOwner,
  selectedSessionId: string | null,
  start: CreationStart | null,
): boolean {
  if (!previous || !start || !selectedSessionId || previous.key === next.key) return false;
  const attempt = readChatSessionCreation(chatSessionCreationKey(getGatewayApiBaseUrl(), next.workspaceId));
  return (
    previous.workspaceId === next.workspaceId &&
    previous.caller === next.caller &&
    attempt === start.attempt &&
    attempt.state === "confirmed" &&
    attempt.sessionId === selectedSessionId &&
    start.key === previous.key
  );
}

/** Captures the queue transition baseline during render, hydrates scoped drafts, then installs persistence effects in the original order. */
export function useChatSessionRestoration({
  workspaceId,
  selection,
  orchestration,
  setPinnedGoal,
  restorePinnedGoal = true,
  sessionData,
  setDraft,
  setPendingAttachments,
  setPendingAttachmentModes,
  pendingAttachments,
  activeGeneratedArtifact,
  setActiveGeneratedArtifact,
  draft,
  STREAM_PREF_KEY,
  streamPreferences,
  metadataDraft,
  threadController,
  setRenameTitle,
  initialOutboundSessionCreationRef,
}: Input) {
  const { setQueuedOutbound } = orchestration;
  const { sessionMetadataConflictDraftRef, setFolderName, setTagsValue } = metadataDraft;
  const draftStorageKey = createDraftStorageKey(workspaceId, selection.selectedSessionId);
  const attachmentStorageKey = createAttachmentStorageKey(workspaceId, selection.selectedSessionId);
  const queueStorageKey = createQueueStorageKey(workspaceId, selection.selectedSessionId);
  // Which owner (caller, workspace, conversation) the draft was last hydrated for, and the draft as it was when
  // the current New started: text typed while a new conversation is being created belongs to that conversation.
  const draftHydrationRef = useRef<{ key: string; workspaceId: string; caller: string } | null>(null);
  const creationAttempt = useChatSessionCreation(chatSessionCreationKey(getGatewayApiBaseUrl(), workspaceId));
  const creationStartRef = useRef<CreationStart | null>(null);
  const consideredAttemptRef = useRef<ChatSessionCreation | null>(null);
  if (
    creationAttempt &&
    (creationAttempt.state === "checking" || creationAttempt.state === "pending") &&
    consideredAttemptRef.current !== creationAttempt
  ) {
    consideredAttemptRef.current = creationAttempt;
    // Only a box that has been hydrated for this key, is empty and has nothing stored can start a carry; an attempt
    // that starts before hydration, or in the render of a key change, gets none.
    creationStartRef.current =
      draftHydrationRef.current?.key === draftStorageKey && draft === "" && nothingStoredFor(draftStorageKey)
        ? { attempt: creationAttempt, key: draftStorageKey, settled: false }
        : null;
  }
  const attachmentKeyRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const queueHydrationTransitionRef = useRef<{
    key: string;
    baselineIds: ReadonlySet<string>;
    workspaceId: string;
    sessionId: string | null;
    creationCandidate?: InitialOutboundSessionCreation;
    initialSessionQueueIds?: ReadonlySet<string>;
  }>({
    key: queueStorageKey,
    baselineIds: new Set(orchestration.queuedOutbound.map((item) => item.id)),
    workspaceId,
    sessionId: selection.selectedSessionId,
    creationCandidate: initialOutboundSessionCreationRef?.current ?? undefined,
  });
  if (queueHydrationTransitionRef.current.key !== queueStorageKey) {
    const previous = queueHydrationTransitionRef.current;
    const creation = initialOutboundSessionCreationRef?.current;
    const ownsInitialTransition =
      previous.workspaceId === workspaceId &&
      previous.sessionId === null &&
      creation?.workspaceId === workspaceId &&
      creation.sessionId === selection.selectedSessionId;
    queueHydrationTransitionRef.current = {
      key: queueStorageKey,
      baselineIds: new Set(orchestration.queuedOutbound.map((item) => item.id)),
      workspaceId,
      sessionId: selection.selectedSessionId,
      creationCandidate: creation ?? undefined,
      ...(ownsInitialTransition
        ? {
            initialSessionQueueIds: new Set(
              orchestration.queuedOutbound.filter((item) => item.sessionId === undefined).map((item) => item.id),
            ),
          }
        : {}),
    };
  }

  useEffect(() => {
    if (!restorePinnedGoal) return;
    const selectedSessionId = selection.selectedSessionId;
    if (!selectedSessionId) {
      setPinnedGoal(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchChatSessionGoal(selectedSessionId);
        if (!cancelled) {
          setPinnedGoal(response.goal ?? undefined);
        }
      } catch {
        // Goal fetch is best-effort. Don't surface errors on session switch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restorePinnedGoal, selection.selectedSessionId, setPinnedGoal]);

  useEffect(() => {
    const thread = sessionData.thread;
    if (!thread) {
      setDevDiagnosticsLatestTraceSummary(undefined);
      return;
    }
    const selectedTurn = thread.turns.find(
      (turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId),
    );
    setDevDiagnosticsLatestTraceSummary(
      selectedTurn?.trace
        ? {
            sessionId: thread.sessionId,
            turnId: selectedTurn.turnId,
            providerId: selectedTurn.trace.routing.effectiveProviderId ?? selectedTurn.trace.routing.primaryProviderId,
            modelId: selectedTurn.trace.routing.effectiveModel ?? selectedTurn.trace.model,
            state: selectedTurn.trace.status,
          }
        : {
            sessionId: thread.sessionId,
            turnCount: thread.turns.length,
          },
    );
  }, [sessionData.thread]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const hydrationTransition = queueHydrationTransitionRef.current;
    const hydratedAttachmentKey = attachmentKeyRef.current;
    attachmentKeyRef.current = attachmentStorageKey;
    const owner = { key: draftStorageKey, workspaceId, caller: getGatewayCallerScope() };
    const previousOwner = draftHydrationRef.current;
    draftHydrationRef.current = owner;
    // The same owner and key again (only another dependency changed): never replace newer typing with a stored value.
    const sameOwnerKey = previousOwner?.key === owner.key;
    const carried = carriedDraft(previousOwner, owner, selection.selectedSessionId, creationStartRef.current);
    // Any key change ends the start, carrying or not: a later selection can never claim it.
    if (!sameOwnerKey) creationStartRef.current = null;
    const hydrateDraft = (stored: string | null) => {
      if (sameOwnerKey) return;
      if (stored === null && carried) {
        const text = draftRef.current;
        setDraft(text);
        // The text was saved under the conversation it was typed in; it belongs to the new one.
        setTimeout(() => {
          try {
            if (window.localStorage.getItem(previousOwner!.key) === text)
              window.localStorage.removeItem(previousOwner!.key);
          } catch {
            // Storage may be unavailable; the new conversation still has the text.
          }
        }, 0);
        return;
      }
      setDraft(stored ?? "");
    };
    try {
      const draftRaw = window.localStorage.getItem(draftStorageKey);
      hydrateDraft(
        draftRaw && isWithinStorageBudget(draftRaw) && draftRaw.length <= MAX_HYDRATED_MESSAGE_CHARS ? draftRaw : null,
      );
      // The same key again never replaces attachments added since with the stored copy.
      if (hydratedAttachmentKey !== attachmentStorageKey) {
        const attachmentsRaw = window.localStorage.getItem(attachmentStorageKey);
        setPendingAttachments(
          parseHydratedChatAttachments(attachmentsRaw, {
            workspaceId,
            sessionId: selection.selectedSessionId,
          }),
        );
      }
      const queueRaw = window.localStorage.getItem(queueStorageKey);
      const hydratedQueue = parseHydratedOutboundQueue(queueRaw, {
        workspaceId,
        sessionId: selection.selectedSessionId,
      });
      setQueuedOutbound((current) =>
        mergeHydratedOutboundQueue({
          hydrated: hydratedQueue,
          current,
          baselineIds: hydrationTransition.baselineIds,
          sessionId: selection.selectedSessionId,
          initialSessionQueueIds: hydrationTransition.initialSessionQueueIds,
        }),
      );
    } catch {
      hydrateDraft(null);
      if (hydratedAttachmentKey !== attachmentStorageKey) setPendingAttachments([]);
      setQueuedOutbound((current) =>
        mergeHydratedOutboundQueue({
          hydrated: [],
          current,
          baselineIds: hydrationTransition.baselineIds,
          sessionId: selection.selectedSessionId,
          initialSessionQueueIds: hydrationTransition.initialSessionQueueIds,
        }),
      );
    }
    if (
      hydrationTransition.creationCandidate &&
      initialOutboundSessionCreationRef?.current === hydrationTransition.creationCandidate
    ) {
      initialOutboundSessionCreationRef.current = null;
    }
  }, [
    attachmentStorageKey,
    draftStorageKey,
    queueStorageKey,
    selection.selectedSessionId,
    setQueuedOutbound,
    setDraft,
    setPendingAttachments,
    initialOutboundSessionCreationRef,
    workspaceId,
  ]);

  // The start lives only across the commit that shows the created conversation as confirmed and the one that selects
  // it (the creator selects it in the same task); an error, or any later commit on the same key, ends it.
  useEffect(() => {
    const start = creationStartRef.current;
    if (!start) return;
    if (creationAttempt !== start.attempt) {
      creationStartRef.current = null;
      return;
    }
    if (creationAttempt.state === "checking" || creationAttempt.state === "pending") return;
    if (creationAttempt.state !== "confirmed" || start.settled) creationStartRef.current = null;
    else start.settled = true;
  });

  useEffect(() => {
    setPendingAttachmentModes((current) => reconcilePendingAttachmentModes(current, pendingAttachments));
  }, [pendingAttachments, setPendingAttachmentModes]);

  useEffect(() => {
    if (!activeGeneratedArtifact) {
      return;
    }
    const refreshedArtifact = sessionData.generatedArtifacts?.items.find(
      (item) => item.artifactId === activeGeneratedArtifact.artifactId,
    );
    if (refreshedArtifact) {
      setActiveGeneratedArtifact(refreshedArtifact);
    }
  }, [activeGeneratedArtifact, sessionData.generatedArtifacts?.items, setActiveGeneratedArtifact]);

  const serializedPendingAttachments = useMemo(() => JSON.stringify(pendingAttachments), [pendingAttachments]);
  const serializedQueuedOutbound = useMemo(
    () => JSON.stringify(orchestration.queuedOutbound),
    [orchestration.queuedOutbound],
  );

  useDebouncedLocalStoragePersistence(draftStorageKey, draft);
  useDebouncedLocalStoragePersistence(attachmentStorageKey, serializedPendingAttachments);
  useDebouncedLocalStoragePersistence(queueStorageKey, serializedQueuedOutbound);

  useEffect(() => {
    // Persistence above flushes the previous key on transition. Retire only the
    // transferred IDs afterward so opening New cannot replay them a second time.
    const transferredIds = queueHydrationTransitionRef.current.initialSessionQueueIds;
    if (typeof window === "undefined" || !transferredIds?.size) return;
    try {
      const previousKey = createQueueStorageKey(workspaceId, null);
      const previousQueue = parseHydratedOutboundQueue(window.localStorage.getItem(previousKey), {
        workspaceId,
        sessionId: null,
      });
      const remaining = previousQueue.filter((item) => !transferredIds.has(item.id));
      if (remaining.length !== previousQueue.length)
        window.localStorage.setItem(previousKey, JSON.stringify(remaining));
    } catch {
      // Keep the in-memory owner authoritative when browser persistence is disabled.
    }
  }, [queueStorageKey, workspaceId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STREAM_PREF_KEY, String(streamPreferences.streamEnabled));
    } catch {
      // Fallback: localStorage may be disabled or quota-exceeded; preference will not persist this session.
    }
  }, [streamPreferences.streamEnabled, STREAM_PREF_KEY]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(VISUAL_STREAM_MODE_PREF_KEY, streamPreferences.visualStreamMode);
    } catch {
      // Fallback: localStorage may be disabled or quota-exceeded; preference will not persist this session.
    }
  }, [streamPreferences.visualStreamMode]);

  useEffect(() => {
    const conflictDraft = sessionMetadataConflictDraftRef.current;
    const appliesToSelectedSession = conflictDraft?.sessionId === threadController.selectedSession?.sessionId;
    setRenameTitle(
      appliesToSelectedSession && conflictDraft?.kind === "rename"
        ? conflictDraft.renameTitle
        : (threadController.selectedSession?.title ?? ""),
    );
    setFolderName(
      appliesToSelectedSession && conflictDraft?.kind === "organization"
        ? conflictDraft.folderName
        : (threadController.selectedSession?.folderName ?? ""),
    );
    setTagsValue(
      appliesToSelectedSession && conflictDraft?.kind === "organization"
        ? conflictDraft.tagsValue
        : (threadController.selectedSession?.tags ?? []).join(", "),
    );
  }, [
    threadController.selectedSession?.folderName,
    threadController.selectedSession?.sessionId,
    threadController.selectedSession?.tags,
    threadController.selectedSession?.title,
    sessionMetadataConflictDraftRef,
    setRenameTitle,
    setFolderName,
    setTagsValue,
  ]);

  return {};
}
