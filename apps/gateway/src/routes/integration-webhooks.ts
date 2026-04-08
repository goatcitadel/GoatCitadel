import { Readable } from "node:stream";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  deriveLineWebhookIdempotencyKey,
  normalizeLineWebhookPayload,
  verifyLineWebhookSignature,
} from "../services/line-webhook.js";
import {
  deriveNextcloudTalkWebhookIdempotencyKey,
  normalizeNextcloudTalkWebhookPayload,
  verifyNextcloudTalkSignature,
} from "../services/nextcloud-talk-webhook.js";
import {
  deriveSlackWebhookIdempotencyKey,
  normalizeSlackWebhookPayload,
  verifySlackSignature,
} from "../services/slack-webhook.js";
import {
  deriveTelegramWebhookIdempotencyKey,
  normalizeTelegramWebhookPayload,
  verifyTelegramWebhookSecretToken,
} from "../services/telegram-webhook.js";
import {
  deriveWhatsAppWebhookIdempotencyKey,
  normalizeWhatsAppWebhookPayload,
  verifyWhatsAppWebhookSignature,
} from "../services/whatsapp-webhook.js";

const CHANNEL_INBOUND_MAX_BYTES = 256 * 1024;
const CHANNEL_INBOUND_MAX_CONTENT_CHARS = 20_000;

const connectionParamsSchema = z.object({
  connectionId: z.string().uuid(),
});

const channelParamsSchema = z.object({
  channel: z.string().min(1),
});

