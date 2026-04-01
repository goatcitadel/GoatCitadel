import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  resolveIntegrationPluginAuthorManifestSource,
  validateIntegrationPluginAuthorManifest,
} from "./integration-plugins.js";

describe("extensions sdk integration-plugin manifest helpers", () => {
  it("validates the reference integration-plugin manifest shape", () => {
    expect(() =>
      validateIntegrationPluginAuthorManifest({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        version: "0.1.0",
        description: "Example reference plugin",
        capabilities: ["reference.install", "lifecycle.smoke"],
      }),
    ).not.toThrow();
  });

  it("rejects manifests without capabilities", () => {
    expect(() =>
      validateIntegrationPluginAuthorManifest({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        version: "0.1.0",
        capabilities: [],
      }),
    ).toThrow(/array/i);
  });

  it("resolves the repo reference integration-plugin scaffold from a directory source", () => {
    const source = path.resolve(process.cwd(), "../../templates/integration-plugins/reference-integration-plugin");
    const resolved = resolveIntegrationPluginAuthorManifestSource(source);

    expect(resolved.manifestPath).toBe(path.join(source, INTEGRATION_PLUGIN_MANIFEST_FILENAME));
    expect(resolved.manifest).toEqual(expect.objectContaining({
      pluginId: "reference-integration-plugin",
      label: "Reference Integration Plugin",
      version: "0.1.0",
      capabilities: expect.arrayContaining(["reference.install", "lifecycle.smoke"]),
    }));
  });
});
