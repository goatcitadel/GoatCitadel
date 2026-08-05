import { Buffer } from "node:buffer";
import {
  NotFoundError,
  ValidationError,
  type ChatHistoryContinuationResponse,
  type ChatHistoryMessageRecord,
  type ChatHistoryAnchorIdentity,
  type ChatHistoryWindowEntry,
  type ChatHistoryWindowResponse,
  type ChatMessagePageResponse,
  type ChatMessageRecord,
} from "@goatcitadel/contracts";
import type {
  ChatMessageAnchoredWindow,
  ChatMessageHistoryContinuationPage,
  ChatMessagePage,
  AsyncStorage as Storage,
} from "@goatcitadel/storage";

export interface ChatHistoryServiceDependencies {
  storage: Storage;
  ensureChatMessageProjection(sessionId: string): Promise<void>;
}

export async function listChatMessagePage(
  deps: ChatHistoryServiceDependencies,
  input: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
    cursor?: string;
    offset?: number;
    snapshotMaxSequence?: number;
    snapshotMessageCount?: number;
  },
): Promise<ChatMessagePageResponse> {
  const workspaceId = await requireSessionWorkspace(deps.storage, input.sessionId, input.workspaceId);
  await deps.ensureChatMessageProjection(input.sessionId);
  const page =
    input.offset !== undefined
      ? await deps.storage.chatMessages.listOffsetPage({
          workspaceId,
          sessionId: input.sessionId,
          limit: input.limit,
          offset: input.offset,
          snapshotMaxSequence: input.snapshotMaxSequence,
          snapshotMessageCount: input.snapshotMessageCount,
        })
      : await deps.storage.chatMessages.listPage({
          workspaceId,
          sessionId: input.sessionId,
          limit: input.limit,
          cursor: input.cursor,
        });
  return toPageResponse(page);
}

export async function readChatHistoryWindow(
  deps: ChatHistoryServiceDependencies,
  anchor: ChatHistoryAnchorIdentity,
  limit?: number,
): Promise<ChatMessageAnchoredWindow> {
  const workspaceId = await requireSessionWorkspace(deps.storage, anchor.sessionId, anchor.workspaceId);
  await deps.ensureChatMessageProjection(anchor.sessionId);
  return deps.storage.chatMessages.readAnchoredWindow({ ...anchor, workspaceId }, limit);
}

export async function readChatHistoryContinuation(
  deps: ChatHistoryServiceDependencies,
  input: {
    workspaceId: string;
    sessionId: string;
    direction: "older" | "newer";
    cursorMessageId: string;
    cursorSequence: number;
    snapshotMaxSequence: number;
    limit?: number;
  },
): Promise<ChatMessageHistoryContinuationPage> {
  const workspaceId = await requireSessionWorkspace(deps.storage, input.sessionId, input.workspaceId);
  await deps.ensureChatMessageProjection(input.sessionId);
  return deps.storage.chatMessages.readHistoryContinuation({ ...input, workspaceId });
}

export function projectChatHistoryContinuation(
  raw: ChatMessageHistoryContinuationPage,
  maxBytes: number,
  projectMessage: (message: ChatMessageRecord) => ChatHistoryMessageRecord,
): ChatHistoryContinuationResponse {
  const budget = normalizeHistoryByteBudget(maxBytes);
  const projected = raw.items.map<ChatHistoryWindowEntry>((entry) => ({
    ...entry,
    message: projectMessage(entry.message),
  }));
  let contentTruncated = false;
  let selected: ChatHistoryWindowEntry[] = [];
  if (projected.length > 0) {
    const adjacentIndex = raw.direction === "older" ? projected.length - 1 : 0;
    const adjacent = fitContinuationEntry(projected[adjacentIndex]!, budget);
    contentTruncated ||= adjacent.contentTruncated;
    selected = [adjacent.entry];
    if (raw.direction === "older") {
      for (let index = adjacentIndex - 1; index >= 0; index -= 1) {
        const candidate = [projected[index]!, ...selected];
        if (jsonBytes(candidate) > budget) break;
        selected = candidate;
      }
    } else {
      for (let index = 1; index < projected.length; index += 1) {
        const candidate = [...selected, projected[index]!];
        if (jsonBytes(candidate) > budget) break;
        selected = candidate;
      }
    }
  }
  const droppedItems = projected.length - selected.length;
  const hasMore = raw.hasMore || droppedItems > 0;
  const boundary = raw.direction === "older" ? selected[0] : selected.at(-1);
  return {
    direction: raw.direction,
    cursorState: raw.cursorState,
    items: selected,
    snapshotMaxSequence: raw.snapshotMaxSequence,
    ...(hasMore && boundary
      ? {
          nextCursor: {
            messageId: boundary.message.messageId,
            sequence: boundary.sequence,
            snapshotMaxSequence: raw.snapshotMaxSequence,
          },
        }
      : {}),
    hasMore,
    truncated: droppedItems > 0 || contentTruncated,
    droppedItems,
    byteLength: jsonBytes(selected),
    ...(contentTruncated ? { contentTruncated: true as const } : {}),
  };
}

