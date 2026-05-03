import { useState, type ReactNode } from "react";
import { downloadChatAttachment } from "../../api/client";

const OBJECT_URL_REVOKE_DELAY_MS = 5 * 60 * 1000;

type AttachmentAction = "open" | "download";

export interface ChatAttachmentActionsProps {
  attachmentId: string;
  fileName: string;
  className?: string;
  buttonClassName?: string;
  statusClassName?: string;
  openLabel?: string;
  downloadLabel?: string;
  onError?: (message: string) => void;
  children?: ReactNode;
}

function normalizeFileName(fileName: string): string {
  const normalized = fileName.trim();
  return normalized.length > 0 ? normalized : "attachment";
}

function ensureBrowserDownloadsAvailable(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Attachment downloads are only available in the browser.");
  }
  if (typeof URL.createObjectURL !== "function") {
    throw new Error("This browser cannot create a local download link for the attachment.");
  }
}

function scheduleObjectUrlRevocation(objectUrl: string): void {
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_REVOKE_DELAY_MS);
}

function startBlobDownload(blob: Blob, fileName: string): void {
  ensureBrowserDownloadsAvailable();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = normalizeFileName(fileName);
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  scheduleObjectUrlRevocation(objectUrl);
}

function preparePendingOpenWindow(fileName: string): Window | null {
  if (typeof window === "undefined") {
    return null;
  }
  const opened = window.open("about:blank", "_blank");
  if (!opened) {
    return null;
  }
  try {
    opened.opener = null;
    opened.document.title = `Opening ${normalizeFileName(fileName)}`;
    opened.document.body.textContent = `Opening ${normalizeFileName(fileName)}...`;
  } catch {
    // Some browsers restrict writes to a new tab; navigation still works below.
  }
  return opened;
}

async function loadAttachmentBlob(input: {
  attachmentId: string;
  fallbackFileName: string;
}): Promise<{ blob: Blob; fileName: string }> {
  const result = await downloadChatAttachment(input.attachmentId);
  return {
    blob: result.blob,
    fileName: normalizeFileName(result.fileName || input.fallbackFileName),
  };
}

export async function downloadChatAttachmentToDevice(input: { attachmentId: string; fileName: string }): Promise<void> {
  ensureBrowserDownloadsAvailable();
  const { blob, fileName } = await loadAttachmentBlob({
    attachmentId: input.attachmentId,
    fallbackFileName: input.fileName,
  });
  startBlobDownload(blob, fileName);
}

export async function openChatAttachmentInBrowser(input: {
  attachmentId: string;
  fileName: string;
}): Promise<"opened" | "downloaded"> {
  ensureBrowserDownloadsAvailable();
  const opened = preparePendingOpenWindow(input.fileName);
  try {
    const { blob, fileName } = await loadAttachmentBlob({
      attachmentId: input.attachmentId,
      fallbackFileName: input.fileName,
    });
    const objectUrl = URL.createObjectURL(blob);
    if (opened && !opened.closed) {
      opened.location.href = objectUrl;
      scheduleObjectUrlRevocation(objectUrl);
      return "opened";
    }
    startBlobDownload(blob, fileName);
    URL.revokeObjectURL(objectUrl);
    return "downloaded";
  } catch (error) {
    if (opened && !opened.closed) {
      try {
        opened.document.body.textContent = `Unable to open attachment: ${(error as Error).message}`;
      } catch {
        opened.close();
      }
    }
    throw error;
  }
}

export function ChatAttachmentActions({
  attachmentId,
  fileName,
  className = "chat-v11-attachment-preview-actions",
  buttonClassName = "chat-v11-attachment-preview-action",
  statusClassName = "chat-v11-attachment-action-status",
  openLabel = "Open",
  downloadLabel = "Download",
  onError,
  children,
}: ChatAttachmentActionsProps) {
  const [busyAction, setBusyAction] = useState<AttachmentAction | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function runAction(action: AttachmentAction): Promise<void> {
    setBusyAction(action);
    setStatus(null);
    try {
      if (action === "open") {
        const result = await openChatAttachmentInBrowser({ attachmentId, fileName });
        setStatus(result === "opened" ? "Opened." : "Download started.");
      } else {
        await downloadChatAttachmentToDevice({ attachmentId, fileName });
        setStatus("Download started.");
      }
    } catch (error) {
      const message = (error as Error).message;
      setStatus(message);
      onError?.(message);
    } finally {
      setBusyAction(null);
    }
  }

  const disabled = busyAction !== null;
  return (
    <div className={className}>
      <button
        type="button"
        className={buttonClassName}
        disabled={disabled}
        onClick={() => void runAction("open")}
        aria-label={`Open attachment ${fileName}`}
      >
        {busyAction === "open" ? "Opening..." : openLabel}
      </button>
      <button
        type="button"
        className={buttonClassName}
        disabled={disabled}
        onClick={() => void runAction("download")}
        aria-label={`Download attachment ${fileName}`}
      >
        {busyAction === "download" ? "Downloading..." : downloadLabel}
      </button>
      {children}
      {status ? (
        <span className={statusClassName} aria-live="polite">
          {status}
        </span>
      ) : null}
    </div>
  );
}
