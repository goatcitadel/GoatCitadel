import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

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

const catalogParamsSchema = z.object({
  catalogId: z.string().min(3),
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
