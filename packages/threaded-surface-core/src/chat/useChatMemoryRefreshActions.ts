import type { LearnedMemoryItemRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import { useCallback } from "react";
import {
  fetchChatLearnedMemory,
  rebuildChatLearnedMemory,
  updateChatLearnedMemoryItem,
} from "@goatcitadel/mission-control-shared/api/client";
import { useChatContextMutationOwner } from "./useChatContextMutationOwner";
import { assertContextRecord } from "./context-mutation-evidence";

export function useChatMemoryRefreshActions(input: {
  workspaceId?: string;
  historicalRevisionRef?: { readonly current: number };
  historicalReadOnly?: boolean;
  selectionRevisionRef?: { readonly current: number };
  sendingRevisionRef?: { readonly current: number };
  selectedSession: ChatSessionRecord | null;
  sending: boolean;
  setSending: (value: boolean) => void;
  setError: (value: string | null) => void;
  setLearnedMemory: React.Dispatch<React.SetStateAction<LearnedMemoryItemRecord[]>>;
}) {
  const { selectedSession, sending, setSending, setError, setLearnedMemory } = input;
  const workspaceId = input.workspaceId ?? selectedSession?.workspaceId ?? "default";
  const owner = useChatContextMutationOwner({
    family: "learned-memory",
    workspaceId,
    sessionId: selectedSession?.sessionId ?? null,
    sessionWorkspaceId: selectedSession?.workspaceId,
    historicalRevisionRef: input.historicalRevisionRef,
    historicalReadOnly: input.historicalReadOnly,
    selectionRevisionRef: input.selectionRevisionRef,
    sendingRevisionRef: input.sendingRevisionRef,
    setError,
  });
  const { run: runMemoryMutation, inspect: inspectMemoryMutation, projection: memoryProjection } = owner;
  const handleMemoryStatusUpdate = useCallback(
    async (itemId: string, status: "active" | "superseded" | "conflict" | "disabled"): Promise<void> => {
      if (!selectedSession) return;
      await runMemoryMutation(
        "learned-memory-status",
        () => updateChatLearnedMemoryItem(selectedSession.sessionId, itemId, { status }),
        (updated) => {
          const id = assertContextRecord(updated, selectedSession.sessionId, workspaceId, "itemId", itemId);
          if (updated.status !== status)
            throw new TypeError("The memory receipt does not confirm the requested status.");
          return [id];
        },
        (updated, publicationCurrent) =>
          setLearnedMemory((current) =>
            publicationCurrent() ? current.map((item) => (item.itemId === itemId ? updated : item)) : current,
          ),
      );
    },
    [selectedSession, workspaceId, runMemoryMutation, setLearnedMemory],
  );
  const handleRebuildLearnedMemory = useCallback(async (): Promise<void> => {
    if (!selectedSession || sending) return;
    await runMemoryMutation(
      "learned-memory-rebuild",
      () => rebuildChatLearnedMemory(selectedSession.sessionId),
      (rebuilt) => {
        if (!Array.isArray(rebuilt.items) || typeof rebuilt.rebuiltAt !== "string" || !rebuilt.rebuiltAt)
          throw new TypeError("The Gateway returned no canonical rebuild receipt.");
        return [
          selectedSession.sessionId,
          ...rebuilt.items.map((item) => assertContextRecord(item, selectedSession.sessionId, workspaceId, "itemId")),
        ];
      },
      (rebuilt, publicationCurrent) => setLearnedMemory((current) => (publicationCurrent() ? rebuilt.items : current)),
      { begin: () => setSending(true), end: () => setSending(false) },
    );
  }, [selectedSession, sending, workspaceId, runMemoryMutation, setLearnedMemory, setSending]);
  const handleInspectLearnedMemory = useCallback(async (): Promise<void> => {
    if (!selectedSession) return;
    await inspectMemoryMutation(
      () => fetchChatLearnedMemory(selectedSession.sessionId, 1000),
      (result) => {
        if (!Array.isArray(result.items)) throw new TypeError("The Gateway returned no learned-memory items.");
        result.items.forEach((item) => assertContextRecord(item, selectedSession.sessionId, workspaceId, "itemId"));
      },
      (result, publicationCurrent) => setLearnedMemory((current) => (publicationCurrent() ? result.items : current)),
    );
  }, [selectedSession, workspaceId, inspectMemoryMutation, setLearnedMemory]);
  return {
    handleMemoryStatusUpdate,
    handleRebuildLearnedMemory,
    learnedMemoryMutation: { ...memoryProjection, onInspect: handleInspectLearnedMemory },
  };
}
