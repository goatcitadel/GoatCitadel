import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  evaluateChannelInboundAccess,
  type ChannelActivityInput,
  type ChannelActivityResult,
} from "@goatcitadel/contracts";
import type { ChatCommandOptions } from "../services/chat-command-service.js";
import type {
  ChannelVoiceInboundRequest,
  ChannelVoiceTranscriptionResult,
} from "../services/channel-voice-inbound-service.js";
import { ChannelBotLoopGuard, type BotLoopGuardConfig } from "../services/channel-bot-loop-guard.js";

export const CHANNEL_INBOUND_MAX_BYTES = 256 * 1024;

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
 * Process-wide guard shared by every inbound webhook dispatch so its in-memory
 * rate buckets accumulate across the five provider routes. Tests may pass their
 * own guard to dispatchInboundWebhookMessage.
 */
const sharedInboundBotLoopGuard = new ChannelBotLoopGuard(DEFAULT_INBOUND_BOT_LOOP_GUARD_CONFIG);

export function getInboundBotLoopGuard(): ChannelBotLoopGuard {
  return sharedInboundBotLoopGuard;
}

const connectionParamsSchema = z.object({
  connectionId: z.string().uuid(),
});

export type WebhookRawBodyRequest = {
  nextcloudTalkRawBody?: Buffer;
  slackRawBody?: Buffer;
  telegramRawBody?: Buffer;
  whatsappRawBody?: Buffer;
  lineRawBody?: Buffer;
  genericChannelRawBody?: Buffer;
};

type RawBodyKey = keyof WebhookRawBodyRequest;

type IntegrationConnectionRecord = {
  connectionId?: string;
  key: string;
  label?: string;
  enabled?: boolean;
  status?: "connected" | "disconnected" | "error" | "paused";
  config: Record<string, unknown>;
};

type IngestChannelMessageInput = {
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
  /**
   * channelVoiceInboundV1Enabled gate + channel voice download/transcription.
   * Optional-typed so existing route-level test harnesses keep compiling, but
   * carried as REQUIRED members of the integration-webhook route port
   * (integration-webhook-route-service.ts), so the real gateway composition
   * cannot silently drop them.
   */
  isVoiceInboundEnabled?: () => boolean;
  transcribeChannelVoice?: (input: ChannelVoiceInboundRequest) => Promise<ChannelVoiceTranscriptionResult>;
};

type FastifyWithGateway = {
  services: { integrationWebhooks: IntegrationWebhookRouteLike };
};

type WebhookRequest = FastifyRequest & Partial<WebhookRawBodyRequest>;

type VerificationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
      statusCode?: number;
      logReason?: string;
    };

type WebhookHandlerContext = {
  request: WebhookRequest;
  reply: FastifyReply;
  connectionId: string;
  connection: IntegrationConnectionRecord;
  rawBody: Buffer;
};

type ParsePayloadResult<TParsed> =
  | {
      kind: "dispatch";
      parsed: TParsed;
    }
  | {
      kind: "reply";
      payload: unknown;
    };

export function createWebhookPreParsing(rawBodyKey: RawBodyKey) {
  return async (request: FastifyRequest, _reply: FastifyReply, payload: NodeJS.ReadableStream) => {
    const rawBody = await readPayloadBuffer(payload);
    (request as WebhookRequest)[rawBodyKey] = rawBody;
    return Readable.from(rawBody);
  };
}

export function createWebhookHandler<TParsed>(
  fastify: FastifyWithGateway,
  options: {
    source: "telegram" | "whatsapp" | "slack" | "line" | "nextcloud-talk";
    connectorKey: string;
    connectorLabel: string;
    rawBodyKey: RawBodyKey;
    missingRawBodyError: string;
    verifySignature: (context: WebhookHandlerContext) => VerificationResult | Promise<VerificationResult>;
    parsePayload: (
      context: WebhookHandlerContext,
    ) => ParsePayloadResult<TParsed> | Promise<ParsePayloadResult<TParsed>>;
    dispatch: (context: WebhookHandlerContext & { parsed: TParsed }) => Promise<unknown>;
  },
) {
  return async (request: WebhookRequest, reply: FastifyReply) => {
    if (rejectOversizedWebhookPayload(request, reply)) {
      return;
    }
    const hostHeaderError = validateWebhookHostHeader(request);
    if (hostHeaderError) {
      return reply.code(400).send({ error: hostHeaderError });
    }

    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }

    let connection: IntegrationConnectionRecord;
    try {
      connection = fastify.services.integrationWebhooks.getIntegrationConnection(params.data.connectionId);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
    if (connection.key !== options.connectorKey) {
      return reply.code(400).send({ error: `Integration connection is not a ${options.connectorLabel} connector` });
    }

    // A disabled or disconnected connection must not ingest inbound traffic.
    // The platform webhook subscription is independent of the local enabled
    // flag, so without this guard "disable" is not an effective inbound kill
    // switch. Reply 200-ignored (rather than a non-2xx) so providers such as
    // Slack/Meta do not auto-disable the subscription on repeated failures.
    if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
      return reply.send(createIgnoredWebhookReply(undefined, "connection_disabled"));
    }

    const rawBody = request[options.rawBodyKey];
    if (!rawBody) {
      return reply.code(400).send({ error: options.missingRawBodyError });
    }

    const context: WebhookHandlerContext = {
      request,
      reply,
      connectionId: params.data.connectionId,
      connection,
      rawBody,
    };

    const verification = await options.verifySignature(context);
    if (!verification.ok) {
      if (verification.logReason) {
        logWebhookVerificationFailure(request, options.source, params.data.connectionId, verification.logReason);
      }
      return reply.code(verification.statusCode ?? 401).send({ error: verification.error });
    }

    const parsed = await options.parsePayload(context);
    if (parsed.kind === "reply") {
      return reply.send(parsed.payload);
    }

    const response = await options.dispatch({
      ...context,
      parsed: parsed.parsed,
    });
    return reply.send(response);
  };
}

