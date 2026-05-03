// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAttachmentPreviewStack, resetAttachmentPreviewStateForTests } from "./ChatAttachmentPreviewStack";

const fetchChatAttachmentPreviewMock = vi.fn();

vi.mock("../../api/client", () => ({
  fetchChatAttachmentPreview: (attachmentId: string) => fetchChatAttachmentPreviewMock(attachmentId),
}));

function makeAttachment(attachmentId: string) {
  return {
    attachmentId,
    fileName: `${attachmentId}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 8_192,
  };
}

describe("ChatAttachmentPreviewStack", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetAttachmentPreviewStateForTests();
    fetchChatAttachmentPreviewMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    resetAttachmentPreviewStateForTests();
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
  });

  it("retries queued previews and updates once extracted content is ready", async () => {
    fetchChatAttachmentPreviewMock
      .mockResolvedValueOnce({
        attachmentId: "attachment-retry",
        fileName: "attachment-retry.pdf",
        mimeType: "application/pdf",
        mediaType: "binary",
        analysisStatus: "queued",
      })
      .mockResolvedValueOnce({
        attachmentId: "attachment-retry",
        fileName: "attachment-retry.pdf",
        mimeType: "application/pdf",
        mediaType: "binary",
        extractPreview: "Resolved preview text",
        analysisStatus: "ready",
      });

    await act(async () => {
      root?.render(<ChatAttachmentPreviewStack attachments={[makeAttachment("attachment-retry")]} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchChatAttachmentPreviewMock).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Extraction is still preparing.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchChatAttachmentPreviewMock).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain("Resolved preview text");
  });

  it("does not keep polling once extracted content is already available", async () => {
    fetchChatAttachmentPreviewMock.mockResolvedValue({
      attachmentId: "attachment-ready",
      fileName: "attachment-ready.pdf",
      mimeType: "application/pdf",
      mediaType: "binary",
      extractPreview: "Stable preview text",
      analysisStatus: "ready",
    });

    await act(async () => {
      root?.render(<ChatAttachmentPreviewStack attachments={[makeAttachment("attachment-ready")]} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
    });

    expect(fetchChatAttachmentPreviewMock).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Stable preview text");
    expect(container?.textContent).toContain("Open");
    expect(container?.textContent).toContain("Download");
  });
});
