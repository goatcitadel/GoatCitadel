import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentPreviewResponse, ChatMessageRecord } from "@goatcitadel/contracts";
import { ChatAttachmentPreviewStack, resetAttachmentPreviewStateForTests } from "./ChatAttachmentPreviewStack";

const apiMocks = vi.hoisted(() => ({
  fetchChatAttachmentPreview: vi.fn(),
  downloadChatAttachment: vi.fn(),
  getGatewayApiBaseUrl: vi.fn(() => "https://gateway-a.example"),
}));

vi.mock("../../api/client", () => ({
  fetchChatAttachmentPreview: apiMocks.fetchChatAttachmentPreview,
  downloadChatAttachment: apiMocks.downloadChatAttachment,
  getGatewayApiBaseUrl: apiMocks.getGatewayApiBaseUrl,
}));

function attachment(patch: Partial<NonNullable<ChatMessageRecord["attachments"]>[number]> = {}) {
  return {
    attachmentId: "attachment-1",
    fileName: "brief.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1536,
    ...patch,
  } as NonNullable<ChatMessageRecord["attachments"]>[number];
}

function preview(patch: Partial<ChatAttachmentPreviewResponse> = {}): ChatAttachmentPreviewResponse {
  return {
    attachmentId: "attachment-1",
    analysisStatus: "completed",
    extractPreview: null,
    ocrText: null,
    transcriptText: null,
    ...patch,
  } as ChatAttachmentPreviewResponse;
}

async function renderStack(attachments: ChatMessageRecord["attachments"]): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ChatAttachmentPreviewStack attachments={attachments} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

function hasText(renderer: ReactTestRenderer, text: string): boolean {
  return JSON.stringify(renderer.toJSON()).includes(text);
}

