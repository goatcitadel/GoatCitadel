import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { composeIntegrationChannelRouteDependencies } from "./gateway-route-composition-integrations.js";
import { registerChannelSetupIntegrationRoutes } from "../routes/integrations-channel-setup-routes.js";
import { registerIntegrationControlRoutes } from "../routes/integrations-control-routes.js";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";

it("serves channel setup definitions without author guidance", async () => {
  // A record left behind by a build that still had integration plugins must not feed the setup guides.
  const configurationForm = {
    version: "goatcitadel.extension-configuration.v1",
    fields: [{ key: "webhookUrl", label: "Author endpoint guidance", kind: "url" }],
    prerequisites: ["Review the service account"],
    sampleTask: { prompt: "Propose a read-only test", expectedOutcome: "A reviewed real result" },
  };
  const read = vi.fn(async () => ({ value: [{ pluginId: "googlechat", version: "1.0.0", configurationForm }] }));
  const gateway = {
    config: { rootDir: process.cwd() },
    storage: { systemSettings: { get: read } },
    recentChannelSetupTests: new Map(),
  } as unknown as GatewayRouteCompositionPort;
  const domains = composeIntegrationChannelRouteDependencies(gateway);
  const app = Fastify();
  app.decorate("services", domains as never);
  registerChannelSetupIntegrationRoutes(app);
  registerIntegrationControlRoutes(app);
  try {
    const catalogId = "channel.google-chat";
    const definition = await app.inject({
      method: "GET",
      url: `/api/v1/channels/catalog/${catalogId}/setup-definition`,
    });
    expect(definition.statusCode, definition.body).toBe(200);
    expect(definition.json()).not.toHaveProperty("configurationGuidance");
    expect(definition.json().wizard).toEqual(requireChannelSetupDefinition(catalogId).definition.wizard);

    const list = await app.inject({ method: "GET", url: "/api/v1/channels/setup-definitions" });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().items as Array<{ catalog: { catalogId: string } }>;
    expect(items.find((entry) => entry.catalog.catalogId === catalogId)).toBeDefined();
    for (const item of items) {
      expect(item).not.toHaveProperty("configurationGuidance");
    }

    const fields = await app.inject({ method: "GET", url: `/api/v1/integrations/catalog/${catalogId}/form-schema` });
    expect(fields.statusCode, fields.body).toBe(200);
    expect(fields.json()).not.toHaveProperty("configurationGuidance");

    const catalog = await app.inject({ method: "GET", url: "/api/v1/integrations/catalog?kind=channel" });
    expect(catalog.statusCode, catalog.body).toBe(200);
    const googleChat = (catalog.json().items as Array<{ catalogId: string }>).find(
      (entry) => entry.catalogId === catalogId,
    );
    expect(googleChat).toBeDefined();
    expect(googleChat).not.toHaveProperty("pluginId");
    expect(googleChat).not.toHaveProperty("formSchema.configurationGuidance");

    expect((await app.inject({ method: "GET", url: "/api/v1/integrations/plugins" })).statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
