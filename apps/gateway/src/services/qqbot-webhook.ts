import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { asRecord, asString } from "./webhook-json-helpers.js";

const QQBOT_WEBHOOK_PATH = /^\/api\/v1\/integrations\/connections\/[^/]+\/qqbot\/webhook$/i;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SEED_BYTES = 32;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const PLAIN_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TS = /^\d{1,16}$/;
const TIMESTAMP = /^\d{1,16}$/;
const LEADING_MENTION = /^<@!?[^>]*>\s*/;

export type QqbotWebhookNormalization =
  | { kind: "validation"; plainToken: string; eventTs: string }
  | {
      kind: "message";
      eventId: string;
      eventType: string;
      scope: "group" | "c2c" | "channel" | "dm";
      target: string;
      actorId: string;
      content: string;
      metadata: Record<string, unknown>;
    }
  | { kind: "invalid"; reason: string }
  | { kind: "ignore"; reason: string };

export function isQqbotWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return QQBOT_WEBHOOK_PATH.test(pathname);
}

/** QQ derives the ed25519 seed by repeating the bot secret until it covers 32 bytes. */
export function deriveQqbotEd25519KeyPair(appSecret: string): { privateKey: KeyObject; publicKey: KeyObject } {
  const secretBytes = Buffer.from(appSecret, "utf8");
  if (secretBytes.length === 0) {
    throw new Error("QQBot app secret is empty");
  }
  const repeats = Math.ceil(ED25519_SEED_BYTES / secretBytes.length);
  const seed = Buffer.concat(Array.from({ length: repeats }, () => secretBytes)).subarray(0, ED25519_SEED_BYTES);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function verifyQqbotSignature(input: {
  appSecret: string;
  signatureHex: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
}): boolean {
  const signatureHex = input.signatureHex?.trim().toLowerCase();
  const timestamp = input.timestamp?.trim();
  if (
    !input.appSecret ||
    !signatureHex ||
    !timestamp ||
    !SIGNATURE_HEX.test(signatureHex) ||
    !TIMESTAMP.test(timestamp)
  ) {
    return false;
  }
  try {
    const { publicKey } = deriveQqbotEd25519KeyPair(input.appSecret);
    const message = Buffer.concat([Buffer.from(timestamp, "utf8"), input.rawBody]);
    return verify(null, message, publicKey, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * QQ may send the op 13 callback validation without signature headers. Only a body that is exactly an op 13
 * validation with a strictly formatted token and timestamp may skip signature checks: that format can never equal
 * "timestamp + JSON body" of a dispatch, so answering it cannot be used as a signing oracle.
 */
export function isUnsignedQqbotValidationBody(rawBody: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const root = parsed as Record<string, unknown>;
  const data = root.d;
  if (root.op !== 13 || typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const { plain_token: plainToken, event_ts: eventTs } = data as Record<string, unknown>;
  return (
    typeof plainToken === "string" &&
    typeof eventTs === "string" &&
    PLAIN_TOKEN.test(plainToken) &&
    EVENT_TS.test(eventTs)
  );
}

/** Callback-validation (op 13) reply: hex ed25519 signature over eventTs + plainToken. */
export function signQqbotValidation(input: { appSecret: string; eventTs: string; plainToken: string }): string {
  const { privateKey } = deriveQqbotEd25519KeyPair(input.appSecret);
  return sign(null, Buffer.from(`${input.eventTs}${input.plainToken}`, "utf8"), privateKey).toString("hex");
}

export function normalizeQqbotWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
}): QqbotWebhookNormalization {
  const root = asRecord(input.payload);
  if (root.op === 13) {
    const data = asRecord(root.d);
    const plainToken = typeof data.plain_token === "string" ? data.plain_token : "";
    const eventTs = typeof data.event_ts === "string" ? data.event_ts : "";
    // The format check keeps the reply from ever signing attacker-chosen JSON that could equal timestamp + body.
    if (!PLAIN_TOKEN.test(plainToken) || !EVENT_TS.test(eventTs)) {
      return { kind: "invalid", reason: "Malformed QQBot validation payload" };
    }
    return { kind: "validation", plainToken, eventTs };
  }
  if (root.op !== 0) {
    return { kind: "ignore", reason: "Unsupported QQBot op" };
  }
  const eventType = asString(root.t);
  const data = asRecord(root.d);
  const author = asRecord(data.author);
  const routed = routeMessage(eventType, data, author);
  if (!eventType || !routed) {
    return { kind: "ignore", reason: `Unsupported QQBot event type: ${eventType ?? "missing"}` };
  }
  const eventId = asString(data.id);
  const content = stripLeadingMention(asString(data.content) ?? "");
  if (!eventId || !routed.actorId || !routed.id || !content) {
    return { kind: "ignore", reason: "Missing id, sender, target, or content in QQBot message event" };
  }
  return {
    kind: "message",
    eventId,
    eventType,
    scope: routed.scope,
    target: `${routed.prefix}:${routed.id}`,
    actorId: routed.actorId,
    content,
    metadata: { qqEventType: eventType, qqScope: routed.scope, qqEventId: asString(root.id) },
  };
}

function routeMessage(
  eventType: string | undefined,
  data: Record<string, unknown>,
  author: Record<string, unknown>,
):
  | { scope: "group" | "c2c" | "channel" | "dm"; prefix: string; id: string | undefined; actorId: string | undefined }
  | undefined {
  switch (eventType) {
    case "GROUP_AT_MESSAGE_CREATE":
      return {
        scope: "group",
        prefix: "group",
        id: asString(data.group_openid),
        actorId: asString(author.member_openid),
      };
    case "C2C_MESSAGE_CREATE":
      return { scope: "c2c", prefix: "user", id: asString(author.user_openid), actorId: asString(author.user_openid) };
    case "AT_MESSAGE_CREATE":
      return { scope: "channel", prefix: "channel", id: asString(data.channel_id), actorId: asString(author.id) };
    case "DIRECT_MESSAGE_CREATE":
      return { scope: "dm", prefix: "dm", id: asString(data.guild_id), actorId: asString(author.id) };
    default:
      return undefined;
  }
}

function stripLeadingMention(content: string): string {
  return content.replace(LEADING_MENTION, "").trim();
}
