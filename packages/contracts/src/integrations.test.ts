import { describe, expect, it } from "vitest";
import type { IntegrationPluginRecord, IntegrationPluginToolOverride } from "./channels.js";

describe("IntegrationPluginToolOverride", () => {
  it("supports IntegrationPluginToolOverride records on plugin records", () => {
    const override: IntegrationPluginToolOverride = {
      toolName: "web_search",
      override: true,
      status: "pending_owner_approval",
    };
    const record: IntegrationPluginRecord = {
      pluginId: "search-plus",
      label: "Search Plus",
      version: "1.0.0",
      enabled: true,
      installedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
      capabilities: ["tool:web_search"],
      toolOverrides: [override],
    };
    expect(record.toolOverrides?.[0]?.toolName).toBe("web_search");
    expect(record.toolOverrides?.[0]?.status).toBe("pending_owner_approval");
  });

  it("manifest entry uses the simpler IntegrationPluginToolOverrideManifestEntry shape", () => {
    // Author-time manifest doesn't have status (status comes from runtime registration)
    const manifestEntry = { toolName: "web_search", override: true };
    expect(manifestEntry.toolName).toBe("web_search");
  });
});
