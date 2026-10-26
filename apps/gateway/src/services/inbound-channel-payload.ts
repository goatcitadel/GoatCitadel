/**
 * The bounded, normalized envelope a durable inbound channel event stores.
 *
 * Only these fields cross the durable boundary, before a provider is acknowledged. Voice media is kept as a
 * secret-free reference (never with connection config), and the inbound worker reads the envelope back under the
 * same rules.
 */
import {
  CHANNEL_INGRESS_ACCEPTED_REVISION_KEY,
  type ChatChannelConversation,
  type InboundChannelEventRecord,
} from "@goatcitadel/contracts";
import type { ChannelVoiceInboundRequest } from "./channel-voice-inbound-service.js";
import type { DurableInboundChannelAcceptInput, IngestChannelMessageInput } from "./channel-inbound-dispatch.js";
import { readChannelConversation } from "./channel-conversation.js";
import { isOperatorDeskEvent } from "./channel-desk-turn.js";
import { sanitizeMetadata } from "./inbound-channel-metadata.js";

export interface StoredInboundPayload {
  eventType: string;
  bindingTarget?: string;
  conversation?: ChatChannelConversation;
  message: IngestChannelMessageInput;
  responseOptions?: {
    deliveryReplyToMessageId?: string;
    channelSystemInstruction?: string;
    /** Only a desk question carries the operator's provider and model choice; provider events never do. */
    providerId?: string;
    model?: string;
  };
  voiceRequest?: PersistedVoiceRequest;
  voiceFallbackContent?: string;
  voiceCaption?: string;
}

/** Secret-free voice media reference: every variant minus connectionConfig. */
type PersistedVoiceRequest =
  | { channel: "telegram"; fileId: string; mimeType?: string }
  | { channel: "whatsapp"; mediaId: string; mimeType?: string }
  | { channel: "slack"; fileId: string; downloadUrl: string; mimeType?: string }
  | { channel: "discord"; attachmentId: string; url: string; mimeType?: string };

export function buildStoredPayload(input: DurableInboundChannelAcceptInput): Record<string, unknown> {
  assertNoApprovalBearerInDurablePayload(input);
  const message: StoredInboundPayload["message"] = {
    eventId: normalizeRequiredString(input.message.eventId, "message.eventId"),
    account: normalizeRequiredString(input.message.account, "message.account"),
    actorId: normalizeRequiredString(input.message.actorId, "message.actorId"),
    content: normalizeRequiredString(input.message.content, "message.content"),
  };
  assignDefined(message, "peer", normalizeOptionalString(input.message.peer));
  assignDefined(message, "room", normalizeOptionalString(input.message.room));
  assignDefined(message, "threadId", normalizeOptionalString(input.message.threadId));
  assignDefined(message, "actorType", input.message.actorType);
  assignDefined(message, "displayName", normalizeOptionalString(input.message.displayName));
  assignDefined(message, "metadata", sanitizeMetadata(input.message.metadata));

  const payload: StoredInboundPayload = {
    eventType: normalizeRequiredString(input.eventType, "eventType"),
    message,
  };
  assignDefined(payload, "bindingTarget", normalizeOptionalString(input.bindingTarget));
  assignDefined(payload, "conversation", readChannelConversation(input.conversation));
  if (input.responseOptions) {
    const responseOptions: NonNullable<StoredInboundPayload["responseOptions"]> = {};
    assignDefined(
      responseOptions,
      "deliveryReplyToMessageId",
      normalizeOptionalString(input.responseOptions.deliveryReplyToMessageId),
    );
    assignDefined(
      responseOptions,
      "channelSystemInstruction",
      normalizeOptionalString(input.responseOptions.channelSystemInstruction),
    );
    if (Object.keys(responseOptions).length > 0) {
      payload.responseOptions = responseOptions;
    }
  }
  assignDefined(payload, "voiceRequest", input.voiceRequest ? persistVoiceRequest(input.voiceRequest) : undefined);
  assignDefined(payload, "voiceFallbackContent", normalizeOptionalString(input.voiceFallbackContent));
  if (input.voiceRequest) {
    assignDefined(payload, "voiceCaption", normalizeOptionalString(input.voiceCaption));
  }
  if (input.acceptedConnectionRevision && /^[a-f0-9]{64}$/.test(input.acceptedConnectionRevision)) {
    (payload as unknown as Record<string, unknown>)[CHANNEL_INGRESS_ACCEPTED_REVISION_KEY] =
      input.acceptedConnectionRevision;
  }
  return payload as unknown as Record<string, unknown>;
}

