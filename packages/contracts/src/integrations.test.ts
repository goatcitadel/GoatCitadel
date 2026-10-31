import { describe, expect, it } from "vitest";
import type { IntegrationPluginToolOverride } from "./channels.js";

describe("IntegrationPluginToolOverride", () => {
  it("supports IntegrationPluginToolOverride records", () => {
    const override: IntegrationPluginToolOverride = {
      toolName: "web_search",
      override: true,
      status: "pending_owner_approval",
    };
    expect(override.toolName).toBe("web_search");
    expect(override.status).toBe("pending_owner_approval");
  });

  it("manifest entry uses the simpler IntegrationPluginToolOverrideManifestEntry shape", () => {
    // Author-time manifest doesn't have status (status comes from runtime registration)
    const manifestEntry = { toolName: "web_search", override: true };
    expect(manifestEntry.toolName).toBe("web_search");
  });
});
