// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAttachmentActions } from "./ChatAttachmentActions";

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
});
