import { useEffect, useState } from "react";
import type { ChatMessageRecord, ChatAttachmentPreviewResponse } from "@goatcitadel/contracts";
import { fetchChatAttachmentPreview } from "../../api/client";

const ATTACHMENT_PREVIEW_CACHE_TTL_MS = 30_000;
const ATTACHMENT_PREVIEW_RETRY_DELAY_MS = 5_000;

const attachmentPreviewCache = new Map<
  string,
  {
    response: ChatAttachmentPreviewResponse;
    cachedAt: number;
  }
>();
const attachmentPreviewInFlight = new Map<string, Promise<ChatAttachmentPreviewResponse>>();

function summarizeExtraction(preview: ChatAttachmentPreviewResponse | null): string | null {
  if (!preview) {
    return null;
  }
  return preview.extractPreview ?? preview.ocrText ?? preview.transcriptText ?? null;
}

function ChatAttachmentPreviewCard({
  attachment,
}: {
  attachment: NonNullable<ChatMessageRecord["attachments"]>[number];
}) {
  const [refreshTick, setRefreshTick] = useState(0);
  const [preview, setPreview] = useState<ChatAttachmentPreviewResponse | null>(() => {
    const cached = attachmentPreviewCache.get(attachment.attachmentId);
    return cached ? cached.response : null;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryHandle: number | null = null;
    void loadAttachmentPreview(attachment.attachmentId, { forceRefresh: refreshTick > 0 })
      .then((response) => {
        if (!cancelled) {
          setPreview(response);
          setError(null);
          if (shouldRetryAttachmentPreview(response)) {
            retryHandle = window.setTimeout(() => {
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
        window.clearTimeout(retryHandle);
      }
    };
  }, [attachment.attachmentId, refreshTick]);

  const extractionSummary = summarizeExtraction(preview);
  const extractionLabel = preview?.transcriptText
    ? "Transcript"
    : preview?.ocrText
      ? "OCR"
      : preview?.extractPreview
        ? "Preview"
        : null;

  return (
    <article className="chat-v11-attachment-preview-card">
      <div className="chat-v11-attachment-preview-head">
        <strong>{attachment.fileName}</strong>
        <span>{attachment.mimeType}</span>
      </div>
      <p className="chat-v11-attachment-preview-meta">
        {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB
        {preview ? ` · ${preview.analysisStatus}` : ""}
      </p>
      {extractionSummary ? (
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
  const cached = attachmentPreviewCache.get(attachmentId);
  if (!options?.forceRefresh && cached && Date.now() - cached.cachedAt < ATTACHMENT_PREVIEW_CACHE_TTL_MS) {
    return Promise.resolve(cached.response);
  }
  const existingRequest = attachmentPreviewInFlight.get(attachmentId);
  if (existingRequest) {
    return existingRequest;
  }
  const request = fetchChatAttachmentPreview(attachmentId)
    .then((response) => {
      attachmentPreviewCache.set(attachmentId, {
        response,
        cachedAt: Date.now(),
      });
      attachmentPreviewInFlight.delete(attachmentId);
      return response;
    })
    .catch((error) => {
      attachmentPreviewInFlight.delete(attachmentId);
      throw error;
    });
  attachmentPreviewInFlight.set(attachmentId, request);
  return request;
}

export function ChatAttachmentPreviewStack({
  attachments,
}: {
  attachments: ChatMessageRecord["attachments"] | undefined;
}) {
  if (!attachments || attachments.length === 0) {
    return null;
  }

  return (
    <div className="chat-v11-attachment-preview-stack">
      {attachments.map((attachment) => (
        <ChatAttachmentPreviewCard key={attachment.attachmentId} attachment={attachment} />
      ))}
    </div>
  );
}

export function resetAttachmentPreviewStateForTests(): void {
  attachmentPreviewCache.clear();
  attachmentPreviewInFlight.clear();
}