function fitContinuationEntry(
  entry: ChatHistoryWindowEntry,
  budget: number,
): { entry: ChatHistoryWindowEntry; contentTruncated: boolean } {
  if (jsonBytes([entry]) <= budget) {
    return { entry, contentTruncated: false };
  }
  const suffix = "\n[historical message truncated]";
  const minimalMessage: ChatHistoryMessageRecord = {
    messageId: entry.message.messageId,
    sessionId: entry.message.sessionId,
    role: entry.message.role,
    content: "",
    timestamp: entry.message.timestamp,
  };
  const minimalEntry: ChatHistoryWindowEntry = {
    ...entry,
    message: minimalMessage,
  };
  if (jsonBytes([minimalEntry]) > budget) {
    throw new ValidationError({
      message:
        "Historical message identity metadata exceeds maxBytes; the bounded history response cannot be represented safely.",
    });
  }
  const marker = jsonBytes([{ ...entry, message: { ...minimalMessage, content: suffix } }]) <= budget ? suffix : "";
  let low = 0;
  let high = entry.message.content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = {
      ...entry,
      message: { ...minimalMessage, content: `${entry.message.content.slice(0, middle)}${marker}` },
    };
    if (jsonBytes([candidate]) <= budget) low = middle;
    else high = middle - 1;
  }
  if (
    low > 0 &&
    low < entry.message.content.length &&
    isHighSurrogate(entry.message.content.charCodeAt(low - 1)) &&
    isLowSurrogate(entry.message.content.charCodeAt(low))
  ) {
    low -= 1;
  }
  const fittedEntry: ChatHistoryWindowEntry = {
    ...entry,
    message: {
      ...minimalMessage,
      content: `${entry.message.content.slice(0, low)}${marker}`,
    },
  };
  if (jsonBytes([fittedEntry]) > budget) {
    throw new ValidationError({
      message: "Historical message could not be projected within maxBytes.",
    });
  }
  return {
    entry: fittedEntry,
    contentTruncated: true,
  };
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

/**
 * Apply the public message projection before enforcing the response byte cap.
 * The exact anchor identity is never discarded. Oversized projected content is
 * UTF-8 truncated before surrounding messages are added symmetrically.
 */
