import {
  evaluateChannelInboundAccess,
  type ChannelActivityInput,
  type ChannelActivityResult,
} from "@goatcitadel/contracts";
import type { ChatCommandOptions } from "./chat-command-service.js";
import type { ChannelVoiceInboundRequest, ChannelVoiceTranscriptionResult } from "./channel-voice-inbound-service.js";
import { ChannelBotLoopGuard, type BotLoopGuardConfig } from "./channel-bot-loop-guard.js";

/**
 * Shared inbound-channel dispatch seam.
 *
 * Extracted from routes/webhook-handler-factory.ts so webhook and gateway
 * transports can dispatch through the same sender trust gate and durable
 * acceptance contract without a services→routes import. The recoverable
 * worker owns ingest, persistent per-event bot-loop decisions, turn admission,
 * and reply settlement.
 */

/**
 * Default rate-cap/cooldown for the inbound bot-loop guard. Values follow the
 * channel-bot-loop-guard spec: at most 20 inbound replies per (actor,
 * connection, conversation) per 60s, then a 60s cooldown. This caps a runaway
 * self/bot reply loop without affecting ordinary human chat bursts.
 */
export const DEFAULT_INBOUND_BOT_LOOP_GUARD_CONFIG: BotLoopGuardConfig = {
  maxEventsPerWindow: 20,
  windowSeconds: 60,
  cooldownSeconds: 60,
  enabled: true,
};

/**
 * Process-wide rate evaluator used by the durable worker. Each event's outcome
 * is claim-fenced and persisted before execution, so a retry or restart never
 * charges the same event twice even though aggregate rate buckets are local to
 * the current Gateway process.
 */
const sharedInboundBotLoopGuard = new ChannelBotLoopGuard(DEFAULT_INBOUND_BOT_LOOP_GUARD_CONFIG);

export function getInboundBotLoopGuard(): ChannelBotLoopGuard {
  return sharedInboundBotLoopGuard;
}

export type IntegrationConnectionRecord = {
  connectionId?: string;
  key: string;
  label?: string;
  enabled?: boolean;
  status?: "connected" | "disconnected" | "error" | "paused";
  config: Record<string, unknown>;
};

