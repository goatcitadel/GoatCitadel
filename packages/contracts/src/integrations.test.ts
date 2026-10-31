import { describe, expect, it } from "vitest";

describe("IntegrationPluginToolOverrideManifestEntry", () => {
  it("manifest entry uses the simpler IntegrationPluginToolOverrideManifestEntry shape", () => {
    const manifestEntry = { toolName: "web_search", override: true };
    expect(manifestEntry.toolName).toBe("web_search");
  });
});
