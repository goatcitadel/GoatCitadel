import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type {
  ExtensionConfigurationForm,
  IntegrationFormSchema,
  IntegrationPluginRecord,
} from "@goatcitadel/contracts";
import {
  projectIntegrationConfigurationGuidance,
  projectIntegrationPluginConfiguration,
} from "./integration-configuration-guidance.js";
import { registerIntegrationControlRoutes } from "../routes/integrations-control-routes.js";

const schema: IntegrationFormSchema = {
  catalogId: "channel.fixture",
  title: "Fixture",
  fields: [
    {
      key: "endpoint",
      label: "Endpoint",
      type: "url",
      required: true,
      defaultValue: "https://owner.invalid",
      description: "Owner URL rule.",
    },
    { key: "tokenEnv", label: "Token variable", type: "text", secretRef: true },
    { key: "rawToken", label: "Secure token", type: "password" },
  ],
};
const form: ExtensionConfigurationForm = {
  version: "goatcitadel.extension-configuration.v1",
  prerequisites: ["Review the remote service."],
  fields: [
    {
      key: "endpoint",
      label: "Service endpoint",
      kind: "url",
      help: "Use the service URL.",
      defaultValue: "https://author.invalid",
    },
    { key: "tokenEnv", label: "Service token reference", kind: "secret_ref", referenceKind: "environment" },
    { key: "rawToken", label: "Would weaken custody", kind: "text" },
    { key: "newSetting", label: "Unknown setting", kind: "boolean", defaultValue: true },
  ],
  sampleTask: { prompt: "Review a read-only test before running it.", expectedOutcome: "A real tool result." },
};
const plugin = { pluginId: "fixture", version: "1.2.3", configurationForm: form } as IntegrationPluginRecord;

describe("extension configuration presentation", () => {
  it("keeps old plugin records valid and projects malformed/future metadata as an actionable warning without mutating storage", () => {
    const legacy = { ...plugin, configurationForm: undefined };
    expect(projectIntegrationPluginConfiguration(legacy)).toBe(legacy);
    const invalid = {
      ...plugin,
      configurationForm: { ...form, version: "future" },
    } as unknown as IntegrationPluginRecord;
    const projected = projectIntegrationPluginConfiguration(invalid);
    expect(projected.configurationForm).toBeUndefined();
    expect(projected.trustWarnings?.at(-1)).toMatchObject({
      code: "configuration.metadata_unsupported",
      severity: "warning",
    });
    expect(invalid.configurationForm).toBeDefined();
  });
  it("supplements exact supported fields without changing accepted keys, custody, requiredness or defaults", () => {
    const before = structuredClone(schema);
    const projected = projectIntegrationConfigurationGuidance(schema, { pluginId: "fixture" }, [plugin]);
    expect(projected.fields).toEqual([
      { ...schema.fields[0], label: "Service endpoint", description: "Owner URL rule.\nUse the service URL." },
      { ...schema.fields[1], label: "Service token reference", description: undefined },
      schema.fields[2],
    ]);
    expect(projected.configurationGuidance).toMatchObject({
      pluginId: "fixture",
      pluginVersion: "1.2.3",
      supportedFieldKeys: ["endpoint", "tokenEnv"],
      form,
    });
    expect(schema).toEqual(before);
  });
  it("keeps old, unknown-version, ambiguous, quarantined and unrelated manifests out of field projection", () => {
    for (const [catalog, plugins] of [
      [undefined, [plugin]],
      [{ pluginId: "other" }, [plugin]],
      [{ pluginId: "fixture" }, []],
      [{ pluginId: "fixture" }, [{ ...plugin, configurationForm: undefined }]],
      [{ pluginId: "fixture" }, [{ ...plugin, configurationForm: { ...form, version: "future" } }]],
      [{ pluginId: "fixture" }, [{ ...plugin, integrityStatus: "quarantined" }]],
      [{ pluginId: "fixture" }, [plugin, plugin]],
    ] as Array<[undefined | { pluginId: string }, IntegrationPluginRecord[]]>) {
      expect(projectIntegrationConfigurationGuidance(schema, catalog, plugins)).toBe(schema);
    }
  });
  it("returns the optional guidance through the existing form-schema API with original field defaults", async () => {
    const app = Fastify();
    app.decorate("services", {
      integrations: {
        getIntegrationFormSchema: async () =>
          projectIntegrationConfigurationGuidance(schema, { pluginId: "fixture" }, [plugin]),
      },
    } as never);
    registerIntegrationControlRoutes(app);
    try {
      const result = await app.inject({
        method: "GET",
        url: "/api/v1/integrations/catalog/channel.fixture/form-schema",
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        fields: [{ key: "endpoint", defaultValue: "https://owner.invalid" }, {}, {}],
        configurationGuidance: { form: { sampleTask: form.sampleTask } },
      });
    } finally {
      await app.close();
    }
  });
});
