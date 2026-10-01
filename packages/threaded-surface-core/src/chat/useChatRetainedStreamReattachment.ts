import type { ChatStreamChunk, ChatThreadResponse } from "@goatcitadel/contracts";
import { useEffect, useRef, type MutableRefObject } from "react";
import { resumeChatTurnStream } from "@goatcitadel/mission-control-shared/api/client";
import {
  clearChatStreamActivity,
  recordChatStreamChunkActivity,
} from "@goatcitadel/mission-control-shared/state/chat-stream-activity-store";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import { isAbortError } from "./chat-page-derivations";
import type { ChatStreamingPreviewBuffer } from "./chat-streaming-preview";
import type { ActiveChatStreamState } from "./useChatOutboundExecution.types";

interface RetainedStreamReattachmentInput {
  selectedSessionId: string | null;
  thread: ChatThreadResponse | null;
  streamEnabled: boolean;
  activeStreamRef: MutableRefObject<ActiveChatStreamState | null>;
  sendingRef: MutableRefObject<boolean>;
  locallyHandledTurnKeysRef: MutableRefObject<Set<string>>;
  setSending: (value: boolean) => void;
  getStreamingPreviewBuffer: () => ChatStreamingPreviewBuffer;
  clearStreamingPreview: () => void;
  loadSessionCoreState: (sessionId: string, options: { background: boolean; includeThread: boolean }) => Promise<void>;
  pushLocalNotice: (message: string, tone: "warning") => void;
}

/** Replays one canonical active turn after a fresh page load, without sending it again. */
export function useChatRetainedStreamReattachment(input: RetainedStreamReattachmentInput): void {
  const latestRef = useRef(input);
  latestRef.current = input;
  const { selectedSessionId, thread, streamEnabled, activeStreamRef, sendingRef, locallyHandledTurnKeysRef } = input;
  const activeTurnId =
    thread?.sessionId === selectedSessionId
      ? [...thread.turns]
          .reverse()
          .find((turn) =>
            turn.trace.status === "queued" ||
            turn.trace.status === "running" ||
            turn.trace.status === "waiting_for_tool",
          )?.turnId
      : undefined;

  useEffect(() => {
    if (
      !streamEnabled || !selectedSessionId || !activeTurnId || activeStreamRef.current || sendingRef.current ||
      locallyHandledTurnKeysRef.current.has(`${selectedSessionId}:${activeTurnId}`)
    ) {
      return;
    }

    const sessionId = selectedSessionId;
    const turnId = activeTurnId;
    const controller = new AbortController();
    const stream: ActiveChatStreamState = {
      sessionId,
      turnId,
      streamToken: `retained-${turnId}-${Date.now()}`,
      controller,
    };
    activeStreamRef.current = stream;
    sendingRef.current = true;
    latestRef.current.setSending(true);
    recordChatStreamChunkActivity(sessionId);
    let terminalSeen = false;

    const isCurrent = () => activeStreamRef.current === stream && !controller.signal.aborted;
    const onChunk = (chunk: ChatStreamChunk) => {
      if (!isCurrent() || chunk.sessionId !== sessionId || (chunk.turnId && chunk.turnId !== turnId)) {
        return;
      }
      recordChatStreamChunkActivity(sessionId);
      if (typeof stream.lastSequence === "number" && chunk.sequence <= stream.lastSequence) {
        return;
      }
      if (chunk.type === "message_start") {
        latestRef.current.getStreamingPreviewBuffer().start({ sessionId, turnId, messageId: chunk.messageId });
      } else if (chunk.type === "delta") {
        latestRef.current.getStreamingPreviewBuffer().append({
          sessionId,
          turnId,
          messageId: chunk.messageId,
          delta: chunk.delta,
        });
      } else if (chunk.type === "message_done") {
        latestRef.current.getStreamingPreviewBuffer().finish({ clear: false, finalText: chunk.content });
      } else if (chunk.type === "done" || (chunk.type === "trace_update" &&
        (chunk.trace.status === "completed" || chunk.trace.status === "partial" ||
          chunk.trace.status === "failed" || chunk.trace.status === "cancelled"))) {
        terminalSeen = true;
      }
      stream.lastEventId = chunk.eventId;
      stream.lastSequence = chunk.sequence;
      if (chunk.runId) stream.runId = chunk.runId;
    };

    const release = () => {
      if (activeStreamRef.current !== stream) return;
      activeStreamRef.current = null;
      sendingRef.current = false;
      latestRef.current.setSending(false);
      latestRef.current.clearStreamingPreview();
      clearChatStreamActivity(sessionId);
    };

    void (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await resumeChatTurnStream(sessionId, turnId, onChunk, {
              signal: controller.signal,
              sinceEventId: stream.lastEventId,
              originSurface: "chat",
            });
            break;
          } catch (error) {
            if (!isCurrent() || isAbortError(error)) return;
            if (terminalSeen || attempt === 2) throw error;
          }
        }
      } catch (error) {
        if (isCurrent()) {
          recordClientDiagnostic({
            level: "warn",
            category: "chat",
            event: "stream.retained_reattach_failed",
            message: "Unable to keep the retained Chat stream attached.",
            sessionId,
            turnId,
            context: { error: error instanceof Error ? error.message : String(error) },
          });
          latestRef.current.pushLocalNotice("Live response disconnected. Refresh the turn to check its status.", "warning");
        }
      } finally {
        if (isCurrent()) {
          try {
            await latestRef.current.loadSessionCoreState(sessionId, { background: true, includeThread: true });
          } catch (error) {
            recordClientDiagnostic({
              level: "warn",
              category: "chat",
              event: "stream.retained_reconcile_failed",
              message: "Unable to refresh the Chat turn after its retained stream ended.",
              sessionId,
              turnId,
              context: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        }
        release();
      }
    })();

    return () => {
      controller.abort();
      release();
    };
  }, [activeStreamRef, activeTurnId, locallyHandledTurnKeysRef, selectedSessionId, sendingRef, streamEnabled]);
}
