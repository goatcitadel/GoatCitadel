import { capChatTurnReasoning, type ChatStreamChunk } from "@goatcitadel/contracts";
import { updateThreadFromStreamChunk } from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import { resumeChatTurnStream } from "@goatcitadel/mission-control-shared/api/client";
import { recordChatStreamChunkActivity } from "@goatcitadel/mission-control-shared/state/chat-stream-activity-store";
import type { MutableRefObject } from "react";
import { isAbortError } from "./chat-page-derivations";
import { ChatStreamingPreviewBuffer, isReducedMotionPreferred } from "./chat-streaming-preview";
import type { ActiveChatStreamState } from "./useChatOutboundExecution.types";
import type { RetainedStreamReattachmentInput } from "./useChatRetainedStreamReattachment";

const previewRuntime = { ChatStreamingPreviewBuffer, isReducedMotionPreferred };

export async function runRetainedChatStream(
  sessionId: string,
  turnId: string,
  stream: ActiveChatStreamState,
  latestRef: MutableRefObject<RetainedStreamReattachmentInput>,
  isCurrent: () => boolean,
): Promise<void> {
  const { controller } = stream;
  let terminalSeen = false;
  let replayedThinking = "";

  const onChunk = (chunk: ChatStreamChunk) => {
    if (!isCurrent() || chunk.sessionId !== sessionId || (chunk.turnId && chunk.turnId !== turnId)) {
      return;
    }
    recordChatStreamChunkActivity(sessionId);
    if (typeof stream.lastSequence === "number" && chunk.sequence <= stream.lastSequence) {
      return;
    }
    if (chunk.type === "message_start") {
      latestRef.current.getStreamingPreviewBuffer(previewRuntime).start({ sessionId, turnId, messageId: chunk.messageId });
    } else if (chunk.type === "delta") {
      latestRef.current.getStreamingPreviewBuffer(previewRuntime).append({
        sessionId,
        turnId,
        messageId: chunk.messageId,
        delta: chunk.delta,
      });
    } else if (chunk.type === "thinking_delta") {
      // First attachment replays from the beginning, including reasoning the
      // fetched thread may already contain. Rebuild its bounded value rather
      // than appending that history twice; retries retain this value/cursor.
      replayedThinking = capChatTurnReasoning(replayedThinking + chunk.delta);
      const thinking = replayedThinking;
      latestRef.current.commitThreadUpdate((current) => {
        if (current?.sessionId !== sessionId) return current;
        const turn = current.turns.find((item) => item.turnId === turnId);
        if (!turn || turn.thinking?.startsWith(thinking)) return current;
        const replayBase = {
          ...current,
          turns: current.turns.map((item) => item === turn ? { ...item, thinking: undefined } : item),
        };
        return updateThreadFromStreamChunk(replayBase, { ...chunk, delta: thinking }, null, sessionId, null);
      });
    } else if (chunk.type === "message_done") {
      latestRef.current.getStreamingPreviewBuffer(previewRuntime).finish({ clear: false, finalText: chunk.content });
    } else if (chunk.type === "done" || (chunk.type === "trace_update" &&
      (chunk.trace.status === "completed" || chunk.trace.status === "partial" ||
        chunk.trace.status === "failed" || chunk.trace.status === "cancelled"))) {
      terminalSeen = true;
    }
    stream.lastEventId = chunk.eventId;
    stream.lastSequence = chunk.sequence;
    if (chunk.runId) stream.runId = chunk.runId;
  };

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
}
