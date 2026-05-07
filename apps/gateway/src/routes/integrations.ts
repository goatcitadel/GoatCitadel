import type { FastifyPluginAsync } from "fastify";
import { registerChannelSetupIntegrationRoutes } from "./integrations-channel-setup-routes.js";
import { registerIntegrationControlRoutes } from "./integrations-control-routes.js";
import { registerObsidianIntegrationRoutes } from "./integrations-obsidian-routes.js";
import { registerSlackOAuthIntegrationRoutes } from "./integrations-slack-oauth-routes.js";
import { registerTelegramIntegrationRoutes } from "./integrations-telegram-routes.js";

export const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  registerSlackOAuthIntegrationRoutes(fastify);
  registerTelegramIntegrationRoutes(fastify);
  registerChannelSetupIntegrationRoutes(fastify);
  registerIntegrationControlRoutes(fastify);
  registerObsidianIntegrationRoutes(fastify);
};
