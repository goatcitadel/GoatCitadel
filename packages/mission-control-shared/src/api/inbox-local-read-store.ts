import type { OperatorInboxUpdateReference } from "@goatcitadel/contracts";
export const INBOX_LOCAL_READ_PREFIX = "goatcitadel.inbox.read.v1:";
export const INBOX_LOCAL_ACCESS_GENERATION_KEY = "goatcitadel.inbox.access-generation.v1";
const listeners = new Set<() => void>();
const writeDenied = new Set<string>();
let invalidationUnavailable = false;
let observedWindow: Window | undefined;
const changed = () => {
  for (const listener of listeners) listener();
};
function storageChanged(event: StorageEvent) {
  if (
    event.key === null ||
    event.key === INBOX_LOCAL_ACCESS_GENERATION_KEY ||
    event.key.startsWith(INBOX_LOCAL_READ_PREFIX)
  )
    changed();
}
function observe() {
  if (typeof window === "undefined" || observedWindow === window) return;
  observedWindow?.removeEventListener("storage", storageChanged);
  observedWindow = window;
  window.addEventListener("storage", storageChanged);
}
function generation(): string {
  return localStorage.getItem(INBOX_LOCAL_ACCESS_GENERATION_KEY) ?? "initial";
}
export function inboxLocalReadKey(installation: string, workspaceId: string): string {
  return INBOX_LOCAL_READ_PREFIX + JSON.stringify([installation, workspaceId, generation()]);
}
function references(raw: string): OperatorInboxUpdateReference[] {
  const data: unknown = JSON.parse(raw);
  return Array.isArray(data)
    ? data
        .filter(
          (e) =>
            e &&
            typeof e.id === "string" &&
            e.id.length <= 240 &&
            typeof e.version === "string" &&
            /^[a-f0-9]{64}$/.test(e.version),
        )
        .slice(-1000)
        .map((e) => ({ id: e.id, version: e.version }))
    : [];
}
export function readLocalInboxUpdates(installation: string, workspaceId: string): string {
  observe();
  if (invalidationUnavailable) return "unavailable";
  try {
    return localStorage.getItem(inboxLocalReadKey(installation, workspaceId)) ?? "[]";
  } catch {
    return "unavailable";
  }
}
export function localInboxStorageAvailable(installation: string, workspaceId: string): boolean {
  try {
    return (
      !invalidationUnavailable &&
      typeof navigator?.locks?.request === "function" &&
      !writeDenied.has(inboxLocalReadKey(installation, workspaceId)) &&
      readLocalInboxUpdates(installation, workspaceId) !== "unavailable"
    );
  } catch {
    return false;
  }
}
export function subscribeLocalInboxReads(listener: () => void) {
  observe();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Persistent access owner calls this even when Inbox has never mounted. The nonce is presentation metadata only. */
export function invalidateLocalInboxReads(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(INBOX_LOCAL_ACCESS_GENERATION_KEY, crypto.randomUUID());
    invalidationUnavailable = false;
    writeDenied.clear();
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
      (key): key is string => Boolean(key?.startsWith(INBOX_LOCAL_READ_PREFIX)),
    );
    for (const key of keys) {
      // Re-read generation: another tab can invalidate again during cleanup.
      const scope = JSON.parse(key.slice(INBOX_LOCAL_READ_PREFIX.length));
      if (!Array.isArray(scope) || scope[2] !== generation()) localStorage.removeItem(key);
    }
  } catch {
    invalidationUnavailable = true;
  }
  changed();
}
/** Origin Web Locks serialize the real shared localStorage read/merge/write across browser tabs. */
export async function acknowledgeLocalInboxUpdate(
  installation: string,
  workspaceId: string,
  update: OperatorInboxUpdateReference,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!installation || !workspaceId || !update.id || update.id.length > 240 || !/^[a-f0-9]{64}$/.test(update.version))
    return false;
  let key: string;
  try {
    key = inboxLocalReadKey(installation, workspaceId);
  } catch {
    return false;
  }
  if (!localInboxStorageAvailable(installation, workspaceId)) return false;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  const unsubscribe = subscribeLocalInboxReads(() => {
    try {
      if (!isCurrent() || key !== inboxLocalReadKey(installation, workspaceId)) controller.abort();
    } catch {
      controller.abort();
    }
  });
  try {
    return await navigator.locks.request(key, { signal: controller.signal }, () => {
      if (
        !isCurrent() ||
        key !== inboxLocalReadKey(installation, workspaceId) ||
        !localInboxStorageAvailable(installation, workspaceId)
      )
        return false;
      const previous = localStorage.getItem(key) ?? "[]";
      const next = [
        ...references(previous).filter((e) => e.id !== update.id || e.version !== update.version),
        { id: update.id, version: update.version },
      ].slice(-1000);
      localStorage.setItem(key, JSON.stringify(next));
      changed();
      return isCurrent() && key === inboxLocalReadKey(installation, workspaceId);
    });
  } catch {
    writeDenied.add(key);
    changed();
    return false;
  } finally {
    clearTimeout(deadline);
    unsubscribe();
  }
}
