import type { PermissionSurface } from "./policy.js";

export interface ChannelAttachmentInput {
  url?: string;
  title?: string;
  mimeType?: string;
  dataBase64?: string;
  attachmentId?: string;
}

export interface ChannelGovernanceInput {
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  runId?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: PermissionSurface;
}

export interface ChannelSendInput extends ChannelGovernanceInput {
  connectionId: string;
  target: string;
  message: string;
  attachments?: ChannelAttachmentInput[];
  attachmentIds?: string[];
  interactiveActions?: {
    platform?: string;
    tokenId?: string;
    buttons: Array<{ label: string; callbackData: string }>;
  };
  replyToMessageId?: string;
  replyToPartIndex?: number;
  effectId?: string;
  subject?: string;
  signal?: AbortSignal;
}

export interface ChannelReactInput extends ChannelGovernanceInput {
  connectionId: string;
  messageId: string;
  reaction: string;
  target?: string;
  partIndex?: number;
  messageText?: string;
  signal?: AbortSignal;
}

export interface ChannelReplyInput extends ChannelSendInput {
  replyToMessageId: string;
}

export interface ChannelUnsendInput extends ChannelGovernanceInput {
  connectionId: string;
  messageId: string;
  target?: string;
  partIndex?: number;
  signal?: AbortSignal;
}

export interface ChannelTypingInput extends ChannelGovernanceInput {
  connectionId: string;
  target: string;
  threadId?: string;
  durationMs?: number;
  signal?: AbortSignal;
}

export interface ChannelTypingResult {
  channelKey: string;
  connectionId: string;
  target: string;
  supported: boolean;
  status: "sent" | "unsupported";
  reason?: string;
  expiresAt?: string;
}

export type ChannelActivityPhase = "seen" | "thinking" | "tooling" | "waiting_approval" | "failed" | "clear";

export interface ChannelActivityInput extends ChannelGovernanceInput {
  connectionId: string;
  target: string;
  messageId: string;
  phase: ChannelActivityPhase;
  channelKey?: string;
  threadId?: string;
  turnId?: string;
  label?: string;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface ChannelActivityEffectResult {
  effect: "mission_control" | "reaction" | "reaction_clear" | "typing" | "read_receipt";
  supported: boolean;
  status: "sent" | "cleared" | "unsupported" | "failed";
  detail?: string;
}

export interface ChannelActivityResult {
  channelKey: string;
  connectionId: string;
  target: string;
  messageId: string;
  phase: ChannelActivityPhase;
  status: "sent" | "cleared" | "unsupported" | "failed" | "partial";
  emoji?: string;
  effects: ChannelActivityEffectResult[];
}

export type ChannelDeliveryStatus = "sent" | "retrying" | "degraded" | "blocked" | "not_available";

export interface GmailSendInput {
  connectionId: string;
  to: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  cc?: string[];
  bcc?: string[];
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface GmailReadQuery {
  connectionId: string;
  query?: string;
  maxResults?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface CalendarCreateEventInput {
  connectionId: string;
  calendarId?: string;
  title: string;
  description?: string;
  startIso: string;
  endIso: string;
  attendees?: string[];
  timeZone?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface CalendarListQuery {
  connectionId: string;
  calendarId?: string;
  fromIso?: string;
  toIso?: string;
  maxResults?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
}

export interface CommsSendResult {
  deliveryId: string;
  status: "queued" | "sent" | "failed";
  deliveryStatus?: ChannelDeliveryStatus;
  providerMessageId?: string;
  channelKey: string;
  target: string;
  error?: string;
  fallbackReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommsSyncResult {
  status: "ok" | "failed";
  channelKey: string;
  records: unknown[];
  error?: string;
}