export type IngestChannelMessageInput = {
  eventId: string;
  account: string;
  peer?: string;
  room?: string;
  threadId?: string;
  actorId: string;
  actorType?: "user" | "agent" | "system";
  displayName?: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type IntegrationWebhookRouteLike = {
  getIntegrationConnection(connectionId: string): IntegrationConnectionRecord;
  cancelLatestActiveChatTurnForSession: (
    sessionId: string,
    cancelledBy?: string,
  ) => Promise<{
    status: "cancelled" | "no_active_run" | "failed";
    sessionId?: string;
    turnId?: string;
    durableRunId?: string;
    durableCancelled?: boolean;
    error?: string;
  }>;
  ingestChannelMessage: (
    channel: string,
    idempotencyKey: string,
    message: IngestChannelMessageInput,
  ) => Promise<{
    deduped: boolean;
    session: {
      sessionId: string;
    };
  }>;
  setChatSessionBinding: (binding: {
    sessionId: string;
    transport: "integration";
    connectionId: string;
    target?: string;
    writable: boolean;
  }) => void;
  respondToExistingChatMessage: (
    sessionId: string,
    eventId: string,
    options?: {
      deliveryReplyToMessageId?: string;
      channelSystemInstruction?: string;
    },
  ) => Promise<{
    turnId?: string;
    trace?: {
      status?: string;
    };
  }>;
  resolveApprovalWithRemoteTokenId: (input: {
    tokenId: string;
    connectorId: string;
    decision: "approve" | "reject";
    resolvedBy?: string;
  }) => Promise<{
    approval: {
      approvalId: string;
      status: string;
    };
  }>;
  resolveApprovalWithRemoteToken: (input: {
    token: string;
    connectorId: string;
    decision: "approve" | "reject";
    resolvedBy?: string;
  }) => Promise<{
    approval: {
      approvalId: string;
      status: string;
    };
  }>;
  hasRunningTurn: (sessionId: string) => boolean;
  parseChatCommand: (
    sessionId: string,
    commandText: string,
    options?: ChatCommandOptions,
  ) => Promise<{
    message: string;
  }>;
  emitChannelActivity: (input: ChannelActivityInput) => Promise<ChannelActivityResult>;
  recordDevDiagnostic?: (input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }) => void;
  updateIntegrationConnection: (
    connectionId: string,
    patch: {
      config?: Record<string, unknown>;
      lastSyncAt?: string;
      lastError?: string | null;
    },
  ) => IntegrationConnectionRecord;
  /**
   * channelVoiceInboundV1Enabled gate + channel voice download/transcription.
   * Optional-typed so existing route-level test harnesses keep compiling, but
   * carried as REQUIRED members of the integration-webhook route port
   * (integration-webhook-route-service.ts), so the real gateway composition
   * cannot silently drop them.
   */
  isVoiceInboundEnabled?: () => boolean;
  transcribeChannelVoice?: (input: ChannelVoiceInboundRequest) => Promise<ChannelVoiceTranscriptionResult>;
  /**
   * Canonical production ingress owner. When present, provider callbacks return
   * after this method commits a bounded durable envelope; model execution and
   * outbound reply delivery happen in the recoverable worker.
   */
  acceptInboundChannelEvent?: (input: DurableInboundChannelAcceptInput) => Promise<DurableInboundChannelAcceptResult>;
  /** Atomically commits every accepted event from one provider callback. */
  acceptInboundChannelEvents?: (
    inputs: readonly DurableInboundChannelAcceptInput[],
  ) => Promise<DurableInboundChannelAcceptResult[]>;
  awaitInboundChannelCommandResult?: (eventId: string) => Promise<DurableInboundChannelCommandResult>;
  findRemoteActionTokenId?: (token: string) => string | undefined;
};

export type InboundWebhookDispatchOptions = {
  channel: string;
  connectionId: string;
  idempotencyKey: string;
  eventType: string;
  bindingTarget?: string;
  /**
   * Per-connection inbound trust config. New connections should set
   * inboundAccessMode: "allowlist"; old configs without the field stay
   * legacy-open and produce a migration diagnostic.
   */
  inboundAccessConfig?: Record<string, unknown>;
  allowedSenders?: readonly string[];
  message: IngestChannelMessageInput;
  responseOptions?: {
    deliveryReplyToMessageId?: string;
    channelSystemInstruction?: string;
  };
};

export type DurableInboundChannelAcceptInput = InboundWebhookDispatchOptions & {
  dispatchKind: "agent_turn" | "voice_agent_turn" | "record_only" | "command";
  voiceRequest?: ChannelVoiceInboundRequest;
  voiceFallbackContent?: string;
};

export type DurableInboundChannelAcceptResult = {
  accepted: true;
  durableAccepted: true;
  deduped: boolean;
  replied: false;
  queued: boolean;
  eventType: string;
  inboundEventId: string;
  commandResultText?: string;
};

export type DurableInboundChannelCommandResult =
  | { status: "completed"; resultText: string }
  | { status: "manual_reconciliation_required" | "failed"; message: string };

export async function dispatchInboundWebhookCommand(
  integrationWebhooks: IntegrationWebhookRouteLike,
  input: InboundWebhookDispatchOptions,
): Promise<{
  acceptance: DurableInboundChannelAcceptResult;
  result: DurableInboundChannelCommandResult;
}> {
  const gate = evaluateInboundWebhookAccess(integrationWebhooks, input);
  if (!gate.allowed) {
    throw new Error(`Inbound command was denied by sender policy: ${gate.response.reason}`);
  }
  const acceptInbound = integrationWebhooks.acceptInboundChannelEvent;
  const awaitResult = integrationWebhooks.awaitInboundChannelCommandResult;
  if (!acceptInbound || !awaitResult) {
    throw new Error("Durable inbound command acceptance is unavailable.");
  }
  const { inboundAccessConfig: _inboundAccessConfig, allowedSenders: _allowedSenders, ...secretFreeInput } = input;
  const acceptance = await acceptInbound({ ...secretFreeInput, dispatchKind: "command" });
  const result = acceptance.commandResultText
    ? { status: "completed" as const, resultText: acceptance.commandResultText }
    : await awaitResult(acceptance.inboundEventId);
  return { acceptance, result };
}

