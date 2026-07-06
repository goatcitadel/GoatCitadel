import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { IntegrationConnectionRecord, IntegrationWebhookRouteLike } from "../services/channel-inbound-dispatch.js";

// The inbound dispatch seam (trust gate + bot-loop guard + ingest idempotency)
// lives in services/channel-inbound-dispatch.ts so non-webhook transports
// (e.g. the Signal bridge poller) can share it. Re-exported here so webhook
// route modules keep importing from this factory unchanged.
export {
  DEFAULT_INBOUND_BOT_LOOP_GUARD_CONFIG,
  dispatchInboundWebhookMessage,
  getInboundBotLoopGuard,
} from "../services/channel-inbound-dispatch.js";
export type {
  IngestChannelMessageInput,
  IntegrationConnectionRecord,
  IntegrationWebhookRouteLike,
} from "../services/channel-inbound-dispatch.js";

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
