import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("waits for the matching native acknowledgement and surfaces native errors", async () => {
  let callback: (event: MessageEvent) => void = () => undefined;
  const postMessage = vi.fn();
  vi.stubGlobal("window", {
    chrome: {
      webview: {
        postMessage,
        addEventListener: (_: string, listener: typeof callback) => {
          callback = listener;
        },
        removeEventListener: vi.fn(),
      },
    },
  });
  const { requestDesktopUpdate } = await import("./desktop-update-bridge");
  const request = requestDesktopUpdate("reveal");
  const id = postMessage.mock.calls.at(-1)![0].requestId;
  const rejection = expect(request).rejects.toThrow("Checksum mismatch");
  callback({
    data: {
      type: "goatcitadel.updates.status",
      requestId: id,
      error: "Checksum mismatch",
      status: { channel: "preview", installedVersion: "1.0.0", message: "Download failed." },
    },
  } as MessageEvent);
  await rejection;
});
it("rejects operations outside the installed desktop host", async () => {
  vi.stubGlobal("window", {});
  const { requestDesktopUpdate } = await import("./desktop-update-bridge");
  await expect(requestDesktopUpdate("download")).rejects.toThrow("installed Windows app");
});
