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

const kindEnum = z.enum(["channel", "model_provider", "productivity", "automation", "platform"]);
const CHANNEL_INBOUND_MAX_BYTES = 256 * 1024;
const CHANNEL_INBOUND_MAX_CONTENT_CHARS = 20_000;

const catalogQuerySchema = z.object({
  kind: kindEnum.optional(),
});

const connectionsQuerySchema = z.object({
  kind: kindEnum.optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const createConnectionSchema = z.object({
  catalogId: z.string().min(3),
  label: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["connected", "disconnected", "error", "paused"]).optional(),
  config: z.record(z.unknown()).optional(),
});

const updateConnectionSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["connected", "disconnected", "error", "paused"]).optional(),
  config: z.record(z.unknown()).optional(),
  lastSyncAt: z.string().datetime().optional(),
  lastError: z.string().max(4000).optional(),
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
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const connectionParamsSchema = z.object({
  connectionId: z.string().uuid(),
});

const discordPairingParamsSchema = z.object({
  connectionId: z.string().uuid(),
  pairingId: z.string().uuid(),
});

const catalogParamsSchema = z.object({
  catalogId: z.string().min(3),
});

const channelDraftParamsSchema = z.object({
  draftId: z.string().uuid(),
});

const channelDraftListQuerySchema = z.object({
  catalogId: z.string().min(3).optional(),
  connectionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const createChannelDraftSchema = z.object({
  catalogId: z.string().min(3),
  connectionId: z.string().uuid().optional(),
  lifecycleMode: z.enum(["create", "edit", "repair", "rotate_secret", "retest"]).optional(),
});

const updateChannelDraftSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  draft: z.record(z.unknown()).optional(),
  lastFailureCategory: z.enum([
    "missing_input",
    "malformed_value",
    "credential_rejected",
    "permission_mismatch",
    "destination_mismatch",
    "platform_unavailable",
    "bridge_unavailable",
    "deprecated_path",
    "unknown",
  ]).optional(),
});

const pluginInstallSchema = z.object({
  source: z.string().min(1),
  pluginId: z.string().optional(),
});

const pluginParamsSchema = z.object({
  pluginId: z.string().min(1),
});

const obsidianPatchSchema = z.object({
  enabled: z.boolean().optional(),
  vaultPath: z.string().optional(),
  mode: z.enum(["read_append", "read_only"]).optional(),
  allowedSubpaths: z.array(z.string().min(1)).optional(),
});

const obsidianSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
});

const obsidianReadQuerySchema = z.object({
  path: z.string().min(1),
});

const obsidianAppendSchema = z.object({
  path: z.string().min(1),
  markdownBlock: z.string().min(1),
});

const obsidianInboxCaptureSchema = z.object({
  id: z.string().min(1),
  request: z.string().min(1),
  type: z.string().optional(),
  priority: z.string().optional(),
  neededBy: z.string().optional(),
  owner: z.string().optional(),
  state: z.string().optional(),
  taskLink: z.string().optional(),
  decisionLink: z.string().optional(),
  notes: z.string().optional(),
});

type NextcloudTalkWebhookRequest = {
  nextcloudTalkRawBody?: Buffer;
  slackRawBody?: Buffer;
  telegramRawBody?: Buffer;
  whatsappRawBody?: Buffer;
  lineRawBody?: Buffer;
};

