/**
 * Module-level, session-scoped store for the flushed chat streaming preview.
 *
 * The RAF-paced preview buffer (`ChatStreamingPreviewBuffer` in
 * threaded-surface-core) used to flush directly into a host `useState`, so
 * every flush (up to ~60/s while streaming) re-rendered the entire
 * ~3,700-line controller host and everything downstream of it. Publishing
 * the flushed snapshot here instead means only components that actually
 * subscribe (the timeline, `ChatThreadView`) re-render per flush; the host
 * re-renders only on start/stop transitions.
 *
 * Mirrors the subscribe/notify/per-session-scoping shape of
 * `channel-activity-store.ts` in this same directory.
 */
import { useSyncExternalStore } from "react";

/**
 * Mirrors `ChatStreamingPreview` from `@goatcitadel/contracts` (also
 * re-exported as a type from `@goatcitadel/threaded-surface-core`). Declared
 * independently here rather than imported so this package never depends on
 * threaded-surface-core (threaded-surface-core already depends on
 * mission-control-shared; the reverse would be a direction violation).
 */
export interface ChatStreamingPreviewSnapshot {
  sessionId: string;
  turnId: string;
  messageId?: string;
  text: string;
  visibleText: string;
  updatedAt: number;
}

type ChatStreamingPreviewListener = () => void;

const snapshotsBySessionId = new Map<string, ChatStreamingPreviewSnapshot>();
const listenersBySessionId = new Map<string, Set<ChatStreamingPreviewListener>>();

/**
 * Publishes the latest flushed preview for a session. Pass `null` to clear
 * it (matches `ChatStreamingPreviewBuffer.clear()`/`dispose()` semantics).
 * Listeners are only notified when the published value's identity actually
 * changes something observable (a null->null publish, or re-publishing the
 * exact same object reference, is a no-op).
 */
export function publishChatStreamingPreview(sessionId: string, preview: ChatStreamingPreviewSnapshot | null): void {
  const previous = snapshotsBySessionId.get(sessionId) ?? null;
  if (previous === preview) {
    return;
  }
  if (preview === null) {
    if (previous === null) {
      return;
    }
    snapshotsBySessionId.delete(sessionId);
  } else {
    snapshotsBySessionId.set(sessionId, preview);
  }
  notifyChatStreamingPreviewListeners(sessionId);
}

export function getChatStreamingPreview(sessionId: string | null | undefined): ChatStreamingPreviewSnapshot | null {
  if (!sessionId) {
    return null;
  }
  return snapshotsBySessionId.get(sessionId) ?? null;
}

/**
 * Subscribes to preview changes for one session. The listener set is scoped
 * per sessionId (like `channel-activity-store`'s scoped subscriptions) so a
 * flush for session A never wakes a listener subscribed to session B.
 */
export function subscribeChatStreamingPreview(sessionId: string, listener: ChatStreamingPreviewListener): () => void {
  let listeners = listenersBySessionId.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    listenersBySessionId.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersBySessionId.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listenersBySessionId.delete(sessionId);
    }
  };
}

export function resetChatStreamingPreviewForTests(): void {
  snapshotsBySessionId.clear();
  listenersBySessionId.clear();
}

export function useChatStreamingPreviewSnapshot(
  sessionId: string | null | undefined,
): ChatStreamingPreviewSnapshot | null {
  return useSyncExternalStore(
    (listener) => subscribeToOptionalSession(sessionId, listener),
    () => getChatStreamingPreview(sessionId),
    getServerChatStreamingPreviewSnapshot,
  );
}

function subscribeToOptionalSession(
  sessionId: string | null | undefined,
  listener: ChatStreamingPreviewListener,
): () => void {
  if (!sessionId) {
    return () => undefined;
  }
  return subscribeChatStreamingPreview(sessionId, listener);
}

// Client-only store: a hypothetical SSR pass has no flushed preview to read,
// so the server snapshot is always null rather than reaching into module
// state that only ever gets populated by a live browser stream.
function getServerChatStreamingPreviewSnapshot(): null {
  return null;
}

function notifyChatStreamingPreviewListeners(sessionId: string): void {
  const listeners = listenersBySessionId.get(sessionId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}
