import type { FastifyInstance } from "fastify";
import { buildTelegramTargetDirectory, resolveChannelTarget } from "../services/channel-target-directory.js";
import { approveTelegramPairingCode } from "../services/telegram-channel-pairing.js";
import { discoverTelegramTargets } from "../services/telegram-target-discovery.js";
import { resolveAllowlistedEnvSecret } from "./integration-webhooks-shared.js";
import {
  channelTargetDirectoryQuerySchema,
  connectionParamsSchema,
  readConfigString,
  readEnvConfigString,
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
        const connection = fastify.services.integrations.getIntegrationConnection(params.data.connectionId);
        if (connection.key !== "telegram") {
          return reply.code(400).send({ error: "Target directory v1 is available for Telegram connections." });
        }
        const token = resolveTelegramDiscoveryToken(fastify, { connectionId: params.data.connectionId });
        const discoveredTargets =
          token && query.data.refresh
            ? await discoverTelegramTargets({
                token,
                setupCode: readConfigString(connection.config, "setupCode"),
                fetcher: (url, init) => fetch(url, init),
              })
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
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      }
    },
  );

  fastify.get("/api/v1/channels/personalities", async (_request, reply) => {
    return reply.send(resolveRoutePersonalityCatalog(fastify.services));
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
        const connection = fastify.services.integrations.getIntegrationConnection(params.data.connectionId);
        if (connection.key !== "telegram") {
          return reply
            .code(400)
            .send({ error: "Telegram pairing approval is only available for Telegram connections." });
        }
        const approval = approveTelegramPairingCode(connection.config, parsed.data.code);
        if (!approval.approved || !approval.configPatch) {
          return reply.code(404).send({ error: "Pairing code was not found or has expired." });
        }
        const updated = fastify.services.integrations.updateIntegrationConnection(params.data.connectionId, {
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

function resolveTelegramDiscoveryToken(
  fastify: FastifyInstance,
  input: TelegramDiscoveryTokenInput,
): string | undefined {
  if (input.botToken?.trim()) {
    return input.botToken.trim();
  }
  if (input.botTokenEnv?.trim()) {
    // The env-var NAME is request-supplied; only resolve allowlisted channel-secret
    // names so an attacker cannot exfiltrate arbitrary process env (e.g. DATABASE_URL,
    // AWS_SECRET_ACCESS_KEY) by routing it through the api.telegram.org bot-token path.
    return resolveAllowlistedEnvSecret(input.botTokenEnv);
  }
  if (!input.connectionId) {
    return undefined;
  }
  const connection = fastify.services.integrations.getIntegrationConnection(input.connectionId);
  const config = connection.config;
  return readConfigString(config, "botToken") ?? readEnvConfigString(config, "botTokenEnv");
}
