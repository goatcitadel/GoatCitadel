import { X } from "lucide-react";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import { formatBytes } from "@goatcitadel/mission-control-shared/content/format";

type PendingAttachment = Pick<ChatAttachmentRecord, "attachmentId" | "fileName" | "mimeType" | "sizeBytes">;

/** A short file type for a chip: the extension when the name has one, otherwise the MIME subtype. */
export function attachmentTypeLabel(attachment: Pick<PendingAttachment, "fileName" | "mimeType">): string {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(attachment.fileName)?.[1];
  if (extension) return extension.toUpperCase();
  const subtype = attachment.mimeType?.split("/")[1]?.split(/[;+]/)[0];
  return subtype ? subtype.toUpperCase() : "File";
}

/** Files waiting to send with the next message, each with its type, size and a remove control. */
export function ChatAttachmentChips({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: readonly PendingAttachment[];
  disabled: boolean;
  onRemove: (attachmentId: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached files">
      {attachments.map((attachment) => (
        <span
          key={attachment.attachmentId}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken py-0.5 pr-0.5 pl-2.5 text-xs text-fg-secondary"
        >
          <span className="max-w-36 truncate">{attachment.fileName}</span>
          <span className="text-fg-muted">
            {attachmentTypeLabel(attachment)} · {formatBytes(attachment.sizeBytes)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${attachment.fileName}`}
            disabled={disabled}
            onClick={() => onRemove(attachment.attachmentId)}
            className="inline-flex size-8 items-center justify-center rounded-full text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50 max-sm:size-11"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
