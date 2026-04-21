import { useEffect, useState } from "react";
import type { ChatMessageRecord, ChatAttachmentPreviewResponse } from "@goatcitadel/contracts";
import { fetchChatAttachmentPreview } from "../../api/client";

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
  const [preview, setPreview] = useState<ChatAttachmentPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchChatAttachmentPreview(attachment.attachmentId)
      .then((response) => {
        if (!cancelled) {
          setPreview(response);
          setError(null);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError((nextError as Error).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.attachmentId]);

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
