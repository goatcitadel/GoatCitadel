import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  loadIntegrationPluginAuthorManifest,
  resolveIntegrationPluginAuthorManifestSource,
  validateIntegrationPluginAuthorManifest,
} from "./integration-plugins.js";

describe("extensions sdk integration-plugin manifest helpers", () => {
  it("validates the reference integration-plugin manifest shape", () => {
    expect(
      validateIntegrationPluginAuthorManifest({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        version: "0.1.0",
        description: "Example reference plugin",
        capabilities: ["reference.install", "reference.install", " lifecycle.smoke ", " "],
        theme: {
          accentColor: "#0ee",
          icon: "plug",
          dashboardVariant: "compact",
        },
      }),
    ).toMatchObject({
      capabilities: ["reference.install", "lifecycle.smoke"],
      theme: {
        dashboardVariant: "compact",
      },
    });
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
    expect(resolved.manifest).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        version: "0.1.0",
        capabilities: expect.arrayContaining(["reference.install", "lifecycle.smoke"]),
      }),
    );
  });

  it("loads manifests from explicit files and resolves blank or missing sources without throwing", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(process.cwd(), "tmp-integration-plugin-"));
    const manifestPath = path.join(tempDir, INTEGRATION_PLUGIN_MANIFEST_FILENAME);
    await fsPromises.writeFile(
      manifestPath,
      JSON.stringify({
        pluginId: "temp-plugin",
        label: "Temporary Plugin",
        version: "1.0.0",
        capabilities: ["temp.run"],
        packageName: "@example/temp-plugin",
        integrity: {
          expected: "sha256-demo",
        },
      }),
      "utf8",
    );

    await expect(loadIntegrationPluginAuthorManifest(manifestPath)).resolves.toMatchObject({
      pluginId: "temp-plugin",
      packageName: "@example/temp-plugin",
    });
    expect(resolveIntegrationPluginAuthorManifestSource(manifestPath)).toMatchObject({
      source: manifestPath,
      manifestPath,
      manifest: expect.objectContaining({ pluginId: "temp-plugin" }),
    });
    expect(resolveIntegrationPluginAuthorManifestSource("   ")).toEqual({ source: "" });
    expect(resolveIntegrationPluginAuthorManifestSource(path.join(tempDir, "missing"))).toEqual({
      source: path.join(tempDir, "missing"),
    });
    expect(resolveIntegrationPluginAuthorManifestSource(tempDir)).toMatchObject({
      source: tempDir,
      manifestPath,
    });

    await fsPromises.rm(manifestPath);
    expect(resolveIntegrationPluginAuthorManifestSource(tempDir)).toEqual({ source: tempDir });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
