import { CHAT_SESSION_FORK_MANIFEST_VERSION, isChatTurnTerminalStatus } from "@goatcitadel/contracts";
import { forkChatSessionFromTurn } from "@goatcitadel/mission-control-shared/api/client";
import { useCallback, useEffect, useRef } from "react";
import { trimForkTitle } from "../mission-threaded-controller-helpers";
import { useChatSessionData } from "../useChatSessionData";
import type { OutboundContextBlock } from "../useChatSurfaceOrchestration";
import { useChatThreadController } from "../useChatThreadController";
import { useChatControllerCoordination } from "./useChatControllerCoordination";
import { useChatNoticesAndPresetRefresh } from "./useChatNoticesAndPresetRefresh";
import { useChatScopedErrors } from "./useChatScopedErrors";
import { useChatSessionSelection } from "./useChatSessionSelection";

type Input = {
  workspaceId: string;
  setSelectedContextTurnIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPendingThreadContext: React.Dispatch<React.SetStateAction<OutboundContextBlock | null>>;
  selection: Pick<
    ReturnType<typeof useChatSessionSelection>,
    "selectedSessionId" | "historyView" | "setHistoryView" | "setSelectedSessionId"
  >;
  sessionData: Pick<ReturnType<typeof useChatSessionData>, "thread" | "setThread" | "setSessions">;
  threadController: Pick<ReturnType<typeof useChatThreadController>, "selectedSession">;
  scopedErrors: Pick<ReturnType<typeof useChatScopedErrors>, "setUiError">;
  setForkPending: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedTurnId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  notices: Pick<ReturnType<typeof useChatNoticesAndPresetRefresh>, "pushLocalNotice">;
  coordination: Pick<ReturnType<typeof useChatControllerCoordination>, "composerRef">;
  setForkConfirm: React.Dispatch<
    React.SetStateAction<{
      turnId: string;
      turnCount: number;
      attachmentCount: number;
      artifactCount: number;
    } | null>
  >;
};

