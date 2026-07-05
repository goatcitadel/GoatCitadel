import {
  evaluateChannelInboundAccess,
  type ChannelActivityInput,
  type ChannelActivityResult,
} from "@goatcitadel/contracts";
import type { ChatCommandOptions } from "./chat-command-service.js";
import { ChannelBotLoopGuard, type BotLoopGuardConfig } from "./channel-bot-loop-guard.js";

/**
 * Shared inbound-channel dispatch seam.
 *
 * Extracted from routes/webhook-handler-factory.ts so non-webhook inbound
 * transports (e.g. the Signal bridge poller) can dispatch through the EXACT
 * same trust gate — default-deny sender allowlist, bot-loop guard, and ingest
 * idempotency — without a services→routes import. The webhook handler factory
 * re-exports everything here, so webhook route modules are unchanged.
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
 * Process-wide guard shared by every inbound channel dispatch so its in-memory
 * rate buckets accumulate across the provider routes and the Signal poller.
 * Tests may pass their own guard to dispatchInboundWebhookMessage.
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
};

export async function dispatchInboundWebhookMessage(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: {
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
  },
  loopGuard: ChannelBotLoopGuard = sharedInboundBotLoopGuard,
) {
  // Sender trust gate. Unlike the bot-loop guard, this runs before
  // ingest/binding: a sender that fails the active trust posture must never
  // open or bind a session, nor dispatch a turn.
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
      accepted: true,
      replied: false,
      ignored: true as const,
      reason: inboundAccess.reason,
      eventType: options.eventType,
      inboundAccess: {
        mode: inboundAccess.mode,
        reason: inboundAccess.reason,
      },
    };
  }

  const ingestResult = await integrationWebhooks.ingestChannelMessage(
    options.channel,
    options.idempotencyKey,
    options.message,
  );
  integrationWebhooks.setChatSessionBinding({
    sessionId: ingestResult.session.sessionId,
    transport: "integration",
    connectionId: options.connectionId,
    target: options.bindingTarget,
    writable: true,
  });

  let responseTurnId: string | undefined;
  if (!ingestResult.deduped) {
    // Bot-loop rate cap: a runaway self/bot reply loop repeatedly hits the same
    // (actor, connection, conversation) bucket. Once the cap is exceeded the
    // guard suppresses the reply for the cooldown window. The session binding
    // and ingest above are preserved so the inbound message is still recorded.
    const guardDecision = loopGuard.decide({
      scope: options.connectionId,
      conversation: options.message.room ?? options.message.peer ?? options.message.account,
      participantA: options.message.actorId,
      participantB: options.connectionId,
    });
    if (guardDecision.action === "suppress") {
      integrationWebhooks.recordDevDiagnostic?.({
        level: "warn",
        category: "channels",
        event: "channel.bot_loop_suppressed",
        message: "Suppressed an inbound channel reply because the bot-loop rate cap was reached.",
        context: {
          channel: options.channel,
          connectionId: options.connectionId,
          actorId: options.message.actorId,
          sessionId: ingestResult.session.sessionId,
          reason: guardDecision.reason,
          cooldownExpiresAt: guardDecision.cooldownExpiresAt,
        },
      });
      return {
        accepted: true,
        deduped: ingestResult.deduped,
        replied: false,
        suppressed: true as const,
        suppressedReason: guardDecision.reason,
        sessionId: ingestResult.session.sessionId,
        turnId: undefined,
        eventType: options.eventType,
      };
    }
    await emitInboundWebhookActivity(integrationWebhooks, options, ingestResult.session.sessionId, "seen");
    try {
      await emitInboundWebhookActivity(integrationWebhooks, options, ingestResult.session.sessionId, "thinking");
      const response = options.responseOptions
        ? await integrationWebhooks.respondToExistingChatMessage(
            ingestResult.session.sessionId,
            options.message.eventId,
            options.responseOptions,
          )
        : await integrationWebhooks.respondToExistingChatMessage(
            ingestResult.session.sessionId,
            options.message.eventId,
          );
      responseTurnId = response.turnId;
      await emitInboundWebhookActivity(
        integrationWebhooks,
        options,
        ingestResult.session.sessionId,
        response.trace?.status === "waiting_for_approval" ? "waiting_approval" : "clear",
        responseTurnId,
      );
    } catch (error) {
      await emitInboundWebhookActivity(
        integrationWebhooks,
        options,
        ingestResult.session.sessionId,
        "failed",
        responseTurnId,
      );
      throw error;
    }
  }

  return {
    accepted: true,
    deduped: ingestResult.deduped,
    replied: !ingestResult.deduped,
    sessionId: ingestResult.session.sessionId,
    turnId: responseTurnId,
    eventType: options.eventType,
  };
}

async function emitInboundWebhookActivity(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: {
    channel: string;
    connectionId: string;
    idempotencyKey: string;
    bindingTarget?: string;
    message: IngestChannelMessageInput;
  },
  sessionId: string,
  phase: ChannelActivityInput["phase"],
  turnId?: string,
): Promise<void> {
  const target = options.bindingTarget ?? options.message.room ?? options.message.peer ?? options.message.account;
  if (!target?.trim()) {
    return;
  }
  try {
    await integrationWebhooks.emitChannelActivity({
      connectionId: options.connectionId,
      target,
      messageId: options.message.eventId,
      threadId: options.message.threadId,
      sessionId,
      turnId,
      phase,
      correlationId: options.idempotencyKey,
    });
  } catch (error) {
    integrationWebhooks.recordDevDiagnostic?.({
      level: "warn",
      category: "channels",
      event: "channel.activity_failed",
      message: "Channel activity signal failed and the inbound reply flow continued.",
      context: {
        channel: options.channel,
        connectionId: options.connectionId,
        phase,
        sessionId,
        messageId: options.message.eventId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
