interface NativeWebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export async function requestNativeManagedSourcePath(planId: string, actionId: string): Promise<string | undefined> {
  const bridge = (window as typeof window & { chrome?: { webview?: NativeWebViewBridge } }).chrome?.webview;
  if (!bridge) {
    throw new Error("Managed source registration requires the signed GoatCitadel Windows desktop host.");
  }
  const requestId = crypto.randomUUID();
  return await new Promise<string | undefined>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      bridge.removeEventListener("message", onMessage);
      reject(new Error("The native source picker expired without returning a selection."));
    }, 5 * 60_000);
    const onMessage = (event: { data: unknown }) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (Reflect.get(data, "type") !== "goatcitadel.evolution.source_selected") return;
      if (Reflect.get(data, "requestId") !== requestId) return;
      window.clearTimeout(timeout);
      bridge.removeEventListener("message", onMessage);
      if (Reflect.get(data, "cancelled") === true) {
        resolve(undefined);
        return;
      }
      const selectedPath = Reflect.get(data, "path");
      if (typeof selectedPath !== "string" || !selectedPath.trim()) {
        reject(new Error("The native source picker returned an invalid selection."));
        return;
      }
      resolve(selectedPath);
    };
    bridge.addEventListener("message", onMessage);
    bridge.postMessage({
      type: "goatcitadel.evolution.pick_source",
      requestId,
      planId,
      actionId,
    });
  });
}
