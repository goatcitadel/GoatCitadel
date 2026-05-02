import type { FastifyPluginAsync } from "fastify";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { z } from "zod";
import {
  buildSlackOAuthConnectionInput,
  buildSlackOAuthStart,
  exchangeSlackOAuthCode,
  redactSlackOAuthConnection,
  summarizeSlackOAuthInstall,
  verifySlackOAuthState,
} from "../services/slack-oauth-service.js";
import { discoverTelegramTargets } from "../services/telegram-target-discovery.js";

const kindEnum = z.enum(["channel", "model_provider", "productivity", "automation", "platform"]);

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

const connectionParamsSchema = z.object({
  connectionId: z.string().uuid(),
});

const connectionActionParamsSchema = z.object({
  connectionId: z.string().uuid(),
  actionId: z.string().min(1).max(120),
});

const connectionActionBodySchema = z.object({
  input: z.record(z.unknown()).optional(),
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
  lastFailureCategory: z
    .enum([
      "missing_input",
      "malformed_value",
      "credential_rejected",
      "permission_mismatch",
      "destination_mismatch",
      "platform_unavailable",
      "bridge_unavailable",
      "deprecated_path",
      "unknown",
    ])
    .optional(),
});

const pluginInstallSchema = z.object({
  source: z.string().min(1),
  pluginId: z.string().optional(),
  sourceType: z.enum(["local", "npm", "git", "url", "manual", "unknown"]).optional(),
  expectedIntegrity: z.string().min(1).optional(),
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

const slackOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const slackOAuthDisconnectSchema = z.object({
  connectionId: z.string().uuid(),
});

const telegramDiscoverTargetsSchema = z.object({
  connectionId: z.string().uuid().optional(),
  botToken: z.string().min(1).optional(),
  botTokenEnv: z.string().min(1).optional(),
  setupCode: z.string().min(1).optional(),
});

export const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/integrations/slack/oauth/status", async (_request, reply) => {
    const start = buildSlackOAuthStart(readSlackOAuthConfig());
    const allConnections: IntegrationConnection[] = fastify.services.integrations.listIntegrationConnections(
      "channel",
      300,
    );
    const connections = allConnections
      .filter((connection) => connection.catalogId === "channel.slack" && connection.config.authMode === "oauth")
      .map((connection) => ({
        connection: redactSlackOAuthConnection(connection),
        install: summarizeSlackOAuthInstall(connection),
      }));
    return reply.send({
      configured: start.configured,
      mode: start.mode,
      scopes: start.scopes,
      missing: start.missing,
      connections,
    });
  });

  fastify.post("/api/v1/integrations/slack/oauth/start", async (_request, reply) => {
    const start = buildSlackOAuthStart(readSlackOAuthConfig());
    if (!start.configured) {
      return reply.code(400).send({
        error: "Slack OAuth is not configured.",
        missing: start.missing,
      });
    }
    return reply.send(start);
  });

  fastify.get("/api/v1/integrations/slack/oauth/callback", async (request, reply) => {
    const parsed = slackOAuthCallbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const config = readSlackOAuthConfig();
    if (!config.clientId || !config.clientSecret || !config.redirectUri || !config.stateSecret) {
      return reply.code(400).send({ error: "Slack OAuth is not configured." });
    }
    if (!verifySlackOAuthState(parsed.data.state, config.stateSecret)) {
      return reply.code(400).send({ error: "Invalid or expired Slack OAuth state." });
    }
    try {
      const payload = await exchangeSlackOAuthCode({
        code: parsed.data.code,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        fetcher: (url, init) => fetch(url, init),
      });
      const connectionInput = buildSlackOAuthConnectionInput(payload);
      const existingConnection = findExistingSlackOAuthConnection(
        fastify.services.integrations.listIntegrationConnections("channel", 300),
        connectionInput.config,
      );
      const connection = existingConnection
        ? fastify.services.integrations.updateIntegrationConnection(existingConnection.connectionId, {
            label: connectionInput.label,
            enabled: true,
            status: "connected",
            lastError: undefined,
            config: mergeSlackOAuthConfig(existingConnection.config, connectionInput.config),
          })
        : fastify.services.integrations.createIntegrationConnection(connectionInput);
      const result = {
        connection: redactSlackOAuthConnection(connection),
        install: summarizeSlackOAuthInstall(connection),
      };
      if (request.headers.accept?.includes("text/html")) {
        return reply.type("text/html").send(renderSlackOAuthSuccessPage(result));
      }
      return reply.send(result);
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/slack/oauth/disconnect", async (request, reply) => {
    const parsed = slackOAuthDisconnectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const current = fastify.services.integrations.getIntegrationConnection(parsed.data.connectionId);
      if (current.catalogId !== "channel.slack" || current.config.authMode !== "oauth") {
        return reply.code(400).send({ error: "Connection is not a Slack OAuth install." });
      }
      const connection = fastify.services.integrations.updateIntegrationConnection(parsed.data.connectionId, {
        enabled: false,
        status: "disconnected",
        lastError: undefined,
      });
      return reply.send({ connection: redactSlackOAuthConnection(connection) });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/telegram/discover-targets", async (request, reply) => {
    const parsed = telegramDiscoverTargetsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const token = resolveTelegramDiscoveryToken(fastify, parsed.data);
      if (!token) {
        return reply.code(400).send({ error: "Provide a Telegram bot token, token env var, or connection id." });
      }
      const items = await discoverTelegramTargets({
        token,
        setupCode: parsed.data.setupCode,
        fetcher: (url, init) => fetch(url, init),
      });
      return reply.send({ items });
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/channels/drafts", async (request, reply) => {
    const parsed = channelDraftListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.channelSetup.listChannelSetupDrafts(parsed.data),
    });
  });

  fastify.get("/api/v1/channels/setup-definitions", async (_request, reply) => {
    return reply.send({
      items: fastify.services.channelSetup.listChannelSetupDefinitions(),
    });
  });

  fastify.get("/api/v1/channels/catalog/:catalogId/setup-definition", async (request, reply) => {
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.channelSetup.getChannelSetupDefinition(params.data.catalogId));
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
      return reply.code(201).send(fastify.services.channelSetup.createChannelSetupDraft(parsed.data));
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
      return reply.send(fastify.services.channelSetup.updateChannelSetupDraft(params.data.draftId, parsed.data));
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
      return reply.send(fastify.services.channelSetup.validateChannelSetupDraft(params.data.draftId));
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
      return reply.send(await fastify.services.channelSetup.testChannelSetupDraft(params.data.draftId));
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
      return reply.send(await fastify.services.channelSetup.finalizeChannelSetupDraft(params.data.draftId));
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
      return reply
        .code(201)
        .send(fastify.services.channelSetup.createChannelSetupRepairDraft(params.data.connectionId));
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
      return reply
        .code(201)
        .send(fastify.services.channelSetup.createChannelSetupRotateSecretDraft(params.data.connectionId));
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
      return reply.send(await fastify.services.channelSetup.retestChannelConnection(params.data.connectionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/integrations/catalog", async (request, reply) => {
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.services.integrations.listIntegrationCatalog(parsed.data.kind) });
  });

  fastify.get("/api/v1/integrations/catalog/:catalogId/form-schema", async (request, reply) => {
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.integrations.getIntegrationFormSchema(params.data.catalogId));
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
      items: fastify.services.integrations.listIntegrationConnections(parsed.data.kind, parsed.data.limit),
    });
  });

  fastify.post("/api/v1/integrations/connections", async (request, reply) => {
    const parsed = createConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.integrations.createIntegrationConnection(parsed.data));
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
      return reply.send(
        fastify.services.integrations.updateIntegrationConnection(params.data.connectionId, parsed.data),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const deleted = fastify.services.integrations.deleteIntegrationConnection(params.data.connectionId);
    return reply.send({ deleted });
  });

  fastify.post("/api/v1/integrations/connections/:connectionId/actions/:actionId", async (request, reply) => {
    const params = connectionActionParamsSchema.safeParse(request.params);
    const parsed = connectionActionBodySchema.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: parsed.success ? undefined : parsed.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.integrations.invokeIntegrationConnectionAction(
          params.data.connectionId,
          params.data.actionId,
          parsed.data,
        ),
      );
    } catch (error) {
      const message = (error as Error).message;
      const lowered = message.toLowerCase();
      const notFound = lowered.includes("unknown integration connection");
      const unsupported = lowered.includes("unsupported integration action");
      return reply.code(notFound || unsupported ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/integrations/connections/:connectionId/discord/pairings", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.integrations.listDiscordPairings(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
    }
  });

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/approve",
    async (request, reply) => {
      const params = discordPairingParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      try {
        return reply.send(
          fastify.services.integrations.approveDiscordPairing(params.data.connectionId, params.data.pairingId),
        );
      } catch (error) {
        const message = (error as Error).message;
        return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/revoke",
    async (request, reply) => {
      const params = discordPairingParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      try {
        return reply.send(
          fastify.services.integrations.revokeDiscordPairing(params.data.connectionId, params.data.pairingId),
        );
      } catch (error) {
        const message = (error as Error).message;
        return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
      }
    },
  );

  fastify.post("/api/v1/integrations/connections/:connectionId/discord/reconnect", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.integrations.reconnectDiscordRuntime(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/integrations/plugins", async (_request, reply) => {
    return reply.send({
      items: fastify.services.integrations.listIntegrationPlugins(),
    });
  });

  fastify.get("/api/v1/integrations/obsidian/status", async (_request, reply) => {
    return reply.send(await fastify.services.obsidian.getObsidianIntegrationStatus());
  });

  fastify.patch("/api/v1/integrations/obsidian/config", async (request, reply) => {
    const parsed = obsidianPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.obsidian.updateObsidianIntegrationConfig(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/obsidian/test", async (_request, reply) => {
    try {
      return reply.send(await fastify.services.obsidian.testObsidianIntegration());
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
        items: await fastify.services.obsidian.searchObsidianNotes(parsed.data.query, parsed.data.limit),
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
      return reply.send(await fastify.services.obsidian.readObsidianNote(parsed.data.path));
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
      return reply.send(
        await fastify.services.obsidian.appendObsidianNote(parsed.data.path, parsed.data.markdownBlock),
      );
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
      return reply.send(await fastify.services.obsidian.captureObsidianInboxEntry(parsed.data));
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
      return reply.code(201).send(fastify.services.integrations.installIntegrationPlugin(parsed.data));
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
      return reply.send(fastify.services.integrations.setIntegrationPluginEnabled(params.data.pluginId, true));
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
      return reply.send(fastify.services.integrations.setIntegrationPluginEnabled(params.data.pluginId, false));
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
      return reply.send(
        await fastify.services.integrations.runIntegrationConnectionDiagnostics(params.data.connectionId),
      );
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("unknown integration connection");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });
};

function readSlackOAuthConfig() {
  return {
    clientId: process.env.GOATCITADEL_SLACK_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GOATCITADEL_SLACK_OAUTH_REDIRECT_URI,
    stateSecret: process.env.GOATCITADEL_SLACK_OAUTH_STATE_SECRET,
    scopes: process.env.GOATCITADEL_SLACK_OAUTH_SCOPES,
    brokerAuthorizeUrl: process.env.GOATCITADEL_SLACK_OAUTH_BROKER_AUTHORIZE_URL,
  };
}

function resolveTelegramDiscoveryToken(
  fastify: Parameters<FastifyPluginAsync>[0],
  input: z.infer<typeof telegramDiscoverTargetsSchema>,
): string | undefined {
  if (input.botToken?.trim()) {
    return input.botToken.trim();
  }
  if (input.botTokenEnv?.trim()) {
    return process.env[input.botTokenEnv.trim()];
  }
  if (!input.connectionId) {
    return undefined;
  }
  const connection = fastify.services.integrations.getIntegrationConnection(input.connectionId);
  const config = connection.config;
  return readConfigString(config, "botToken") ?? readEnvConfigString(config, "botTokenEnv");
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readEnvConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const envName = readConfigString(config, key);
  return envName ? process.env[envName] : undefined;
}

function findExistingSlackOAuthConnection(
  connections: IntegrationConnection[],
  nextConfig: Record<string, unknown>,
): IntegrationConnection | undefined {
  const nextTeamId = readConfigString(nextConfig, "slackTeamId");
  const nextInstallId = readConfigString(nextConfig, "slackInstallId");
  return connections.find((connection) => {
    if (connection.catalogId !== "channel.slack" || connection.config.authMode !== "oauth") {
      return false;
    }
    return Boolean(
      (nextTeamId && readConfigString(connection.config, "slackTeamId") === nextTeamId) ||
      (nextInstallId && readConfigString(connection.config, "slackInstallId") === nextInstallId),
    );
  });
}

function mergeSlackOAuthConfig(
  existingConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): Record<string, unknown> {
  const nextTargets = Array.isArray(nextConfig.targets) ? nextConfig.targets : [];
  return {
    ...existingConfig,
    ...nextConfig,
    targets: nextTargets.length > 0 ? nextTargets : existingConfig.targets,
    defaultChannel:
      readConfigString(nextConfig, "defaultChannel") ?? readConfigString(existingConfig, "defaultChannel"),
    defaultThreadTs: readConfigString(existingConfig, "defaultThreadTs"),
  };
}

function renderSlackOAuthSuccessPage(result: {
  connection: IntegrationConnection;
  install: ReturnType<typeof summarizeSlackOAuthInstall>;
}): string {
  const payload = JSON.stringify({
    type: "goatcitadel.slackOAuth.connected",
    connectionId: result.connection.connectionId,
    teamName: result.install.teamName,
    teamId: result.install.teamId,
  }).replaceAll("<", "\\u003c");
  const teamName = escapeHtml(result.install.teamName ?? "Slack workspace");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Slack connected</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; color: #dff7f4; background: #071112; }
      main { max-width: 560px; padding: 32px; text-align: center; }
      h1 { font-size: 24px; margin: 0 0 12px; }
      p { color: #9ac7c2; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Slack connected</h1>
      <p>${teamName} is connected. You can return to GoatCitadel and choose channel targets.</p>
    </main>
    <script>
      if (window.opener) {
        window.opener.postMessage(${payload}, "*");
        window.setTimeout(() => window.close(), 700);
      }
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
