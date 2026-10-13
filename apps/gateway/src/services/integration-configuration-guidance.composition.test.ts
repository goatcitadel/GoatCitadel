import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { composeIntegrationChannelRouteDependencies } from "./gateway-route-composition-integrations.js";
import { registerChannelSetupIntegrationRoutes } from "../routes/integrations-channel-setup-routes.js";
import { registerIntegrationControlRoutes } from "../routes/integrations-control-routes.js";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";

it("projects installed manifest guidance through actual catalog and canonical channel setup read owners without changing the wizard", async () => {
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
    expect(definition.json()).toMatchObject({
      configurationGuidance: { pluginId: "googlechat", form: configurationForm },
    });
    expect(definition.json().wizard).toEqual(requireChannelSetupDefinition(catalogId).definition.wizard);
    const list = await app.inject({ method: "GET", url: "/api/v1/channels/setup-definitions" });
    expect(
      list.json().items.find((entry: { catalog: { catalogId: string } }) => entry.catalog.catalogId === catalogId),
    ).toMatchObject({ configurationGuidance: { form: configurationForm } });
    const fields = await app.inject({ method: "GET", url: `/api/v1/integrations/catalog/${catalogId}/form-schema` });
    expect(fields.json()).toMatchObject({ configurationGuidance: { form: configurationForm } });
    const plugins = await app.inject({ method: "GET", url: "/api/v1/integrations/plugins" });
    expect(plugins.json()).toMatchObject({ items: [{ pluginId: "googlechat", configurationForm }] });
  } finally {
    await app.close();
  }
});
