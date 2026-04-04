import type { ChatAttachmentRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { cancelChatTurn } from "../../api/client";
import { recordClientDiagnostic } from "../../state/dev-diagnostics-store";
import { useCallback, useEffect, useState, type RefObject } from "react";
import type { ChatThreadNotice } from "../../components/chat/ChatThreadView";

export interface OutboundQueueItem {
  id: string;
  action: "send" | "edit" | "retry";
  sessionId?: string;
  targetTurnId?: string;
  content: string;
  attachments: ChatAttachmentRecord[];
  createdAt: string;
  paused?: boolean;
}

export function useChatSurfaceOrchestration(input: {
  draft: string;
  pendingAttachments: ChatAttachmentRecord[];
  selectedSessionId: string | null;
  thread: ChatThreadResponse | null;
  sending: boolean;
  composerRef: RefObject<HTMLTextAreaElement>;
  activeStreamRef: RefObject<{
    sessionId: string;
    streamToken: string;
    turnId?: string;
    controller: AbortController;
  } | null>;
  tryBeginOutboundExecutionRef: RefObject<() => boolean>;
  executeOutboundItemRef: RefObject<(item: OutboundQueueItem) => Promise<void>>;
  pushLocalNoticeRef: RefObject<(message: string, tone?: ChatThreadNotice["tone"]) => void>;
  setDraft: (value: string) => void;
  setPendingAttachments: (value: ChatAttachmentRecord[] | ((current: ChatAttachmentRecord[]) => ChatAttachmentRecord[])) => void;
  setPendingApproval: (value: null) => void;
  setError: (value: string | null) => void;
  loadSessionCoreStateRef: RefObject<(sessionId: string, options?: { background?: boolean; includeThread?: boolean }) => Promise<void>>;
  abortActiveChatStream: (stream: {
    sessionId: string;
    streamToken: string;
    turnId?: string;
    controller: AbortController;
  } | null) => void;
}) {
  const [queuedOutbound, setQueuedOutbound] = useState<OutboundQueueItem[]>([]);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);

  const handleSend = useCallback(async () => {
    const content = input.draft.trim();
    if (!content) {
      return;
    }
    const nextItem: OutboundQueueItem = {
      id: `queue-${Date.now()}`,
      action: editingTurnId ? "edit" : "send",
      sessionId: input.selectedSessionId ?? undefined,
      targetTurnId: editingTurnId ?? undefined,
      content,
      attachments: input.pendingAttachments,
      createdAt: new Date().toISOString(),
    };
    input.setDraft("");
    input.setPendingAttachments([]);
    input.setPendingApproval(null);
    if (!input.tryBeginOutboundExecutionRef.current?.()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      input.pushLocalNoticeRef.current?.(`${editingTurnId ? "Edit" : "Message"} queued while the current turn finishes.`);
      return;
    }
    await input.executeOutboundItemRef.current?.(nextItem);
  }, [editingTurnId, input]);

  const handleRetryTurn = useCallback(async (turnId: string) => {
    const nextItem: OutboundQueueItem = {
      id: `queue-${Date.now()}`,
      action: "retry",
      sessionId: input.selectedSessionId ?? undefined,
      targetTurnId: turnId,
      content: "",
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    if (!input.tryBeginOutboundExecutionRef.current?.()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      input.pushLocalNoticeRef.current?.("Retry queued while the current turn finishes.");
      return;
    }
    await input.executeOutboundItemRef.current?.(nextItem);
  }, [input]);

  const handleStopActiveTurn = useCallback(async () => {
    if (!input.selectedSessionId) {
      return;
    }
    const activeStream = input.activeStreamRef.current;
    if (!activeStream) {
      return;
    }
    try {
      if (activeStream.turnId) {
        await cancelChatTurn(input.selectedSessionId, activeStream.turnId, "mission-control");
        input.pushLocalNoticeRef.current?.(`Stopped turn ${activeStream.turnId.slice(-6)}.`, "warning");
        const reloadSession = input.loadSessionCoreStateRef.current;
        if (reloadSession) {
          void reloadSession(input.selectedSessionId, {
            background: true,
            includeThread: true,
          }).catch(() => undefined);
        }
      } else {
        input.pushLocalNoticeRef.current?.("Stopped the local connection before the turn id was assigned.", "warning");
      }
    } catch (err) {
      input.setError((err as Error).message);
    } finally {
      input.abortActiveChatStream(activeStream);
    }
  }, [input]);

  const handleBeginEditTurn = useCallback((turnId: string) => {
    const turn = input.thread?.turns.find((item) => item.turnId === turnId);
    if (!turn) {
      return;
    }
    setEditingTurnId(turnId);
    input.setDraft(turn.userMessage.content);
    input.composerRef.current?.focus();
  }, [input]);

  const handleResumeQueue = useCallback(() => {
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "queue.resume",
      message: "Resuming queued outbound chat items",
      sessionId: input.selectedSessionId ?? undefined,
      context: {
        queuedCount: queuedOutbound.length,
      },
    });
    setQueuedOutbound((current) => current.map((item) => ({ ...item, paused: false })));
  }, [input.selectedSessionId, input.pushLocalNoticeRef, queuedOutbound.length]);

  const handleRemoveQueuedItem = useCallback((id: string) => {
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "queue.remove",
      message: "Removed queued outbound chat item",
      sessionId: input.selectedSessionId ?? undefined,
      context: { id },
    });
    setQueuedOutbound((current) => current.filter((item) => item.id !== id));
  }, [input.selectedSessionId]);

  useEffect(() => {
    const nextItem = queuedOutbound.find((item) => !item.paused);
    if (input.sending || !nextItem) {
      return;
    }
    if (!input.tryBeginOutboundExecutionRef.current?.()) {
      return;
    }
    setQueuedOutbound((current) => current.filter((item) => item.id !== nextItem.id));
    void input.executeOutboundItemRef.current?.(nextItem);
  }, [input.executeOutboundItemRef, input.sending, input.tryBeginOutboundExecutionRef, queuedOutbound]);

  return {
    queuedOutbound,
    setQueuedOutbound,
    editingTurnId,
    setEditingTurnId,
    handleSend,
    handleRetryTurn,
    handleStopActiveTurn,
    handleBeginEditTurn,
    handleResumeQueue,
    handleRemoveQueuedItem,
  };
}
