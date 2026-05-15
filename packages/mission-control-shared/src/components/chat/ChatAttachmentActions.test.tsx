// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatAttachmentActions,
  downloadChatAttachmentToDevice,
  openChatAttachmentInBrowser,
} from "./ChatAttachmentActions";

const downloadChatAttachmentMock = vi.fn();

vi.mock("../../api/client", () => ({
  downloadChatAttachment: (attachmentId: string) => downloadChatAttachmentMock(attachmentId),
}));

describe("ChatAttachmentActions", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let clickedDownloadName: string | null = null;
  let clickedHref: string | null = null;
  let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    originalCreateObjectUrl = URL.createObjectURL;
    originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:goatcitadel-test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    clickedDownloadName = null;
    clickedHref = null;
    downloadChatAttachmentMock.mockReset();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      clickedDownloadName = this.download;
      clickedHref = this.href;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  });

  it("downloads the attachment through the authenticated attachment API", async () => {
    downloadChatAttachmentMock.mockResolvedValue({
      blob: new Blob(["image"], { type: "image/png" }),
      fileName: "generated-image.png",
      mimeType: "image/png",
    });

    await act(async () => {
      root?.render(<ChatAttachmentActions attachmentId="attachment-1" fileName="fallback.png" />);
      await Promise.resolve();
    });

    const downloadButton = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Download",
    );
    expect(downloadButton).toBeTruthy();

    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(downloadChatAttachmentMock).toHaveBeenCalledWith("attachment-1");
    expect(clickedDownloadName).toBe("generated-image.png");
    expect(clickedHref).toBe("blob:goatcitadel-test");
    expect(container?.textContent).toContain("Download started.");
  });

  it("opens attachments in a prepared browser tab and falls back to downloads when popups are blocked", async () => {
    const openedWindow = {
      closed: false,
      document: {
        title: "",
        body: { textContent: "" },
      },
      location: { href: "" },
      opener: {},
    };
    vi.spyOn(window, "open").mockReturnValue(openedWindow as unknown as Window);
    downloadChatAttachmentMock.mockResolvedValue({
      blob: new Blob(["report"], { type: "text/plain" }),
      fileName: "",
      mimeType: "text/plain",
    });

    await expect(openChatAttachmentInBrowser({ attachmentId: "attachment-2", fileName: " report.txt " })).resolves.toBe(
      "opened",
    );

    expect(openedWindow.opener).toBeNull();
    expect(openedWindow.document.title).toBe("Opening report.txt");
    expect(openedWindow.document.body.textContent).toBe("Opening report.txt...");
    expect(openedWindow.location.href).toBe("blob:goatcitadel-test");
    expect(clickedDownloadName).toBeNull();

    vi.mocked(window.open).mockReturnValue(null);
    await expect(openChatAttachmentInBrowser({ attachmentId: "attachment-3", fileName: "fallback.txt" })).resolves.toBe(
      "downloaded",
    );
    expect(clickedDownloadName).toBe("fallback.txt");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:goatcitadel-test");
  });

  it("surfaces browser capability errors and attachment download failures", async () => {
    const onError = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: undefined,
    });

    await act(async () => {
      root?.render(
        <ChatAttachmentActions attachmentId="attachment-4" fileName="errors.txt" onError={onError}>
          <span>child action</span>
        </ChatAttachmentActions>,
      );
      await Promise.resolve();
    });

    const [openButton, downloadButton] = [...(container?.querySelectorAll("button") ?? [])];
    expect(container?.textContent).toContain("child action");

    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith("This browser cannot create a local download link for the attachment.");
    expect(downloadChatAttachmentMock).not.toHaveBeenCalled();

    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("reports attachment open failures in the pending tab and closes it when error reporting is blocked", async () => {
    const close = vi.fn();
    let bodyText = "";
    const openedWindow = {
      closed: false,
      document: {
        title: "",
        body: {
          get textContent() {
            return bodyText;
          },
          set textContent(value: string) {
            bodyText = value;
          },
        },
      },
      location: { href: "" },
      opener: {},
      close,
    };
    vi.spyOn(window, "open").mockReturnValue(openedWindow as unknown as Window);
    downloadChatAttachmentMock.mockRejectedValueOnce(new Error("Gateway denied attachment"));

    await expect(openChatAttachmentInBrowser({ attachmentId: "attachment-5", fileName: "denied.txt" })).rejects.toThrow(
      "Gateway denied attachment",
    );

    expect(bodyText).toBe("Unable to open attachment: Gateway denied attachment");
    expect(close).not.toHaveBeenCalled();

    const throwingWindow = {
      closed: false,
      document: {
        title: "",
        body: {
          set textContent(_value: string) {
            throw new Error("cross-origin tab");
          },
        },
      },
      location: { href: "" },
      opener: {},
      close,
    };
    vi.mocked(window.open).mockReturnValue(throwingWindow as unknown as Window);
    downloadChatAttachmentMock.mockRejectedValueOnce(new Error("Still denied"));

    await expect(openChatAttachmentInBrowser({ attachmentId: "attachment-6", fileName: "" })).rejects.toThrow(
      "Still denied",
    );

    expect(close).toHaveBeenCalled();
  });

  it("normalizes blank download names and rejects outside browser globals", async () => {
    downloadChatAttachmentMock.mockResolvedValue({
      blob: new Blob(["blank"], { type: "text/plain" }),
      fileName: "",
      mimeType: "text/plain",
    });
    await downloadChatAttachmentToDevice({ attachmentId: "attachment-7", fileName: "   " });
    expect(clickedDownloadName).toBe("attachment");

    const originalWindow = globalThis.window;
    vi.stubGlobal("window", undefined);
    try {
      await expect(
        downloadChatAttachmentToDevice({ attachmentId: "attachment-8", fileName: "offline.txt" }),
      ).rejects.toThrow("Attachment downloads are only available in the browser.");
    } finally {
      vi.stubGlobal("window", originalWindow);
    }
  });
});
