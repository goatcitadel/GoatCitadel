/**
 * Tracks the last time a chat stream produced any chunk, keyed by sessionId.
 *
 * This is a poll-only store (no subscriptions): consumers are expected to
 * read `getChatStreamActivityAt` from their own interval tick rather than
 * subscribing to changes, because activity happens far too often (every SSE
 * chunk, 10-50/s while streaming) to justify a listener fan-out. The whole
 * point of recording activity here is to let a slow (1s) poller detect
 * *silence*, not to react to every update.
 */

let lastActivityAtBySessionId = new Map<string, number>();

export function recordChatStreamChunkActivity(sessionId: string, at: number = Date.now()): void {
  lastActivityAtBySessionId.set(sessionId, at);
}

export function clearChatStreamActivity(sessionId: string): void {
  lastActivityAtBySessionId.delete(sessionId);
}

export function getChatStreamActivityAt(sessionId: string | null | undefined): number | null {
  if (!sessionId) {
    return null;
  }
  return lastActivityAtBySessionId.get(sessionId) ?? null;
}

export function resetChatStreamActivityForTests(): void {
  lastActivityAtBySessionId = new Map();
}
