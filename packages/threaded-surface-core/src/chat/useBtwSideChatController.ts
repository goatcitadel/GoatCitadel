import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import type {
  ChatMode,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSideChatRecord,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import {
  createChatSideChat,
  fetchChatThread,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatStreamingPreviewBuffer, ChatStreamingPreview } from "./chat-streaming-preview";
import type { ChatPreviewRuntime } from "./useChatStreamingPreviewState";

type SideChatStream = typeof import("./btw-side-chat-stream.js");
let sideChatStream: Promise<SideChatStream> | undefined;

function loadSideChatStream() {
  return (sideChatStream ??= import("./btw-side-chat-stream.js").catch((error: unknown) => {
    sideChatStream = undefined;
    throw error;
  }));
}

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
  const caller = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const installation = getGatewayApiBaseUrl();
  const identity = JSON.stringify([installation, access, caller, input.workspaceId, input.selectedSessionId]);
  const scopeRef = useRef({ identity });
  if (scopeRef.current.identity !== identity) scopeRef.current = { identity };
  const scope = scopeRef.current;
  const mounted = useRef(true);
  const current = useCallback(
    () =>
      mounted.current &&
      scopeRef.current === scope &&
      installation === getGatewayApiBaseUrl() &&
      access === getGatewayAccessRevision() &&
      caller === getGatewayCallerScopeRevision(),
    [scope, installation, access, caller],
  );
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

  const getStreamingPreviewBuffer = useCallback((runtime: ChatPreviewRuntime) => {
    if (!streamingPreviewBufferRef.current) {
      streamingPreviewBufferRef.current = new runtime.ChatStreamingPreviewBuffer({
        onFlush: (preview) => { if (current()) setStreamingPreview(preview); },
        isReducedMotion: runtime.isReducedMotionPreferred,
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
    (sessionId: string, project: SideChatStream["createInterruptedBtwReplyProjection"]) => {
      const snapshot = streamingPreviewBufferRef.current?.getSnapshot({ forceVisible: true });
      if (!snapshot || snapshot.sessionId !== sessionId || snapshot.text.trim().length === 0) {
        clearStreamingPreview();
        return;
      }
      setThread(project(snapshot));
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
      let code: SideChatStream;
      try {
        code = await loadSideChatStream();
        if (!current()) return;
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
      try {
        await code.streamBtwSideChatTurn({
          current,
          getStreamingPreviewBuffer,
          input,
          message,
          parentTurnId: threadRef.current?.activeLeafTurnId,
          promoteStreamingPreviewToThread,
          setError,
          setThread,
          sideChat,
        });
      } catch (cause) {
        if (!current()) return;
        promoteStreamingPreviewToThread(sideChat.childSession.sessionId, code.createInterruptedBtwReplyProjection);
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
