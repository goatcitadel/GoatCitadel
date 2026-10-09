import { invalidateLocalInboxReads, INBOX_LOCAL_ACCESS_GENERATION_KEY } from "./inbox-local-read-store.js";
let gatewayAccessRevision = 0;
const gatewayAccessChangeListeners = new Set<() => void>();
let gatewayAccessObservedWindow: Window | undefined;

/** Custody-change revision only; never a caller identity or authorization claim. */
export function getGatewayAccessRevision(): number {
  observeGatewayAccessStorage();
  return gatewayAccessRevision;
}
export function notifyGatewayAccessChanged(invalidateLocalReads = true) {
  if (invalidateLocalReads) invalidateLocalInboxReads();
  gatewayAccessRevision += 1;
  gatewayAccessChangeListeners.forEach((listener) => listener());
}
function gatewayAccessStorageChanged(event: StorageEvent) {
  if (event.key === INBOX_LOCAL_ACCESS_GENERATION_KEY) {
    notifyGatewayAccessChanged(false);
    return;
  }
  if (
    event.key === null ||
    event.key === "goatcitadel.gateway.auth" ||
    event.key === "goatcitadel.gateway.auth.storageMode"
  )
    notifyGatewayAccessChanged();
}
function observeGatewayAccessStorage() {
  // The custody owner keeps observing between view unmounts; a later reader must not reuse old denials.
  if (
    typeof window === "undefined" ||
    gatewayAccessObservedWindow === window ||
    typeof window.addEventListener !== "function"
  )
    return;
  gatewayAccessObservedWindow?.removeEventListener?.("storage", gatewayAccessStorageChanged);
  gatewayAccessObservedWindow = window;
  window.addEventListener("storage", gatewayAccessStorageChanged);
}
export function subscribeGatewayAccessChange(listener: () => void): () => void {
  observeGatewayAccessStorage();
  gatewayAccessChangeListeners.add(listener);
  return () => {
    gatewayAccessChangeListeners.delete(listener);
  };
}

let callerScope = "";
const callerScopeListeners = new Set<() => void>();
export function subscribeGatewayCallerScope(listener: () => void): () => void {
  callerScopeListeners.add(listener);
  return () => { callerScopeListeners.delete(listener); };
}
export function getGatewayCallerScope() {
  return callerScope;
}
/** Server-authored principal scope only; never submitted credential material. */
export function setGatewayCallerScope(scope: string) {
  if (callerScope === scope) return;
  if (callerScope && callerScope !== scope) invalidateLocalInboxReads();
  callerScope = scope;
  callerScopeListeners.forEach((listener) => listener());
}