describe("ChatAttachmentPreviewStack", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetAttachmentPreviewStateForTests();
    apiMocks.fetchChatAttachmentPreview.mockReset();
    apiMocks.downloadChatAttachment.mockReset();
    apiMocks.getGatewayApiBaseUrl.mockReset();
    apiMocks.getGatewayApiBaseUrl.mockReturnValue("https://gateway-a.example");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not render an empty attachment preview stack", async () => {
    expect((await renderStack(undefined)).toJSON()).toBeNull();
    expect((await renderStack([])).toJSON()).toBeNull();
    expect(apiMocks.fetchChatAttachmentPreview).not.toHaveBeenCalled();
  });

  it("renders transcript and metadata from the authenticated preview endpoint", async () => {
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        transcriptText: "Recorded launch notes",
      }),
    );

    const renderer = await renderStack([attachment()]);

    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledWith("attachment-1");
    expect(hasText(renderer, "Transcript")).toBe(true);
    expect(hasText(renderer, "Recorded launch notes")).toBe(true);
    expect(hasText(renderer, "completed")).toBe(true);
  });

  it("reuses cached OCR previews for the same attachment during the cache window", async () => {
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        ocrText: "OCR text from cached report",
      }),
    );

    const first = await renderStack([attachment()]);
    expect(hasText(first, "OCR")).toBe(true);
    first.unmount();

    const second = await renderStack([attachment()]);

    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(1);
    expect(hasText(second, "OCR text from cached report")).toBe(true);
  });

  it("refetches after the gateway changes even though the cache window has not elapsed", async () => {
    apiMocks.getGatewayApiBaseUrl.mockReturnValue("https://gateway-a.example");
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        ocrText: "OCR text from gateway A",
      }),
    );

    const first = await renderStack([attachment()]);
    expect(hasText(first, "OCR text from gateway A")).toBe(true);
    first.unmount();

    apiMocks.getGatewayApiBaseUrl.mockReturnValue("https://gateway-b.example");
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        ocrText: "OCR text from gateway B",
      }),
    );

    const second = await renderStack([attachment()]);

    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(2);
    expect(hasText(second, "OCR text from gateway B")).toBe(true);
  });

  it("does not serve a stale gateway-A cache entry after switching back from gateway B", async () => {
    apiMocks.getGatewayApiBaseUrl.mockReturnValue("https://gateway-a.example");
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        ocrText: "OCR text unique to gateway A",
      }),
    );
    const onGatewayA = await renderStack([attachment()]);
    expect(hasText(onGatewayA, "OCR text unique to gateway A")).toBe(true);
    onGatewayA.unmount();

    apiMocks.getGatewayApiBaseUrl.mockReturnValue("https://gateway-a.example");
    const stillOnGatewayA = await renderStack([attachment()]);
    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(1);
    expect(hasText(stillOnGatewayA, "OCR text unique to gateway A")).toBe(true);
  });

  it("treats a failed preview as expired after 5 seconds instead of the normal 30 second window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(preview({ analysisStatus: "failed" }));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatAttachmentPreviewStack attachments={[attachment()]} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(1);
    expect(hasText(renderer, "failed")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });

    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(preview({ analysisStatus: "failed" }));
    await act(async () => {
      renderer = create(<ChatAttachmentPreviewStack attachments={[attachment()]} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(2);
  });

  it("keeps serving a healthy cached preview after 6 seconds, under the normal 30 second window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        analysisStatus: "completed",
        ocrText: "Healthy cached OCR text",
      }),
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatAttachmentPreviewStack attachments={[attachment()]} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });

    await act(async () => {
      renderer = create(<ChatAttachmentPreviewStack attachments={[attachment()]} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(1);
    expect(hasText(renderer, "Healthy cached OCR text")).toBe(true);
  });

  it("shares an in-flight preview request across concurrent preview cards", async () => {
    let resolvePreview!: (value: ChatAttachmentPreviewResponse) => void;
    apiMocks.fetchChatAttachmentPreview.mockReturnValue(
      new Promise<ChatAttachmentPreviewResponse>((resolve) => {
        resolvePreview = resolve;
      }),
    );

    let first!: ReactTestRenderer;
    let second!: ReactTestRenderer;
    await act(async () => {
      first = create(<ChatAttachmentPreviewStack attachments={[attachment({ attachmentId: "shared-preview" })]} />);
      second = create(<ChatAttachmentPreviewStack attachments={[attachment({ attachmentId: "shared-preview" })]} />);
      await Promise.resolve();
    });

    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledTimes(1);
    expect(hasText(first, "Extraction is still preparing.")).toBe(true);
    expect(hasText(second, "Extraction is still preparing.")).toBe(true);

    await act(async () => {
      resolvePreview(
        preview({
          attachmentId: "shared-preview",
          extractPreview: "Shared extracted preview",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasText(first, "Preview")).toBe(true);
    expect(hasText(second, "Shared extracted preview")).toBe(true);
  });

  it("defers preview loading until the attachment card is visible unless eager loading is requested", async () => {
    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class MockIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observerCallback = callback;
      }

      observe = observe;
      disconnect = disconnect;
    }

    vi.stubGlobal("window", {
      IntersectionObserver: MockIntersectionObserver,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        extractPreview: "Visible extracted preview",
      }),
    );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ChatAttachmentPreviewStack attachments={[attachment()]} />, {
        createNodeMock: (element) => (element.type === "article" ? { kind: "attachment-card" } : null),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fetchChatAttachmentPreview).not.toHaveBeenCalled();
    expect(hasText(renderer, "Preview will load when visible.")).toBe(true);
    expect(observe).toHaveBeenCalled();

    await act(async () => {
      observerCallback?.([{ isIntersecting: true }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(disconnect).toHaveBeenCalled();
    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledWith("attachment-1");
    expect(hasText(renderer, "Visible extracted preview")).toBe(true);

    apiMocks.fetchChatAttachmentPreview.mockClear();
    resetAttachmentPreviewStateForTests();
    await act(async () => {
      renderer.update(
        <ChatAttachmentPreviewStack attachments={[attachment({ attachmentId: "eager-preview" })]} eager />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.fetchChatAttachmentPreview).toHaveBeenCalledWith("eager-preview");
  });
});
