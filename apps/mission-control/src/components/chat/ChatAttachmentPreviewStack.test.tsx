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

  it("renders nothing for empty attachment lists", async () => {
    await act(async () => {
      root?.render(<ChatAttachmentPreviewStack attachments={[]} />);
      await Promise.resolve();
    });

    expect(fetchChatAttachmentPreviewMock).not.toHaveBeenCalled();
    expect(container?.textContent).toBe("");
  });

  it("surfaces fetch errors and prefers transcript text over OCR or extract previews", async () => {
    fetchChatAttachmentPreviewMock.mockRejectedValueOnce(new Error("preview service offline")).mockResolvedValueOnce({
      attachmentId: "attachment-transcript",
      fileName: "attachment-transcript.pdf",
      mimeType: "application/pdf",
      mediaType: "binary",
      transcriptText: "Transcript text wins",
      analysisStatus: "ready",
    });

    await act(async () => {
      root?.render(<ChatAttachmentPreviewStack attachments={[makeAttachment("attachment-error")]} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Preview unavailable: preview service offline");

    await act(async () => {
      root?.render(<ChatAttachmentPreviewStack attachments={[makeAttachment("attachment-transcript")]} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Transcript");
    expect(container?.textContent).toContain("Transcript text wins");
    expect(container?.textContent).not.toContain("Preview text loses");
  });

  it("serves fresh cached previews without another request", async () => {
    fetchChatAttachmentPreviewMock.mockResolvedValueOnce({
      attachmentId: "attachment-cache",
      fileName: "attachment-cache.pdf",
      mimeType: "application/pdf",
      mediaType: "binary",
      ocrText: "Cached OCR text",
      analysisStatus: "ready",
    });

    await act(async () => {
      root?.render(<ChatAttachmentPreviewStack attachments={[makeAttachment("attachment-cache")]} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("OCR");
    expect(container?.textContent).toContain("Cached OCR text");

    await act(async () => {
      root?.render(<ChatAttachmentPreviewStack attachments={[]} />);
      await Promise.resolve();
      root?.render(<ChatAttachmentPreviewStack attachments={[makeAttachment("attachment-cache")]} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchChatAttachmentPreviewMock).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Cached OCR text");
  });
});
