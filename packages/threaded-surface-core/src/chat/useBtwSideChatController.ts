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
import type { ChatStreamingPreviewBuffer, ChatStreamingPreview } from "./chat-streaming-preview";
import type { ChatPreviewRuntime } from "./useChatStreamingPreviewState";
import type { useChatSessionSelection } from "./controller/useChatSessionSelection";

type SideChatStream = typeof import("./btw-side-chat-stream.js");
let sideChatStream: Promise<SideChatStream> | undefined;

export type SideChatScope = { identity: string; revision: number; panel: object };
export type FirstParentHandoff = {
  origin: SideChatScope;
  parentId: string;
  parentIdentity: string;
};

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
  selection: Pick<
    ReturnType<typeof useChatSessionSelection>,
    "selectedSessionIntentRef" | "selectedSessionRevisionRef"
  >;
  selectedTurnId: string | null;
  currentSurface: ChatMode;
  prefs: ChatSessionPrefsRecord | null;
  selectedProviderId?: string;
  selectedModel?: string;
  fullWebAccess: boolean;
  ensureSession: (onResolved?: (session: ChatSessionRecord) => void) => Promise<ChatSessionRecord>;
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
  const { selectedSessionIntentRef, selectedSessionRevisionRef } = input.selection;
  const { ensureSession, selectedSessionId, workspaceId } = input;
  const identity = JSON.stringify([installation, access, caller, workspaceId, selectedSessionId]);
  const revision = selectedSessionRevisionRef.current;
  const scopeRef = useRef<SideChatScope>({ identity, revision, panel: {} });
  const firstParentRef = useRef<FirstParentHandoff | null>(null);
  if (scopeRef.current.identity !== identity || scopeRef.current.revision !== revision) {
    const previous = scopeRef.current;
    const handoff = firstParentRef.current;
    const adoptsOwnParent =
      handoff?.origin === previous && handoff.parentIdentity === identity && revision === previous.revision + 1;
    const next = { identity, revision, panel: adoptsOwnParent ? previous.panel : {} };
    scopeRef.current = next;
    if (!adoptsOwnParent) firstParentRef.current = null;
  }
  const scope = scopeRef.current;
  const panelScope = scope.panel;
  const mounted = useRef(true);
  const isCurrent = useCallback(
    (handoff?: FirstParentHandoff) => {
      if (
        !mounted.current ||
        installation !== getGatewayApiBaseUrl() ||
        access !== getGatewayAccessRevision() ||
        caller !== getGatewayCallerScopeRevision()
      )
        return false;
      const liveScope = scopeRef.current;
      const liveRevision = selectedSessionRevisionRef.current;
      const intendedSession = selectedSessionIntentRef.current;
      if (liveScope === scope && liveRevision === scope.revision && intendedSession === selectedSessionId) return true;
      return (
        handoff !== undefined &&
        firstParentRef.current === handoff &&
        liveScope.panel === scope.panel &&
        liveRevision === scope.revision + 1 &&
        intendedSession === handoff.parentId
      );
    },
    [scope, installation, access, caller, selectedSessionId, selectedSessionIntentRef, selectedSessionRevisionRef],
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

  const getStreamingPreviewBuffer = useCallback((runtime: ChatPreviewRuntime, current: () => boolean) => {
    if (!streamingPreviewBufferRef.current) {
      streamingPreviewBufferRef.current = new runtime.ChatStreamingPreviewBuffer({
        onFlush: (preview) => {
          if (current()) setStreamingPreview(preview);
        },
        isReducedMotion: runtime.isReducedMotionPreferred,
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
  }, [panelScope]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamingPreviewBufferRef.current?.dispose();
    };
  }, []);

  const startOpen = useCallback(
    (code: SideChatStream) =>
      code.startBtwSideChat({
        isCurrent,
        ensureSession,
        selectedSessionId,
        selectedSessionIntentRef,
        workspaceId,
        scope,
        installation,
        access,
        caller,
        firstParentRef,
        record,
        childSession,
        input,
        setRecord,
        setChildSession,
        setThread,
        setLoading,
        setError,
      }),
    [
      isCurrent,
      ensureSession,
      selectedSessionId,
      selectedSessionIntentRef,
      workspaceId,
      scope,
      installation,
      access,
      caller,
      record,
      childSession,
      input,
    ],
  );

  const sendMessage = useCallback(
    async (messageOverride?: string) => {
      if (!isCurrent()) return;
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
      let current = isCurrent;
      let sideChat: Awaited<ReturnType<ReturnType<typeof startOpen>["open"]>>;
      let code: SideChatStream;
      try {
        code = await loadSideChatStream();
        const attempt = startOpen(code);
        current = attempt.current;
        sideChat = await attempt.open();
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
          getStreamingPreviewBuffer: (runtime) => getStreamingPreviewBuffer(runtime, current),
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
    [
      clearStreamingPreview,
      isCurrent,
      draft,
      getStreamingPreviewBuffer,
      input,
      promoteStreamingPreviewToThread,
      startOpen,
    ],
  );

  const openSideChat = useCallback(
    async (message?: string) => {
      if (!isCurrent()) return;
      if (message?.trim()) {
        await sendMessage(message);
        return;
      }
      setOpen(true);
      let current = isCurrent;
      try {
        const attempt = startOpen(await loadSideChatStream());
        current = attempt.current;
        await attempt.open();
      } catch (cause) {
        if (!current()) return;
        const nextError = cause instanceof Error ? cause.message : "Failed to open side chat.";
        setError(nextError);
        input.setUiError(nextError);
      }
    },
    [input, sendMessage, isCurrent, startOpen],
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
