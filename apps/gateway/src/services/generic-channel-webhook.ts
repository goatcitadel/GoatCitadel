import { createHmac } from "node:crypto";
import { timingSafeStringEqual } from "./webhook-json-helpers.js";

const GENERIC_CHANNEL_INBOUND_PATH = /^\/api\/v1\/integrations\/connections\/[^/]+\/[^/]+\/inbound$/i;
const GENERIC_CHANNEL_SIGNATURE_PREFIX = "v1=";
const GENERIC_CHANNEL_SIGNATURE_VERSION = "v1";
const GENERIC_CHANNEL_MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export function isGenericChannelInboundPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return GENERIC_CHANNEL_INBOUND_PATH.test(pathname);
}

export function buildGenericChannelInboundSignature(
  timestamp: string,
  rawBody: Buffer | string,
  secret: string,
): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return `${GENERIC_CHANNEL_SIGNATURE_PREFIX}${createHmac("sha256", secret)
    .update(`${GENERIC_CHANNEL_SIGNATURE_VERSION}:${timestamp}:`)
    .update(body)
    .digest("hex")}`;
}

export function verifyGenericChannelInboundSignature(input: {
  timestamp?: string;
  signature?: string;
  rawBody: Buffer;
  secret: string;
  nowMs?: number;
}): boolean {
  const timestamp = input.timestamp?.trim();
  const signature = input.signature?.trim().toLowerCase();
  if (!timestamp || !signature?.startsWith(GENERIC_CHANNEL_SIGNATURE_PREFIX) || !/^v1=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const timestampMs = parseWebhookTimestampMs(timestamp);
  if (timestampMs === undefined) {
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > GENERIC_CHANNEL_MAX_TIMESTAMP_SKEW_MS) {
    return false;
  }
  const expected = buildGenericChannelInboundSignature(timestamp, input.rawBody, input.secret);
  return timingSafeStringEqual(expected, signature);
}

export function deriveGenericChannelInboundIdempotencyKey(
  connectionId: string,
  channel: string,
  eventId: string,
): string {
  return `generic-channel:${connectionId}:${channel}:${eventId}`;
}

function parseWebhookTimestampMs(timestamp: string): number | undefined {
  if (/^\d+$/.test(timestamp)) {
    const numeric = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    return timestamp.length >= 13 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}
