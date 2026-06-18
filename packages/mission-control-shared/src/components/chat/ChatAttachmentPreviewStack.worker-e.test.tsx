import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentPreviewResponse, ChatMessageRecord } from "@goatcitadel/contracts";
import { ChatAttachmentPreviewStack, resetAttachmentPreviewStateForTests } from "./ChatAttachmentPreviewStack";

const apiMocks = vi.hoisted(() => ({
  buildGatewayUrl: vi.fn((path: string) => `http://localhost:8787${path}`),
  fetchChatAttachmentPreview: vi.fn(),
  downloadChatAttachment: vi.fn(),
  issueMediaPlaybackToken: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  buildGatewayUrl: apiMocks.buildGatewayUrl,
  fetchChatAttachmentPreview: apiMocks.fetchChatAttachmentPreview,
  downloadChatAttachment: apiMocks.downloadChatAttachment,
  issueMediaPlaybackToken: apiMocks.issueMediaPlaybackToken,
}));

const originalNavigator = globalThis.navigator;

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
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });
    resetAttachmentPreviewStateForTests();
    apiMocks.buildGatewayUrl.mockClear();
    apiMocks.fetchChatAttachmentPreview.mockReset();
    apiMocks.downloadChatAttachment.mockReset();
    apiMocks.issueMediaPlaybackToken.mockReset();
    apiMocks.issueMediaPlaybackToken.mockResolvedValue({
      token: "media-token",
      expiresAt: "2026-06-18T00:00:00.000Z",
      source: { kind: "chat_attachment", attachmentId: "attachment-1" },
      variantId: "original",
      contentPath: "/api/v1/chat/attachments/attachment-1/content?disposition=inline&media_token=media-token",
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    vi.unstubAllGlobals();
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

  it("uses tokenized streaming URLs for inline video without downloading the full blob first", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        connection: {
          effectiveType: "4g",
          downlink: 15,
        },
      },
    });
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        attachmentId: "video-1",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        mediaType: "video",
      }),
    );
    apiMocks.issueMediaPlaybackToken.mockResolvedValueOnce({
      token: "video-token",
      expiresAt: "2026-06-18T00:00:00.000Z",
      source: { kind: "chat_attachment", attachmentId: "video-1" },
      variantId: "original",
      contentPath: "/api/v1/chat/attachments/video-1/content?disposition=inline&media_token=video-token",
    });

    const renderer = await renderStack([
      attachment({
        attachmentId: "video-1",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 42 * 1024 * 1024,
      }),
    ]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.issueMediaPlaybackToken).toHaveBeenCalledWith({
      source: { kind: "chat_attachment", attachmentId: "video-1" },
      variantId: "original",
    });
    expect(apiMocks.downloadChatAttachment).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "http://localhost:8787/api/v1/chat/attachments/video-1/content?disposition=inline&media_token=video-token",
    );
  });

  it("uses generated standard video variants when preview metadata exposes them", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        connection: {
          effectiveType: "4g",
          downlink: 12,
        },
      },
    });
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        attachmentId: "video-variant",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        mediaType: "video",
        playback: {
          variants: [
            {
              variantId: "original",
              label: "Original upload",
              source: { kind: "chat_attachment", attachmentId: "video-variant" },
              mimeType: "video/mp4",
              sizeBytes: 42 * 1024 * 1024,
              status: "available",
            },
            {
              variantId: "standard",
              label: "Standard",
              source: { kind: "media_artifact", artifactId: "artifact-standard" },
              mimeType: "video/mp4",
              sizeBytes: 12 * 1024 * 1024,
              status: "available",
            },
          ],
        },
      }),
    );
    apiMocks.issueMediaPlaybackToken.mockResolvedValueOnce({
      token: "variant-token",
      expiresAt: "2026-06-18T00:00:00.000Z",
      source: { kind: "media_artifact", artifactId: "artifact-standard" },
      variantId: "standard",
      contentPath: "/api/v1/media/artifacts/artifact-standard/content?media_token=variant-token",
    });

    const renderer = await renderStack([
      attachment({
        attachmentId: "video-variant",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 42 * 1024 * 1024,
      }),
    ]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.issueMediaPlaybackToken).toHaveBeenCalledWith({
      source: { kind: "media_artifact", artifactId: "artifact-standard" },
      variantId: "standard",
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "http://localhost:8787/api/v1/media/artifacts/artifact-standard/content?media_token=variant-token",
    );
  });

  it("defers inline video on data-saver connections until the operator loads it", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        connection: {
          saveData: true,
          effectiveType: "4g",
        },
      },
    });
    apiMocks.fetchChatAttachmentPreview.mockResolvedValue(
      preview({
        attachmentId: "video-2",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        mediaType: "video",
      }),
    );

    const renderer = await renderStack([
      attachment({
        attachmentId: "video-2",
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 30 * 1024 * 1024,
      }),
    ]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasText(renderer, "Load ")).toBe(true);
    expect(hasText(renderer, "video")).toBe(true);
    expect(hasText(renderer, "preview")).toBe(true);
    expect(apiMocks.issueMediaPlaybackToken).not.toHaveBeenCalled();
  });
});
