import type { ChannelAttachmentInput, ChatAttachmentRecord } from "@goatcitadel/contracts";

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
    } else {
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
    .map((attachment) => ({ ...attachment }));
}

function trimOptionalString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
