/**
 * Chat turn user-message & attachment content builders.
 *
 * Pure user-message prompt building and attachment-content helpers for the
 * chat runtime.
 */

import type { ChatAttachmentRecord, ChatInputPart, ChatMessageRecord } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { isImageMimeType } from "./chat-turn-helpers.js";

export interface ChatTurnUserMessageDependencies {
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

export async function resolveMessageAttachments(
  deps: ChatTurnUserMessageDependencies,
  message: ChatMessageRecord,
): Promise<ChatAttachmentRecord[]> {
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
  return (await deps.storage.chatAttachments.listByIds([...attachmentIds])).slice(0, 6);
}

export async function buildAttachmentPromptContext(
  deps: ChatTurnUserMessageDependencies,
  input: unknown,
  supportsVision = false,
): Promise<string | undefined> {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }

  const attachmentIds = input
    .map((item) => (item as Record<string, unknown>).attachmentId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (attachmentIds.length === 0) {
    return undefined;
  }

  const attachments = (await deps.storage.chatAttachments.listByIds(attachmentIds)).slice(0, 6);
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
  deps: ChatTurnUserMessageDependencies,
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

  const attachments = (await deps.storage.chatAttachments.listByIds(attachmentIds)).slice(0, 4);
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
      const content = await deps.readChatAttachmentContent(attachment.attachmentId);
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
  deps: ChatTurnUserMessageDependencies,
  message: ChatMessageRecord,
  supportsVision: boolean,
): Promise<string | Array<Record<string, unknown>>> {
  const prompt = buildUserMessagePrompt(message);
  const attachments = await resolveMessageAttachments(deps, message);
  const contentParts = await buildAttachmentMessageParts(deps, attachments, prompt, supportsVision);
  if (contentParts) {
    return contentParts;
  }
  const attachmentContext = await buildAttachmentPromptContext(deps, attachments, supportsVision);
  return attachmentContext ? `${prompt}\n\n${attachmentContext}` : prompt;
}
