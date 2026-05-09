import { vi } from "vitest";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { integrationWebhookRoutes } from "./integration-webhooks.js";
import { integrationsRoutes as baseIntegrationsRoutes } from "./integrations.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

export const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(baseIntegrationsRoutes);
  await fastify.register(integrationWebhookRoutes);
};

const gatewayAuthMethodNames = new Set([
  "validateDeviceAccessToken",
  "validateCompanionAccessToken",
  "verifyCompanionRequestSignature",
]);

export function decorateIntegrationServices(app: FastifyInstance, methods: Record<string, unknown>) {
  const routeMethods: Record<string, unknown> = {};
  const gatewayMethods: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(methods)) {
    if (gatewayAuthMethodNames.has(key)) {
      gatewayMethods[key] = value;
      continue;
    }
    routeMethods[key] = value;
  }
  if (Object.keys(routeMethods).length > 0) {
    app.decorate("services", {
      channelSetup: routeMethods,
      integrations: routeMethods,
      obsidian: routeMethods,
      integrationWebhooks: {
        hasRunningTurn: () => false,
        ...routeMethods,
      },
    } as never);
  }
  app.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: true }),
    validateDeviceAccessToken: () => undefined,
    validateCompanionAccessToken: () => undefined,
    verifyCompanionRequestSignature: () => undefined,
    ...gatewayMethods,
  } as never);
}

export async function cleanupIntegrationTestApp(app: FastifyInstance | null): Promise<void> {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (app) {
    await app.close();
  }
}
