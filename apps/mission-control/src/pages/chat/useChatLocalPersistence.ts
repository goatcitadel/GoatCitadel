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

function setLocalStorageItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function removeLocalStorageItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

export function clearChatSessionLocalState(workspaceId: string, sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  removeLocalStorageItem(createDraftStorageKey(workspaceId, sessionId));
  removeLocalStorageItem(createAttachmentStorageKey(workspaceId, sessionId));
  removeLocalStorageItem(createQueueStorageKey(workspaceId, sessionId));
}

export function useDebouncedLocalStoragePersistence(key: string, value: string, delayMs = 400): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriteRef = useRef<{ key: string; value: string } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (pendingWriteRef.current && pendingWriteRef.current.key !== key) {
      setLocalStorageItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
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
        setLocalStorageItem(pending.key, pending.value);
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
        setLocalStorageItem(pendingWriteRef.current.key, pendingWriteRef.current.value);
        pendingWriteRef.current = null;
      }
    },
    [],
  );
}
