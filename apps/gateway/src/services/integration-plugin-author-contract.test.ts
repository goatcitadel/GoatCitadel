import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInstalledIntegrationPluginRecord,
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  resolveIntegrationPluginInstallMetadata,
  validateIntegrationPluginAuthorManifest,
} from "./integration-plugin-author-contract.js";

describe("integration plugin author contract", () => {
  it("validates the reference manifest shape", () => {
    expect(() => validateIntegrationPluginAuthorManifest({
      pluginId: "reference-integration-plugin",
      label: "Reference Integration Plugin",
      version: "0.1.0",
      description: "Example reference plugin",
      capabilities: ["reference.install", "lifecycle.smoke"],
    })).not.toThrow();
  });

  it("rejects manifests without capabilities", () => {
    expect(() => validateIntegrationPluginAuthorManifest({
      pluginId: "reference-integration-plugin",
      label: "Reference Integration Plugin",
      version: "0.1.0",
      capabilities: [],
    })).toThrow(/capabilities/i);
  });

  it("loads the repo reference scaffold from a directory source", () => {
    const source = path.resolve(process.cwd(), "../../templates/integration-plugins/reference-integration-plugin");
    const resolved = resolveIntegrationPluginInstallMetadata(source);

    expect(resolved.manifestPath).toBe(path.join(source, INTEGRATION_PLUGIN_MANIFEST_FILENAME));
    expect(resolved.manifest).toEqual(expect.objectContaining({
      pluginId: "reference-integration-plugin",
      label: "Reference Integration Plugin",
      version: "0.1.0",
      capabilities: expect.arrayContaining(["reference.install", "lifecycle.smoke"]),
    }));
  });

  it("builds and updates installed plugin records from the reference scaffold", () => {
    const source = path.resolve(process.cwd(), "../../templates/integration-plugins/reference-integration-plugin");
    const created = buildInstalledIntegrationPluginRecord({
      now: "2026-03-30T10:00:00.000Z",
      pluginId: "reference-integration-plugin",
      source,
    });

    expect(created).toEqual(expect.objectContaining({
      pluginId: "reference-integration-plugin",
      label: "Reference Integration Plugin",
      version: "0.1.0",
      source,
      enabled: true,
      installedAt: "2026-03-30T10:00:00.000Z",
      updatedAt: "2026-03-30T10:00:00.000Z",
      capabilities: expect.arrayContaining(["reference.install", "lifecycle.smoke"]),
    }));

    const updated = buildInstalledIntegrationPluginRecord({
      now: "2026-03-30T12:00:00.000Z",
      pluginId: "reference-integration-plugin",
      source,
      existing: {
        ...created,
        enabled: false,
        updatedAt: "2026-03-30T11:00:00.000Z",
      },
    });

    expect(updated.enabled).toBe(false);
    expect(updated.installedAt).toBe("2026-03-30T10:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-03-30T12:00:00.000Z");
    expect(updated.source).toBe(source);
  });
});
