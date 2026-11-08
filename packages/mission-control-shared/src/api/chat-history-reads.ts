import type { ChatHistoryContinuationResponse, ChatHistoryWindowResponse, ChatMessagePageResponse } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

const DEFAULT_CHAT_HISTORY_MAX_BYTES = 65_536;
const MIN_CHAT_HISTORY_MAX_BYTES = 1_024;
const MAX_CHAT_HISTORY_MAX_BYTES = 1_048_576;

function clampChatHistoryMaxBytes(maxBytes?: number): number {
  const normalized =
    maxBytes !== undefined && Number.isFinite(maxBytes) ? Math.floor(maxBytes) : DEFAULT_CHAT_HISTORY_MAX_BYTES;
  return Math.max(MIN_CHAT_HISTORY_MAX_BYTES, Math.min(MAX_CHAT_HISTORY_MAX_BYTES, normalized));
}

export async function fetchChatHistoryWindow(input: {
  workspaceId: string;
  sessionId: string;
  messageId: string;
  sequence: number;
  limit?: number;
  maxBytes?: number;
}): Promise<ChatHistoryWindowResponse> {
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    messageId: input.messageId,
    sequence: String(input.sequence),
    limit: String(input.limit ?? 21),
    maxBytes: String(clampChatHistoryMaxBytes(input.maxBytes)),
  });
  return request<ChatHistoryWindowResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/history?${query.toString()}`,
  );
}

export async function fetchChatHistoryContinuation(input: {
  workspaceId: string;
  sessionId: string;
  direction: "older" | "newer";
  cursor: { messageId: string; sequence: number; snapshotMaxSequence: number };
  limit?: number;
  maxBytes?: number;
}): Promise<ChatHistoryContinuationResponse> {
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    direction: input.direction,
    cursor: input.cursor.messageId,
    cursorSequence: String(input.cursor.sequence),
    snapshotMaxSequence: String(input.cursor.snapshotMaxSequence),
    limit: String(input.limit ?? 21),
    maxBytes: String(clampChatHistoryMaxBytes(input.maxBytes)),
  });
  return request<ChatHistoryContinuationResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/history?${query.toString()}`,
  );
}

export async function fetchChatMessagePage(input: {
  workspaceId: string;
  sessionId: string;
  limit?: number;
  cursor?: string;
  offset?: number;
  snapshotMaxSequence?: number;
  snapshotMessageCount?: number;
}): Promise<ChatMessagePageResponse> {
  if (input.cursor !== undefined && input.offset !== undefined) {
    throw new Error("cursor and offset cannot be used together");
  }
  const query = new URLSearchParams({
    workspaceId: input.workspaceId,
    limit: String(input.limit ?? 200),
  });
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.offset !== undefined) query.set("offset", String(input.offset));
  if (input.snapshotMaxSequence !== undefined) {
    query.set("snapshotMaxSequence", String(input.snapshotMaxSequence));
  }
  if (input.snapshotMessageCount !== undefined) {
    query.set("snapshotMessageCount", String(input.snapshotMessageCount));
  }
  return request<ChatMessagePageResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(input.sessionId)}/history?${query.toString()}`,
  );
}
