import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getGatewayAccessRevision, subscribeGatewayAccessChange, getGatewayCallerScope, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
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
  const access = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, getGatewayCallerScope);
  const identity = JSON.stringify([getGatewayApiBaseUrl(), access, caller, input.workspaceId, input.selectedSessionId]);
  const scopeRef = useRef({ identity });
  if (scopeRef.current.identity !== identity) scopeRef.current = { identity };
  const scope = scopeRef.current;
  const mounted = useRef(true);
  const current = useCallback(() => mounted.current && scopeRef.current === scope && access === getGatewayAccessRevision() && caller === getGatewayCallerScope(), [scope, access, caller]);
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
        onFlush: (preview) => { if (current()) setStreamingPreview(preview); },
        isReducedMotion: isReducedMotionPreferred,
      });
    }
    return streamingPreviewBufferRef.current;
  }, [current]);

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
    streamingPreviewBufferRef.current?.dispose();
    streamingPreviewBufferRef.current = null;
    setStreamingPreview(null);
    setLoading(false);
    setSending(false);
    sendingRef.current = false;
    threadRef.current = null;
  }, [identity]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; streamingPreviewBufferRef.current?.dispose(); };
  }, []);

  const ensureSideChat = useCallback(async (): Promise<{
    item: ChatSideChatRecord;
    childSession: ChatSessionRecord;
  }> => {
    const parent = await input.ensureSession();
    if (!current()) throw new Error("Side chat scope changed. Reopen it in the current conversation.");
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
      if (!current()) throw new Error("Side chat scope changed.");
      setRecord(created.item);
      setChildSession(created.childSession);
      const nextThread = await fetchChatThread(created.childSession.sessionId);
      if (!current()) throw new Error("Side chat scope changed.");
      setThread(nextThread);
      setError(null);
      return created;
    } finally {
      if (current()) setLoading(false);
    }
  }, [childSession, input, record, current]);

  const sendMessage = useCallback(
    async (messageOverride?: string) => {
      if (!current()) return;
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
      sendingRef.current = true;
      let sideChat: Awaited<ReturnType<typeof ensureSideChat>>;
      try {
        sideChat = await ensureSideChat();
      } catch (cause) {
        if (!current()) return;
        sendingRef.current = false;
        const nextError = cause instanceof Error ? cause.message : "Failed to open side chat.";
        setError(nextError);
        input.setUiError(nextError);
        return;
      }

      if (!current()) return;
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
        sourceAuthority: "operator",
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
        if (!current()) return;
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
            if (!current()) return;
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
        if (!current()) return;
        const finalThread = await fetchChatThread(sideChat.childSession.sessionId);
        if (current()) setThread(finalThread);
      } catch (cause) {
        if (!current()) return;
        promoteStreamingPreviewToThread(sideChat.childSession.sessionId);
        const nextError = cause instanceof Error ? cause.message : "Side chat failed.";
        setError(nextError);
      } finally {
        if (current()) {
          sendingRef.current = false;
          setSending(false);
          clearStreamingPreview({ allowSettlingFinalText: true });
        }
      }
    },
    [clearStreamingPreview, current, draft, ensureSideChat, getStreamingPreviewBuffer, input, promoteStreamingPreviewToThread],
  );

  const openSideChat = useCallback(
    async (message?: string) => {
      if (!current()) return;
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
        if (!current()) return;
        const nextError = cause instanceof Error ? cause.message : "Failed to open side chat.";
        setError(nextError);
        input.setUiError(nextError);
      }
    },
    [ensureSideChat, input, sendMessage, current],
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
