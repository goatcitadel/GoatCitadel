import type { ChatInputPart, ChatMessageSourceAuthority } from "./chat.js";

export type SessionKind = "dm" | "group" | "thread";
export type SessionHealth = "healthy" | "degraded" | "blocked";
export type BudgetState = "ok" | "warning" | "hard_cap";

export interface SessionRouteInput {
  channel: string;
  account: string;
  peer?: string;
  room?: string;
  threadId?: string;
}

export interface SessionMeta {
  sessionId: string;
  sessionKey: string;
  kind: SessionKind;
  channel: string;
  account: string;
  displayName?: string;
  routingHints?: Record<string, string>;
  lastActivityAt: string;
  updatedAt: string;
  health: SessionHealth;
  tokenInput: number;
  tokenOutput: number;
  tokenCachedInput: number;
  tokenTotal: number;
  costUsdTotal: number;
  budgetState: BudgetState;
}

export interface TranscriptEvent {
  eventId: string;
  actionId: string;
  idempotencyKey: string;
  sessionId: string;
  sessionKey: string;
  timestamp: string;
  type:
    | "message.user"
    | "message.assistant"
    | "tool.request"
    | "tool.result"
    | "approval.required"
    | "approval.resolved"
    | "orchestration.phase";
  actorType: "user" | "agent" | "system";
  actorId: string;
  /** Optional only for legacy transcript records; canonical chat messages require it. */
  sourceAuthority?: ChatMessageSourceAuthority;
  payload: Record<string, unknown>;
  tokenInput?: number;
  tokenOutput?: number;
  costUsd?: number;
}

export interface InboundEventIndexRow {
  endpoint: string;
  idempotencyKey: string;
  eventId: string;
  sessionKey: string;
  payloadHash: string;
  receivedAt: string;
  processedAt?: string;
  status: "accepted" | "deduped" | "failed";
}

export interface GatewayEventInput {
  eventId: string;
  route: SessionRouteInput;
  actor: { type: "user" | "agent" | "system"; id: string };
  message: {
    role: "user" | "assistant";
    content: string;
    parts?: ChatInputPart[];
    attachments?: Array<{
      attachmentId: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    }>;
    /**
     * Set true when this user message was injected into an active run via /steer.
     * Forwarded to chat_messages so transcripts show the operator intervention.
     */
    steered?: boolean;
    /**
     * Links the message to a parent delegation step. Set on the [Subagent Task]
     * first message of a child session so the lineage is queryable from the message.
     */
    parentDelegationStepId?: string;
  };
  taskId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
    providerId?: string;
    model?: string;
    /** Credential class billed against (Anthropic Jun-2026 pool split). */
    credentialType?: "api_key" | "oauth" | "unknown";
    /** Billing pool the usage drew from (subscription credit pool vs standard). */
    usagePool?: "standard" | "subscription" | "unknown";
    /**
     * Canonical per-provider-attempt records that already own session/cost
     * projection. When present, ingest must not add another assistant aggregate.
     */
    canonicalUsageEventIds?: string[];
    /** Exact owner tuple used to validate canonical usage references at ingest. */
    canonicalUsageOwner?: {
      workspaceId: string;
      sessionId: string;
      turnId: string;
    };
  };
}

export interface GatewayEventResult {
  accepted: boolean;
  deduped: boolean;
  session: SessionMeta;
  transcriptOffset: number;
}

export interface SessionSummary {
  session: SessionMeta;
  transcriptEventCount: number;
  latestEventAt?: string;
  latestEventType?: string;
  lastMessagePreview?: string;
  countsByType: Record<string, number>;
}

export interface SessionTimelineItem {
  eventId: string;
  timestamp: string;
  type: TranscriptEvent["type"];
  actorType: TranscriptEvent["actorType"];
  actorId: string;
  preview: string;
  payload: Record<string, unknown>;
  tokenInput?: number;
  tokenOutput?: number;
  costUsd?: number;
}
