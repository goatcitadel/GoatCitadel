import type {
  ChatHistoryWindowResponse,
  ChatHistoryContinuationResponse,
  ChatHistoryContinuationCursor,
  ChatSessionSearchHitRecord,
} from "@goatcitadel/contracts";
type HistoryTarget = { workspaceId: string; sessionId: string };
export function historicalWindowIdentityMismatch(
  nextWindow: ChatHistoryWindowResponse,
  workspaceId: string,
  sessionId: string,
  hit: ChatSessionSearchHitRecord,
): boolean {
  return (
    nextWindow.anchor.workspaceId !== workspaceId ||
    nextWindow.anchor.sessionId !== sessionId ||
    nextWindow.anchor.messageId !== hit.messageId ||
    nextWindow.anchor.sequence !== hit.sequence
  );
}
export function isHistoricalContinuationValid(
  page: ChatHistoryContinuationResponse,
  direction: "older" | "newer",
  cursor: ChatHistoryContinuationCursor,
  target: HistoryTarget,
): boolean {
  return (
    page.direction === direction &&
    page.snapshotMaxSequence === cursor.snapshotMaxSequence &&
    page.items.every(
      (entry) =>
        entry.message.sessionId === target.sessionId &&
        entry.sequence <= cursor.snapshotMaxSequence &&
        (direction === "older" ? entry.sequence < cursor.sequence : entry.sequence > cursor.sequence),
    ) &&
    (!page.nextCursor || page.nextCursor.snapshotMaxSequence === cursor.snapshotMaxSequence)
  );
}
export function mergeHistoricalContinuation(
  active: ChatHistoryWindowResponse | null,
  currentWindow: ChatHistoryWindowResponse,
  page: ChatHistoryContinuationResponse,
  direction: "older" | "newer",
  target: HistoryTarget,
): ChatHistoryWindowResponse | null {
  if (
    !active ||
    active.anchor.workspaceId !== target.workspaceId ||
    active.anchor.sessionId !== target.sessionId ||
    active.anchor.messageId !== currentWindow.anchor.messageId ||
    active.anchor.sequence !== currentWindow.anchor.sequence
  ) {
    return active;
  }
  const combined = direction === "older" ? [...page.items, ...active.items] : [...active.items, ...page.items];
  const seen = new Set<string>();
  const items = combined.filter((entry) => {
    const key = `${entry.message.messageId}:${entry.sequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...active,
    items,
    ...(direction === "older"
      ? { hasOlder: page.hasMore, olderCursor: page.nextCursor }
      : { hasNewer: page.hasMore, newerCursor: page.nextCursor }),
    truncated: active.truncated || page.truncated,
    droppedItems: active.droppedItems + page.droppedItems,
  };
}

export function historicalTargetChanged(
  target: HistoryTarget | null,
  workspaceId: string,
  selectedSessionId: string | null,
): boolean | null {
  return target && (target.workspaceId !== workspaceId || target.sessionId !== selectedSessionId);
}
