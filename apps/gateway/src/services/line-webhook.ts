import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const LINE_WEBHOOK_PATH =
  /^\/api\/v1\/integrations\/connections\/[^/]+\/line\/webhook$/i;

type JsonRecord = Record<string, unknown>;

export type LineWebhookNormalization =
  | {
    kind: "message";
    eventType: "message";
    eventId: string;
    account: string;
    actorId: string;
    actorType: "user";
    content: string;
    room?: string;
    peer?: string;
    deliveryReplyToMessageId: string;
    metadata: Record<string, unknown>;
  }
  | {
    kind: "ignore";
    eventType?: string;
    reason: string;
  };

export function isLineWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return LINE_WEBHOOK_PATH.test(pathname);
}

export function buildLineWebhookSignature(rawBody: Buffer | string, channelSecret: string): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return createHmac("sha256", channelSecret).update(body).digest("base64");
}

export function verifyLineWebhookSignature(
  providedSignature: string | undefined,
  rawBody: Buffer,
  channelSecret: string,
): boolean {
  const signature = providedSignature?.trim();
  if (!signature) {
    return false;
  }
  const expected = buildLineWebhookSignature(rawBody, channelSecret);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function deriveLineWebhookIdempotencyKey(
  connectionId: string,
  payload: unknown,
  rawBody: Buffer,
): string {
  const root = asRecord(payload);
  const event = firstRecord(asArray(root.events));
  const webhookEventId = asString(event?.webhookEventId);
  if (webhookEventId) {
    return `line:${connectionId}:${webhookEventId}`;
  }
  const messageId = asString(asRecord(event?.message).id);
  if (messageId) {
    return `line:${connectionId}:${messageId}`;
  }
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return `line:${connectionId}:${digest}`;
}

export function normalizeLineWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
}): LineWebhookNormalization {
  const root = asRecord(input.payload);
  const event = firstRecord(asArray(root.events));
  if (!event) {
    return {
      kind: "ignore",
      reason: "No LINE webhook events were present",
    };
  }

  const eventType = asString(event.type);
  if (eventType !== "message") {
    return {
      kind: "ignore",
      eventType,
      reason: `Unsupported LINE event type: ${eventType ?? "unknown"}`,
    };
  }

  const source = asRecord(event.source);
  const message = asRecord(event.message);
  const sourceType = asString(source.type);
  const room = sourceType === "group"
    ? asString(source.groupId)
    : sourceType === "room"
      ? asString(source.roomId)
      : undefined;
  const peer = sourceType === "user" ? asString(source.userId) : undefined;
  const actorId = asString(source.userId) ?? room ?? peer;
  const eventId = asString(message.id);
  const content = renderLineMessageContent(message);

  if (!actorId || !eventId || !content) {
    return {
      kind: "ignore",
      eventType,
      reason: "Missing LINE actor, message id, or content",
    };
  }

  return {
    kind: "message",
    eventType: "message",
    eventId,
    account: input.connectionId,
    actorId,
    actorType: "user",
    content,
    room,
    peer,
    deliveryReplyToMessageId: eventId,
    metadata: compactRecord({
      destination: asString(root.destination),
      isRedelivery: asBoolean(asRecord(event.deliveryContext).isRedelivery),
      mode: asString(event.mode),
      replyToken: asString(event.replyToken),
      sourceType,
      webhookEventId: asString(event.webhookEventId),
    }),
  };
}

function renderLineMessageContent(message: JsonRecord): string | undefined {
  const messageType = asString(message.type) ?? "message";
  switch (messageType) {
    case "text":
      return asString(message.text);
    case "image":
    case "video":
    case "audio":
    case "file":
    case "location":
    case "sticker":
      return `[line ${messageType}]`;
    default:
      return undefined;
  }
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstRecord(value: unknown[]): JsonRecord | undefined {
  const first = value.find((item) => item && typeof item === "object" && !Array.isArray(item));
  return first ? first as JsonRecord : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
