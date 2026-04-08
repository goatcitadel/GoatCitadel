import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

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

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/approve",
    async (request, reply) => {
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
        return reply.send(fastify.gateway.revokeDiscordPairing(params.data.connectionId, params.data.pairingId));
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
      return reply.send(await fastify.gateway.reconnectDiscordRuntime(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(message.toLowerCase().includes("unknown") ? 404 : 409).send({ error: message });
    }
  });

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
