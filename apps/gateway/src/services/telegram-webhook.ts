import { createHash, timingSafeEqual } from "node:crypto";

const TELEGRAM_WEBHOOK_PATH =
  /^\/api\/v1\/integrations\/connections\/[^/]+\/telegram\/webhook$/i;

type JsonRecord = Record<string, unknown>;

export type TelegramWebhookNormalization =
  | {
    kind: "message";
    eventType: "message" | "channel_post";
    eventId: string;
    account: string;
    actorId: string;
    actorType: "user" | "system";
    content: string;
    room?: string;
    peer?: string;
    threadId?: string;
    deliveryReplyToMessageId: string;
    metadata: Record<string, unknown>;
  }
  | {
    kind: "ignore";
    eventType?: string;
    reason: string;
  };

export function isTelegramWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return TELEGRAM_WEBHOOK_PATH.test(pathname);
}

export function verifyTelegramWebhookSecretToken(
  providedToken: string | undefined,
  expectedToken: string,
): boolean {
  const provided = providedToken?.trim();
  const expected = expectedToken.trim();
  if (!provided || !expected) {
    return false;
  }
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function deriveTelegramWebhookIdempotencyKey(
  connectionId: string,
  payload: unknown,
  rawBody: Buffer,
): string {
  const root = asRecord(payload);
  const updateId = valueToIdString(root.update_id);
  if (updateId) {
    return `telegram:${connectionId}:${updateId}`;
  }
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return `telegram:${connectionId}:${digest}`;
}

export function normalizeTelegramWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
}): TelegramWebhookNormalization {
  const root = asRecord(input.payload);
  const message = asRecord(root.message);
  const channelPost = asRecord(root.channel_post);
  const effectiveMessage = Object.keys(message).length > 0
    ? message
    : Object.keys(channelPost).length > 0
      ? channelPost
      : undefined;
  const eventType = effectiveMessage === message
    ? "message"
    : effectiveMessage === channelPost
      ? "channel_post"
      : detectUnsupportedTelegramEventType(root);

  if (!effectiveMessage) {
    return {
      kind: "ignore",
      eventType,
      reason: `Unsupported Telegram webhook envelope: ${eventType ?? "unknown"}`,
    };
  }

  const from = asRecord(effectiveMessage.from);
  if (from.is_bot === true) {
    return {
      kind: "ignore",
      eventType,
      reason: "Ignoring bot-authored Telegram event",
    };
  }

  const senderChat = asRecord(effectiveMessage.sender_chat);
  const chat = asRecord(effectiveMessage.chat);
  const chatId = valueToIdString(chat.id);
  const messageId = valueToIdString(effectiveMessage.message_id);
  const content = asString(effectiveMessage.text) ?? asString(effectiveMessage.caption);
  const actorId = valueToIdString(from.id) ?? valueToIdString(senderChat.id);
  const actorType: "user" | "system" = valueToIdString(from.id) ? "user" : "system";

  if (!chatId || !messageId || !content || !actorId) {
    return {
      kind: "ignore",
      eventType,
      reason: "Missing Telegram chat, message id, content, or actor id",
    };
  }

  const chatType = asString(chat.type);
  const isPrivate = chatType === "private";
  const threadId = !isPrivate ? valueToIdString(effectiveMessage.message_thread_id) : undefined;
  const replyToMessageId = valueToIdString(asRecord(effectiveMessage.reply_to_message).message_id);

  return {
    kind: "message",
    eventType: eventType === "channel_post" ? "channel_post" : "message",
    eventId: messageId,
    account: input.connectionId,
    actorId,
    actorType,
    content,
    room: isPrivate ? undefined : chatId,
    peer: isPrivate ? chatId : undefined,
    threadId,
    deliveryReplyToMessageId: messageId,
    metadata: compactRecord({
      updateId: valueToIdString(root.update_id),
      chatId,
      chatType,
      chatTitle: asString(chat.title),
      chatUsername: asString(chat.username),
      messageId,
      threadId,
      replyToMessageId,
      actorUsername: asString(from.username),
      actorDisplayName: renderTelegramDisplayName(from),
      senderChatTitle: asString(senderChat.title),
    }),
  };
}

function detectUnsupportedTelegramEventType(root: JsonRecord): string | undefined {
  const knownEventTypes = [
    "edited_message",
    "edited_channel_post",
    "callback_query",
    "inline_query",
    "chosen_inline_result",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
  ];
  return knownEventTypes.find((key) => Object.keys(asRecord(root[key])).length > 0);
}

function renderTelegramDisplayName(from: JsonRecord): string | undefined {
  const firstName = asString(from.first_name);
  const lastName = asString(from.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || asString(from.username);
}

function compactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function valueToIdString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}
