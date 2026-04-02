import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const WHATSAPP_WEBHOOK_PATH =
  /^\/api\/v1\/integrations\/connections\/[^/]+\/whatsapp\/webhook$/i;
const WHATSAPP_SIGNATURE_PREFIX = "sha256=";

type JsonRecord = Record<string, unknown>;

export type WhatsAppWebhookNormalization =
  | {
    kind: "message";
    eventType: string;
    eventId: string;
    account: string;
    actorId: string;
    actorType: "user";
    displayName?: string;
    content: string;
    peer: string;
    deliveryReplyToMessageId: string;
    metadata: Record<string, unknown>;
  }
  | {
    kind: "ignore";
    eventType?: string;
    reason: string;
  };

export function isWhatsAppWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return WHATSAPP_WEBHOOK_PATH.test(pathname);
}

export function buildWhatsAppWebhookSignature(rawBody: Buffer | string, appSecret: string): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return `${WHATSAPP_SIGNATURE_PREFIX}${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

export function verifyWhatsAppWebhookSignature(
  providedSignature: string | undefined,
  rawBody: Buffer,
  appSecret: string,
): boolean {
  const signature = providedSignature?.trim().toLowerCase();
  if (!signature?.startsWith(WHATSAPP_SIGNATURE_PREFIX) || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const expected = buildWhatsAppWebhookSignature(rawBody, appSecret);
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}

export function deriveWhatsAppWebhookIdempotencyKey(
  connectionId: string,
  payload: unknown,
  rawBody: Buffer,
): string {
  const messageId = firstMessageId(payload);
  if (messageId) {
    return `whatsapp:${connectionId}:${messageId}`;
  }
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return `whatsapp:${connectionId}:${digest}`;
}

export function normalizeWhatsAppWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
}): WhatsAppWebhookNormalization {
  const root = asRecord(input.payload);
  if (asString(root.object) !== "whatsapp_business_account") {
    return {
      kind: "ignore",
      reason: "Unsupported WhatsApp webhook object",
    };
  }

  const value = firstChangeValue(root);
  const statuses = asArray(value.statuses);
  if (statuses.length > 0) {
    return {
      kind: "ignore",
      eventType: "status",
      reason: "Ignoring WhatsApp delivery status event",
    };
  }

  const message = firstRecord(asArray(value.messages));
  if (!message) {
    return {
      kind: "ignore",
      reason: "No WhatsApp message payload was present",
    };
  }

  const actorId = asString(message.from);
  const eventId = asString(message.id);
  const eventType = asString(message.type) ?? "message";
  const content = renderWhatsAppMessageContent(message);
  if (!actorId || !eventId || !content) {
    return {
      kind: "ignore",
      eventType,
      reason: "Missing WhatsApp actor, message id, or content",
    };
  }

  const contacts = asArray(value.contacts);
  const contact = firstRecord(contacts);
  const profile = asRecord(contact?.profile);
  const metadata = asRecord(value.metadata);
  const context = asRecord(message.context);

  return {
    kind: "message",
    eventType,
    eventId,
    account: input.connectionId,
    actorId,
    actorType: "user",
    displayName: asString(profile.name),
    content,
    peer: actorId,
    deliveryReplyToMessageId: eventId,
    metadata: compactRecord({
      contactWaId: asString(contact?.wa_id),
      displayPhoneNumber: asString(metadata.display_phone_number),
      phoneNumberId: asString(metadata.phone_number_id),
      replyToMessageId: asString(context.id),
      timestamp: asString(message.timestamp),
    }),
  };
}

function firstChangeValue(root: JsonRecord): JsonRecord {
  const entry = firstRecord(asArray(root.entry));
  const change = firstRecord(asArray(entry?.changes));
  return asRecord(change?.value);
}

function firstMessageId(payload: unknown): string | undefined {
  const value = firstChangeValue(asRecord(payload));
  const message = firstRecord(asArray(value.messages));
  return asString(message?.id);
}

function renderWhatsAppMessageContent(message: JsonRecord): string | undefined {
  const messageType = asString(message.type) ?? "message";
  switch (messageType) {
    case "text":
      return asString(asRecord(message.text).body);
    case "image":
    case "video":
    case "document":
      return asString(asRecord(message[messageType]).caption) ?? `[whatsapp ${messageType}]`;
    case "audio":
    case "sticker":
      return `[whatsapp ${messageType}]`;
    case "reaction": {
      const emoji = asString(asRecord(message.reaction).emoji);
      return emoji ? `Reaction: ${emoji}` : "[whatsapp reaction]";
    }
    case "location": {
      const location = asRecord(message.location);
      const latitude = location.latitude;
      const longitude = location.longitude;
      if (typeof latitude === "number" && typeof longitude === "number") {
        return `Location: ${latitude},${longitude}`;
      }
      return "[whatsapp location]";
    }
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
