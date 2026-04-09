import type { LearnedMemoryItemRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import { useCallback } from "react";
import { rebuildChatLearnedMemory, updateChatLearnedMemoryItem } from "../../api/client";

export function useChatMemoryRefreshActions(input: {
  selectedSession: ChatSessionRecord | null;
  sending: boolean;
  setSending: (value: boolean) => void;
  setError: (value: string | null) => void;
  setLearnedMemory: React.Dispatch<React.SetStateAction<LearnedMemoryItemRecord[]>>;
}) {
  const { selectedSession, sending, setSending, setError, setLearnedMemory } = input;

  const handleMemoryStatusUpdate = useCallback(
    async (itemId: string, status: "active" | "superseded" | "conflict" | "disabled") => {
      if (!selectedSession) return;
      try {
        const updated = await updateChatLearnedMemoryItem(selectedSession.sessionId, itemId, { status });
        setLearnedMemory((current) => current.map((item) => (item.itemId === itemId ? updated : item)));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [selectedSession, setError, setLearnedMemory],
  );

  const handleRebuildLearnedMemory = useCallback(async () => {
    if (!selectedSession || sending) return;
    setSending(true);
    try {
      const rebuilt = await rebuildChatLearnedMemory(selectedSession.sessionId);
      setLearnedMemory(rebuilt.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [selectedSession, sending, setError, setLearnedMemory, setSending]);

  return {
    handleMemoryStatusUpdate,
    handleRebuildLearnedMemory,
  };
}
