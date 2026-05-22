import { useEffect, useRef } from "react";

export function createDraftStorageKey(workspaceId: string, sessionId: string | null): string {
  return `goatcitadel.chat.draft.${workspaceId}.${sessionId ?? "new"}`;
}

export function createAttachmentStorageKey(workspaceId: string, sessionId: string | null): string {
  return `goatcitadel.chat.attachments.${workspaceId}.${sessionId ?? "new"}`;
}

export function createQueueStorageKey(workspaceId: string, sessionId: string | null): string {
  return `goatcitadel.chat.queue.${workspaceId}.${sessionId ?? "new"}`;
}

export function clearChatSessionLocalState(workspaceId: string, sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(createDraftStorageKey(workspaceId, sessionId));
    window.localStorage.removeItem(createAttachmentStorageKey(workspaceId, sessionId));
    window.localStorage.removeItem(createQueueStorageKey(workspaceId, sessionId));
  } catch {
    // Fallback: localStorage may be disabled; stale keys (if any) will be overwritten on next write.
  }
}

export function useDebouncedLocalStoragePersistence(key: string, value: string, delayMs = 400): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriteRef = useRef<{ key: string; value: string } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (pendingWriteRef.current && pendingWriteRef.current.key !== key) {
      try {
        window.localStorage.setItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
      } catch {
        // Fallback: localStorage may be disabled or quota-exceeded; drop the pending write rather than crash.
      }
      pendingWriteRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    pendingWriteRef.current = { key, value };
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      const pending = pendingWriteRef.current;
      if (pending) {
        try {
          window.localStorage.setItem(pending.key, pending.value);
        } catch {
          // Fallback: localStorage may be disabled or quota-exceeded; drop the pending write rather than crash.
        }
        pendingWriteRef.current = null;
      }
      timerRef.current = null;
    }, delayMs);
  }, [delayMs, key, value]);

  useEffect(
    () => () => {
      if (typeof window === "undefined") {
        return;
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingWriteRef.current) {
        try {
          window.localStorage.setItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
        } catch {
          // Fallback: localStorage may be disabled or quota-exceeded; drop the pending write rather than crash.
        }
        pendingWriteRef.current = null;
      }
    },
    [],
  );
}