export function validateWebhookHostHeader(request: Pick<FastifyRequest, "headers">): string | undefined {
  const host = readHeaderValue(request.headers.host);
  if (!host) {
    return undefined;
  }
  const trimmed = host.trim();
  if (trimmed !== host || /[\s/@\\]/u.test(trimmed)) {
    return "Malformed Host header";
  }
  try {
    new URL(`http://${trimmed}`);
    return undefined;
  } catch {
    return "Malformed Host header";
  }
}

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
  loopGuard: ChannelBotLoopGuard = sharedInboundBotLoopGuard,
) {
  const gate = evaluateInboundWebhookAccess(integrationWebhooks, options);
  if (!gate.allowed) {
    return gate.response;
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

/**
 * Ingest framing for transcribed inbound voice. The prefix marks the text as
 * spoofable auto-transcription: it is NEVER eligible for channel command
 * parsing or approval-token resolution (commands require typed text), and the
 * model-facing turn carries the untrusted provenance inline.
 */
export const VOICE_TRANSCRIPT_CONTENT_PREFIX = "[voice transcript — untrusted, auto-transcribed]";

export type InboundVoiceDispatchOptions = InboundWebhookDispatchOptions & {
  voice: {
    /** Downloads + transcribes the referenced media. Only invoked AFTER the sender trust gate passes. */
    transcribe: () => Promise<ChannelVoiceTranscriptionResult>;
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
 * 2. The webhook is acked immediately; download/transcription/ingest run async.
 * 3. The transcript is framed with VOICE_TRANSCRIPT_CONTENT_PREFIX and flows
 *    through the same dispatchInboundWebhookMessage policy path as text ingest.
 * 4. On transcription failure the placeholder content is ingested instead.
 */
export async function dispatchInboundVoiceWebhookMessage(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: InboundVoiceDispatchOptions,
  loopGuard: ChannelBotLoopGuard = sharedInboundBotLoopGuard,
) {
  const gate = evaluateInboundWebhookAccess(integrationWebhooks, options);
  if (!gate.allowed) {
    return gate.response;
  }
  void runInboundVoiceIngestTask(integrationWebhooks, options, loopGuard);
  return {
    accepted: true,
    replied: false,
    queued: true as const,
    transcription: "pending" as const,
    eventType: options.eventType,
  };
}

async function runInboundVoiceIngestTask(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: InboundVoiceDispatchOptions,
  loopGuard: ChannelBotLoopGuard,
): Promise<void> {
  const { voice, ...dispatchOptions } = options;
  let content = voice.fallbackContent;
  try {
    const result = await voice.transcribe();
    if (result.ok) {
      content = `${VOICE_TRANSCRIPT_CONTENT_PREFIX} ${result.transcript}`;
    } else {
      integrationWebhooks.recordDevDiagnostic?.({
        level: "warn",
        category: "channels",
        event: "channel.voice_transcription_failed",
        message: "Inbound channel voice transcription failed; ingesting the placeholder content instead.",
        context: {
          channel: options.channel,
          connectionId: options.connectionId,
          actorId: options.message.actorId,
          eventId: options.message.eventId,
          reason: result.reason,
          detail: result.detail,
        },
      });
    }
  } catch (error) {
    integrationWebhooks.recordDevDiagnostic?.({
      level: "warn",
      category: "channels",
      event: "channel.voice_transcription_failed",
      message: "Inbound channel voice transcription threw; ingesting the placeholder content instead.",
      context: {
        channel: options.channel,
        connectionId: options.connectionId,
        actorId: options.message.actorId,
        eventId: options.message.eventId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  try {
    await dispatchInboundWebhookMessage(
      integrationWebhooks,
      {
        ...dispatchOptions,
        message: {
          ...dispatchOptions.message,
          content,
        },
      },
      loopGuard,
    );
  } catch (error) {
    integrationWebhooks.recordDevDiagnostic?.({
      level: "error",
      category: "channels",
      event: "channel.voice_inbound_dispatch_failed",
      message: "Inbound channel voice ingest failed after the webhook was already acked.",
      context: {
        channel: options.channel,
        connectionId: options.connectionId,
        actorId: options.message.actorId,
        eventId: options.message.eventId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
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

export function createIgnoredWebhookReply(eventType: string | undefined, reason: string) {
  return {
    accepted: true,
    ignored: true,
    eventType,
    reason,
  };
}

export function parseContentLength(value: string | string[] | undefined): number | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readQueryString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function rejectOversizedWebhookPayload(request: FastifyRequest, reply: FastifyReply): boolean {
  const contentLength = parseContentLength(request.headers["content-length"]);
  if (contentLength === undefined || contentLength <= CHANNEL_INBOUND_MAX_BYTES) {
    return false;
  }
  void reply.code(413).send({
    error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
  });
  return true;
}

async function readPayloadBuffer(payload: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of payload) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > CHANNEL_INBOUND_MAX_BYTES) {
      throw new Error(`Inbound channel payload exceeded ${CHANNEL_INBOUND_MAX_BYTES} bytes during streaming read.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function logWebhookVerificationFailure(
  request: { log: { warn: (...args: unknown[]) => void } },
  channel: "whatsapp" | "slack" | "line" | "nextcloud-talk" | "telegram",
  connectionId: string,
  reason: string,
): void {
  request.log.warn(
    {
      channel,
      connectionId,
      reason,
    },
    "Rejected inbound webhook because verification failed.",
  );
}