export function projectAndCapChatHistoryWindow(
  raw: ChatMessageAnchoredWindow,
  maxBytes: number,
  projectMessage: (message: ChatMessageRecord) => ChatHistoryMessageRecord,
): ChatHistoryWindowResponse {
  const budget = normalizeHistoryByteBudget(maxBytes);
  const projected = raw.items.map<ChatHistoryWindowEntry>((entry) => ({
    sequence: entry.sequence,
    message: projectMessage(entry.message),
    isAnchor: entry.isAnchor,
  }));
  if (raw.anchor.state !== "found") {
    return {
      anchor: raw.anchor,
      items: [],
      snapshotMaxSequence: raw.snapshotMaxSequence,
      hasOlder: raw.hasOlder,
      hasNewer: raw.hasNewer,
      truncated: false,
      droppedItems: 0,
      byteLength: jsonBytes([]),
    };
  }

  const anchorIndex = projected.findIndex((entry) => entry.isAnchor);
  if (anchorIndex < 0) {
    return {
      anchor: { ...raw.anchor, state: "identity_mismatch" },
      items: [],
      snapshotMaxSequence: raw.snapshotMaxSequence,
      hasOlder: raw.hasOlder,
      hasNewer: raw.hasNewer,
      truncated: projected.length > 0,
      droppedItems: projected.length,
      byteLength: jsonBytes([]),
    };
  }

  let start = anchorIndex;
  let end = anchorIndex + 1;
  const fittedAnchor = fitContinuationEntry(projected[anchorIndex]!, budget);
  let selected = [fittedAnchor.entry];
  let byteLength = jsonBytes(selected);
  let canGrowOlder = start > 0;
  let canGrowNewer = end < projected.length;
  while (canGrowOlder || canGrowNewer) {
    if (canGrowOlder) {
      const candidate = [projected[start - 1]!, ...selected];
      const candidateBytes = jsonBytes(candidate);
      if (candidateBytes <= budget) {
        start -= 1;
        selected = candidate;
        byteLength = candidateBytes;
      } else {
        canGrowOlder = false;
      }
    }
    canGrowOlder = canGrowOlder && start > 0;
    if (canGrowNewer) {
      const candidate = [...selected, projected[end]!];
      const candidateBytes = jsonBytes(candidate);
      if (candidateBytes <= budget) {
        end += 1;
        selected = candidate;
        byteLength = candidateBytes;
      } else {
        canGrowNewer = false;
      }
    }
    canGrowNewer = canGrowNewer && end < projected.length;
  }

  return {
    anchor: raw.anchor,
    items: selected,
    snapshotMaxSequence: raw.snapshotMaxSequence,
    hasOlder: raw.hasOlder || start > 0,
    hasNewer: raw.hasNewer || end < projected.length,
    ...buildWindowContinuationCursors(
      selected,
      raw.snapshotMaxSequence,
      raw.hasOlder || start > 0,
      raw.hasNewer || end < projected.length,
    ),
    truncated: selected.length < projected.length || fittedAnchor.contentTruncated,
    droppedItems: projected.length - selected.length,
    byteLength,
    ...(fittedAnchor.contentTruncated ? { contentTruncated: true as const } : {}),
  };
}

function buildWindowContinuationCursors(
  items: ChatHistoryWindowEntry[],
  snapshotMaxSequence: number | undefined,
  hasOlder: boolean,
  hasNewer: boolean,
): Pick<ChatHistoryWindowResponse, "olderCursor" | "newerCursor"> {
  if (snapshotMaxSequence === undefined || items.length === 0) {
    return {};
  }
  const oldest = items[0];
  const newest = items.at(-1);
  return {
    ...(hasOlder && oldest
      ? {
          olderCursor: {
            messageId: oldest.message.messageId,
            sequence: oldest.sequence,
            snapshotMaxSequence,
          },
        }
      : {}),
    ...(hasNewer && newest
      ? {
          newerCursor: {
            messageId: newest.message.messageId,
            sequence: newest.sequence,
            snapshotMaxSequence,
          },
        }
      : {}),
  };
}

async function requireSessionWorkspace(
  storage: Storage,
  sessionId: string,
  requestedWorkspaceId: string,
): Promise<string> {
  const normalizedSessionId = sessionId.trim();
  const normalizedWorkspaceId = requestedWorkspaceId.trim();
  const meta = normalizedSessionId ? await storage.chatSessionMeta.get(normalizedSessionId) : undefined;
  if (!meta || !normalizedWorkspaceId || meta.workspaceId !== normalizedWorkspaceId) {
    // Do not distinguish a missing session from a cross-workspace session.
    throw new NotFoundError({ entity: "Chat session", id: normalizedSessionId || "unknown" });
  }
  return normalizedWorkspaceId;
}

function toPageResponse(page: ChatMessagePage): ChatMessagePageResponse {
  return {
    items: page.items,
    cursorState: page.cursorState,
    nextCursor: page.nextCursor,
    hasOlder: page.hasOlder,
    snapshotMaxSequence: page.snapshotMaxSequence,
    snapshotMessageCount: page.snapshotMessageCount,
    offset: page.offset,
    nextOffset: page.nextOffset,
  };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeHistoryByteBudget(maxBytes: number): number {
  const finiteBudget = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 65_536;
  return Math.max(1_024, Math.min(1_048_576, finiteBudget));
}
