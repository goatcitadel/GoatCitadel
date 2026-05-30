import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessageRecord, ChatAttachmentPreviewResponse } from "@goatcitadel/contracts";
import { fetchChatAttachmentPreview } from "../../api/client";
import { ChatAttachmentActions, loadAttachmentBlob } from "./ChatAttachmentActions";

const ATTACHMENT_PREVIEW_CACHE_TTL_MS = 30_000;
const ATTACHMENT_PREVIEW_CACHE_MAX_ENTRIES = 80;
const ATTACHMENT_PREVIEW_RETRY_DELAY_MS = 5_000;
const INLINE_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

// TODO(cache): namespace by sessionId to avoid cross-session staleness. sessionId
// is not currently threaded through ChatAttachmentPreviewStack/Card props, so wiring
// it here would require a non-trivial prop refactor; deferred deliberately.
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

type InlineMediaKind = "image" | "audio" | "video";

function pickInlineMediaKind(preview: ChatAttachmentPreviewResponse): InlineMediaKind | null {
  if (preview.mediaType === "image" || preview.mediaType === "audio" || preview.mediaType === "video") {
    return preview.mediaType;
  }
  return null;
}

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        // Already open or unsupported; render visibly anyway.
      }
    }
    const handleCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, [onClose]);
  return (
    <dialog
      ref={dialogRef}
      className="chat-v11-attachment-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button type="button" className="chat-v11-attachment-lightbox-close" aria-label="Close preview" onClick={onClose}>
        ×
      </button>
      <img src={src} alt={alt} />
    </dialog>
  );
}

function ChatAttachmentInlineMedia({
  kind,
  attachmentId,
  fileName,
  sizeBytes,
  shouldLoad,
}: {
  kind: InlineMediaKind;
  attachmentId: string;
  fileName: string;
  sizeBytes: number;
  shouldLoad: boolean;
}) {
  const exceedsSizeCap = sizeBytes > INLINE_MEDIA_MAX_BYTES;
  const [activated, setActivated] = useState(!exceedsSizeCap);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!shouldLoad || !activated) {
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    loadAttachmentBlob({ attachmentId, fallbackFileName: fileName })
      .then(({ blob }) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        createdUrl = url;
        setObjectUrl(url);
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError((nextError as Error).message);
      });
    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
        // Clear the now-revoked URL from state so a dead object URL is never
        // rendered. This only runs in cleanup, so it cannot create a render loop.
        setObjectUrl(null);
      }
    };
  }, [activated, attachmentId, fileName, shouldLoad]);

  const openLightbox = useCallback(() => setLightboxOpen(true), []);
  const closeLightbox = useCallback(() => setLightboxOpen(false), []);

  if (!activated) {
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
    return (
      <button type="button" className="chat-v11-attachment-inline-fallback" onClick={() => setActivated(true)}>
        Load {kind} preview ({sizeMb} MB)
      </button>
    );
  }

  if (error) {
    return <p className="chat-v11-attachment-inline-error">Inline preview unavailable: {error}</p>;
  }

  if (!objectUrl) {
    return null;
  }

  if (kind === "image") {
    return (
      <>
        <button
          type="button"
          className="chat-v11-attachment-image-trigger"
          aria-label={`Open ${fileName} in full view`}
          onClick={openLightbox}
        >
          <img
            src={objectUrl}
            alt={fileName}
            className="chat-v11-attachment-inline-image"
            loading="lazy"
            decoding="async"
          />
        </button>
        {lightboxOpen ? <ImageLightbox src={objectUrl} alt={fileName} onClose={closeLightbox} /> : null}
      </>
    );
  }

  if (kind === "audio") {
    return (
      <audio className="chat-v11-attachment-inline-audio" controls preload="metadata" src={objectUrl}>
        Your browser does not support inline audio playback.
      </audio>
    );
  }

  return (
    <video className="chat-v11-attachment-inline-video" controls preload="metadata" src={objectUrl}>
      Your browser does not support inline video playback.
    </video>
  );
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

  const inlineKind = preview ? pickInlineMediaKind(preview) : null;

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
      {inlineKind ? (
        <div className="chat-v11-attachment-inline-media">
          <ChatAttachmentInlineMedia
            kind={inlineKind}
            attachmentId={attachment.attachmentId}
            fileName={attachment.fileName}
            sizeBytes={attachment.sizeBytes}
            shouldLoad={shouldLoadPreview}
          />
        </div>
      ) : null}
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
      ) : inlineKind ? null : (
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
