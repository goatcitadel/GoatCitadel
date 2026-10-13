import { useEffect, useRef, useSyncExternalStore } from "react";
import { getGatewayApiBaseUrl, getGatewayAccessRevision, subscribeGatewayAccessChange } from "@goatcitadel/mission-control-shared/api/client-core";
import { getGatewayCallerScope, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { upsertNotificationPresence } from "@goatcitadel/mission-control-shared/api/client";

const PRESENCE_INTERVAL_MS = 45_000;
const PRESENCE_TTL_MS = 90_000;
const CLIENT_STORAGE_KEY = "goatcitadel.notification-client-id";
const ephemeralIdentifiers = new Map<string, string>();

interface PresenceLeaseOwner {
  identity: string;
  workspaceId: string;
  sessionId?: string;
  publish: (forceAway?: boolean) => void;
}

function presenceAccessIdentity(): string {
  return JSON.stringify([getGatewayApiBaseUrl(), getGatewayCallerScope(), getGatewayAccessRevision()]);
}

export function useNotificationPresenceLease(workspaceId: string, sessionId?: string): void {
  const revision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, getGatewayCallerScope);
  const identity = JSON.stringify([getGatewayApiBaseUrl(), caller, revision]);
  const active = useRef<PresenceLeaseOwner | null>(null);
  useEffect(() => {
    if (!workspaceId || typeof window === "undefined" || typeof document === "undefined" ||
      typeof window.addEventListener !== "function" || typeof document.addEventListener !== "function") return;
    const clientId = sessionIdentifier(CLIENT_STORAGE_KEY);
    const leaseId = randomIdentifier();
    let disposed = false;
    let writes = Promise.resolve();
    const owner: PresenceLeaseOwner = {
      identity, workspaceId, sessionId,
      publish(forceAway = false) {
        if (disposed && !forceAway) return;
        const input = {
          workspaceId, leaseId, clientId, ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
          focused: forceAway ? false : document.hasFocus(),
          visible: forceAway ? false : document.visibilityState === "visible", ttlMs: PRESENCE_TTL_MS,
        };
        // Serialize updates to this lease so a slow previous session write cannot replace its successor.
        writes = writes.then(async () => {
          // A replacement transport/caller cannot retire a lease using its predecessor's authority.
          // The old lease expires fail-safe under its existing TTL.
          if (presenceAccessIdentity() !== identity) return;
          try { await upsertNotificationPresence(input); } catch { /* Unknown or expired presence is away. */ }
        });
      },
    };
    active.current = owner;
    const handleStateChange = () => owner.publish();
    window.addEventListener("focus", handleStateChange);
    window.addEventListener("blur", handleStateChange);
    document.addEventListener("visibilitychange", handleStateChange);
    const interval = window.setInterval(handleStateChange, PRESENCE_INTERVAL_MS);
    owner.publish();
    return () => {
      disposed = true;
      if (active.current === owner) active.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleStateChange);
      window.removeEventListener("blur", handleStateChange);
      document.removeEventListener("visibilitychange", handleStateChange);
      owner.publish(true);
    };
  }, [workspaceId, identity]);

  useEffect(() => {
    const owner = active.current;
    if (!owner || owner.identity !== identity || owner.workspaceId !== workspaceId || owner.sessionId === sessionId) return;
    // Selecting a conversation updates the mounted scope's lease without an artificial away/return pair.
    owner.sessionId = sessionId;
    owner.publish();
  }, [workspaceId, identity, sessionId]);
}

function randomIdentifier(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sessionIdentifier(key: string): string {
  try {
    const storage = window.sessionStorage;
    const existing = storage?.getItem(key);
    if (existing) return existing;
    const value = ephemeralIdentifiers.get(key) ?? randomIdentifier();
    ephemeralIdentifiers.set(key, value);
    storage?.setItem(key, value);
    return value;
  } catch {
    const value = ephemeralIdentifiers.get(key) ?? randomIdentifier();
    ephemeralIdentifiers.set(key, value);
    return value;
  }
}
