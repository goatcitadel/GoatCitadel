import type { ChatSessionPrefsRecord, ChatStreamChunk, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { updateThreadFromStreamChunk } from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import {
  getChatStreamingPreview,
  publishChatStreamingPreview,
} from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import type { FinalizedStreamMessageState } from "./chat-page-pure-helpers";
import {
  ChatStreamingPreviewBuffer,
  isReducedMotionPreferred,
  type ChatStreamingPreview,
  type ChatVisualStreamMode,
} from "./chat-streaming-preview";
import type { ChatThreadCommitter } from "./useChatOutboundExecution.types";

interface UseChatStreamingPreviewStateInput {
  selectedSessionId: string | null;
  visualStreamMode: ChatVisualStreamMode;
  commitThreadUpdate: ChatThreadCommitter;
  prefsRef: MutableRefObject<ChatSessionPrefsRecord | null>;
}

/**
 * Owns the streaming-preview buffer lifecycle for the outbound chat hook.
 *
 * Perf note: every buffer flush (up to ~60/s while a turn streams) used to
 * call `setStreamingPreview` here, which re-rendered this hook's caller (the
 * ~3,700-line controller host) and everything downstream of it once per
 * flush. The flushed value is now published to the module-level
 * `chat-streaming-preview-store` (mission-control-shared) instead; the
 * timeline and `ChatThreadView` subscribe to it directly, so only they
 * re-render per flush.
 *
 * The host still needs to re-render on stream start/stop (to flip
 * `streamStatus`, enable/disable the composer stop control, etc.), so
 * `activeStreamingTurnId` remains real host state -- but it is only set when
 * the *turn identity* changes (a new turn starts, or the preview clears to
 * null), never on an in-place text flush within the same turn. React's
 * `setState` already bails out of scheduling a render when the next value is
 * `===` the current one, so publishing the same turnId on every flush inside
 * one turn is already a no-op render-wise; this hook still guards it
 * explicitly below so the intent doesn't depend on that implementation
 * detail.
 *
 * `streamingPreview` is kept as a deprecated return value for source
 * compatibility with existing consumers (and so the host's
 * `activeSessionSurfaceProps.streamingPreview` passthrough stays
 * compile-valid): it mirrors the full snapshot only at the same start/stop
 * cadence as `activeStreamingTurnId`, not per flush. Callers that need the
 * live, per-flush text must subscribe to the store
 * (`useChatStreamingPreviewSnapshot`) instead.
 */
export function useChatStreamingPreviewState({
  selectedSessionId,
  visualStreamMode,
  commitThreadUpdate,
  prefsRef,
}: UseChatStreamingPreviewStateInput) {
  const [transitionPreview, setTransitionPreview] = useState<ChatStreamingPreview | null>(null);
  const finalizedStreamMessageRef = useRef<FinalizedStreamMessageState | null>(null);
  const streamingPreviewBufferRef = useRef<ChatStreamingPreviewBuffer | null>(null);
  const visualStreamModeRef = useRef<ChatVisualStreamMode>(visualStreamMode);
  // Mirrors transitionPreview without waiting for the next render, so
  // read-after-write call sites in this same hook (promoteStreamingPreviewToThread,
  // the clear-on-session-switch effect) always see the latest transition value
  // instead of a stale one from before this render committed.
  const transitionPreviewRef = useRef<ChatStreamingPreview | null>(null);

  useEffect(() => {
    visualStreamModeRef.current = visualStreamMode;
    if (visualStreamMode === "instant") {
      streamingPreviewBufferRef.current?.flush({ forceVisible: true });
    }
  }, [visualStreamMode]);

  const applyTransitionPreview = useCallback((next: ChatStreamingPreview | null) => {
    transitionPreviewRef.current = next;
    setTransitionPreview(next);
  }, []);

  const handleBufferFlush = useCallback(
    (preview: ChatStreamingPreview | null) => {
      // A cleared flush (preview === null) has no sessionId of its own; publish
      // the clear to whichever session was previously tracked so that
      // session's subscribers see it disappear.
      const publishSessionId = preview?.sessionId ?? transitionPreviewRef.current?.sessionId;
      if (publishSessionId) {
        publishChatStreamingPreview(publishSessionId, preview);
      }
      // A turn-identity change (new turn started, or cleared to null) is the
      // only case that should touch host state; an in-place text flush within
      // the same turn must not, even though setState would already bail out on
      // an unchanged turnId -- this keeps the intent explicit rather than
      // relying on that bail-out alone.
      const previousTurnId = transitionPreviewRef.current?.turnId ?? null;
      const nextTurnId = preview?.turnId ?? null;
      if (previousTurnId !== nextTurnId) {
        applyTransitionPreview(preview);
      }
    },
    [applyTransitionPreview],
  );

  const getStreamingPreviewBuffer = useCallback(() => {
    if (!streamingPreviewBufferRef.current) {
      streamingPreviewBufferRef.current = new ChatStreamingPreviewBuffer({
        onFlush: handleBufferFlush,
        isReducedMotion: () => visualStreamModeRef.current === "instant" || isReducedMotionPreferred(),
      });
    }
    return streamingPreviewBufferRef.current;
  }, [handleBufferFlush]);

  const clearStreamingPreview = useCallback((options: { allowSettlingFinalText?: boolean } = {}) => {
    if (options.allowSettlingFinalText && streamingPreviewBufferRef.current?.isSettlingFinalText()) {
      return;
    }
    streamingPreviewBufferRef.current?.clear();
  }, []);

  const promoteStreamingPreviewToThread = useCallback(
    (sessionId: string, reason: "abort" | "error") => {
      const snapshot =
        streamingPreviewBufferRef.current?.getSnapshot({ forceVisible: true }) ?? getChatStreamingPreview(sessionId);
      if (!snapshot || snapshot.sessionId !== sessionId || snapshot.text.trim().length === 0) {
        clearStreamingPreview();
        return;
      }
      const partialChunk: ChatStreamChunk = {
        type: "message_done",
        sessionId: snapshot.sessionId,
        eventId: `local-preview-${reason}-${Date.now()}`,
        sequence: -1,
        turnId: snapshot.turnId,
        messageId: snapshot.messageId ?? `local-assistant-${snapshot.turnId}`,
        content: snapshot.text,
      };
      commitThreadUpdate((current: ChatThreadResponse | null) =>
        updateThreadFromStreamChunk(current, partialChunk, null, snapshot.sessionId, prefsRef.current),
      );
      recordClientDiagnostic({
        level: "warn",
        category: "chat",
        event: "stream.preview_promoted_partial",
        message: "Promoted visible streaming preview after the live stream ended before message_done.",
        sessionId: snapshot.sessionId,
        turnId: snapshot.turnId,
        context: {
          reason,
          characterCount: snapshot.text.length,
        },
      });
      clearStreamingPreview();
    },
    [clearStreamingPreview, commitThreadUpdate, prefsRef],
  );

  useEffect(() => {
    const activeSessionId = transitionPreview?.sessionId ?? null;
    if (activeSessionId && activeSessionId !== selectedSessionId) {
      clearStreamingPreview();
    }
  }, [clearStreamingPreview, selectedSessionId, transitionPreview]);

  const disposeStreamingPreview = useCallback(() => {
    streamingPreviewBufferRef.current?.dispose();
    streamingPreviewBufferRef.current = null;
    const sessionId = transitionPreviewRef.current?.sessionId;
    if (sessionId) {
      publishChatStreamingPreview(sessionId, null);
    }
    applyTransitionPreview(null);
  }, [applyTransitionPreview]);

  return {
    /** @deprecated Only reflects start/stop transitions, not per-flush text. Subscribe to the chat-streaming-preview-store (useChatStreamingPreviewSnapshot) for the live value. */
    streamingPreview: transitionPreview,
    activeStreamingTurnId: transitionPreview?.turnId ?? null,
    finalizedStreamMessageRef,
    getStreamingPreviewBuffer,
    clearStreamingPreview,
    promoteStreamingPreviewToThread,
    disposeStreamingPreview,
  };
}
