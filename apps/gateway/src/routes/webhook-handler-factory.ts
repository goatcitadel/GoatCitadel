import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChannelActivityInput, ChannelActivityResult } from "@goatcitadel/contracts";
import type { ChatCommandOptions } from "../services/chat-command-service.js";

export const CHANNEL_INBOUND_MAX_BYTES = 256 * 1024;

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

export async function dispatchInboundWebhookMessage(
  integrationWebhooks: IntegrationWebhookRouteLike,
  options: {
    channel: string;
    connectionId: string;
    idempotencyKey: string;
    eventType: string;
    bindingTarget?: string;
    message: IngestChannelMessageInput;
    responseOptions?: {
      deliveryReplyToMessageId?: string;
      channelSystemInstruction?: string;
    };
  },
) {
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