export const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/channels/drafts", async (request, reply) => {
    const parsed = channelDraftListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.gateway.listChannelSetupDrafts(parsed.data),
    });
  });

  fastify.get("/api/v1/channels/setup-definitions", async (_request, reply) => {
    return reply.send({
      items: fastify.gateway.listChannelSetupDefinitions(),
    });
  });

  fastify.get("/api/v1/channels/catalog/:catalogId/setup-definition", async (request, reply) => {
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getChannelSetupDefinition(params.data.catalogId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts", async (request, reply) => {
    const parsed = createChannelDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.gateway.createChannelSetupDraft(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/channels/drafts/:draftId", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    const parsed = updateChannelDraftSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: parsed.success ? undefined : parsed.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.updateChannelSetupDraft(params.data.draftId, parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/validate", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.validateChannelSetupDraft(params.data.draftId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/test", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.testChannelSetupDraft(params.data.draftId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/drafts/:draftId/finalize", async (request, reply) => {
    const params = channelDraftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.finalizeChannelSetupDraft(params.data.draftId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/connections/:connectionId/repair-draft", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.gateway.createChannelSetupRepairDraft(params.data.connectionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/connections/:connectionId/rotate-secret-draft", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.gateway.createChannelSetupRotateSecretDraft(params.data.connectionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/channels/connections/:connectionId/retest", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.retestChannelConnection(params.data.connectionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/integrations/catalog", async (request, reply) => {
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.gateway.listIntegrationCatalog(parsed.data.kind) });
  });

  fastify.get("/api/v1/integrations/catalog/:catalogId/form-schema", async (request, reply) => {
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getIntegrationFormSchema(params.data.catalogId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/integrations/connections", async (request, reply) => {
    const parsed = connectionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.gateway.listIntegrationConnections(parsed.data.kind, parsed.data.limit),
    });
  });

  fastify.post("/api/v1/integrations/connections", async (request, reply) => {
    const parsed = createConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.gateway.createIntegrationConnection(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    const parsed = updateConnectionSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: parsed.success ? undefined : parsed.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.updateIntegrationConnection(params.data.connectionId, parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const deleted = fastify.gateway.deleteIntegrationConnection(params.data.connectionId);
    return reply.send({ deleted });
  });

  fastify.get("/api/v1/integrations/connections/:connectionId/discord/pairings", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.listDiscordPairings(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/approve", async (request, reply) => {
    const params = discordPairingParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.approveDiscordPairing(params.data.connectionId, params.data.pairingId));
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/revoke", async (request, reply) => {
    const params = discordPairingParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.revokeDiscordPairing(params.data.connectionId, params.data.pairingId));
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/integrations/connections/:connectionId/discord/reconnect", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.reconnectDiscordRuntime(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
    }
  });

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
        (request as typeof request & NextcloudTalkWebhookRequest).telegramRawBody = rawBody;
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

      const rawBody = (request as typeof request & NextcloudTalkWebhookRequest).telegramRawBody;
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
        (request as typeof request & NextcloudTalkWebhookRequest).whatsappRawBody = rawBody;
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

      const rawBody = (request as typeof request & NextcloudTalkWebhookRequest).whatsappRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing WhatsApp raw request body" });
      }

      const appSecret = resolveWhatsAppAppSecret(connection.config);
      if (!appSecret) {
        return reply.code(400).send({ error: "WhatsApp connection is missing an app secret" });
      }

      const signatureHeader = readHeaderValue(request.headers["x-hub-signature-256"]);
      if (!verifyWhatsAppWebhookSignature(signatureHeader, rawBody, appSecret)) {
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
        (request as typeof request & NextcloudTalkWebhookRequest).slackRawBody = rawBody;
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

      const rawBody = (request as typeof request & NextcloudTalkWebhookRequest).slackRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing Slack raw request body" });
      }

      const signingSecret = readConfigSecret(connection.config, "signingSecret", "signingSecretEnv");
      if (!signingSecret) {
        return reply.code(400).send({ error: "Slack connection is missing a signing secret" });
      }

      const timestampHeader = readHeaderValue(request.headers["x-slack-request-timestamp"]);
      const signatureHeader = readHeaderValue(request.headers["x-slack-signature"]);
      if (!verifySlackSignature({
        timestamp: timestampHeader,
        signature: signatureHeader,
        rawBody,
        secret: signingSecret,
      })) {
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
        (request as typeof request & NextcloudTalkWebhookRequest).lineRawBody = rawBody;
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

      const rawBody = (request as typeof request & NextcloudTalkWebhookRequest).lineRawBody;
      if (!rawBody) {
        return reply.code(400).send({ error: "Missing LINE raw request body" });
      }

      const channelSecret = resolveLineChannelSecret(connection.config);
      if (!channelSecret) {
        return reply.code(400).send({ error: "LINE connection is missing a channel secret" });
      }

      const signatureHeader = readHeaderValue(request.headers["x-line-signature"]);
      if (!verifyLineWebhookSignature(signatureHeader, rawBody, channelSecret)) {
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
        (request as typeof request & NextcloudTalkWebhookRequest).nextcloudTalkRawBody = rawBody;
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

      const rawBody = (request as typeof request & NextcloudTalkWebhookRequest).nextcloudTalkRawBody;
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

  fastify.get("/api/v1/integrations/plugins", async (_request, reply) => {
    return reply.send({
      items: fastify.gateway.listIntegrationPlugins(),
    });
  });

  fastify.get("/api/v1/integrations/obsidian/status", async (_request, reply) => {
    return reply.send(await fastify.gateway.getObsidianIntegrationStatus());
  });

  fastify.patch("/api/v1/integrations/obsidian/config", async (request, reply) => {
    const parsed = obsidianPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.updateObsidianIntegrationConfig(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/test", async (_request, reply) => {
    try {
      return reply.send(await fastify.gateway.testObsidianIntegration());
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/search", async (request, reply) => {
    const parsed = obsidianSearchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: await fastify.gateway.searchObsidianNotes(parsed.data.query, parsed.data.limit),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/integrations/obsidian/note", async (request, reply) => {
    const parsed = obsidianReadQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.readObsidianNote(parsed.data.path));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/append", async (request, reply) => {
    const parsed = obsidianAppendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.appendObsidianNote(parsed.data.path, parsed.data.markdownBlock));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/inbox/capture", async (request, reply) => {
    const parsed = obsidianInboxCaptureSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.captureObsidianInboxEntry(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/plugins/install", async (request, reply) => {
    const parsed = pluginInstallSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.gateway.installIntegrationPlugin(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/plugins/:pluginId/enable", async (request, reply) => {
    const params = pluginParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.setIntegrationPluginEnabled(params.data.pluginId, true));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/plugins/:pluginId/disable", async (request, reply) => {
    const params = pluginParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.setIntegrationPluginEnabled(params.data.pluginId, false));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/integrations/connections/:connectionId/diagnostics", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.runIntegrationConnectionDiagnostics(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("unknown integration connection");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });
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

function resolveNextcloudTalkSecret(config: Record<string, unknown>): string | undefined {
  return readConfigSecret(config, "token", "tokenEnv")
    ?? readConfigSecret(config, "botSecret", "botSecretEnv")
    ?? readConfigSecret(config, "secret", "secretEnv");
}

function resolveTelegramWebhookSecret(config: Record<string, unknown>): string | undefined {
  return readConfigSecret(config, "webhookSecret", "webhookSecretEnv")
    ?? readConfigSecret(config, "secretToken", "secretTokenEnv")
    ?? readConfigSecret(config, "botSecret", "botSecretEnv");
}

function resolveWhatsAppAppSecret(config: Record<string, unknown>): string | undefined {
  return readConfigSecret(config, "appSecret", "appSecretEnv")
    ?? readConfigSecret(config, "webhookSecret", "webhookSecretEnv");
}

function resolveWhatsAppVerifyToken(config: Record<string, unknown>): string | undefined {
  return readConfigSecret(config, "webhookVerifyToken", "webhookVerifyTokenEnv")
    ?? readConfigSecret(config, "verifyToken", "verifyTokenEnv");
}

function resolveLineChannelSecret(config: Record<string, unknown>): string | undefined {
  return readConfigSecret(config, "channelSecret", "channelSecretEnv")
    ?? readConfigSecret(config, "secret", "secretEnv");
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
