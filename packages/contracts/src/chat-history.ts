import type { ChatMessageRole } from "./chat.js";

export type ChatHistoryAnchorState = "found" | "unavailable" | "identity_mismatch";
export type ChatHistoryUnavailableReason = "missing_deleted_or_compacted";

/** Exact, workspace-authorized identity for a persisted transcript message. */
export interface ChatHistoryAnchorIdentity {
  workspaceId: string;
  sessionId: string;
  messageId: string;
  sequence: number;
}

export interface ChatHistoryAnchorResult extends ChatHistoryAnchorIdentity {
  state: ChatHistoryAnchorState;
  unavailableReason?: ChatHistoryUnavailableReason;
}

/** Minimal provider/client-safe transcript shape for historical reads. */
export interface ChatHistoryMessageRecord {
  messageId: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
}

export interface ChatHistoryWindowEntry {
  sequence: number;
  message: ChatHistoryMessageRecord;
  isAnchor: boolean;
}

/** Exact keyset boundary for paging away from an anchored historical window. */
export interface ChatHistoryContinuationCursor {
  messageId: string;
  sequence: number;
  snapshotMaxSequence: number;
}

/** A bounded historical window centered on one exact search-result anchor. */
export interface ChatHistoryWindowResponse {
  anchor: ChatHistoryAnchorResult;
  items: ChatHistoryWindowEntry[];
  snapshotMaxSequence?: number;
  snapshotMessageCount?: number;
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: ChatHistoryContinuationCursor;
  newerCursor?: ChatHistoryContinuationCursor;
  truncated: boolean;
  droppedItems: number;
  /** UTF-8 byte length of the JSON-encoded `items` array after public projection. */
  byteLength: number;
  contentTruncated?: true;
  /** Legacy truth flag retained for older clients; strict public projection now truncates the anchor. */
  anchorExceededByteLimit?: true;
}

export interface ChatHistoryContinuationResponse {
  direction: "older" | "newer";
  cursorState: "valid" | "stale";
  items: ChatHistoryWindowEntry[];
  snapshotMaxSequence: number;
  nextCursor?: ChatHistoryContinuationCursor;
  hasMore: boolean;
  truncated: boolean;
  droppedItems: number;
  /** UTF-8 byte length of the JSON-encoded `items` array after public projection. */
  byteLength: number;
  contentTruncated?: true;
}

export interface ChatMessagePageResponse {
  items: ChatHistoryMessageRecord[];
  cursorState: "start" | "valid" | "offset" | "stale";
  nextCursor?: string;
  hasOlder: boolean;
  snapshotMaxSequence?: number;
  snapshotMessageCount?: number;
  offset?: number;
  nextOffset?: number;
}