/** Coordinates context selection and an explicit conversation fork without changing route ownership. */
export function useChatConversationFork({
  workspaceId,
  setSelectedContextTurnIds,
  setPendingThreadContext,
  selection,
  sessionData,
  threadController,
  scopedErrors,
  setForkPending,
  setSelectedTurnId,
  setDraft,
  notices,
  coordination,
  setForkConfirm,
}: Input) {
  const { setUiError } = scopedErrors;
  const { setHistoryView } = selection;
  const { setSelectedSessionId } = selection;
  const { setThread } = sessionData;
  const { setSessions } = sessionData;
  const { pushLocalNotice } = notices;
  const scope = JSON.stringify([workspaceId, selection.selectedSessionId, selection.historyView]);
  const owner = useRef({ scope, generation: 0, mounted: true, lifetime: 0 });
  if (owner.current.scope !== scope) {
    owner.current.scope = scope;
    owner.current.generation += 1;
  }
  const generation = owner.current.generation;
  const pendingKeys = useRef(new Set<string>());
  const activeRequest = useRef<{ generation: number; turnId: string } | null>(null);
  useEffect(() => {
    const lifecycle = owner.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.lifetime += 1;
    };
  }, []);
  useEffect(() => {
    const pending = activeRequest.current;
    if (!pending || pending.generation === generation) return;
    setForkPending(false);
    setForkConfirm((current) => (current?.turnId === pending.turnId ? null : current));
  }, [generation, setForkConfirm, setForkPending]);

  const handleToggleContextTurn = useCallback(
    (turnId: string) => {
      setSelectedContextTurnIds((current) =>
        current.includes(turnId) ? current.filter((item) => item !== turnId) : [...current, turnId],
      );
      setPendingThreadContext(null);
    },
    [setPendingThreadContext, setSelectedContextTurnIds],
  );
  const handleClearContextSelection = useCallback(() => {
    setSelectedContextTurnIds([]);
    setPendingThreadContext((current) => (current?.sessionId === selection.selectedSessionId ? null : current));
  }, [selection.selectedSessionId, setPendingThreadContext, setSelectedContextTurnIds]);
  const handleStartNewThreadFromTurn = useCallback(
    async (turnId: string) => {
      if (!owner.current.mounted || owner.current.generation !== generation) return;
      const source = threadController.selectedSession;
      const thread = sessionData.thread;
      const turn = thread?.turns.find((item) => item.turnId === turnId);
      if (
        !source ||
        !selection.selectedSessionId ||
        source.sessionId !== selection.selectedSessionId ||
        (source.workspaceId ?? "default") !== workspaceId ||
        thread?.sessionId !== source.sessionId ||
        !turn ||
        turn.trace.sessionId !== source.sessionId ||
        turn.trace.turnId !== turnId ||
        turn.userMessage.sessionId !== source.sessionId ||
        !isChatTurnTerminalStatus(turn.trace.status)
      ) {
        setUiError("The source turn does not match the current conversation. Refresh before forking.");
        return;
      }
      const key = JSON.stringify([workspaceId, source.sessionId, turnId]);
      if (pendingKeys.current.has(key) || activeRequest.current?.generation === generation) return;
      const request = { generation, turnId };
      const lifetime = owner.current.lifetime;
      const ownsRequest = () =>
        owner.current.mounted &&
        owner.current.lifetime === lifetime &&
        owner.current.generation === generation &&
        activeRequest.current === request;
      pendingKeys.current.add(key);
      activeRequest.current = request;
      setUiError(null);
      setForkPending(true);
      try {
        const nextHistoryView = selection.historyView === "archived" ? "active" : selection.historyView;
        const result = await forkChatSessionFromTurn(source.sessionId, turnId, {
          expectedRevision: source.revision,
          title: `Fork of ${trimForkTitle(source.title || "Chat")}`,
        });
        if (!ownsRequest()) return;
        const { session, manifest } = result;
        if (
          !session?.sessionId ||
          session.sessionId === source.sessionId ||
          (session.workspaceId ?? "default") !== workspaceId ||
          session.lifecycleStatus !== "active" ||
          manifest?.manifestVersion !== CHAT_SESSION_FORK_MANIFEST_VERSION ||
          !manifest.forkId ||
          manifest.sourceSessionId !== source.sessionId ||
          manifest.sourceTurnId !== turnId ||
          manifest.newSessionId !== session.sessionId ||
          manifest.workspaceId !== workspaceId ||
          !/^[a-f0-9]{64}$/u.test(manifest.transcriptPathHash) ||
          !manifest.turnMappings?.some((mapping) => mapping.sourceTurnId === turnId && mapping.copiedTurnId) ||
          !session.forkRelationships?.some(
            (relation) =>
              relation.forkId === manifest.forkId &&
              relation.direction === "forked_from" &&
              relation.relatedSessionId === source.sessionId &&
              relation.sourceTurnId === turnId &&
              relation.transcriptPathHash === manifest.transcriptPathHash,
          )
        ) {
          throw new Error(
            "The Gateway did not confirm the requested fork identity. Refresh conversations before retrying.",
          );
        }
        // Publish the returned owner record before selecting it. The normal
        // selection effect owns hydration; an awaited sidebar preferred-selection
        // or extra core load here could overwrite navigation made after the fork.
        setSessions((current) => ({
          ...current,
          items: [
            session,
            ...(current?.items ?? []).filter(
              (item) =>
                item.sessionId !== session.sessionId &&
                (item.workspaceId ?? "default") === workspaceId &&
                item.lifecycleStatus === nextHistoryView,
            ),
          ],
        }));
        setForkPending(false);
        setForkConfirm((current) => (current?.turnId === turnId ? null : current));
        if (nextHistoryView !== selection.historyView) {
          setHistoryView(nextHistoryView);
        }
        setSelectedSessionId(session.sessionId);
        setSelectedTurnId(null);
        setSelectedContextTurnIds([]);
        setPendingThreadContext(null);
        setThread(null);
        setDraft("");
        pushLocalNotice("Created an independent fork with immutable source provenance.", "success");
        coordination.composerRef.current?.focus();
      } catch (cause) {
        if (ownsRequest()) setUiError(cause instanceof Error ? cause.message : "Unable to fork this conversation.");
      } finally {
        pendingKeys.current.delete(key);
        if (ownsRequest()) {
          setForkPending(false);
          setForkConfirm((current) => (current?.turnId === turnId ? null : current));
        }
        if (activeRequest.current === request) activeRequest.current = null;
      }
    },
    [
      coordination.composerRef,
      generation,
      workspaceId,
      selection.historyView,
      setSessions,
      pushLocalNotice,
      threadController.selectedSession,
      selection.selectedSessionId,
      setHistoryView,
      setSelectedSessionId,
      setThread,
      setUiError,
      sessionData.thread,
      setDraft,
      setForkConfirm,
      setForkPending,
      setPendingThreadContext,
      setSelectedContextTurnIds,
      setSelectedTurnId,
    ],
  );

  return { handleToggleContextTurn, handleClearContextSelection, handleStartNewThreadFromTurn };
}
