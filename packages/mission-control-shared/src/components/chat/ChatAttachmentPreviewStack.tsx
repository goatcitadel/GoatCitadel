import { useEffect, useRef, useState } from "react";
import type { ChatMessageRecord, ChatAttachmentPreviewResponse } from "@goatcitadel/contracts";
import { fetchChatAttachmentPreview } from "../../api/client";
import { ChatAttachmentActions } from "./ChatAttachmentActions";

const ATTACHMENT_PREVIEW_CACHE_TTL_MS = 30_000;
const ATTACHMENT_PREVIEW_CACHE_MAX_ENTRIES = 80;
const ATTACHMENT_PREVIEW_RETRY_DELAY_MS = 5_000;

const attachmentPreviewCache = new Map<
  string,
  {
    response: ChatAttachmentPreviewResponse;
    cachedAt: number;
  }
>();
const attachmentPreviewInFlight = new Map<string, Promise<ChatAttachmentPreviewResponse>>();

function getInFlightCacheKey(attachmentId: string, forceRefresh: boolean): string {
  return `${attachmentId}:${forceRefresh ? "refresh" : "cached"}`;
}

function getCachedAttachmentPreview(attachmentId: string, now = Date.now()): ChatAttachmentPreviewResponse | null {
  const cached = attachmentPreviewCache.get(attachmentId);
  if (!cached) {
    return null;
  }
  if (now - cached.cachedAt >= ATTACHMENT_PREVIEW_CACHE_TTL_MS) {
    attachmentPreviewCache.delete(attachmentId);
    return null;
  }
  attachmentPreviewCache.delete(attachmentId);
  attachmentPreviewCache.set(attachmentId, cached);
  return cached.response;
}

function rememberAttachmentPreview(attachmentId: string, response: ChatAttachmentPreviewResponse): void {
  attachmentPreviewCache.delete(attachmentId);
  attachmentPreviewCache.set(attachmentId, {
    response,
    cachedAt: Date.now(),
  });
  while (attachmentPreviewCache.size > ATTACHMENT_PREVIEW_CACHE_MAX_ENTRIES) {
    const oldestKey = attachmentPreviewCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    attachmentPreviewCache.delete(oldestKey);
  }
}

function summarizeExtraction(preview: ChatAttachmentPreviewResponse | null): string | null {
  if (!preview) {
    return null;
  }
  return preview.extractPreview ?? preview.ocrText ?? preview.transcriptText ?? null;
}

function ChatAttachmentPreviewCard({
  attachment,
  eager,
}: {
  attachment: NonNullable<ChatMessageRecord["attachments"]>[number];
  eager: boolean;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [shouldLoadPreview, setShouldLoadPreview] = useState(eager);
  const [preview, setPreview] = useState<ChatAttachmentPreviewResponse | null>(() => {
    return getCachedAttachmentPreview(attachment.attachmentId);
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (eager) {
      setShouldLoadPreview(true);
    }
  }, [eager]);

  useEffect(() => {
    if (shouldLoadPreview) {
      return;
    }
    const target = cardRef.current;
    if (!target || typeof window === "undefined" || typeof window.IntersectionObserver !== "function") {
      setShouldLoadPreview(true);
      return;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoadPreview(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [shouldLoadPreview]);

  useEffect(() => {
    if (!shouldLoadPreview) {
      return;
    }
    let cancelled = false;
    let retryHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
    void loadAttachmentPreview(attachment.attachmentId, { forceRefresh: refreshTick > 0 })
      .then((response) => {
        if (!cancelled) {
          setPreview(response);
          setError(null);
          if (shouldRetryAttachmentPreview(response)) {
            retryHandle = globalThis.setTimeout(() => {
              setRefreshTick((current) => current + 1);
            }, ATTACHMENT_PREVIEW_RETRY_DELAY_MS);
          }
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError((nextError as Error).message);
        }
      });
    return () => {
      cancelled = true;
      if (retryHandle !== null) {
        globalThis.clearTimeout(retryHandle);
      }
    };
  }, [attachment.attachmentId, refreshTick, shouldLoadPreview]);

  const extractionSummary = summarizeExtraction(preview);
  const extractionLabel = preview?.transcriptText
    ? "Transcript"
    : preview?.ocrText
      ? "OCR"
      : preview?.extractPreview
        ? "Preview"
        : null;

  return (
    <article ref={cardRef} className="chat-v11-attachment-preview-card">
      <div className="chat-v11-attachment-preview-head">
        <strong>{attachment.fileName}</strong>
        <span>{attachment.mimeType}</span>
      </div>
      <p className="chat-v11-attachment-preview-meta">
        {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB
        {preview ? ` · ${preview.analysisStatus}` : ""}
      </p>
      <ChatAttachmentActions attachmentId={attachment.attachmentId} fileName={attachment.fileName} />
      {!shouldLoadPreview && !preview ? (
        <p className="chat-v11-attachment-preview-copy muted">Preview will load when visible.</p>
      ) : extractionSummary ? (
        <>
          <p className="chat-v11-attachment-preview-label">{extractionLabel}</p>
          <p className="chat-v11-attachment-preview-copy">{extractionSummary}</p>
        </>
      ) : error ? (
        <p className="chat-v11-attachment-preview-copy muted">Preview unavailable: {error}</p>
      ) : (
        <p className="chat-v11-attachment-preview-copy muted">Extraction is still preparing.</p>
      )}
    </article>
  );
}

function shouldRetryAttachmentPreview(preview: ChatAttachmentPreviewResponse): boolean {
  return !summarizeExtraction(preview) && (preview.analysisStatus === "queued" || preview.analysisStatus === "running");
}

function loadAttachmentPreview(
  attachmentId: string,
  options?: { forceRefresh?: boolean },
): Promise<ChatAttachmentPreviewResponse> {
  const forceRefresh = Boolean(options?.forceRefresh);
  if (!forceRefresh) {
    const cached = getCachedAttachmentPreview(attachmentId);
    if (cached) {
      return Promise.resolve(cached);
    }
  }
  const requestKey = getInFlightCacheKey(attachmentId, forceRefresh);
  const existingRequest = attachmentPreviewInFlight.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }
  const request = fetchChatAttachmentPreview(attachmentId)
    .then((response) => {
      rememberAttachmentPreview(attachmentId, response);
      attachmentPreviewInFlight.delete(requestKey);
      return response;
    })
    .catch((error) => {
      attachmentPreviewInFlight.delete(requestKey);
      throw error;
    });
  attachmentPreviewInFlight.set(requestKey, request);
  return request;
}

export function ChatAttachmentPreviewStack({
  attachments,
  eager = false,
}: {
  attachments: ChatMessageRecord["attachments"] | undefined;
  eager?: boolean;
}) {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  return (
    <div className="chat-v11-attachment-preview-stack">
      {attachments.map((attachment) => (
        <ChatAttachmentPreviewCard key={attachment.attachmentId} attachment={attachment} eager={eager} />
      ))}
    </div>
  );
}

export function resetAttachmentPreviewStateForTests(): void {
  attachmentPreviewCache.clear();
  attachmentPreviewInFlight.clear();
}
