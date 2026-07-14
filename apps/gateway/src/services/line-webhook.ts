import { createHmac } from "node:crypto";
import {
  asRecord,
  asString,
  hashRawBodyDigest,
  timingSafeStringEqual,
  type JsonRecord,
} from "./webhook-json-helpers.js";

const LINE_WEBHOOK_PATH = /^\/api\/v1\/integrations\/connections\/[^/]+\/line\/webhook$/i;

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
  return timingSafeStringEqual(expected, signature);
}

export function deriveLineWebhookIdempotencyKey(connectionId: string, payload: unknown, rawBody: Buffer): string {
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
  return `line:${connectionId}:${hashRawBodyDigest(rawBody)}`;
}

/**
 * Derive the identity for one normalized event in a LINE webhook batch. LINE
 * can deliver several events in one signed callback, so using the first event
 * from the raw body for every row would collapse otherwise-distinct messages.
 */
export function deriveLineWebhookEventIdempotencyKey(
  connectionId: string,
  event: Extract<LineWebhookNormalization, { kind: "message" }>,
): string {
  const webhookEventId = asString(event.metadata.webhookEventId);
  return `line:${connectionId}:${webhookEventId ?? event.eventId}`;
}

export function normalizeLineWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
}): LineWebhookNormalization {
  return (
    normalizeLineWebhookPayloads(input)[0] ?? {
      kind: "ignore",
      reason: "No LINE webhook events were present",
    }
  );
}

/** Normalize every event in a signed LINE callback, preserving wire order. */
export function normalizeLineWebhookPayloads(input: {
  connectionId: string;
  payload: unknown;
}): LineWebhookNormalization[] {
  const root = asRecord(input.payload);
  const events = records(asArray(root.events));
  if (events.length === 0) {
    return [
      {
        kind: "ignore",
        reason: "No LINE webhook events were present",
      },
    ];
  }

  return events.map((event) => normalizeLineWebhookEvent(input.connectionId, root, event));
}

function normalizeLineWebhookEvent(
  connectionId: string,
  root: JsonRecord,
  event: JsonRecord,
): LineWebhookNormalization {
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
  const room =
    sourceType === "group" ? asString(source.groupId) : sourceType === "room" ? asString(source.roomId) : undefined;
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
    account: connectionId,
    actorId,
    actorType: "user",
    content,
    room,
    peer,
    deliveryReplyToMessageId: eventId,
    metadata: compactRecord({
      // LINE replyToken is an ephemeral bearer credential. Outbound delivery
      // does not use it, so it must not cross the durable intake boundary.
      destination: asString(root.destination),
      isRedelivery: asBoolean(asRecord(event.deliveryContext).isRedelivery),
      mode: asString(event.mode),
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
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstRecord(value: unknown[]): JsonRecord | undefined {
  const first = value.find((item) => item && typeof item === "object" && !Array.isArray(item));
  return first ? (first as JsonRecord) : undefined;
}

function records(value: unknown[]): JsonRecord[] {
  return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
