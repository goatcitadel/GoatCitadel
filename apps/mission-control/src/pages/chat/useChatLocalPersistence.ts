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
  window.localStorage.removeItem(createDraftStorageKey(workspaceId, sessionId));
  window.localStorage.removeItem(createAttachmentStorageKey(workspaceId, sessionId));
  window.localStorage.removeItem(createQueueStorageKey(workspaceId, sessionId));
}

export function useDebouncedLocalStoragePersistence(key: string, value: string, delayMs = 400): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriteRef = useRef<{ key: string; value: string } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (pendingWriteRef.current && pendingWriteRef.current.key !== key) {
      window.localStorage.setItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
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
        window.localStorage.setItem(pending.key, pending.value);
        pendingWriteRef.current = null;
      }
      timerRef.current = null;
    }, delayMs);
  }, [delayMs, key, value]);

  useEffect(() => () => {
    if (typeof window === "undefined") {
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingWriteRef.current) {
      window.localStorage.setItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
      pendingWriteRef.current = null;
    }
  }, []);
}
