import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const NEXTCLOUD_TALK_WEBHOOK_PATH =
  /^\/api\/v1\/integrations\/connections\/[^/]+\/nextcloud-talk\/webhook$/i;

type JsonRecord = Record<string, unknown>;

export type NextcloudTalkWebhookNormalization =
  | {
    kind: "message";
    eventType: "Create";
    eventId: string;
    account: string;
    room: string;
    actorId: string;
    actorType: "user" | "system";
    displayName?: string;
    content: string;
    replyToMessageId?: string;
    backendUrl?: string;
    metadata: Record<string, unknown>;
  }
  | {
    kind: "activity";
    eventType: "Like" | "Undo" | "Join" | "Leave";
    account: string;
    room?: string;
    actorId?: string;
    displayName?: string;
    backendUrl?: string;
    metadata: Record<string, unknown>;
  }
  | {
    kind: "ignore";
    eventType?: string;
    reason: string;
  };

export function isNextcloudTalkWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return NEXTCLOUD_TALK_WEBHOOK_PATH.test(pathname);
}

export function buildNextcloudTalkSignature(random: string, rawBody: Buffer | string, secret: string): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(random, "utf8"), body]))
    .digest("hex");
}

export function verifyNextcloudTalkSignature(
  random: string | undefined,
  signature: string | undefined,
  rawBody: Buffer,
  secret: string,
): boolean {
  if (!random?.trim() || !signature?.trim()) {
    return false;
  }
  const expected = buildNextcloudTalkSignature(random.trim(), rawBody, secret);
  const provided = signature.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}

export function deriveNextcloudTalkWebhookIdempotencyKey(connectionId: string, rawBody: Buffer): string {
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return `nextcloud-talk:${connectionId}:${digest}`;
}

export function normalizeNextcloudTalkWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
  backendUrl?: string;
}): NextcloudTalkWebhookNormalization {
  const root = asRecord(input.payload);
  const eventType = asString(root.type);
  if (!eventType) {
    return { kind: "ignore", reason: "Missing Nextcloud webhook type" };
  }

  switch (eventType) {
    case "Create":
      return normalizeCreateEvent(input.connectionId, root, input.backendUrl);
    case "Like":
      return normalizeActivityEvent("Like", input.connectionId, root, input.backendUrl);
    case "Undo":
      return normalizeActivityEvent("Undo", input.connectionId, root, input.backendUrl);
    case "Join":
      return normalizeActivityEvent("Join", input.connectionId, root, input.backendUrl);
    case "Leave":
      return normalizeActivityEvent("Leave", input.connectionId, root, input.backendUrl);
    default:
      return {
        kind: "ignore",
        eventType,
        reason: `Unsupported Nextcloud webhook type: ${eventType}`,
      };
  }
}

function normalizeCreateEvent(
  connectionId: string,
  root: JsonRecord,
  backendUrl?: string,
): NextcloudTalkWebhookNormalization {
  const actor = asRecord(root.actor);
  const object = asRecord(root.object);
  const target = asRecord(root.target);
  const actorType = asString(actor.type);
  const actorId = asString(actor.id);
  const displayName = asString(actor.name);
  const messageId = asString(object.id);
  const roomId = asString(target.id);
  const messageContent = renderNextcloudTalkMessage(asString(object.content));
  const inReplyTo = asRecord(object.inReplyTo);
  const replyToObject = asRecord(inReplyTo.object);
  const replyToMessageId = asString(replyToObject.id);

  if (actorType?.toLowerCase() === "application" || actorId?.startsWith("bots/")) {
    return {
      kind: "ignore",
      eventType: "Create",
      reason: "Ignoring bot-authored Nextcloud message",
    };
  }
  if (!actorId || !messageId || !roomId || !messageContent) {
    return {
      kind: "ignore",
      eventType: "Create",
      reason: "Missing actor, message, room, or content in Nextcloud message event",
    };
  }

  return {
    kind: "message",
    eventType: "Create",
    eventId: messageId,
    account: connectionId,
    room: roomId,
    actorId,
    actorType: actorType?.toLowerCase() === "system" ? "system" : "user",
    displayName,
    content: messageContent,
    replyToMessageId,
    backendUrl,
    metadata: {
      roomName: asString(target.name),
      mediaType: asString(object.mediaType),
      objectName: asString(object.name),
      replyToMessageId,
    },
  };
}

function normalizeActivityEvent(
  eventType: "Like" | "Undo" | "Join" | "Leave",
  connectionId: string,
  root: JsonRecord,
  backendUrl?: string,
): NextcloudTalkWebhookNormalization {
  const actor = asRecord(root.actor);
  const target = asRecord(root.target);
  const directObject = asRecord(root.object);
  const nestedObject = asRecord(directObject.object);
  const messageObject = eventType === "Undo" ? nestedObject : directObject;
  const roomId = asString(target.id)
    ?? asString(directObject.id)
    ?? asString(asRecord(root.object).id);
  const reaction = eventType === "Like"
    ? asString(root.content)
    : eventType === "Undo"
      ? asString(directObject.content)
      : undefined;

  return {
    kind: "activity",
    eventType,
    account: connectionId,
    room: roomId,
    actorId: asString(actor.id),
    displayName: asString(actor.name),
    backendUrl,
    metadata: {
      reaction,
      messageId: asString(messageObject.id),
      objectType: asString(directObject.type),
      roomName: asString(target.name),
    },
  };
}

function renderNextcloudTalkMessage(content: string | undefined): string {
  if (!content) {
    return "";
  }
  let parsed: JsonRecord;
  try {
    parsed = asRecord(JSON.parse(content));
  } catch {
    return content.trim();
  }
  const template = asString(parsed.message)?.trim();
  if (!template) {
    return "";
  }
  const parameters = asRecord(parsed.parameters);
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    const parameter = asRecord(parameters[key]);
    const replacement = asString(parameter.name)
      ?? asString(parameter.label)
      ?? asString(parameter.id)
      ?? asString(parameter.type);
    return replacement ?? match;
  }).trim();
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