function assertNoApprovalBearerInDurablePayload(input: DurableInboundChannelAcceptInput): void {
  if (
    (input.channel === "telegram" || input.channel === "discord") &&
    /^\/(?:approve|deny|reject)(?:@[^\s]+)?\s+\S+/i.test(input.message.content.trim())
  ) {
    throw new Error("Approval bearer commands must be converted to opaque action ids before durable acceptance.");
  }
}

export function parseStoredPayload(event: InboundChannelEventRecord): StoredInboundPayload {
  const value = event.payload;
  if (!isRecord(value) || !isRecord(value.message)) {
    throw new Error(`Inbound channel event ${event.eventId} has an invalid normalized payload.`);
  }
  const message = value.message;
  const payload: StoredInboundPayload = {
    eventType: readRequiredString(value.eventType, "eventType"),
    bindingTarget: readOptionalString(value.bindingTarget),
    conversation: readChannelConversation(value.conversation),
    message: {
      eventId: readRequiredString(message.eventId, "message.eventId"),
      account: readRequiredString(message.account, "message.account"),
      peer: readOptionalString(message.peer),
      room: readOptionalString(message.room),
      threadId: readOptionalString(message.threadId),
      actorId: readRequiredString(message.actorId, "message.actorId"),
      actorType:
        message.actorType === "agent" || message.actorType === "system" || message.actorType === "user"
          ? message.actorType
          : undefined,
      displayName: readOptionalString(message.displayName),
      content: readRequiredString(message.content, "message.content"),
      metadata: isRecord(message.metadata) ? message.metadata : undefined,
    },
    responseOptions: isRecord(value.responseOptions)
      ? {
          deliveryReplyToMessageId: readOptionalString(value.responseOptions.deliveryReplyToMessageId),
          channelSystemInstruction: readOptionalString(value.responseOptions.channelSystemInstruction),
        }
      : undefined,
    voiceRequest: parsePersistedVoiceRequest(value.voiceRequest),
    voiceFallbackContent: readOptionalString(value.voiceFallbackContent),
    voiceCaption: readOptionalString(value.voiceCaption),
  };
  if (payload.responseOptions && isRecord(value.responseOptions) && isOperatorDeskEvent(event)) {
    assignDefined(payload.responseOptions, "providerId", readOptionalString(value.responseOptions.providerId));
    assignDefined(payload.responseOptions, "model", readOptionalString(value.responseOptions.model));
  }
  return payload;
}

/**
 * The media-reference fields each voice channel persists. connectionConfig is
 * deliberately absent: the worker re-reads current connection config at
 * transcription time, so credentials never cross the durable boundary.
 */
const PERSISTED_VOICE_REFERENCE_FIELDS = {
  telegram: ["fileId"],
  whatsapp: ["mediaId"],
  slack: ["fileId", "downloadUrl"],
  discord: ["attachmentId", "url"],
} as const satisfies Record<ChannelVoiceInboundRequest["channel"], readonly string[]>;

function isPersistedVoiceChannel(value: unknown): value is ChannelVoiceInboundRequest["channel"] {
  return typeof value === "string" && Object.hasOwn(PERSISTED_VOICE_REFERENCE_FIELDS, value);
}

function persistVoiceRequest(request: ChannelVoiceInboundRequest): PersistedVoiceRequest {
  const source = request as unknown as Record<string, unknown>;
  const persisted: Record<string, unknown> = { channel: request.channel };
  for (const field of PERSISTED_VOICE_REFERENCE_FIELDS[request.channel]) {
    const raw = source[field];
    persisted[field] = normalizeRequiredString(typeof raw === "string" ? raw : "", `voiceRequest.${field}`);
  }
  assignDefined(persisted, "mimeType", normalizeOptionalString(request.mimeType));
  return persisted as PersistedVoiceRequest;
}

function parsePersistedVoiceRequest(value: unknown): PersistedVoiceRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isPersistedVoiceChannel(value.channel)) {
    throw new Error("Inbound voice payload has an unsupported channel.");
  }
  const parsed: Record<string, unknown> = { channel: value.channel };
  for (const field of PERSISTED_VOICE_REFERENCE_FIELDS[value.channel]) {
    parsed[field] = readRequiredString(value[field], `voiceRequest.${field}`);
  }
  parsed.mimeType = readOptionalString(value.mimeType);
  return parsed as PersistedVoiceRequest;
}

export function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is missing from the durable inbound payload.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
