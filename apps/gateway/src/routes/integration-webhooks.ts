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
import {
  CHANNEL_INBOUND_MAX_BYTES,
  createIgnoredWebhookReply,
  createWebhookHandler,
  createWebhookPreParsing,
  dispatchInboundWebhookMessage,
  parseContentLength,
  readHeaderValue,
  readQueryString,
} from "./webhook-handler-factory.js";

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

type TelegramDispatchPayload = Exclude<ReturnType<typeof normalizeTelegramWebhookPayload>, { kind: "ignore" }>;
type WhatsAppDispatchPayload = Exclude<ReturnType<typeof normalizeWhatsAppWebhookPayload>, { kind: "ignore" }>;
type SlackDispatchPayload = Exclude<
  ReturnType<typeof normalizeSlackWebhookPayload>,
  { kind: "ignore" } | { kind: "challenge" }
>;
type LineDispatchPayload = Exclude<ReturnType<typeof normalizeLineWebhookPayload>, { kind: "ignore" }>;
type NextcloudTalkDispatchPayload = Exclude<
  ReturnType<typeof normalizeNextcloudTalkWebhookPayload>,
  { kind: "ignore" } | { kind: "activity" }
>;

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
      preParsing: createWebhookPreParsing("telegramRawBody"),
    },
    createWebhookHandler<TelegramDispatchPayload>(fastify, {
      source: "telegram",
      connectorKey: "telegram",
      connectorLabel: "Telegram",
      rawBodyKey: "telegramRawBody",
      missingRawBodyError: "Missing Telegram raw request body",
      verifySignature: ({ request, connection }) => {
        const webhookSecret = resolveTelegramWebhookSecret(connection.config);
        if (!webhookSecret) {
          return { ok: false as const, statusCode: 400, error: "Telegram connection is missing a webhook secret" };
        }
        const secretTokenHeader = readHeaderValue(request.headers["x-telegram-bot-api-secret-token"]);
        if (!verifyTelegramWebhookSecretToken(secretTokenHeader, webhookSecret)) {
          return { ok: false as const, statusCode: 401, error: "Invalid Telegram webhook secret token" };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeTelegramWebhookPayload({
          connectionId,
          payload: request.body,
        });
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, request, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.gateway, {
          channel: "telegram",
          connectionId,
          idempotencyKey: deriveTelegramWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room ?? parsed.peer,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: parsed.peer,
            room: parsed.room,
            threadId: parsed.threadId,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            content: parsed.content,
            metadata: parsed.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
          },
        }),
    }),
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
      preParsing: createWebhookPreParsing("whatsappRawBody"),
    },
    createWebhookHandler<WhatsAppDispatchPayload>(fastify, {
      source: "whatsapp",
      connectorKey: "whatsapp",
      connectorLabel: "WhatsApp",
      rawBodyKey: "whatsappRawBody",
      missingRawBodyError: "Missing WhatsApp raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const appSecret = resolveWhatsAppAppSecret(connection.config);
        if (!appSecret) {
          return { ok: false as const, statusCode: 400, error: "WhatsApp connection is missing an app secret" };
        }

        const signatureHeader = readHeaderValue(request.headers["x-hub-signature-256"]);
        if (!verifyWhatsAppWebhookSignature(signatureHeader, rawBody, appSecret)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid WhatsApp webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeWhatsAppWebhookPayload({
          connectionId,
          payload: request.body,
        });
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, request, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.gateway, {
          channel: "whatsapp",
          connectionId,
          idempotencyKey: deriveWhatsAppWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.peer,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: parsed.peer,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            displayName: parsed.displayName,
            content: parsed.content,
            metadata: parsed.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
          },
        }),
    }),
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/slack/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: createWebhookPreParsing("slackRawBody"),
    },
    createWebhookHandler<SlackDispatchPayload>(fastify, {
      source: "slack",
      connectorKey: "slack",
      connectorLabel: "Slack",
      rawBodyKey: "slackRawBody",
      missingRawBodyError: "Missing Slack raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const signingSecret = readConfigSecret(connection.config, "signingSecret", "signingSecretEnv");
        if (!signingSecret) {
          return { ok: false as const, statusCode: 400, error: "Slack connection is missing a signing secret" };
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
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid Slack webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeSlackWebhookPayload({
          connectionId,
          payload: request.body,
        });
        if (normalized.kind === "challenge") {
          return {
            kind: "reply" as const,
            payload: { challenge: normalized.challenge },
          };
        }
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, request, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.gateway, {
          channel: "slack",
          connectionId,
          idempotencyKey: deriveSlackWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room ?? parsed.peer,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: parsed.peer,
            room: parsed.room,
            threadId: parsed.threadId,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            content: parsed.content,
            metadata: parsed.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
          },
        }),
    }),
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/line/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: createWebhookPreParsing("lineRawBody"),
    },
    createWebhookHandler<LineDispatchPayload>(fastify, {
      source: "line",
      connectorKey: "line",
      connectorLabel: "LINE",
      rawBodyKey: "lineRawBody",
      missingRawBodyError: "Missing LINE raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const channelSecret = resolveLineChannelSecret(connection.config);
        if (!channelSecret) {
          return { ok: false as const, statusCode: 400, error: "LINE connection is missing a channel secret" };
        }

        const signatureHeader = readHeaderValue(request.headers["x-line-signature"]);
        if (!verifyLineWebhookSignature(signatureHeader, rawBody, channelSecret)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid LINE webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const normalized = normalizeLineWebhookPayload({
          connectionId,
          payload: request.body,
        });
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, request, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.gateway, {
          channel: "line",
          connectionId,
          idempotencyKey: deriveLineWebhookIdempotencyKey(connectionId, request.body, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room ?? parsed.peer,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            peer: parsed.peer,
            room: parsed.room,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            content: parsed.content,
            metadata: parsed.metadata,
          },
          responseOptions: {
            deliveryReplyToMessageId: parsed.deliveryReplyToMessageId,
          },
        }),
    }),
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/nextcloud-talk/webhook",
    {
      bodyLimit: CHANNEL_INBOUND_MAX_BYTES,
      preParsing: createWebhookPreParsing("nextcloudTalkRawBody"),
    },
    createWebhookHandler<NextcloudTalkDispatchPayload>(fastify, {
      source: "nextcloud-talk",
      connectorKey: "nextcloud-talk",
      connectorLabel: "Nextcloud Talk",
      rawBodyKey: "nextcloudTalkRawBody",
      missingRawBodyError: "Missing Nextcloud Talk raw request body",
      verifySignature: ({ request, connection, rawBody }) => {
        const secret = resolveNextcloudTalkSecret(connection.config);
        if (!secret) {
          return {
            ok: false as const,
            statusCode: 400,
            error: "Nextcloud Talk connection is missing a token/secret",
          };
        }

        const randomHeader = readHeaderValue(request.headers["x-nextcloud-talk-random"]);
        const signatureHeader = readHeaderValue(request.headers["x-nextcloud-talk-signature"]);
        if (!verifyNextcloudTalkSignature(randomHeader, signatureHeader, rawBody, secret)) {
          return {
            ok: false as const,
            statusCode: 401,
            error: "Invalid Nextcloud Talk webhook signature",
            logReason: "signature_mismatch",
          };
        }
        return { ok: true as const };
      },
      parsePayload: ({ connectionId, request }) => {
        const backendHeader = readHeaderValue(request.headers["x-nextcloud-talk-backend"]);
        const normalized = normalizeNextcloudTalkWebhookPayload({
          connectionId,
          payload: request.body,
          backendUrl: backendHeader,
        });
        if (normalized.kind === "ignore") {
          return {
            kind: "reply" as const,
            payload: createIgnoredWebhookReply(normalized.eventType, normalized.reason),
          };
        }
        if (normalized.kind === "activity") {
          fastify.gateway.recordDevDiagnostic({
            level: "info",
            category: "channels",
            event: "nextcloud-talk.webhook.activity",
            message: `Processed Nextcloud Talk ${normalized.eventType} webhook`,
            context: {
              connectionId,
              eventType: normalized.eventType,
              room: normalized.room,
              actorId: normalized.actorId,
              backendUrl: normalized.backendUrl,
              ...normalized.metadata,
            },
          });
          return {
            kind: "reply" as const,
            payload: {
              accepted: true,
              handled: true,
              eventType: normalized.eventType,
            },
          };
        }
        return {
          kind: "dispatch" as const,
          parsed: normalized,
        };
      },
      dispatch: async ({ connectionId, rawBody, parsed }) =>
        dispatchInboundWebhookMessage(fastify.gateway, {
          channel: "nextcloud-talk",
          connectionId,
          idempotencyKey: deriveNextcloudTalkWebhookIdempotencyKey(connectionId, rawBody),
          eventType: parsed.eventType,
          bindingTarget: parsed.room,
          message: {
            eventId: parsed.eventId,
            account: parsed.account,
            room: parsed.room,
            actorId: parsed.actorId,
            actorType: parsed.actorType,
            displayName: parsed.displayName,
            content: parsed.content,
            metadata: {
              backendUrl: parsed.backendUrl,
              ...parsed.metadata,
            },
          },
        }),
    }),
  );
};

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

/** Allowed env var name prefixes for webhook secret resolution. */
const ALLOWED_SECRET_ENV_PREFIXES = [
  "GOATCITADEL_",
  "GC_",
  "SLACK_",
  "DISCORD_",
  "TELEGRAM_",
  "WHATSAPP_",
  "LINE_",
  "NEXTCLOUD_",
  "WEBHOOK_SECRET",
  "CHANNEL_SECRET",
];

function readConfigSecret(config: Record<string, unknown>, key: string, envKey: string): string | undefined {
  const direct = config[key];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const envName = config[envKey];
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  const trimmedEnvName = envName.trim().toUpperCase();
  if (!ALLOWED_SECRET_ENV_PREFIXES.some((prefix) => trimmedEnvName.startsWith(prefix))) {
    return undefined;
  }
  const resolved = process.env[envName.trim()];
  return resolved?.trim() ? resolved.trim() : undefined;
}
