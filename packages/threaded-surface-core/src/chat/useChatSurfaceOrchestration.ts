import type { ChatAttachmentRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import { cancelChatTurn } from "@goatcitadel/mission-control-shared/api/client";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadView";

const ATTACHMENT_ONLY_SEND_PLACEHOLDER = "Please review the attached files and continue.";
let fallbackQueueItemIdCounter = 0;

function createQueueItemId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) {
    return `queue-${randomUUID}`;
  }
  fallbackQueueItemIdCounter = (fallbackQueueItemIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `queue-${Date.now()}-${fallbackQueueItemIdCounter}`;
}

export function resolveOutboundDraftContent(
  draft: string,
  attachmentCount: number,
  action: OutboundQueueItem["action"] = "send",
): string {
  const trimmed = draft.trim();
  if (trimmed) {
    return trimmed;
  }
  if (action === "send" && attachmentCount > 0) {
    return ATTACHMENT_ONLY_SEND_PLACEHOLDER;
  }
  return "";
}

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

export interface OutboundContextBlock {
  label: string;
  content: string;
  sourceLabel?: string;
  sourceSessionId?: string;
  turnIds?: string[];
  sessionId?: string;
  createdAt?: string;
}

export function resolveOutboundContentWithContext(content: string, context?: OutboundContextBlock | null): string {
  const trimmedContent = content.trim();
  const trimmedContext = context?.content.trim();
  if (!trimmedContext) {
    return trimmedContent;
  }
  return ["[Selected conversation context]", trimmedContext, "", "[New message]", trimmedContent].join("\n");
}

export function useChatSurfaceOrchestration(input: {
  draft: string;
  pendingAttachments: ChatAttachmentRecord[];
  outboundContext?: OutboundContextBlock | null;
  selectedSessionId: string | null;
  thread: ChatThreadResponse | null;
  sending: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
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
  setPendingAttachments: (
    value: ChatAttachmentRecord[] | ((current: ChatAttachmentRecord[]) => ChatAttachmentRecord[]),
  ) => void;
  setPendingApproval: (value: null) => void;
  setError: (value: string | null) => void;
  onOutboundContextConsumed?: () => void;
  loadSessionCoreStateRef: RefObject<
    (sessionId: string, options?: { background?: boolean; includeThread?: boolean }) => Promise<void>
  >;
  abortActiveChatStream: (
    stream: {
      sessionId: string;
      streamToken: string;
      turnId?: string;
      controller: AbortController;
    } | null,
  ) => void;
}) {
  const [queuedOutbound, setQueuedOutbound] = useState<OutboundQueueItem[]>([]);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const drainingQueueItemIdRef = useRef<string | null>(null);

  const handleSend = useCallback(async () => {
    const action: OutboundQueueItem["action"] = editingTurnId ? "edit" : "send";
    const draftContent = resolveOutboundDraftContent(input.draft, input.pendingAttachments.length, action);
    if (!draftContent) {
      return;
    }
    const content =
      action === "send" ? resolveOutboundContentWithContext(draftContent, input.outboundContext) : draftContent;
    const nextItem: OutboundQueueItem = {
      id: createQueueItemId(),
      action,
      sessionId: input.selectedSessionId ?? undefined,
      targetTurnId: editingTurnId ?? undefined,
      content,
      attachments: input.pendingAttachments,
      createdAt: new Date().toISOString(),
    };
    input.setDraft("");
    input.setPendingAttachments([]);
    input.setPendingApproval(null);
    if (action === "send" && input.outboundContext) {
      input.onOutboundContextConsumed?.();
    }
    if (!input.tryBeginOutboundExecutionRef.current?.()) {
      setQueuedOutbound((current) => [...current, nextItem]);
      input.pushLocalNoticeRef.current?.(
        `${editingTurnId ? "Edit" : "Message"} queued while the current turn finishes.`,
      );
      return;
    }
    await input.executeOutboundItemRef.current?.(nextItem);
  }, [editingTurnId, input]);

  const handleRetryTurn = useCallback(
    async (turnId: string) => {
      const nextItem: OutboundQueueItem = {
        id: createQueueItemId(),
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
    },
    [input],
  );

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

  const handleBeginEditTurn = useCallback(
    (turnId: string) => {
      const turn = input.thread?.turns.find((item) => item.turnId === turnId);
      if (!turn) {
        return;
      }
      setEditingTurnId(turnId);
      input.setDraft(turn.userMessage.content);
      input.composerRef.current?.focus();
    },
    [input],
  );

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

  const handleRemoveQueuedItem = useCallback(
    (id: string) => {
      recordClientDiagnostic({
        level: "info",
        category: "chat",
        event: "queue.remove",
        message: "Removed queued outbound chat item",
        sessionId: input.selectedSessionId ?? undefined,
        context: { id },
      });
      setQueuedOutbound((current) => current.filter((item) => item.id !== id));
    },
    [input.selectedSessionId],
  );

  useEffect(() => {
    if (drainingQueueItemIdRef.current) {
      return;
    }
    const nextItem = queuedOutbound.find((item) => !item.paused);
    if (input.sending || !nextItem) {
      return;
    }
    const executeOutboundItem = input.executeOutboundItemRef.current;
    if (!executeOutboundItem || !input.tryBeginOutboundExecutionRef.current?.()) {
      return;
    }
    drainingQueueItemIdRef.current = nextItem.id;
    setQueuedOutbound((current) => current.filter((item) => item.id !== nextItem.id));
    void executeOutboundItem(nextItem)
      .finally(() => {
        if (drainingQueueItemIdRef.current === nextItem.id) {
          drainingQueueItemIdRef.current = null;
        }
        setQueuedOutbound((current) => (current.some((item) => !item.paused) ? [...current] : current));
      })
      .catch(() => undefined);
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