const channelInboundSchema = z.object({
  eventId: z.string().optional(),
  account: z.string().min(1),
  peer: z.string().optional(),
  room: z.string().optional(),
  threadId: z.string().optional(),
  actorId: z.string().min(1),
  actorType: z.enum(["user", "agent", "system"]).optional(),
  role: z.enum(["user", "assistant"]).optional(),
  content: z.string().min(1).max(CHANNEL_INBOUND_MAX_CONTENT_CHARS),
  displayName: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

type WebhookRawBodyRequest = {
  nextcloudTalkRawBody?: Buffer;
  slackRawBody?: Buffer;
  telegramRawBody?: Buffer;
  whatsappRawBody?: Buffer;
  lineRawBody?: Buffer;
};

export const integrationWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/api/v1/channels/:channel/inbound",
    { bodyLimit: CHANNEL_INBOUND_MAX_BYTES },
    async (request, reply) => {
      const contentLength = parseContentLength(request.headers["content-length"]);
      if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
        return reply.code(413).send({
          error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
        });
      }

      const params = channelParamsSchema.safeParse(request.params);
      const parsed = channelInboundSchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: parsed.success ? undefined : parsed.error.flatten(),
          },
        });
      }

      try {
        const result = await fastify.gateway.ingestChannelMessage(
          params.data.channel,
          request.idempotencyKey,
          parsed.data,
        );
        return reply.send(result);
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/telegram/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: async (request, _reply, payload) => {
        const rawBody = await readPayloadBuffer(payload);
        (request as typeof request & WebhookRawBodyRequest).telegramRawBody = rawBody;
        return Readable.from(rawBody);
      },
    },
    async (request, reply) => {
      const contentLength = parseContentLength(request.headers["content-length"]);
      if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
        return reply.code(413).send({
          error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
        });
      }

      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection;
      try {
        connection = fastify.gateway.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      if (connection.key !== "telegram") {
        return reply.code(400).send({ error: "Integration connection is not a Telegram connector" });
      }

      const rawBody = (request as typeof request & WebhookRawBodyRequest).telegramRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing Telegram raw request body" });
      }

      const webhookSecret = resolveTelegramWebhookSecret(connection.config);
      if (!webhookSecret) {
        return reply.code(400).send({ error: "Telegram connection is missing a webhook secret" });
      }

      const secretTokenHeader = readHeaderValue(request.headers["x-telegram-bot-api-secret-token"]);
      if (!verifyTelegramWebhookSecretToken(secretTokenHeader, webhookSecret)) {
        return reply.code(401).send({ error: "Invalid Telegram webhook secret token" });
      }

      const normalized = normalizeTelegramWebhookPayload({
        connectionId: params.data.connectionId,
        payload: request.body,
      });
      if (normalized.kind === "ignore") {
        return reply.send({
          accepted: true,
          ignored: true,
          eventType: normalized.eventType,
          reason: normalized.reason,
        });
      }

      const idempotencyKey = deriveTelegramWebhookIdempotencyKey(params.data.connectionId, request.body, rawBody);
      const ingestResult = await fastify.gateway.ingestChannelMessage("telegram", idempotencyKey, {
        eventId: normalized.eventId,
        account: normalized.account,
        peer: normalized.peer,
        room: normalized.room,
        threadId: normalized.threadId,
        actorId: normalized.actorId,
        actorType: normalized.actorType,
        content: normalized.content,
        metadata: normalized.metadata,
      });
      fastify.gateway.setChatSessionBinding({
        sessionId: ingestResult.session.sessionId,
        transport: "integration",
        connectionId: params.data.connectionId,
        target: normalized.room ?? normalized.peer,
        writable: true,
      });

      let responseTurnId: string | undefined;
      if (!ingestResult.deduped) {
        const response = await fastify.gateway.respondToExistingChatMessage(
          ingestResult.session.sessionId,
          normalized.eventId,
          { deliveryReplyToMessageId: normalized.deliveryReplyToMessageId },
        );
        responseTurnId = response.turnId;
      }

      return reply.send({
        accepted: true,
        deduped: ingestResult.deduped,
        replied: !ingestResult.deduped,
        sessionId: ingestResult.session.sessionId,
        turnId: responseTurnId,
        eventType: normalized.eventType,
      });
    },
  );

  fastify.get("/api/v1/integrations/connections/:connectionId/whatsapp/webhook", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }

    let connection;
    try {
      connection = fastify.gateway.getIntegrationConnection(params.data.connectionId);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
    if (connection.key !== "whatsapp") {
      return reply.code(400).send({ error: "Integration connection is not a WhatsApp connector" });
    }

    const verifyToken = resolveWhatsAppVerifyToken(connection.config);
    if (!verifyToken) {
      return reply.code(400).send({ error: "WhatsApp connection is missing a webhook verify token" });
    }

    const query = request.query as Record<string, unknown>;
    const mode = readQueryString(query, "hub.mode");
    const providedVerifyToken = readQueryString(query, "hub.verify_token");
    const challenge = readQueryString(query, "hub.challenge");
    if (mode !== "subscribe" || !challenge) {
      return reply.code(400).send({ error: "Invalid WhatsApp webhook verification query" });
    }
    if (providedVerifyToken !== verifyToken) {
      return reply.code(401).send({ error: "Invalid WhatsApp webhook verify token" });
    }

    return reply.type("text/plain").send(challenge);
  });

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/whatsapp/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: async (request, _reply, payload) => {
        const rawBody = await readPayloadBuffer(payload);
        (request as typeof request & WebhookRawBodyRequest).whatsappRawBody = rawBody;
        return Readable.from(rawBody);
      },
    },
    async (request, reply) => {
      const contentLength = parseContentLength(request.headers["content-length"]);
      if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
        return reply.code(413).send({
          error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
        });
      }

      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection;
      try {
        connection = fastify.gateway.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      if (connection.key !== "whatsapp") {
        return reply.code(400).send({ error: "Integration connection is not a WhatsApp connector" });
      }

      const rawBody = (request as typeof request & WebhookRawBodyRequest).whatsappRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing WhatsApp raw request body" });
      }

      const appSecret = resolveWhatsAppAppSecret(connection.config);
      if (!appSecret) {
        return reply.code(400).send({ error: "WhatsApp connection is missing an app secret" });
      }

      const signatureHeader = readHeaderValue(request.headers["x-hub-signature-256"]);
      if (!verifyWhatsAppWebhookSignature(signatureHeader, rawBody, appSecret)) {
        logWebhookVerificationFailure(request, "whatsapp", params.data.connectionId, "signature_mismatch");
        return reply.code(401).send({ error: "Invalid WhatsApp webhook signature" });
      }

      const normalized = normalizeWhatsAppWebhookPayload({
        connectionId: params.data.connectionId,
        payload: request.body,
      });
      if (normalized.kind === "ignore") {
        return reply.send({
          accepted: true,
          ignored: true,
          eventType: normalized.eventType,
          reason: normalized.reason,
        });
      }

      const idempotencyKey = deriveWhatsAppWebhookIdempotencyKey(params.data.connectionId, request.body, rawBody);
      const ingestResult = await fastify.gateway.ingestChannelMessage("whatsapp", idempotencyKey, {
        eventId: normalized.eventId,
        account: normalized.account,
        peer: normalized.peer,
        actorId: normalized.actorId,
        actorType: normalized.actorType,
        displayName: normalized.displayName,
        content: normalized.content,
        metadata: normalized.metadata,
      });
      fastify.gateway.setChatSessionBinding({
        sessionId: ingestResult.session.sessionId,
        transport: "integration",
        connectionId: params.data.connectionId,
        target: normalized.peer,
        writable: true,
      });

      let responseTurnId: string | undefined;
      if (!ingestResult.deduped) {
        const response = await fastify.gateway.respondToExistingChatMessage(
          ingestResult.session.sessionId,
          normalized.eventId,
          { deliveryReplyToMessageId: normalized.deliveryReplyToMessageId },
        );
        responseTurnId = response.turnId;
      }

      return reply.send({
        accepted: true,
        deduped: ingestResult.deduped,
        replied: !ingestResult.deduped,
        sessionId: ingestResult.session.sessionId,
        turnId: responseTurnId,
        eventType: normalized.eventType,
      });
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/slack/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: async (request, _reply, payload) => {
        const rawBody = await readPayloadBuffer(payload);
        (request as typeof request & WebhookRawBodyRequest).slackRawBody = rawBody;
        return Readable.from(rawBody);
      },
    },
    async (request, reply) => {
      const contentLength = parseContentLength(request.headers["content-length"]);
      if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
        return reply.code(413).send({
          error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
        });
      }

      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection;
      try {
        connection = fastify.gateway.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      if (connection.key !== "slack") {
        return reply.code(400).send({ error: "Integration connection is not a Slack connector" });
      }

      const rawBody = (request as typeof request & WebhookRawBodyRequest).slackRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing Slack raw request body" });
      }

      const signingSecret = readConfigSecret(connection.config, "signingSecret", "signingSecretEnv");
      if (!signingSecret) {
        return reply.code(400).send({ error: "Slack connection is missing a signing secret" });
      }

      const timestampHeader = readHeaderValue(request.headers["x-slack-request-timestamp"]);
      const signatureHeader = readHeaderValue(request.headers["x-slack-signature"]);
      if (
        !verifySlackSignature({
          timestamp: timestampHeader,
          signature: signatureHeader,
          rawBody,
          secret: signingSecret,
        })
      ) {
        logWebhookVerificationFailure(request, "slack", params.data.connectionId, "signature_mismatch");
        return reply.code(401).send({ error: "Invalid Slack webhook signature" });
      }

      const normalized = normalizeSlackWebhookPayload({
        connectionId: params.data.connectionId,
        payload: request.body,
      });
      if (normalized.kind === "challenge") {
        return reply.send({ challenge: normalized.challenge });
      }
      if (normalized.kind === "ignore") {
        return reply.send({
          accepted: true,
          ignored: true,
          eventType: normalized.eventType,
          reason: normalized.reason,
        });
      }

      const idempotencyKey = deriveSlackWebhookIdempotencyKey(params.data.connectionId, request.body, rawBody);
      const ingestResult = await fastify.gateway.ingestChannelMessage("slack", idempotencyKey, {
        eventId: normalized.eventId,
        account: normalized.account,
        peer: normalized.peer,
        room: normalized.room,
        threadId: normalized.threadId,
        actorId: normalized.actorId,
        actorType: normalized.actorType,
        content: normalized.content,
        metadata: normalized.metadata,
      });
      fastify.gateway.setChatSessionBinding({
        sessionId: ingestResult.session.sessionId,
        transport: "integration",
        connectionId: params.data.connectionId,
        target: normalized.room ?? normalized.peer,
        writable: true,
      });

      let responseTurnId: string | undefined;
      if (!ingestResult.deduped) {
        const response = await fastify.gateway.respondToExistingChatMessage(
          ingestResult.session.sessionId,
          normalized.eventId,
          { deliveryReplyToMessageId: normalized.deliveryReplyToMessageId },
        );
        responseTurnId = response.turnId;
      }

      return reply.send({
        accepted: true,
        deduped: ingestResult.deduped,
        replied: !ingestResult.deduped,
        sessionId: ingestResult.session.sessionId,
        turnId: responseTurnId,
        eventType: normalized.eventType,
      });
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/line/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: async (request, _reply, payload) => {
        const rawBody = await readPayloadBuffer(payload);
        (request as typeof request & WebhookRawBodyRequest).lineRawBody = rawBody;
        return Readable.from(rawBody);
      },
    },
    async (request, reply) => {
      const contentLength = parseContentLength(request.headers["content-length"]);
      if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
        return reply.code(413).send({
          error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
        });
      }

      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection;
      try {
        connection = fastify.gateway.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      if (connection.key !== "line") {
        return reply.code(400).send({ error: "Integration connection is not a LINE connector" });
      }

      const rawBody = (request as typeof request & WebhookRawBodyRequest).lineRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing LINE raw request body" });
      }

      const channelSecret = resolveLineChannelSecret(connection.config);
      if (!channelSecret) {
        return reply.code(400).send({ error: "LINE connection is missing a channel secret" });
      }

      const signatureHeader = readHeaderValue(request.headers["x-line-signature"]);
      if (!verifyLineWebhookSignature(signatureHeader, rawBody, channelSecret)) {
        logWebhookVerificationFailure(request, "line", params.data.connectionId, "signature_mismatch");
        return reply.code(401).send({ error: "Invalid LINE webhook signature" });
      }

      const normalized = normalizeLineWebhookPayload({
        connectionId: params.data.connectionId,
        payload: request.body,
      });
      if (normalized.kind === "ignore") {
        return reply.send({
          accepted: true,
          ignored: true,
          eventType: normalized.eventType,
          reason: normalized.reason,
        });
      }

      const idempotencyKey = deriveLineWebhookIdempotencyKey(params.data.connectionId, request.body, rawBody);
      const ingestResult = await fastify.gateway.ingestChannelMessage("line", idempotencyKey, {
        eventId: normalized.eventId,
        account: normalized.account,
        peer: normalized.peer,
        room: normalized.room,
        actorId: normalized.actorId,
        actorType: normalized.actorType,
        content: normalized.content,
        metadata: normalized.metadata,
      });
      fastify.gateway.setChatSessionBinding({
        sessionId: ingestResult.session.sessionId,
        transport: "integration",
        connectionId: params.data.connectionId,
        target: normalized.room ?? normalized.peer,
        writable: true,
      });

      let responseTurnId: string | undefined;
      if (!ingestResult.deduped) {
        const response = await fastify.gateway.respondToExistingChatMessage(
          ingestResult.session.sessionId,
          normalized.eventId,
          { deliveryReplyToMessageId: normalized.deliveryReplyToMessageId },
        );
        responseTurnId = response.turnId;
      }

      return reply.send({
        accepted: true,
        deduped: ingestResult.deduped,
        replied: !ingestResult.deduped,
        sessionId: ingestResult.session.sessionId,
        turnId: responseTurnId,
        eventType: normalized.eventType,
      });
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/nextcloud-talk/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: async (request, _reply, payload) => {
        const rawBody = await readPayloadBuffer(payload);
        (request as typeof request & WebhookRawBodyRequest).nextcloudTalkRawBody = rawBody;
        return Readable.from(rawBody);
      },
    },
    async (request, reply) => {
      const contentLength = parseContentLength(request.headers["content-length"]);
      if (contentLength !== undefined && contentLength > CHANNEL_INBOUND_MAX_BYTES) {
        return reply.code(413).send({
          error: `Inbound channel payload too large. Max ${CHANNEL_INBOUND_MAX_BYTES} bytes.`,
        });
      }

      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }

      let connection;
      try {
        connection = fastify.gateway.getIntegrationConnection(params.data.connectionId);
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
      if (connection.key !== "nextcloud-talk") {
        return reply.code(400).send({ error: "Integration connection is not a Nextcloud Talk connector" });
      }

      const rawBody = (request as typeof request & WebhookRawBodyRequest).nextcloudTalkRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing Nextcloud Talk raw request body" });
      }

      const secret = resolveNextcloudTalkSecret(connection.config);
      if (!secret) {
        return reply.code(400).send({ error: "Nextcloud Talk connection is missing a token/secret" });
      }

      const randomHeader = readHeaderValue(request.headers["x-nextcloud-talk-random"]);
      const signatureHeader = readHeaderValue(request.headers["x-nextcloud-talk-signature"]);
      const backendHeader = readHeaderValue(request.headers["x-nextcloud-talk-backend"]);
      if (!verifyNextcloudTalkSignature(randomHeader, signatureHeader, rawBody, secret)) {
        logWebhookVerificationFailure(request, "nextcloud-talk", params.data.connectionId, "signature_mismatch");
        return reply.code(401).send({ error: "Invalid Nextcloud Talk webhook signature" });
      }

      const normalized = normalizeNextcloudTalkWebhookPayload({
        connectionId: params.data.connectionId,
        payload: request.body,
        backendUrl: backendHeader,
      });
      if (normalized.kind === "ignore") {
        return reply.send({
          accepted: true,
          ignored: true,
          eventType: normalized.eventType,
          reason: normalized.reason,
        });
      }

      if (normalized.kind === "activity") {
        fastify.gateway.recordDevDiagnostic({
          level: "info",
          category: "channels",
          event: "nextcloud-talk.webhook.activity",
          message: `Processed Nextcloud Talk ${normalized.eventType} webhook`,
          context: {
            connectionId: params.data.connectionId,
            eventType: normalized.eventType,
            room: normalized.room,
            actorId: normalized.actorId,
            backendUrl: normalized.backendUrl,
            ...normalized.metadata,
          },
        });
        return reply.send({
          accepted: true,
          handled: true,
          eventType: normalized.eventType,
        });
      }

      const idempotencyKey = deriveNextcloudTalkWebhookIdempotencyKey(params.data.connectionId, rawBody);
      const ingestResult = await fastify.gateway.ingestChannelMessage("nextcloud-talk", idempotencyKey, {
        eventId: normalized.eventId,
        account: normalized.account,
        room: normalized.room,
        actorId: normalized.actorId,
        actorType: normalized.actorType,
        content: normalized.content,
        displayName: normalized.displayName,
        metadata: {
          backendUrl: normalized.backendUrl,
          ...normalized.metadata,
        },
      });
      fastify.gateway.setChatSessionBinding({
        sessionId: ingestResult.session.sessionId,
        transport: "integration",
        connectionId: params.data.connectionId,
        target: normalized.room,
        writable: true,
      });

      let responseTurnId: string | undefined;
      if (!ingestResult.deduped) {
        const response = await fastify.gateway.respondToExistingChatMessage(
          ingestResult.session.sessionId,
          normalized.eventId,
        );
        responseTurnId = response.turnId;
      }

      return reply.send({
        accepted: true,
        deduped: ingestResult.deduped,
        replied: !ingestResult.deduped,
        sessionId: ingestResult.session.sessionId,
        turnId: responseTurnId,
        eventType: normalized.eventType,
      });
    },
  );
};

