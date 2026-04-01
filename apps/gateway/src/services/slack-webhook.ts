import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SLACK_WEBHOOK_PATH =
  /^\/api\/v1\/integrations\/connections\/[^/]+\/slack\/webhook$/i;
const SLACK_SIGNATURE_PREFIX = "v0=";
const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

export type SlackWebhookNormalization =
  | {
    kind: "challenge";
    challenge: string;
  }
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
    threadId?: string;
    deliveryReplyToMessageId: string;
    metadata: Record<string, unknown>;
  }
  | {
    kind: "ignore";
    eventType?: string;
    reason: string;
  };

export function isSlackWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return SLACK_WEBHOOK_PATH.test(pathname);
}

export function buildSlackSignature(timestamp: string, rawBody: Buffer | string, secret: string): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return `${SLACK_SIGNATURE_PREFIX}${createHmac("sha256", secret)
    .update(`${SLACK_SIGNATURE_VERSION}:${timestamp}:`)
    .update(body)
    .digest("hex")}`;
}

export function verifySlackSignature(input: {
  timestamp?: string;
  signature?: string;
  rawBody: Buffer;
  secret: string;
  nowMs?: number;
}): boolean {
  const timestamp = input.timestamp?.trim();
  const signature = input.signature?.trim().toLowerCase();
  if (!timestamp || !signature?.startsWith(SLACK_SIGNATURE_PREFIX) || !/^v0=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const timestampMs = Number.parseInt(timestamp, 10) * 1000;
  if (!Number.isFinite(timestampMs)) {
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > SLACK_MAX_TIMESTAMP_SKEW_MS) {
    return false;
  }
  const expected = buildSlackSignature(timestamp, input.rawBody, input.secret);
  if (expected.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}

export function deriveSlackWebhookIdempotencyKey(connectionId: string, payload: unknown, rawBody: Buffer): string {
  const root = asRecord(payload);
  const eventId = asString(root.event_id);
  if (eventId) {
    return `slack:${connectionId}:${eventId}`;
  }
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return `slack:${connectionId}:${digest}`;
}

export function normalizeSlackWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
}): SlackWebhookNormalization {
  const root = asRecord(input.payload);
  const envelopeType = asString(root.type);
  if (envelopeType === "url_verification") {
    const challenge = asString(root.challenge);
    if (!challenge) {
      return {
        kind: "ignore",
        eventType: envelopeType,
        reason: "Slack url_verification payload did not include a challenge",
      };
    }
    return {
      kind: "challenge",
      challenge,
    };
  }
  if (envelopeType !== "event_callback") {
    return {
      kind: "ignore",
      eventType: envelopeType,
      reason: `Unsupported Slack webhook envelope: ${envelopeType ?? "unknown"}`,
    };
  }

  const event = asRecord(root.event);
  const eventType = asString(event.type);
  if (eventType !== "message") {
    return {
      kind: "ignore",
      eventType,
      reason: `Unsupported Slack event type: ${eventType ?? "unknown"}`,
    };
  }

  const subtype = asString(event.subtype);
  if (subtype) {
    return {
      kind: "ignore",
      eventType,
      reason: `Ignoring Slack message subtype ${subtype}`,
    };
  }

  const actorId = asString(event.user);
  const content = asString(event.text);
  const channel = asString(event.channel);
  const channelType = asString(event.channel_type);
  const messageTs = asString(event.ts) ?? asString(event.event_ts);
  const threadTs = asString(event.thread_ts);
  const teamId = asString(root.team_id) ?? asString(event.team);

  if (!actorId || !content || !channel || !messageTs) {
    return {
      kind: "ignore",
      eventType,
      reason: "Missing Slack actor, text, channel, or message timestamp",
    };
  }

  const isDirectMessage = channelType === "im";
  return {
    kind: "message",
    eventType: "message",
    eventId: messageTs,
    account: input.connectionId,
    actorId,
    actorType: "user",
    content,
    room: isDirectMessage ? undefined : channel,
    peer: isDirectMessage ? channel : undefined,
    threadId: threadTs,
    deliveryReplyToMessageId: threadTs ?? messageTs,
    metadata: {
      teamId,
      channel,
      channelType,
      threadTs,
      messageTs,
      eventId: asString(root.event_id),
      eventTime: root.event_time,
    },
  };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
