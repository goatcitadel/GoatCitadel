import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessageRecord,
  ChatMode,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSideChatRecord,
  ChatStreamChunk,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import {
  createChatSideChat,
  fetchChatThread,
  preflightChatRoute,
  streamAgentChatMessage,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  isThreadMutatingStreamChunk,
  type PendingStreamTurnSeed,
  updateThreadFromStreamChunk,
} from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import {
  ChatStreamingPreviewBuffer,
  isReducedMotionPreferred,
  type ChatStreamingPreview,
} from "./chat-streaming-preview";

export interface MissionThreadedBtwSideChatProps {
  open: boolean;
  workspaceId: string;
  parentSessionId: string | null;
  parentTitle: string;
  childSessionId: string | null;
  thread: ChatThreadResponse | null;
  streamingPreview: ChatStreamingPreview | null;
  draft: string;
  loading: boolean;
  sending: boolean;
  error: string | null;
  onClose: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
}

export function useBtwSideChatController(input: {
  workspaceId: string;
  selectedSession: ChatSessionRecord | null;
  selectedSessionId: string | null;
  selectedTurnId: string | null;
  currentSurface: ChatMode;
  prefs: ChatSessionPrefsRecord | null;
  selectedProviderId?: string;
  selectedModel?: string;
  fullWebAccess: boolean;
  ensureSession: () => Promise<ChatSessionRecord>;
  pushLocalNotice: (message: string, tone?: "success" | "warning" | "neutral") => void;
  setUiError: (message: string | null) => void;
}): {
  panelProps: MissionThreadedBtwSideChatProps;
  openSideChat: (message?: string) => Promise<void>;
} {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [record, setRecord] = useState<ChatSideChatRecord | null>(null);
  const [childSession, setChildSession] = useState<ChatSessionRecord | null>(null);
  const [thread, setThread] = useState<ChatThreadResponse | null>(null);
  const [streamingPreview, setStreamingPreview] = useState<ChatStreamingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<ChatThreadResponse | null>(null);
  const sendingRef = useRef(false);
  const streamingPreviewBufferRef = useRef<ChatStreamingPreviewBuffer | null>(null);

  const getStreamingPreviewBuffer = useCallback(() => {
    if (!streamingPreviewBufferRef.current) {
      streamingPreviewBufferRef.current = new ChatStreamingPreviewBuffer({
        onFlush: setStreamingPreview,
        isReducedMotion: isReducedMotionPreferred,
      });
    }
    return streamingPreviewBufferRef.current;
  }, []);

  const clearStreamingPreview = useCallback((options: { allowSettlingFinalText?: boolean } = {}) => {
    if (options.allowSettlingFinalText && streamingPreviewBufferRef.current?.isSettlingFinalText()) {
      return;
    }
    streamingPreviewBufferRef.current?.clear();
    setStreamingPreview(null);
  }, []);

  const promoteStreamingPreviewToThread = useCallback(
    (sessionId: string) => {
      const snapshot = streamingPreviewBufferRef.current?.getSnapshot({ forceVisible: true });
      if (!snapshot || snapshot.sessionId !== sessionId || snapshot.text.trim().length === 0) {
        clearStreamingPreview();
        return;
      }
      const partialChunk: ChatStreamChunk = {
        type: "message_done",
        sessionId: snapshot.sessionId,
        eventId: `local-btw-preview-${Date.now()}`,
        sequence: -1,
        turnId: snapshot.turnId,
        messageId: snapshot.messageId ?? `local-assistant-${snapshot.turnId}`,
        content: snapshot.text,
      };
      setThread((current) => updateThreadFromStreamChunk(current, partialChunk, null, snapshot.sessionId, null));
      clearStreamingPreview();
    },
    [clearStreamingPreview],
  );

  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    setOpen(false);
    setDraft("");
    setRecord(null);
    setChildSession(null);
    setThread(null);
    setError(null);
    streamingPreviewBufferRef.current?.clear();
    setStreamingPreview(null);
  }, [input.selectedSessionId]);

  useEffect(() => () => streamingPreviewBufferRef.current?.dispose(), []);

  const ensureSideChat = useCallback(async (): Promise<{
    item: ChatSideChatRecord;
    childSession: ChatSessionRecord;
  }> => {
    const parent = await input.ensureSession();
    if (record?.parentSessionId === parent.sessionId && childSession) {
      return { item: record, childSession };
    }
    setLoading(true);
    try {
      const created = await createChatSideChat(
        parent.sessionId,
        {
          createdFromSurface: input.currentSurface,
          sourceTurnId: input.selectedTurnId ?? undefined,
        },
        { originSurface: input.currentSurface },
      );
      setRecord(created.item);
      setChildSession(created.childSession);
      const nextThread = await fetchChatThread(created.childSession.sessionId);
      setThread(nextThread);
      setError(null);
      return created;
    } finally {
      setLoading(false);
    }
  }, [childSession, input, record]);

  const sendMessage = useCallback(
    async (messageOverride?: string) => {
      const message = (messageOverride ?? draft).trim();
      setOpen(true);
      if (!message) {
        return;
      }
      if (sendingRef.current) {
        setDraft(message);
        input.pushLocalNotice("Side chat is still responding.", "warning");
        return;
      }
      let sideChat: Awaited<ReturnType<typeof ensureSideChat>>;
      try {
        sideChat = await ensureSideChat();
      } catch (cause) {
        const nextError = cause instanceof Error ? cause.message : "Failed to open side chat.";
        setError(nextError);
        input.setUiError(nextError);
        return;
      }

      setSending(true);
      setError(null);
      setDraft("");
      const optimisticPrefs = buildBtwOptimisticPrefs(input.prefs, input.selectedProviderId, input.selectedModel);
      const userMessage: ChatMessageRecord = {
        messageId: `local-btw-user-${Date.now()}`,
        sessionId: sideChat.childSession.sessionId,
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: message,
        timestamp: new Date().toISOString(),
      };
      const seed: PendingStreamTurnSeed = {
        userMessage,
        parentTurnId: threadRef.current?.activeLeafTurnId,
        branchKind: "append",
        mode: "send",
      };

      try {
        const route = await preflightChatRoute(
          sideChat.childSession.sessionId,
          {
            action: "send",
            providerId: input.selectedProviderId,
            model: input.selectedModel,
            mode: "chat",
            prefsOverride: buildBtwPrefsOverride(input.prefs, input.selectedProviderId, input.selectedModel),
          },
          { originSurface: "chat" },
        );
        if (route.blockedReason) {
          throw new Error(route.blockedReason);
        }
        await streamAgentChatMessage(
          sideChat.childSession.sessionId,
          {
            content: message,
            providerId: route.effectiveProviderId ?? input.selectedProviderId,
            model: route.effectiveModel ?? input.selectedModel,
            routeDecision: route.decision,
            mode: "chat",
            prefsOverride: buildBtwPrefsOverride(input.prefs, route.effectiveProviderId, route.effectiveModel),
            fullWebAccess: input.fullWebAccess,
            sideChatContext: {
              parentSessionId: sideChat.item.parentSessionId,
              originSurface: input.currentSurface,
              selectedTurnId: input.selectedTurnId ?? undefined,
              recentTurnLimit: 6,
            },
          },
          (chunk: ChatStreamChunk) => {
            if (chunk.type === "error") {
              setError(chunk.error || "Side chat stream failed.");
              promoteStreamingPreviewToThread(sideChat.childSession.sessionId);
              return;
            }
            if (chunk.type === "message_start") {
              getStreamingPreviewBuffer().start({
                sessionId: chunk.sessionId,
                turnId: chunk.turnId,
                messageId: chunk.messageId,
              });
            }
            if (chunk.type === "delta") {
              // Per-token deltas feed the rAF-coalesced preview buffer instead of the
              // thread, so thread identity only changes on real chunk boundaries.
              getStreamingPreviewBuffer().append({
                sessionId: chunk.sessionId,
                turnId: chunk.turnId,
                messageId: chunk.messageId,
                delta: chunk.delta,
              });
              return;
            }
            if (chunk.type === "message_done") {
              const previewBuffer = getStreamingPreviewBuffer();
              if (!previewBuffer.matches(chunk.sessionId, chunk.turnId)) {
                previewBuffer.start({
                  sessionId: chunk.sessionId,
                  turnId: chunk.turnId,
                  messageId: chunk.messageId,
                });
              }
              previewBuffer.finish({ clear: true, forceVisible: false, finalText: chunk.content });
            }
            if (!isThreadMutatingStreamChunk(chunk)) {
              return;
            }
            setThread((current) =>
              updateThreadFromStreamChunk(current, chunk, seed, sideChat.childSession.sessionId, optimisticPrefs),
            );
          },
          { originSurface: "chat" },
        );
        setThread(await fetchChatThread(sideChat.childSession.sessionId));
      } catch (cause) {
        promoteStreamingPreviewToThread(sideChat.childSession.sessionId);
        const nextError = cause instanceof Error ? cause.message : "Side chat failed.";
        setError(nextError);
      } finally {
        setSending(false);
        clearStreamingPreview({ allowSettlingFinalText: true });
      }
    },
    [clearStreamingPreview, draft, ensureSideChat, getStreamingPreviewBuffer, input, promoteStreamingPreviewToThread],
  );

  const openSideChat = useCallback(
    async (message?: string) => {
      setOpen(true);
      if (message?.trim() && sendingRef.current) {
        setDraft(message.trim());
        input.pushLocalNotice("Side chat is still responding.", "warning");
        return;
      }
      if (message?.trim()) {
        await sendMessage(message);
        return;
      }
      try {
        await ensureSideChat();
      } catch (cause) {
        const nextError = cause instanceof Error ? cause.message : "Failed to open side chat.";
        setError(nextError);
        input.setUiError(nextError);
      }
    },
    [ensureSideChat, input, sendMessage],
  );

  const panelProps: MissionThreadedBtwSideChatProps = {
    open,
    workspaceId: input.workspaceId,
    parentSessionId: record?.parentSessionId ?? input.selectedSessionId,
    parentTitle: input.selectedSession?.title?.trim() || "Current chat",
    childSessionId: childSession?.sessionId ?? record?.childSessionId ?? null,
    thread,
    streamingPreview,
    draft,
    loading,
    sending,
    error,
    onClose: () => setOpen(false),
    onDraftChange: setDraft,
    onSend: () => void sendMessage(),
  };

  return { panelProps, openSideChat };
}

function buildBtwPrefsOverride(
  prefs: ChatSessionPrefsRecord | null,
  providerId?: string,
  model?: string,
): ChatSessionPrefsPatch {
  return {
    mode: "chat",
    providerId: providerId ?? prefs?.providerId,
    model: model ?? prefs?.model,
    webMode: prefs?.webMode,
    memoryMode: prefs?.memoryMode,
    thinkingLevel: prefs?.thinkingLevel,
    speedMode: prefs?.speedMode,
    subagentPolicy: prefs?.subagentPolicy,
  };
}

function buildBtwOptimisticPrefs(
  prefs: ChatSessionPrefsRecord | null,
  providerId?: string,
  model?: string,
): ChatSessionPrefsRecord | null {
  return prefs
    ? {
        ...prefs,
        mode: "chat",
        providerId: providerId ?? prefs.providerId,
        model: model ?? prefs.model,
      }
    : null;
}