/**
 * Commit a provider webhook batch before its HTTP acknowledgement is emitted.
 * Sender policy is evaluated per event before the single atomic acceptance
 * call. A missing batch owner fails closed so callbacks are retried instead of
 * acknowledging only a prefix of the provider batch.
 */
export async function dispatchInboundWebhookBatch(
  integrationWebhooks: IntegrationWebhookRouteLike,
  inputs: readonly DurableInboundChannelAcceptInput[],
) {
  const allowed: DurableInboundChannelAcceptInput[] = [];
  const ignoredByIndex = new Map<number, ReturnType<typeof evaluateInboundWebhookAccess> & { allowed: false }>();

  inputs.forEach((input, index) => {
    const gate = evaluateInboundWebhookAccess(integrationWebhooks, input);
    if (gate.allowed) {
      // Access has already been decided. Do not carry connector credentials or
      // other connection config across the durable acceptance boundary.
      const { inboundAccessConfig: _inboundAccessConfig, allowedSenders: _allowedSenders, ...secretFreeInput } = input;
      allowed.push(secretFreeInput);
    } else {
      ignoredByIndex.set(index, gate);
    }
  });

  let accepted: DurableInboundChannelAcceptResult[] = [];
  if (allowed.length > 0) {
    const acceptBatch = integrationWebhooks.acceptInboundChannelEvents;
    if (!acceptBatch) {
      throw new Error("Durable inbound channel batch acceptance is unavailable.");
    }
    accepted = await acceptBatch(allowed);
    if (accepted.length !== allowed.length) {
      throw new Error(
        `Durable inbound channel batch acceptance returned ${accepted.length} results for ${allowed.length} events.`,
      );
    }
  }

  let acceptedIndex = 0;
  const events = inputs.map((input, index) => {
    const ignored = ignoredByIndex.get(index);
    if (ignored) {
      return {
        providerEventId: input.message.eventId,
        ...ignored.response,
      };
    }
    const result = accepted[acceptedIndex++];
    if (!result) {
      throw new Error(`Missing durable acceptance result for inbound event ${input.message.eventId}.`);
    }
    return {
      providerEventId: input.message.eventId,
      ...result,
    };
  });

  return {
    accepted: true as const,
    durableAccepted: accepted.length > 0,
    batch: true as const,
    eventCount: inputs.length,
    acceptedCount: accepted.length,
    ignoredCount: ignoredByIndex.size,
    dedupedCount: accepted.filter((result) => result.deduped).length,
    events,
  };
}

/**
 * Sender trust gate. Unlike the bot-loop guard, this runs before
 * ingest/binding: a sender that fails the active trust posture must never
 * open or bind a session, dispatch a turn — or, on the voice path, trigger a
 * media download or transcription subprocess.
 */
