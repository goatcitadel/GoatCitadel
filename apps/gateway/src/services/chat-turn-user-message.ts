/**
 * Chat turn user-message & attachment content builders.
 *
 * Pure user-message prompt building and attachment-content helpers for the
 * chat runtime.
 */

import type { ChatAttachmentRecord, ChatInputPart, ChatMessageRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { isImageMimeType } from "./gateway-service.js";

export interface ChatTurnUserMessageHost {
  readonly storage: Pick<Storage, "chatAttachments">;
  readChatAttachmentContent(attachmentId: string): Promise<{
    bytes: Buffer;
  }>;
}

export function buildUserMessagePrompt(message: ChatMessageRecord): string {
  const baseContent = message.content.trim();
  const textParts = Array.isArray(message.parts)
    ? message.parts
        .filter((part): part is Extract<ChatInputPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
    : [];
  if (textParts.length === 0) {
    return baseContent;
  }
  if (!baseContent) {
    return textParts.join("\n\n");
  }
  if (textParts[0] === baseContent) {
    return textParts.join("\n\n");
  }
  return [baseContent, ...textParts].join("\n\n");
}

export function resolveMessageAttachments(
  host: ChatTurnUserMessageHost,
  message: ChatMessageRecord,
): ChatAttachmentRecord[] {
  const attachmentIds = new Set<string>();
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (attachment?.attachmentId) {
        attachmentIds.add(attachment.attachmentId);
      }
    }
  }
  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (part.type !== "text" && part.attachmentId) {
        attachmentIds.add(part.attachmentId);
      }
    }
  }
  if (attachmentIds.size === 0) {
    return [];
  }
  return host.storage.chatAttachments.listByIds([...attachmentIds]).slice(0, 6);
}

export function buildAttachmentPromptContext(
  host: ChatTurnUserMessageHost,
  input: unknown,
  supportsVision = false,
): string | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }

  const attachmentIds = input
    .map((item) => (item as Record<string, unknown>).attachmentId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (attachmentIds.length === 0) {
    return undefined;
  }

  const attachments = host.storage.chatAttachments.listByIds(attachmentIds).slice(0, 6);
  if (attachments.length === 0) {
    return undefined;
  }

  const lines = attachments.map((attachment) => {
    const descriptor = `- ${attachment.fileName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`;
    if (supportsVision && isImageMimeType(attachment.mimeType)) {
      return `${descriptor}\n  Preview: sent directly to a vision-capable model.`;
    }
    if (!attachment.extractPreview?.trim()) {
      return `${descriptor}\n  Preview: unavailable for this file type in current pipeline.`;
    }
    const preview = attachment.extractPreview
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, 1600);
    return `${descriptor}\n  Preview:\n${preview}`;
  });

  return ["Attached file context (from uploaded attachments):", ...lines].join("\n");
}

export async function buildAttachmentMessageParts(
  host: ChatTurnUserMessageHost,
  input: unknown,
  prompt: string,
  supportsVision: boolean,
): Promise<Array<Record<string, unknown>> | undefined> {
  if (!supportsVision || !Array.isArray(input) || input.length === 0) {
    return undefined;
  }
  const attachmentIds = input
    .map((item) => (item as Record<string, unknown>).attachmentId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (attachmentIds.length === 0) {
    return undefined;
  }

  const attachments = host.storage.chatAttachments.listByIds(attachmentIds).slice(0, 4);
  const parts: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: prompt,
    },
  ];

  for (const attachment of attachments) {
    if (!isImageMimeType(attachment.mimeType)) {
      continue;
    }
    try {
      const content = await host.readChatAttachmentContent(attachment.attachmentId);
      if (content.bytes.length > 5 * 1024 * 1024) {
        continue;
      }
      const dataUrl = `data:${attachment.mimeType};base64,${content.bytes.toString("base64")}`;
      parts.push({
        type: "image_url",
        image_url: {
          url: dataUrl,
        },
      });
    } catch {
      // keep chat flowing even if one image cannot be loaded
    }
  }

  return parts.length > 1 ? parts : undefined;
}

export async function buildUserMessageContent(
  host: ChatTurnUserMessageHost,
  message: ChatMessageRecord,
  supportsVision: boolean,
): Promise<string | Array<Record<string, unknown>>> {
  const prompt = buildUserMessagePrompt(message);
  const attachments = resolveMessageAttachments(host, message);
  const contentParts = await buildAttachmentMessageParts(host, attachments, prompt, supportsVision);
  if (contentParts) {
    return contentParts;
  }
  const attachmentContext = buildAttachmentPromptContext(host, attachments, supportsVision);
  return attachmentContext ? `${prompt}\n\n${attachmentContext}` : prompt;
}
