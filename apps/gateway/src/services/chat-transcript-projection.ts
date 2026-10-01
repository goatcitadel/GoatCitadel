import type { ChatMessageRecord, TranscriptEvent } from "@goatcitadel/contracts";
import { parseMessageAttachments, parseMessageParts } from "./chat-message-history-service.js";

/** Projects stored transcript records only; no read, backfill, or admission is performed. */
export function projectTranscriptMessages(events: readonly TranscriptEvent[]): ChatMessageRecord[] {
  return events
    .filter((event) => event.type === "message.user" || event.type === "message.assistant")
    .map(toChatMessageRecord)
    .filter((message): message is ChatMessageRecord => Boolean(message));
}

export function selectTranscriptMessageWindow(
  events: readonly TranscriptEvent[],
  limit: number,
  cursor?: string,
): ChatMessageRecord[] {
  let messages = projectTranscriptMessages(events);
  if (cursor) {
    const index = messages.findIndex((message) => message.messageId === cursor);
    if (index >= 0) messages = messages.slice(0, index);
  }
  return messages.slice(-Math.max(1, Math.min(limit, 1000)));
}

function toChatMessageRecord(event: TranscriptEvent): ChatMessageRecord | undefined {
  const payload = event.payload as {
    message?: { role?: string; content?: unknown; parts?: unknown; attachments?: unknown };
  };
  const message = payload.message;
  if (!message || typeof message.content !== "string") return undefined;
  const role = message.role === "assistant" ? "assistant" : "user";
  return {
    messageId: event.eventId,
    sessionId: event.sessionId,
    role,
    actorType: event.actorType,
    actorId: event.actorId,
    sourceAuthority: event.sourceAuthority ?? "unknown",
    content: message.content,
    timestamp: event.timestamp,
    tokenInput: event.tokenInput,
    tokenOutput: event.tokenOutput,
    costUsd: event.costUsd,
    parts: parseMessageParts(message.parts),
    attachments: parseMessageAttachments(message.attachments),
  };
}
