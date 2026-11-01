import { useEffect, useState } from "react";
import { buildGatewayUrl, readGatewayAuthHeaders } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

function attachmentContentPath(attachmentId: string): string {
  return `/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/content?disposition=inline`;
}

/**
 * The gateway may live on another origin and require header auth, which a bare `<img src>` cannot
 * carry, so the PNG is fetched with the gateway auth headers into a blob URL (same pattern as the
 * Classic composer's image preview).
 */
export function AttachmentImage({
  attachmentId,
  alt,
  className = "max-w-full rounded-md border border-line bg-sunken",
}: {
  attachmentId: string;
  alt: string;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const contentPath = attachmentContentPath(attachmentId);
    setBlobUrl(null);
    setFailure(null);
    void (async () => {
      try {
        const response = await fetch(buildGatewayUrl(contentPath), { headers: readGatewayAuthHeaders(contentPath) });
        if (!response.ok) throw new Error(`Render image request failed (${response.status}).`);
        const blob = await response.blob();
        // Create the object URL only while mounted; one created after cleanup would never be revoked.
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      } catch (error) {
        if (active) setFailure(describeFailure(error));
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  if (failure) {
    return (
      <p role="alert" className="text-sm text-status-failed">
        {failure}
      </p>
    );
  }
  if (!blobUrl) {
    return (
      <p role="status" className="text-xs text-fg-muted">
        Loading {alt}…
      </p>
    );
  }
  return <img src={blobUrl} alt={alt} className={className} />;
}

export function describeFailure(error: unknown): string {
  const described = describeApiError(error);
  if (described.technical === undefined && error instanceof Error && error.message.trim()) return error.message;
  return described.summary;
}
