import type { ChatAttachmentRecord, ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { fetchChatSessionGoal } from "@goatcitadel/mission-control-shared/api/client";
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

/** Captures the queue transition baseline during render, hydrates scoped drafts, then installs persistence effects in the original order. */
export function useChatSessionRestoration({
  workspaceId,
  selection,
  orchestration,
  setPinnedGoal,
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
  }, [selection.selectedSessionId, setPinnedGoal]);

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
    try {
      const draftRaw = window.localStorage.getItem(draftStorageKey);
      setDraft(
        draftRaw && isWithinStorageBudget(draftRaw) && draftRaw.length <= MAX_HYDRATED_MESSAGE_CHARS ? draftRaw : "",
      );
      const attachmentsRaw = window.localStorage.getItem(attachmentStorageKey);
      setPendingAttachments(
        parseHydratedChatAttachments(attachmentsRaw, {
          workspaceId,
          sessionId: selection.selectedSessionId,
        }),
      );
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
      setDraft("");
      setPendingAttachments([]);
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
      // Browser persistence may be disabled; the in-memory owner remains authoritative for this session.
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
