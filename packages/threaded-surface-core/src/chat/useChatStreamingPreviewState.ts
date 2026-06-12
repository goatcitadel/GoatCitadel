import type { ChatSessionPrefsRecord, ChatStreamChunk, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { updateThreadFromStreamChunk } from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
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

export function useChatStreamingPreviewState({
  selectedSessionId,
  visualStreamMode,
  commitThreadUpdate,
  prefsRef,
}: UseChatStreamingPreviewStateInput) {
  const [streamingPreview, setStreamingPreview] = useState<ChatStreamingPreview | null>(null);
  const finalizedStreamMessageRef = useRef<FinalizedStreamMessageState | null>(null);
  const streamingPreviewBufferRef = useRef<ChatStreamingPreviewBuffer | null>(null);
  const visualStreamModeRef = useRef<ChatVisualStreamMode>(visualStreamMode);

  useEffect(() => {
    visualStreamModeRef.current = visualStreamMode;
    if (visualStreamMode === "instant") {
      streamingPreviewBufferRef.current?.flush({ forceVisible: true });
    }
  }, [visualStreamMode]);

  const getStreamingPreviewBuffer = useCallback(() => {
    if (!streamingPreviewBufferRef.current) {
      streamingPreviewBufferRef.current = new ChatStreamingPreviewBuffer({
        onFlush: setStreamingPreview,
        isReducedMotion: () => visualStreamModeRef.current === "instant" || isReducedMotionPreferred(),
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
    (sessionId: string, reason: "abort" | "error") => {
      const snapshot =
        streamingPreviewBufferRef.current?.getSnapshot({ forceVisible: true }) ??
        (streamingPreview?.sessionId === sessionId ? streamingPreview : null);
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
    [clearStreamingPreview, commitThreadUpdate, prefsRef, streamingPreview],
  );

  useEffect(() => {
    if (streamingPreview && streamingPreview.sessionId !== selectedSessionId) {
      clearStreamingPreview();
    }
  }, [clearStreamingPreview, selectedSessionId, streamingPreview]);

  const disposeStreamingPreview = useCallback(() => {
    streamingPreviewBufferRef.current?.dispose();
    streamingPreviewBufferRef.current = null;
    setStreamingPreview(null);
  }, []);

  return {
    streamingPreview,
    activeStreamingTurnId: streamingPreview?.turnId ?? null,
    finalizedStreamMessageRef,
    getStreamingPreviewBuffer,
    clearStreamingPreview,
    promoteStreamingPreviewToThread,
    disposeStreamingPreview,
  };
}
