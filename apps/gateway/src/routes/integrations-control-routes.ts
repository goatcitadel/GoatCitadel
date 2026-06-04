import type { FastifyInstance } from "fastify";
import type { ExternalSideEffectRunHealthSummary, ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import {
  catalogParamsSchema,
  catalogQuerySchema,
  connectionActionBodySchema,
  connectionActionParamsSchema,
  connectionParamsSchema,
  connectionsQuerySchema,
  createConnectionSchema,
  discordPairingParamsSchema,
  externalSideEffectRunsQuerySchema,
  pluginInstallSchema,
  pluginParamsSchema,
  updateConnectionSchema,
} from "./integrations-shared.js";

export function registerIntegrationControlRoutes(fastify: FastifyInstance): void {
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

  fastify.get("/api/v1/integrations/external-side-effects", async (request, reply) => {
    const parsed = externalSideEffectRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = fastify.services.integrations.listExternalSideEffectRuns(parsed.data);
    return reply.send({
      items,
      summary: buildExternalSideEffectHealthSummary(items),
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
      const idempotencyKey = parsed.data.idempotencyKey ?? request.idempotencyKey;
      return reply.send(
        await fastify.services.integrations.invokeIntegrationConnectionAction(
          params.data.connectionId,
          params.data.actionId,
          idempotencyKey ? { ...parsed.data, idempotencyKey } : parsed.data,
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
}

function buildExternalSideEffectHealthSummary(
  items: ExternalSideEffectRunRecord[],
): ExternalSideEffectRunHealthSummary {
  const generatedAt = new Date().toISOString();
  const completed = items.filter((item) => item.status === "completed").length;
  const staleClaimCutoff = Date.now() - 15 * 60 * 1000;
  const staleClaimedNotSentCount = items.filter((item) => {
    if (item.status !== "claimed_not_sent") {
      return false;
    }
    const timestamp = Date.parse(item.updatedAt || item.createdAt);
    return Number.isFinite(timestamp) && timestamp <= staleClaimCutoff;
  }).length;
  const replayAuditEligibleCount = items.filter(
    (item) =>
      item.replayPolicy === "idempotent_external" &&
      (item.resumeState === "manual_retry_after_recorded_failure" || item.status === "claimed_not_sent"),
  ).length;
  const lastStatusCheckAt = items
    .map((item) => item.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    generatedAt,
    total: items.length,
    successRate: items.length === 0 ? 0 : completed / items.length,
    failedBeforeBoundaryCount: items.filter((item) => item.status === "failed_before_boundary").length,
    unknownOutcomeCount: items.filter((item) => item.status === "unknown_external_outcome").length,
    staleClaimedNotSentCount,
    replayAuditEligibleCount,
    lastStatusCheckAt,
    manualReconciliationCount: items.filter(
      (item) =>
        item.resumeState === "manual_retry_after_recorded_failure" || item.status === "unknown_external_outcome",
    ).length,
    posture: {
      readOnly: true,
      operatorTriggeredStatusReads: true,
      hiddenPolling: false,
      managedWorkflowLifecycle: false,
      note: "Activepieces and n8n bridge evidence is computed from the existing side-effect ledger; recipe exports remain read-only planning artifacts.",
    },
  };
}
