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
  /**
   * Persistable template for approval actions whose bearer remains in the OS
   * keychain until the final provider transport. Runtime-only callers hydrate
   * this into `interactiveActions`; public API callers should not set it.
   */
  interactiveActionTemplate?: {
    platform?: string;
    tokenId: string;
    tokenRef: string;
    expiresAt: string;
    buttons: Array<{ label: string; decision: "a" | "r" }>;
  };
  replyToMessageId?: string;
  replyToPartIndex?: number;
  effectId?: string;
  subject?: string;
  /** Optional autonomous commitment linkage used to update delivery lifecycle truth. */
  commitmentId?: string;
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

export type ChannelDeliveryStatus =
  | "sent"
  | "retrying"
  | "degraded"
  | "blocked"
  | "not_available"
  | "manual_reconciliation_required";

export type ChannelDeliveryChunkingMode = "none" | "unicode_safe";

export interface ChannelDeliveryChunkPartDiagnostic {
  partIndex: number;
  codePointLength: number;
  utf16Length: number;
}

export interface ChannelDeliveryChunkingDiagnostics {
  mode: ChannelDeliveryChunkingMode;
  originalCodePointLength: number;
  partCount: number;
  maxPartUtf16Length: number;
  parts: ChannelDeliveryChunkPartDiagnostic[];
}

export interface ChannelDeliveryDiagnostics {
  chunking?: ChannelDeliveryChunkingDiagnostics;
  richFormatting?: {
    requestedFormat?: "plain_text" | "html" | "markdown" | "provider_native";
    posture: "preserved" | "plain_text_fallback";
    notes: string[];
  };
  richMessage?: {
    channelKey: string;
    provider: "telegram_bot_api" | "whatsapp_cloud_api";
    capabilityLabel: string;
    status: "preserved" | "degraded" | "blocked";
    textPosture: "text_only" | "caption" | "separate_text_then_media" | "media_only";
    attachmentCount: number;
    nativeAttachmentCount: number;
    fallbackAttachmentCount: number;
    blockedAttachmentCount: number;
    pendingAttachmentIdCount: number;
    providerAttachmentLimit: number;
    captionMaxCodeUnits: number;
    notes: string[];
    evidence: {
      owner: "gateway";
      source: "channel_rich_message_plan";
      status: "preserved" | "degraded" | "blocked";
      provider: "telegram_bot_api" | "whatsapp_cloud_api";
      evidenceId: string;
    };
    attachments: Array<{
      index: number;
      source: "url" | "inline" | "pending_attachment_id" | "metadata_only";
      mediaKind: "image" | "video" | "audio" | "document" | "unknown";
      providerKind?: "photo" | "image" | "video" | "audio" | "document";
      disposition: "native_media" | "document_fallback" | "text_fallback" | "pending_hydration" | "blocked";
      mimeType?: string;
      title?: string;
      reason?: string;
    }>;
  };
}

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
  /** Caller-supplied idempotency key so retries of the same send are safely deduped. */
  idempotencyKey?: string;
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
  deliveryDiagnostics?: ChannelDeliveryDiagnostics;
  createdAt: string;
  updatedAt: string;
}

export interface CommsSyncResult {
  status: "ok" | "failed";
  channelKey: string;
  records: unknown[];
  error?: string;
}
