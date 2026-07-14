import { createHmac } from "node:crypto";
import {
  asRecord,
  asString,
  hashRawBodyDigest,
  timingSafeStringEqual,
  type JsonRecord,
} from "./webhook-json-helpers.js";

const WHATSAPP_WEBHOOK_PATH = /^\/api\/v1\/integrations\/connections\/[^/]+\/whatsapp\/webhook$/i;
const WHATSAPP_SIGNATURE_PREFIX = "sha256=";

/**
 * Structured reference to an inbound WhatsApp audio/voice-note message.
 * Only the Cloud API media id is emitted — never media bytes. Download +
 * transcription happen later in the dispatch flow, after the sender trust gate.
 */
export type WhatsAppVoiceMediaRef = {
  mediaId: string;
  mimeType?: string;
};

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
      /** Present only when channelVoiceInboundV1Enabled and the message is audio with a media id. */
      voiceMedia?: WhatsAppVoiceMediaRef;
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
  return timingSafeStringEqual(expected, signature);
}

export function deriveWhatsAppWebhookIdempotencyKey(connectionId: string, payload: unknown, rawBody: Buffer): string {
  const messageId = firstMessageId(payload);
  if (messageId) {
    return `whatsapp:${connectionId}:${messageId}`;
  }
  return `whatsapp:${connectionId}:${hashRawBodyDigest(rawBody)}`;
}

/** Derive the durable identity for one message in a WhatsApp webhook batch. */
export function deriveWhatsAppWebhookEventIdempotencyKey(
  connectionId: string,
  event: Extract<WhatsAppWebhookNormalization, { kind: "message" }>,
): string {
  return `whatsapp:${connectionId}:${event.eventId}`;
}

export function normalizeWhatsAppWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
  /**
   * channelVoiceInboundV1Enabled gate. Absent/false (default) ⇒ audio messages
   * keep today's behavior: the literal "[whatsapp audio]" placeholder content.
   */
  voiceInboundEnabled?: boolean;
}): WhatsAppWebhookNormalization {
  return (
    normalizeWhatsAppWebhookPayloads(input)[0] ?? {
      kind: "ignore",
      reason: "No WhatsApp message payload was present",
    }
  );
}

/**
 * Normalize every entry/change/message in a WhatsApp Cloud API callback. Meta
 * may coalesce several messages (and delivery statuses) into one signed body.
 */
export function normalizeWhatsAppWebhookPayloads(input: {
  connectionId: string;
  payload: unknown;
  voiceInboundEnabled?: boolean;
}): WhatsAppWebhookNormalization[] {
  const root = asRecord(input.payload);
  if (asString(root.object) !== "whatsapp_business_account") {
    return [
      {
        kind: "ignore",
        reason: "Unsupported WhatsApp webhook object",
      },
    ];
  }

  const normalized: WhatsAppWebhookNormalization[] = [];
  for (const entry of records(asArray(root.entry))) {
    for (const change of records(asArray(entry.changes))) {
      const value = asRecord(change.value);
      if (asArray(value.statuses).length > 0) {
        normalized.push({
          kind: "ignore",
          eventType: "status",
          reason: "Ignoring WhatsApp delivery status event",
        });
      }
      for (const message of records(asArray(value.messages))) {
        normalized.push(normalizeWhatsAppMessage(input, value, message));
      }
    }
  }

  if (normalized.length === 0) {
    return [
      {
        kind: "ignore",
        reason: "No WhatsApp message payload was present",
      },
    ];
  }
  return normalized;
}

function normalizeWhatsAppMessage(
  input: { connectionId: string; voiceInboundEnabled?: boolean },
  value: JsonRecord,
  message: JsonRecord,
): WhatsAppWebhookNormalization {
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

  const contacts = records(asArray(value.contacts));
  const contact = contacts.find((candidate) => asString(candidate.wa_id) === actorId) ?? contacts[0];
  const profile = asRecord(contact?.profile);
  const metadata = asRecord(value.metadata);
  const context = asRecord(message.context);
  const voiceMedia =
    input.voiceInboundEnabled === true && eventType === "audio" ? readWhatsAppVoiceMedia(message) : undefined;

  return {
    kind: "message",
    eventType,
    eventId,
    account: input.connectionId,
    actorId,
    actorType: "user",
    displayName: asString(profile.name),
    content,
    ...(voiceMedia ? { voiceMedia } : {}),
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

function readWhatsAppVoiceMedia(message: JsonRecord): WhatsAppVoiceMediaRef | undefined {
  const audio = asRecord(message.audio);
  const mediaId = asString(audio.id);
  if (!mediaId) {
    return undefined;
  }
  const mimeType = asString(audio.mime_type);
  return {
    mediaId,
    ...(mimeType ? { mimeType } : {}),
  };
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
