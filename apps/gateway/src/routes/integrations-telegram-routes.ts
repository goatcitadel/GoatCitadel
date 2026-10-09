import type { FastifyInstance } from "fastify";
import { buildTelegramTargetDirectory, resolveChannelTarget } from "../services/channel-target-directory.js";
import { z } from "zod";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";
import { sendRouteError } from "./_error-handler.js";
import { approveTelegramPairingCode, listTelegramPairingState, revokeTelegramPairingActor } from "../services/telegram-channel-pairing.js";
import { discoverTelegramTargets } from "../services/telegram-target-discovery.js";
import { resolveTelegramBotTokenEnvSecret } from "./integration-webhooks-shared.js";
import {
  channelTargetDirectoryQuerySchema,
  connectionParamsSchema,
  readConfigString,
  resolveRoutePersonalityCatalog,
  telegramDiscoverTargetsSchema,
  telegramPairingApproveSchema,
} from "./integrations-shared.js";

interface TelegramDiscoveryTokenInput {
  connectionId?: string;
  botToken?: string;
  botTokenEnv?: string;
}

const RATE_LIMIT_READ_MAX = 500;
const RATE_LIMIT_AUTH_MAX = 60;

export function registerTelegramIntegrationRoutes(fastify: FastifyInstance): void {
  const channelReadRoute = {
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

  fastify.post("/api/v1/integrations/telegram/discover-targets", async (request, reply) => {
    const parsed = telegramDiscoverTargetsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      if (parsed.data.connectionId && !parsed.data.botToken && !parsed.data.botTokenEnv) {
        const connection = await fastify.services.integrations.getIntegrationConnection(parsed.data.connectionId);
        const result = await fastify.services.channelSetup.discoverChannelSetupTelegramTargets({ source: "connection", connectionId: connection.connectionId, expectedConnectionRevision: connection.revision, setupCode: parsed.data.setupCode });
        return reply.header("cache-control", "no-store").send(result);
      }
      const token = await resolveTelegramDiscoveryToken(fastify, parsed.data);
      if (!token) {
        return reply.code(400).send({ error: "Provide a Telegram bot token, token env var, or connection id." });
      }
      const items = await discoverTelegramTargets({
        token,
        setupCode: parsed.data.setupCode,
        fetcher: (url, init) => fetch(url, init),
      });
      return reply.send({ items });
    } catch {
      return reply.code(502).send({ error: "Telegram target discovery could not complete. Check credentials, provider availability and the current delivery mode." });
    }
  });

  fastify.get(
    "/api/v1/channels/connections/:connectionId/target-directory",
    channelReadRoute,
    async (request, reply) => {
      const params = connectionParamsSchema.safeParse(request.params);
      const query = channelTargetDirectoryQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            query: query.success ? undefined : query.error.flatten(),
          },
        });
      }
      try {
        const connection = await fastify.services.integrations.getIntegrationConnection(params.data.connectionId);
        if (connection.key !== "telegram") {
          return reply.code(400).send({ error: "Target directory v1 is available for Telegram connections." });
        }
        const discoveredTargets = query.data.refresh
          ? (await fastify.services.channelSetup.discoverChannelSetupTelegramTargets({ source: "connection", connectionId: connection.connectionId, expectedConnectionRevision: connection.revision, setupCode: readConfigString(connection.config, "setupCode") })).items
          : [];
        const directory = buildTelegramTargetDirectory({
          connectionId: params.data.connectionId,
          connectionConfig: connection.config,
          discoveredTargets,
        });
        return reply.send({
          directory,
          ...(query.data.query ? { resolution: resolveChannelTarget(directory, query.data.query) } : {}),
        });
      } catch {
        return reply.code(502).send({ error: "Telegram target discovery could not complete. Check credentials, provider availability and the current delivery mode." });
      }
    },
  );

  const reviewedPairingSchema = z.object({ expectedConnectionRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  fastify.get("/api/v1/channels/connections/:connectionId/telegram/pairings", channelReadRoute, async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "A valid connection ID is required." });
    try {
      const connection = await fastify.services.integrations.getIntegrationConnection(params.data.connectionId);
      if (connection.key !== "telegram") throw new ValidationError({ message: "Pairing is available only for Telegram connections." });
      return reply.send(listTelegramPairingState(connection));
    } catch (error) { return sendRouteError(reply, error, request.log); }
  });
  fastify.post("/api/v1/channels/connections/:connectionId/telegram/pairings/approve", pairingMutationRoute, async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    const body = reviewedPairingSchema.extend({ code: z.string().trim().min(1).max(32) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "A pairing code and current connection revision are required." });
    try {
      const connection = await fastify.services.integrations.getIntegrationConnection(params.data.connectionId);
      assertReviewedTelegramConnection(connection, body.data.expectedConnectionRevision);
      const approval = approveTelegramPairingCode(connection.config, body.data.code);
      if (!approval.approved || !approval.configPatch) return reply.code(404).send({ error: "Pairing code was not found or has expired." });
      const updated = await fastify.services.integrations.updateIntegrationConnection(connection.connectionId, { expectedRevision: connection.revision, config: { ...connection.config, ...approval.configPatch } }, async () => { await markMutationCommitted(request); });
      return reply.send(listTelegramPairingState(updated));
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });
  fastify.post("/api/v1/channels/connections/:connectionId/telegram/pairings/:actorId/revoke", pairingMutationRoute, async (request, reply) => {
    const params = connectionParamsSchema.extend({ actorId: z.string().regex(/^\d{1,32}$/) }).safeParse(request.params);
    const body = reviewedPairingSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "A Telegram actor ID and current connection revision are required." });
    try {
      const connection = await fastify.services.integrations.getIntegrationConnection(params.data.connectionId);
      assertReviewedTelegramConnection(connection, body.data.expectedConnectionRevision);
      const updated = await fastify.services.integrations.updateIntegrationConnection(connection.connectionId, { expectedRevision: connection.revision, config: { ...connection.config, ...revokeTelegramPairingActor(connection.config, params.data.actorId) } }, async () => { await markMutationCommitted(request); });
      return reply.send(listTelegramPairingState(updated));
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });

  fastify.get("/api/v1/channels/personalities", async (_request, reply) => {
    return reply.send(await resolveRoutePersonalityCatalog(fastify.services));
  });

  fastify.post(
    "/api/v1/channels/connections/:connectionId/telegram/pairing/approve",
    pairingMutationRoute,
    async (request, reply) => {
      const params = connectionParamsSchema.safeParse(request.params);
      const parsed = telegramPairingApproveSchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: parsed.success ? undefined : parsed.error.flatten(),
          },
        });
      }
      try {
        const connection = await fastify.services.integrations.getIntegrationConnection(params.data.connectionId);
        if (connection.key !== "telegram") {
          return reply
            .code(400)
            .send({ error: "Telegram pairing approval is only available for Telegram connections." });
        }
        const approval = approveTelegramPairingCode(connection.config, parsed.data.code);
        if (!approval.approved || !approval.configPatch) {
          return reply.code(404).send({ error: "Pairing code was not found or has expired." });
        }
        const updated = await fastify.services.integrations.updateIntegrationConnection(params.data.connectionId, {
          expectedRevision: connection.revision,
          config: {
            ...connection.config,
            ...approval.configPatch,
          },
          lastSyncAt: new Date().toISOString(),
          lastError: undefined,
        });
        return reply.send({
          approved: true,
          actorId: approval.actorId,
          displayName: approval.displayName,
          connectionId: updated.connectionId,
        });
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );
}

async function resolveTelegramDiscoveryToken(
  fastify: FastifyInstance,
  input: TelegramDiscoveryTokenInput,
): Promise<string | undefined> {
  if (input.botToken?.trim()) {
    return input.botToken.trim();
  }
  if (input.botTokenEnv?.trim()) {
    // The env-var NAME is request-supplied; only resolve Telegram bot-token-shaped
    // names so generic GOATCITADEL_* / GC_* secrets cannot be routed to Telegram.
    return resolveTelegramBotTokenEnvSecret(input.botTokenEnv);
  }
  if (!input.connectionId) {
    return undefined;
  }
  throw new ValidationError({ message: "Use reviewed connection-owner discovery for saved Telegram credentials." });
}

function assertReviewedTelegramConnection(connection: { key: string; revision: string }, revision: string): void {
  if (connection.key !== "telegram") throw new ValidationError({ message: "Pairing is available only for Telegram connections." });
  if (connection.revision !== revision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "The Telegram connection changed. Reload it before changing sender access." });
}
