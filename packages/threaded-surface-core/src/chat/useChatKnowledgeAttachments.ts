import { useCallback, type Dispatch, type SetStateAction } from "react";
import type {
  ChatAttachmentRecord,
  ThreadKnowledgeAttachmentRecord,
  ThreadKnowledgeRetrievalMode,
} from "@goatcitadel/contracts";
import { attachThreadKnowledgeAttachment } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatThreadNotice } from "@goatcitadel/mission-control-shared/components/chat/ChatThreadPrimitives";
import {
  isDocumentAttachment,
  canReadAttachmentInFull,
  type PendingAttachmentDocumentMode,
} from "./mission-threaded-controller-helpers";
import type { useChatSessionControls } from "./useChatSessionControls";
import type { useChatSessionData } from "./useChatSessionData";

type Input = {
  pendingAttachments: ChatAttachmentRecord[];
  pendingAttachmentModes: Record<string, PendingAttachmentDocumentMode>;
  setPendingAttachmentModes: Dispatch<SetStateAction<Record<string, PendingAttachmentDocumentMode>>>;
  knowledgeUrlDraft: string;
  knowledgeUrlMode: ThreadKnowledgeRetrievalMode;
  setKnowledgeUrlDraft: Dispatch<SetStateAction<string>>;
  ensureSession: ReturnType<typeof useChatSessionControls>["ensureSession"];
  threadKnowledgeAttachments: ReturnType<typeof useChatSessionData>["threadKnowledgeAttachments"];
  setThreadKnowledgeAttachments: ReturnType<typeof useChatSessionData>["setThreadKnowledgeAttachments"];
  pushLocalNotice: (content: string, tone?: ChatThreadNotice["tone"]) => void;
  setUiError: (value: string | null) => void;
};

export function useChatKnowledgeAttachments({
  pendingAttachments,
  pendingAttachmentModes,
  setPendingAttachmentModes,
  knowledgeUrlDraft,
  knowledgeUrlMode,
  setKnowledgeUrlDraft,
  ensureSession,
  threadKnowledgeAttachments,
  setThreadKnowledgeAttachments,
  pushLocalNotice,
  setUiError,
}: Input) {
  const handleSetPendingAttachmentMode = useCallback(
    (attachmentId: string, mode: PendingAttachmentDocumentMode) => {
      setPendingAttachmentModes((current) => ({
        ...current,
        [attachmentId]: mode,
      }));
    },
    [setPendingAttachmentModes],
  );
  const requiresThreadKnowledge =
    pendingAttachments.some((attachment) => {
      const mode = pendingAttachmentModes[attachment.attachmentId] ?? "message";
      return isDocumentAttachment(attachment) && mode !== "message";
    }) || knowledgeUrlDraft.trim().length > 0;
  const attachPendingKnowledgeSources = useCallback(async () => {
    const normalizedKnowledgeUrl = knowledgeUrlDraft.trim();
    if (!requiresThreadKnowledge) {
      return;
    }
    const session = await ensureSession();
    const existingKeys = new Set(
      (threadKnowledgeAttachments?.items ?? []).map((item) =>
        item.chatAttachmentId
          ? `${item.chatAttachmentId}:${item.retrievalMode}`
          : `url:${normalizeThreadKnowledgeUrlKey(item.sourceRef)}:${item.retrievalMode}`,
      ),
    );
    const nextItems: ThreadKnowledgeAttachmentRecord[] = [...(threadKnowledgeAttachments?.items ?? [])];

    for (const attachment of pendingAttachments) {
      if (!isDocumentAttachment(attachment)) {
        continue;
      }
      const mode = pendingAttachmentModes[attachment.attachmentId] ?? "message";
      if (mode === "message") {
        continue;
      }
      if (mode === "full_text" && !canReadAttachmentInFull(attachment)) {
        throw new Error(`${attachment.fileName} is not ready for full-text context yet. Use retrieval instead.`);
      }
      const key = `${attachment.attachmentId}:${mode}`;
      if (existingKeys.has(key)) {
        continue;
      }
      const response = await attachThreadKnowledgeAttachment(session.sessionId, {
        chatAttachmentId: attachment.attachmentId,
        title: attachment.fileName,
        retrievalMode: mode,
      });
      existingKeys.add(key);
      nextItems.unshift(response.item);
    }

    if (normalizedKnowledgeUrl) {
      const urlKey = `url:${normalizeThreadKnowledgeUrlKey(normalizedKnowledgeUrl)}:${knowledgeUrlMode}`;
      if (!existingKeys.has(urlKey)) {
        const response = await attachThreadKnowledgeAttachment(session.sessionId, {
          url: normalizedKnowledgeUrl,
          title: normalizedKnowledgeUrl,
          retrievalMode: knowledgeUrlMode,
        });
        nextItems.unshift(response.item);
      }
      setKnowledgeUrlDraft("");
    }

    setThreadKnowledgeAttachments({ items: nextItems });
  }, [
    ensureSession,
    knowledgeUrlDraft,
    knowledgeUrlMode,
    pendingAttachmentModes,
    pendingAttachments,
    requiresThreadKnowledge,
    setKnowledgeUrlDraft,
    setThreadKnowledgeAttachments,
    threadKnowledgeAttachments?.items,
  ]);
  const handleAttachKnowledgeUrlValue = useCallback(
    async (value: string) => {
      const normalizedKnowledgeUrl = value.trim();
      if (!normalizedKnowledgeUrl) {
        return;
      }
      try {
        const session = await ensureSession();
        const response = await attachThreadKnowledgeAttachment(session.sessionId, {
          url: normalizedKnowledgeUrl,
          title: normalizedKnowledgeUrl,
          retrievalMode: knowledgeUrlMode,
        });
        setThreadKnowledgeAttachments((current) => ({
          items: [
            response.item,
            ...(current?.items ?? []).filter((item) => item.attachmentId !== response.item.attachmentId),
          ],
        }));
        if (knowledgeUrlDraft.trim() === normalizedKnowledgeUrl) setKnowledgeUrlDraft("");
        pushLocalNotice("Attached a thread knowledge source.", "success");
      } catch (cause) {
        setUiError(cause instanceof Error ? cause.message : "Unable to attach thread knowledge source.");
      }
    },
    [
      ensureSession,
      knowledgeUrlMode,
      setThreadKnowledgeAttachments,
      knowledgeUrlDraft,
      setKnowledgeUrlDraft,
      pushLocalNotice,
      setUiError,
    ],
  );
  const handleAttachKnowledgeUrl = useCallback(
    () => handleAttachKnowledgeUrlValue(knowledgeUrlDraft),
    [handleAttachKnowledgeUrlValue, knowledgeUrlDraft],
  );
  return {
    handleSetPendingAttachmentMode,
    requiresThreadKnowledge,
    attachPendingKnowledgeSources,
    handleAttachKnowledgeUrlValue,
    handleAttachKnowledgeUrl,
  };
}

function normalizeThreadKnowledgeUrlKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}