function evaluateInboundWebhookAccess(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: InboundWebhookDispatchOptions,
) {
  const inboundAccess = evaluateChannelInboundAccess({
    config: options.inboundAccessConfig,
    actorId: options.message.actorId,
    allowedSenders: options.allowedSenders,
  });
  if (inboundAccess.legacyWarning) {
    integrationWebhooks.recordDevDiagnostic?.({
      level: "warn",
      category: "channels",
      event: "channel.inbound_access_legacy_open",
      message: inboundAccess.legacyWarning,
      context: {
        channel: options.channel,
        connectionId: options.connectionId,
        actorId: options.message.actorId,
        eventType: options.eventType,
        mode: inboundAccess.mode,
        reason: inboundAccess.reason,
      },
    });
  }
  if (!inboundAccess.allowed) {
    const hasEmptyAllowlist = inboundAccess.reason === "allowlist_empty";
    const hasInvalidConfig = inboundAccess.reason === "invalid_config";
    integrationWebhooks.recordDevDiagnostic?.({
      level: "warn",
      category: "channels",
      event: hasEmptyAllowlist
        ? "channel.inbound_allowlist_empty"
        : hasInvalidConfig
          ? "channel.inbound_access_invalid_config"
          : "channel.sender_not_allowlisted",
      message: hasEmptyAllowlist
        ? "Dropped an inbound channel message because allowlist mode is enabled with no permitted senders."
        : hasInvalidConfig
          ? "Dropped an inbound channel message because its inbound access config is malformed."
          : "Dropped an inbound channel message because the sender is not on the connection allowlist.",
      context: {
        channel: options.channel,
        connectionId: options.connectionId,
        actorId: options.message.actorId,
        eventType: options.eventType,
        mode: inboundAccess.mode,
        reason: inboundAccess.reason,
        allowedSenderCount: inboundAccess.allowedSenders.length,
      },
    });
    return {
      allowed: false as const,
      response: {
        accepted: true,
        replied: false,
        ignored: true as const,
        reason: inboundAccess.reason,
        eventType: options.eventType,
        inboundAccess: {
          mode: inboundAccess.mode,
          reason: inboundAccess.reason,
        },
      },
    };
  }
  return { allowed: true as const };
}

export async function dispatchInboundWebhookMessage(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: InboundWebhookDispatchOptions,
) {
  const gate = evaluateInboundWebhookAccess(integrationWebhooks, options);
  if (!gate.allowed) {
    return gate.response;
  }

  const acceptInbound = integrationWebhooks.acceptInboundChannelEvent;
  if (!acceptInbound) {
    throw new Error("Durable inbound channel acceptance is unavailable for message events.");
  }
  const { inboundAccessConfig: _inboundAccessConfig, allowedSenders: _allowedSenders, ...secretFreeOptions } = options;
  return acceptInbound({
    ...secretFreeOptions,
    dispatchKind: "agent_turn",
  });
}

/**
 * Ingest framing for transcribed inbound voice. The prefix marks the text as
 * spoofable auto-transcription: it is NEVER eligible for channel command
 * parsing or approval-token resolution (commands require typed text), and the
 * model-facing turn carries the untrusted provenance inline.
 */
export const VOICE_TRANSCRIPT_CONTENT_PREFIX = "[voice transcript — untrusted, auto-transcribed]";

export type InboundVoiceDispatchOptions = InboundWebhookDispatchOptions & {
  voice: {
    /** Secret-free provider media reference persisted by the durable ingress owner. */
    request: ChannelVoiceInboundRequest;
    /** Ingested instead of a transcript when transcription fails — the message is never silently dropped. */
    fallbackContent: string;
  };
};

/**
 * Voice variant of dispatchInboundWebhookMessage (channelVoiceInboundV1Enabled).
 *
 * Ordering is governance-critical:
 * 1. The sender trust gate runs FIRST — a non-allowlisted sender never triggers
 *    a media download or a transcription subprocess.
 * 2. The bounded secret-free media reference is durably accepted before ACK.
 * 3. Download/transcription/ingest run only from the recoverable worker.
 * 4. A missing durable owner fails closed so the provider can retry.
 */
export async function dispatchInboundVoiceWebhookMessage(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: InboundVoiceDispatchOptions,
) {
  const gate = evaluateInboundWebhookAccess(integrationWebhooks, options);
  if (!gate.allowed) {
    return gate.response;
  }
  const acceptInbound = integrationWebhooks.acceptInboundChannelEvent;
  if (!acceptInbound) {
    throw new Error("Durable inbound channel acceptance is unavailable for voice events.");
  }
  const {
    voice,
    inboundAccessConfig: _inboundAccessConfig,
    allowedSenders: _allowedSenders,
    ...dispatchOptions
  } = options;
  return acceptInbound({
    ...dispatchOptions,
    dispatchKind: "voice_agent_turn",
    voiceRequest: voice.request,
    voiceFallbackContent: voice.fallbackContent,
  });
}
