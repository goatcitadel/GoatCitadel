import { useEffect, useRef } from "react";
import { getGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";

function storageKey(kind: string, workspaceId: string, sessionId: string | null): string {
  const caller = getGatewayCallerScope();
  // Only the Gateway-authored caller can own retained input. Legacy keys remain intact,
  // but cannot be attributed to an identified caller and must not be imported into it.
  return caller
    ? `goatcitadel.chat.${kind}.caller:${JSON.stringify([caller, workspaceId, sessionId])}`
    : `goatcitadel.chat.${kind}.${workspaceId}.${sessionId ?? "new"}`;
}

export function createDraftStorageKey(workspaceId: string, sessionId: string | null): string {
  return storageKey("draft", workspaceId, sessionId);
}

export function createAttachmentStorageKey(workspaceId: string, sessionId: string | null): string {
  return storageKey("attachments", workspaceId, sessionId);
}

export function createQueueStorageKey(workspaceId: string, sessionId: string | null): string {
  return storageKey("queue", workspaceId, sessionId);
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

  useEffect(() => {
    const flush = () => {
      if (typeof window === "undefined") return;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingWriteRef.current;
      if (pending) {
        try {
          // Keep the original captured owner even if access changed before pagehide.
          window.localStorage.setItem(pending.key, pending.value);
        } catch {
          // Best-effort on exit: storage may be disabled or quota-exceeded; do not crash.
        }
        pendingWriteRef.current = null;
      }
    };
    // Browser reload/navigation does not unmount React. Persist retained input
    // synchronously before the document leaves, including an immediate queue reload.
    if (typeof window !== "undefined") window.addEventListener?.("pagehide", flush);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener?.("pagehide", flush);
      flush();
    };
  }, []);
}
