import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { buildGatewayUrl, readGatewayAuthHeaders } from "@goatcitadel/mission-control-shared/api/client-core";
import { useEffect, useRef, useState } from "react";

type PendingAttachment = MissionThreadedActiveSessionSurfaceProps["pendingAttachments"][number];

export function isImageAttachment(attachment: PendingAttachment): boolean {
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
  const fileName = attachment.fileName.trim().toLowerCase();
  return (
    mimeType.startsWith("image/") ||
    mimeType.includes("image") ||
    /\.(png|apng|jpe?g|gif|webp|avif|bmp|svg)$/i.test(fileName)
  );
}

export function PendingImagePreview({ attachment }: { attachment: PendingAttachment }) {
  const contentPath = `/api/v1/chat/attachments/${encodeURIComponent(attachment.attachmentId)}/content?disposition=inline`;
  const directPreviewUrl = buildGatewayUrl(contentPath);
  const [blobPreviewUrl, setBlobPreviewUrl] = useState<string | null>(null);
  const [loadWithAuthHeaders, setLoadWithAuthHeaders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeBlobPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeBlobPreviewUrlRef.current) {
      URL.revokeObjectURL(activeBlobPreviewUrlRef.current);
      activeBlobPreviewUrlRef.current = null;
    }
    setBlobPreviewUrl(null);
    setLoadWithAuthHeaders(false);
    setError(null);
  }, [attachment.attachmentId]);

  useEffect(
    () => () => {
      if (activeBlobPreviewUrlRef.current) {
        URL.revokeObjectURL(activeBlobPreviewUrlRef.current);
        activeBlobPreviewUrlRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!loadWithAuthHeaders || activeBlobPreviewUrlRef.current) {
      return;
    }
    let active = true;

    async function loadPreview(): Promise<void> {
      try {
        setError(null);
        const response = await fetch(directPreviewUrl, {
          headers: readGatewayAuthHeaders(contentPath),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API error ${response.status}: ${text}`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (activeBlobPreviewUrlRef.current) {
          URL.revokeObjectURL(activeBlobPreviewUrlRef.current);
        }
        activeBlobPreviewUrlRef.current = objectUrl;
        setBlobPreviewUrl(objectUrl);
      } catch (nextError) {
        if (active) {
          setError((nextError as Error).message);
          setBlobPreviewUrl(null);
        }
      }
    }

    void loadPreview();
    return () => {
      active = false;
    };
  }, [contentPath, directPreviewUrl, loadWithAuthHeaders]);

  const previewUrl = blobPreviewUrl ?? directPreviewUrl;
  const fallbackLoading = loadWithAuthHeaders && !blobPreviewUrl && !error;
  const showImage = !error && !fallbackLoading;

  if (showImage) {
    return (
      <div className="mc-next-composer-image-shell">
        <img
          src={previewUrl}
          alt={attachment.fileName}
          className="mc-next-composer-image-preview"
          onError={() => {
            if (blobPreviewUrl) {
              setError("Preview unavailable.");
              return;
            }
            setLoadWithAuthHeaders(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mc-next-composer-image-shell loading">
      <p>{fallbackLoading ? "Loading image preview..." : `Preview unavailable: ${error}`}</p>
    </div>
  );
}
