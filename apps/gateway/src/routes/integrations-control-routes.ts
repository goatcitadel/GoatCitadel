import type { FastifyInstance, FastifyReply } from "fastify";
import type { ExternalSideEffectRunHealthSummary, ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import {
  preserveIntegrationConnectionSecretsForPublicUpdate,
  projectExternalSideEffectRunsForPublicResponse,
  projectIntegrationConnectionForPublicResponse,
  projectIntegrationConnectionsForPublicResponse,
} from "../services/integration-connection-public-projection.js";
import { projectPublicSecretValue } from "../services/public-secret-projection.js";
import {
  catalogParamsSchema,
  catalogQuerySchema,
  connectionActionBodySchema,
  connectionActionParamsSchema,
  connectionParamsSchema,
  connectionsQuerySchema,
  createConnectionSchema,
  discordPairingParamsSchema,
  externalConnectorActionParamsSchema,
  externalConnectorDetailQuerySchema,
  externalConnectorReviewPatchSchema,
  externalConnectorServiceParamsSchema,
  externalConnectorServicesQuerySchema,
  externalConnectorStageActionSchema,
  externalSideEffectRunsQuerySchema,
  pluginInstallSchema,
  pluginParamsSchema,
  updateConnectionSchema,
} from "./integrations-shared.js";

const RATE_LIMIT_READ_MAX = 500;
const RATE_LIMIT_MUTATION_MAX = 180;
const RATE_LIMIT_AUTH_MAX = 60;

export function registerIntegrationControlRoutes(fastify: FastifyInstance): void {
  const pairingReadRoute = {
    config: {
      rateLimit: {
        max: RATE_LIMIT_READ_MAX,
      },
    },
  };
  const pairingMutationRoute = {
    config: {
      rateLimit: {
        max: RATE_LIMIT_AUTH_MAX,
      },
    },
  };
  const integrationMutationRoute = {
    config: {
      rateLimit: {
        max: RATE_LIMIT_MUTATION_MAX,
      },
    },
  };

  fastify.get("/api/v1/integrations/catalog", async (request, reply) => {
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: await fastify.services.integrations.listIntegrationCatalog(parsed.data.kind) });
  });

  fastify.get("/api/v1/integrations/catalog/:catalogId/form-schema", async (request, reply) => {
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.integrations.getIntegrationFormSchema(params.data.catalogId));
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
      items: projectIntegrationConnectionsForPublicResponse(
        await fastify.services.integrations.listIntegrationConnections(parsed.data.kind, parsed.data.limit),
      ),
    });
  });

  fastify.get("/api/v1/integrations/external-side-effects", async (request, reply) => {
    const parsed = externalSideEffectRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = await fastify.services.integrations.listExternalSideEffectRuns(parsed.data);
    return reply.send({
      items: projectExternalSideEffectRunsForPublicResponse(items),
      summary: buildExternalSideEffectHealthSummary(items),
    });
  });

  fastify.get("/api/v1/integrations/external-connectors/sources", async (_request, reply) => {
    return reply.send({
      items: await fastify.services.integrations.listExternalConnectorSources(),
    });
  });

  fastify.get("/api/v1/integrations/external-connectors/services", async (request, reply) => {
    const parsed = externalConnectorServicesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: await fastify.services.integrations.listExternalConnectorServices(parsed.data),
    });
  });

  fastify.get("/api/v1/integrations/external-connectors/services/:sourceId/:serviceId", async (request, reply) => {
    const params = externalConnectorServiceParamsSchema.safeParse(request.params);
    const query = externalConnectorDetailQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.integrations.getExternalConnectorService(
          params.data.sourceId,
          params.data.serviceId,
          query.data.workspaceId,
        ),
      );
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get(
    "/api/v1/integrations/external-connectors/services/:sourceId/:serviceId/actions/:actionId",
    async (request, reply) => {
      const params = externalConnectorActionParamsSchema.safeParse(request.params);
      const query = externalConnectorDetailQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            query: query.success ? undefined : query.error.flatten(),
          },
        });
      }
      try {
        return reply.send(
          await fastify.services.integrations.getExternalConnectorAction(
            params.data.sourceId,
            params.data.serviceId,
            params.data.actionId,
            query.data.workspaceId,
          ),
        );
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );

  fastify.patch(
    "/api/v1/integrations/external-connectors/services/:sourceId/:serviceId/review",
    integrationMutationRoute,
    async (request, reply) => {
      const params = externalConnectorServiceParamsSchema.safeParse(request.params);
      const parsed = externalConnectorReviewPatchSchema.safeParse(request.body ?? {});
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
          await fastify.services.integrations.updateExternalConnectorReviewState(
            {
              sourceId: params.data.sourceId,
              serviceId: params.data.serviceId,
            },
            parsed.data,
          ),
        );
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );

  fastify.patch(
    "/api/v1/integrations/external-connectors/services/:sourceId/:serviceId/actions/:actionId/review",
    integrationMutationRoute,
    async (request, reply) => {
      const params = externalConnectorActionParamsSchema.safeParse(request.params);
      const parsed = externalConnectorReviewPatchSchema.safeParse(request.body ?? {});
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
          await fastify.services.integrations.updateExternalConnectorReviewState(
            {
              sourceId: params.data.sourceId,
              serviceId: params.data.serviceId,
              actionId: params.data.actionId,
            },
            parsed.data,
          ),
        );
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/external-connectors/services/:sourceId/:serviceId/actions/:actionId/stage",
    integrationMutationRoute,
    async (request, reply) => {
      const params = externalConnectorActionParamsSchema.safeParse(request.params);
      const parsed = externalConnectorStageActionSchema.safeParse(request.body ?? {});
      if (!params.success || !parsed.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: parsed.success ? undefined : parsed.error.flatten(),
          },
        });
      }
      try {
        return reply
          .code(201)
          .send(
            await fastify.services.integrations.stageExternalConnectorAction(
              params.data.sourceId,
              params.data.serviceId,
              params.data.actionId,
              parsed.data,
            ),
          );
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post("/api/v1/integrations/connections", async (request, reply) => {
    const parsed = createConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = await fastify.services.integrations.createIntegrationConnection(parsed.data);
      return reply.code(201).send(projectIntegrationConnectionForPublicResponse(created));
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
      const update =
        parsed.data.config === undefined
          ? parsed.data
          : preserveIntegrationConnectionSecretsForPublicUpdate(
              await fastify.services.integrations.getIntegrationConnection(params.data.connectionId),
              parsed.data,
            );
      const updated = await fastify.services.integrations.updateIntegrationConnection(params.data.connectionId, update);
      return reply.send(projectIntegrationConnectionForPublicResponse(updated));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/integrations/connections/:connectionId", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const deleted = await fastify.services.integrations.deleteIntegrationConnection(params.data.connectionId);
    return reply.send({ deleted });
  });

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/actions/:actionId",
    integrationMutationRoute,
    async (request, reply) => {
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
          projectPublicSecretValue(
            await fastify.services.integrations.invokeIntegrationConnectionAction(
              params.data.connectionId,
              params.data.actionId,
              idempotencyKey ? { ...parsed.data, idempotencyKey } : parsed.data,
            ),
          ),
        );
      } catch (error) {
        const message = (error as Error).message;
        const lowered = message.toLowerCase();
        const notFound = lowered.includes("unknown integration connection");
        const unsupported = lowered.includes("unsupported integration action");
        return sendProjectedIntegrationError(reply, notFound || unsupported ? 404 : 409, message);
      }
    },
  );

  fastify.get(
    "/api/v1/integrations/connections/:connectionId/discord/pairings",
    pairingReadRoute,
    async (request, reply) => {
      const params = connectionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      try {
        return reply.send(
          projectPublicSecretValue(await fastify.services.integrations.listDiscordPairings(params.data.connectionId)),
        );
      } catch (error) {
        const message = (error as Error).message;
        return sendProjectedIntegrationError(reply, message.toLowerCase().includes("unknown") ? 404 : 409, message);
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/approve",
    pairingMutationRoute,
    async (request, reply) => {
      const params = discordPairingParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      try {
        return reply.send(
          projectPublicSecretValue(
            await fastify.services.integrations.approveDiscordPairing(params.data.connectionId, params.data.pairingId),
          ),
        );
      } catch (error) {
        const message = (error as Error).message;
        return sendProjectedIntegrationError(reply, message.toLowerCase().includes("unknown") ? 404 : 409, message);
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/revoke",
    pairingMutationRoute,
    async (request, reply) => {
      const params = discordPairingParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      try {
        return reply.send(
          projectPublicSecretValue(
            await fastify.services.integrations.revokeDiscordPairing(params.data.connectionId, params.data.pairingId),
          ),
        );
      } catch (error) {
        const message = (error as Error).message;
        return sendProjectedIntegrationError(reply, message.toLowerCase().includes("unknown") ? 404 : 409, message);
      }
    },
  );

  fastify.post("/api/v1/integrations/connections/:connectionId/discord/reconnect", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(
        projectPublicSecretValue(await fastify.services.integrations.reconnectDiscordRuntime(params.data.connectionId)),
      );
    } catch (error) {
      const message = (error as Error).message;
      return sendProjectedIntegrationError(reply, message.toLowerCase().includes("unknown") ? 404 : 409, message);
    }
  });

  fastify.get("/api/v1/integrations/plugins", async (_request, reply) => {
    return reply.send(
      projectPublicSecretValue({
        items: await fastify.services.integrations.listIntegrationPlugins(),
      }),
    );
  });

  fastify.post("/api/v1/integrations/plugins/install", async (request, reply) => {
    const parsed = pluginInstallSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply
        .code(201)
        .send(projectPublicSecretValue(await fastify.services.integrations.installIntegrationPlugin(parsed.data)));
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
      return reply.send(
        projectPublicSecretValue(
          await fastify.services.integrations.setIntegrationPluginEnabled(params.data.pluginId, true),
        ),
      );
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
      return reply.send(
        projectPublicSecretValue(
          await fastify.services.integrations.setIntegrationPluginEnabled(params.data.pluginId, false),
        ),
      );
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
        projectPublicSecretValue(
          await fastify.services.integrations.runIntegrationConnectionDiagnostics(params.data.connectionId),
        ),
      );
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("unknown integration connection");
      return sendProjectedIntegrationError(reply, notFound ? 404 : 409, message);
    }
  });
}

function sendProjectedIntegrationError(reply: FastifyReply, statusCode: number, message: string) {
  return reply.code(statusCode).send(projectPublicSecretValue({ error: message }));
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
        item.resumeState === "manual_retry_after_recorded_failure" ||
        item.resumeState === "manual_review_unknown_external_outcome" ||
        item.status === "unknown_external_outcome",
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
