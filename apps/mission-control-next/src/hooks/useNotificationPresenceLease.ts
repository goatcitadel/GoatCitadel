import { useEffect } from "react";
import { upsertNotificationPresence } from "@goatcitadel/mission-control-shared/api/client";

const PRESENCE_INTERVAL_MS = 45_000;
const PRESENCE_TTL_MS = 90_000;
const CLIENT_STORAGE_KEY = "goatcitadel.notification-client-id";
const LEASE_STORAGE_KEY = "goatcitadel.notification-lease-id";

export function useNotificationPresenceLease(workspaceId: string, sessionId?: string): void {
  useEffect(() => {
    if (
      !workspaceId ||
      typeof window === "undefined" ||
      typeof document === "undefined" ||
      typeof window.addEventListener !== "function" ||
      typeof document.addEventListener !== "function"
    )
      return;
    const clientId = sessionIdentifier(CLIENT_STORAGE_KEY);
    const leaseId = sessionIdentifier(LEASE_STORAGE_KEY);
    let disposed = false;

    const publish = async (forceAway = false) => {
      if (disposed && !forceAway) return;
      try {
        await upsertNotificationPresence({
          workspaceId,
          leaseId,
          clientId,
          ...(sessionId ? { sessionId } : {}),
          focused: forceAway ? false : document.hasFocus(),
          visible: forceAway ? false : document.visibilityState === "visible",
          ttlMs: PRESENCE_TTL_MS,
        });
      } catch {
        // Presence is intentionally fail-safe: an unknown or expired lease is away.
      }
    };

    const handleStateChange = () => void publish();
    window.addEventListener("focus", handleStateChange);
    window.addEventListener("blur", handleStateChange);
    document.addEventListener("visibilitychange", handleStateChange);
    const interval = window.setInterval(handleStateChange, PRESENCE_INTERVAL_MS);
    void publish();

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleStateChange);
      window.removeEventListener("blur", handleStateChange);
      document.removeEventListener("visibilitychange", handleStateChange);
      void publish(true);
    };
  }, [sessionId, workspaceId]);
}

function sessionIdentifier(key: string): string {
  const storage = window.sessionStorage;
  const existing = storage?.getItem(key);
  if (existing) return existing;
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  storage?.setItem(key, value);
  return value;
}
