import { createHmac } from "node:crypto";
import { asRecord, asString, hashRawBodyDigest, timingSafeStringEqual } from "./webhook-json-helpers.js";

const SLACK_WEBHOOK_PATH = /^\/api\/v1\/integrations\/connections\/[^/]+\/slack\/webhook$/i;
const SLACK_SIGNATURE_PREFIX = "v0=";
const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const SLACK_FILE_SHARE_SUBTYPE = "file_share";
const SLACK_AUDIO_FILE_SUBTYPE = "slack_audio";

/** Fallback/marker content for an inbound Slack voice message. */
export const SLACK_VOICE_MESSAGE_PLACEHOLDER = "[voice message]";

/** Secret-free reference to a Slack audio file (download needs the bot token). */
export type SlackVoiceMediaRef = {
  fileId: string;
  downloadUrl: string;
  mimeType?: string;
};

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
      /** Present only when channelVoiceInboundV1Enabled and the message shares an audio file. */
      voiceMedia?: SlackVoiceMediaRef;
      /** The typed text sent with the audio, kept so a successful transcript does not drop it. */
      voiceCaption?: string;
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
  return timingSafeStringEqual(expected, signature);
}

export type SlackWebhookConnectionBindingResult =
  | { ok: true }
  | { ok: false; reason: "missing_connection_identity" | "missing_envelope_identity" | "identity_mismatch" };

export function verifySlackWebhookConnectionBinding(input: {
  payload: unknown;
  expectedTeamId?: string;
  expectedAppId?: string;
}): SlackWebhookConnectionBindingResult {
  const expectedTeamId = input.expectedTeamId?.trim();
  const expectedAppId = input.expectedAppId?.trim();
  if (!expectedTeamId || !expectedAppId) {
    return { ok: false, reason: "missing_connection_identity" };
  }
  const root = asRecord(input.payload);
  const teamId = asString(root.team_id);
  const appId = asString(root.api_app_id);
  if (!teamId || !appId) {
    return { ok: false, reason: "missing_envelope_identity" };
  }
  if (teamId !== expectedTeamId || appId !== expectedAppId) {
    return { ok: false, reason: "identity_mismatch" };
  }
  return { ok: true };
}

export function deriveSlackWebhookIdempotencyKey(connectionId: string, payload: unknown, rawBody: Buffer): string {
  const root = asRecord(payload);
  const eventId = asString(root.event_id);
  if (eventId) {
    return `slack:${connectionId}:${eventId}`;
  }
  return `slack:${connectionId}:${hashRawBodyDigest(rawBody)}`;
}

export function normalizeSlackWebhookPayload(input: {
  connectionId: string;
  payload: unknown;
  botUserId?: string;
  appId?: string;
  /**
   * channelVoiceInboundV1Enabled gate. Callers pass the resolved flag (on by default). Absent/false ⇒ every
   * file_share message stays ignored, exactly as before voice inbound existed.
   */
  voiceInboundEnabled?: boolean;
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
  // `file_share` is the subtype Slack uses for a message carrying uploaded
  // files. It stays ignored exactly as before unless voice inbound is enabled
  // AND the share carries an audio file; image/PDF shares are never routed.
  const voiceMedia = input.voiceInboundEnabled === true ? readSlackVoiceMedia(event) : undefined;
  if (subtype && !(subtype === SLACK_FILE_SHARE_SUBTYPE && voiceMedia)) {
    return {
      kind: "ignore",
      eventType,
      reason: `Ignoring Slack message subtype ${subtype}`,
    };
  }

  // Drop messages authored by a bot/app, including this connection's own bot.
  // A bot_message subtype is not always present (e.g. user-token posts or
  // some app messages), so the subtype check above is not sufficient on its
  // own to prevent self-trigger loops. Compare the explicit bot/app markers
  // and the connection's own bot user id captured at OAuth time.
  const eventBotId = asString(event.bot_id);
  const eventAppId = asString(event.app_id);
  const actorId = asString(event.user);
  if (eventBotId) {
    return {
      kind: "ignore",
      eventType,
      reason: "Ignoring Slack message authored by a bot",
    };
  }
  if (input.botUserId && actorId === input.botUserId) {
    return {
      kind: "ignore",
      eventType,
      reason: "Ignoring Slack message authored by this connection's bot user",
    };
  }
  if (input.appId && eventAppId === input.appId) {
    return {
      kind: "ignore",
      eventType,
      reason: "Ignoring Slack message authored by this connection's app",
    };
  }

  const text = asString(event.text);
  const content = voiceMedia ? buildSlackVoiceFallbackContent(text) : text;
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
    ...(voiceMedia ? { voiceMedia, ...(text ? { voiceCaption: text } : {}) } : {}),
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

/**
 * First shared file that is audio: a `slack_audio` clip or any `audio/*`
 * mimetype. Only the file id and its private download URL are kept; the URL
 * host is re-validated (files.slack.com only) before the worker attaches the
 * bot token to it.
 */
function readSlackVoiceMedia(event: Record<string, unknown>): SlackVoiceMediaRef | undefined {
  const files = Array.isArray(event.files) ? event.files : [];
  for (const entry of files) {
    const file = asRecord(entry);
    const mimeType = asString(file.mimetype);
    const isAudio =
      asString(file.subtype) === SLACK_AUDIO_FILE_SUBTYPE || mimeType?.toLowerCase().startsWith("audio/") === true;
    const fileId = asString(file.id);
    const downloadUrl = asString(file.url_private_download) ?? asString(file.url_private);
    if (isAudio && fileId && downloadUrl) {
      return { fileId, downloadUrl, ...(mimeType ? { mimeType } : {}) };
    }
  }
  return undefined;
}

function buildSlackVoiceFallbackContent(text: string | undefined): string {
  return text ? `${SLACK_VOICE_MESSAGE_PLACEHOLDER} ${text}` : SLACK_VOICE_MESSAGE_PLACEHOLDER;
}