function parseContentLength(value: string | string[] | undefined): number | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

async function readPayloadBuffer(payload: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function logWebhookVerificationFailure(
  request: { log: { warn: (...args: unknown[]) => void } },
  channel: "whatsapp" | "slack" | "line" | "nextcloud-talk",
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

function resolveNextcloudTalkSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "token", "tokenEnv") ??
    readConfigSecret(config, "botSecret", "botSecretEnv") ??
    readConfigSecret(config, "secret", "secretEnv")
  );
}

function resolveTelegramWebhookSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv") ??
    readConfigSecret(config, "secretToken", "secretTokenEnv") ??
    readConfigSecret(config, "botSecret", "botSecretEnv")
  );
}

function resolveWhatsAppAppSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "appSecret", "appSecretEnv") ??
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv")
  );
}

function resolveWhatsAppVerifyToken(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "webhookVerifyToken", "webhookVerifyTokenEnv") ??
    readConfigSecret(config, "verifyToken", "verifyTokenEnv")
  );
}

function resolveLineChannelSecret(config: Record<string, unknown>): string | undefined {
  return (
    readConfigSecret(config, "channelSecret", "channelSecretEnv") ?? readConfigSecret(config, "secret", "secretEnv")
  );
}

function readConfigSecret(config: Record<string, unknown>, key: string, envKey: string): string | undefined {
  const direct = config[key];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const envName = config[envKey];
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  const resolved = process.env[envName.trim()];
  return resolved?.trim() ? resolved.trim() : undefined;
}

function readQueryString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
