import { useSyncExternalStore } from "react";
import type { DesktopUpdateRequest, DesktopUpdateResponse, DesktopUpdateStatus } from "@goatcitadel/contracts";

interface NativeWebView {
  postMessage(message: DesktopUpdateRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
const listeners = new Set<() => void>();
let status: DesktopUpdateStatus | null = null;
let connected: NativeWebView | undefined;
const pending = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function nativeHost(): NativeWebView | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { chrome?: { webview?: NativeWebView } }).chrome?.webview;
}

function onMessage(event: MessageEvent): void {
  const value = event.data as Partial<DesktopUpdateResponse> | null;
  if (
    value?.type !== "goatcitadel.updates.status" ||
    !value.status ||
    !["stable", "preview"].includes(value.status.channel) ||
    typeof value.status.message !== "string" ||
    typeof value.status.installedVersion !== "string"
  )
    return;
  status = value.status;
  listeners.forEach((listener) => listener());
  const request = value.requestId ? pending.get(value.requestId) : undefined;
  if (request && value.requestId) {
    clearTimeout(request.timer);
    pending.delete(value.requestId);
    if (value.error) request.reject(new Error(value.error));
    else request.resolve();
  }
}

function connect(): void {
  const host = nativeHost();
  if (!host || connected === host) return;
  connected?.removeEventListener("message", onMessage);
  connected = host;
  host.addEventListener("message", onMessage);
  host.postMessage({ type: "goatcitadel.updates.request", requestId: crypto.randomUUID(), action: "status" });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
  };
}

export function useDesktopUpdates(): DesktopUpdateStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => null,
  );
}

export function requestDesktopUpdate(
  action: DesktopUpdateRequest["action"],
  options: Pick<DesktopUpdateRequest, "channel" | "releaseTag"> = {},
): Promise<void> {
  connect();
  if (!connected) return Promise.reject(new Error("Open the installed Windows app to manage updates."));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pending.delete(requestId);
        reject(new Error("The desktop update operation did not respond. Check its status or try again."));
      },
      action === "download" ? 16 * 60 * 1000 : 90_000,
    );
    pending.set(requestId, { resolve, reject, timer });
    connected!.postMessage({ type: "goatcitadel.updates.request", requestId, action, ...options });
  });
}
