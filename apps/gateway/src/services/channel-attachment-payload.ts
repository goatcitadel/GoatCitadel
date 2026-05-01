import type { ChannelAttachmentInput, ChatAttachmentRecord } from "@goatcitadel/contracts";

const MAX_INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export async function resolveChannelSendAttachments(
  input: {
    attachments?: ChannelAttachmentInput[];
    attachmentIds?: string[];
  },
  deps: {
    readChatAttachmentContent: (attachmentId: string) => Promise<{
      record: ChatAttachmentRecord;
      bytes: Buffer;
    }>;
  },
): Promise<ChannelAttachmentInput[] | undefined> {
  const attachments = normalizeExplicitAttachments(input.attachments);
  const hydratedAttachmentIds = new Set(
    attachments
      .filter((item) => item.url || item.dataBase64)
      .map((item) => item.attachmentId)
      .filter((item): item is string => Boolean(item)),
  );
  const pendingAttachmentIds = new Set<string>();

  for (const attachmentId of input.attachmentIds ?? []) {
    const trimmed = attachmentId.trim();
    if (trimmed) {
      pendingAttachmentIds.add(trimmed);
    }
  }

  for (const attachment of attachments) {
    if (attachment.attachmentId && !attachment.url && !attachment.dataBase64) {
      pendingAttachmentIds.add(attachment.attachmentId);
    }
  }

  for (const attachmentId of pendingAttachmentIds) {
    if (hydratedAttachmentIds.has(attachmentId)) {
      continue;
    }
    const content = await deps.readChatAttachmentContent(attachmentId);
    const hydratedAttachment: ChannelAttachmentInput = {
      attachmentId,
      title: content.record.fileName,
      mimeType: content.record.mimeType,
      dataBase64: content.bytes.toString("base64"),
    };
    const existingIndex = attachments.findIndex((item) => item.attachmentId === attachmentId && !item.url && !item.dataBase64);
    if (existingIndex >= 0) {
      attachments[existingIndex] = {
        ...attachments[existingIndex],
        ...hydratedAttachment,
      };
      validateChannelAttachment(attachments[existingIndex]);
    } else {
      validateChannelAttachment(hydratedAttachment);
      attachments.push(hydratedAttachment);
    }
    hydratedAttachmentIds.add(attachmentId);
  }

  return attachments.length > 0 ? attachments : undefined;
}

function normalizeExplicitAttachments(input: ChannelAttachmentInput[] | undefined): ChannelAttachmentInput[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((attachment) => ({
      url: trimOptionalString(attachment.url),
      title: trimOptionalString(attachment.title),
      mimeType: trimOptionalString(attachment.mimeType),
      dataBase64: trimOptionalString(attachment.dataBase64),
      attachmentId: trimOptionalString(attachment.attachmentId),
    }))
    .filter((attachment) =>
      Boolean(
        attachment.url
        || attachment.title
        || attachment.mimeType
        || attachment.dataBase64
        || attachment.attachmentId,
      ))
    .map((attachment) => {
      const normalized = { ...attachment };
      validateChannelAttachment(normalized);
      return normalized;
    });
}

function trimOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validateChannelAttachment(attachment: ChannelAttachmentInput): void {
  if (attachment.url) {
    let parsed: URL;
    try {
      parsed = new URL(attachment.url);
    } catch {
      throw new Error("Channel attachment URL is invalid.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Channel attachment URLs must use http or https.");
    }
  }
  if (attachment.dataBase64) {
    const estimatedBytes = estimateBase64Bytes(attachment.dataBase64);
    if (estimatedBytes > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new Error(`Channel inline attachment exceeds the ${MAX_INLINE_ATTACHMENT_BYTES} byte limit.`);
    }
  }
}

function estimateBase64Bytes(value: string): number {
  const normalized = value.replace(/\s+/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}
