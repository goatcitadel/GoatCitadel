import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildInstalledIntegrationPluginRecord,
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  resolveIntegrationPluginInstallMetadata,
  validateIntegrationPluginAuthorManifest,
} from "./integration-plugin-author-contract.js";

describe("integration plugin author contract", () => {
  it("validates the reference manifest shape", () => {
    expect(() =>
      validateIntegrationPluginAuthorManifest({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        version: "0.1.0",
        description: "Example reference plugin",
        capabilities: ["reference.install", "lifecycle.smoke"],
        theme: {
          accentColor: "#22d3ee",
          dashboardVariant: "compact",
        },
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
    ).toThrow(/capabilities/i);
  });

  it("loads the repo reference scaffold from a directory source", () => {
    const source = referencePluginSource();
    const resolved = resolveIntegrationPluginInstallMetadata(source);

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

  it("builds and updates installed plugin records from the reference scaffold", () => {
    const source = referencePluginSource();
    const created = buildInstalledIntegrationPluginRecord({
      now: "2026-03-30T10:00:00.000Z",
      pluginId: "reference-integration-plugin",
      source,
    });

    expect(created).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        version: "0.1.0",
        source,
        sourceMetadata: expect.objectContaining({
          type: "local",
          display: "Local: reference-integration-plugin",
          integrityStatus: "not_applicable",
        }),
        integrityStatus: "not_applicable",
        trustWarnings: [],
        enabled: true,
        installedAt: "2026-03-30T10:00:00.000Z",
        updatedAt: "2026-03-30T10:00:00.000Z",
        capabilities: expect.arrayContaining(["reference.install", "lifecycle.smoke"]),
      }),
    );

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

  it("keeps legacy installs compatible while surfacing trust warnings for unverified sources", () => {
    const created = buildInstalledIntegrationPluginRecord({
      now: "2026-03-30T10:00:00.000Z",
      pluginId: "remote-plugin",
      source: "https://example.com/plugin.js",
      expectedIntegrity: "sha256-example",
    });

    expect(created).toMatchObject({
      pluginId: "remote-plugin",
      label: "Remote Plugin",
      version: "0.1.0",
      sourceMetadata: {
        type: "url",
        display: "URL: example.com",
        integrityStatus: "missing",
        expectedIntegrity: "sha256-example",
      },
      integrityStatus: "missing",
      enabled: true,
    });
    expect(created.trustWarnings?.map((warning) => warning.code)).toEqual([
      "integrity_not_verified",
      "unverified_source",
    ]);
  });

  it("classifies GitHub URL sources by hostname instead of substring", () => {
    expect(resolveIntegrationPluginInstallMetadata("https://github.com/example/plugin").sourceMetadata.type).toBe(
      "git",
    );
    expect(resolveIntegrationPluginInstallMetadata("https://github.com.example.test/plugin").sourceMetadata.type).toBe(
      "url",
    );
    expect(resolveIntegrationPluginInstallMetadata("https://example.test/github.com/plugin").sourceMetadata.type).toBe(
      "url",
    );
  });

  it("normalizes install source displays for empty, git, npm, manual, and invalid-url overrides", () => {
    expect(resolveIntegrationPluginInstallMetadata("   ")).toMatchObject({
      sourceMetadata: {
        type: "unknown",
        display: "Unknown source",
        integrityStatus: "unknown",
      },
      trustWarnings: [expect.objectContaining({ code: "unverified_source" })],
    });
    expect(resolveIntegrationPluginInstallMetadata("git@github.com:goat/plugin.git")).toMatchObject({
      sourceMetadata: {
        type: "git",
        display: "Git source",
      },
      trustWarnings: [],
    });
    expect(resolveIntegrationPluginInstallMetadata("goat-plugin")).toMatchObject({
      sourceMetadata: {
        type: "npm",
        display: "goat-plugin",
      },
      trustWarnings: [],
    });
    expect(resolveIntegrationPluginInstallMetadata("npm:@goat/plugin", { sourceType: "npm" })).toMatchObject({
      sourceMetadata: {
        type: "npm",
        display: "@goat/plugin",
      },
    });
    expect(resolveIntegrationPluginInstallMetadata("plugin bundle", { sourceType: "manual" })).toMatchObject({
      sourceMetadata: {
        type: "manual",
        display: "Manual source",
      },
      trustWarnings: [expect.objectContaining({ code: "unverified_source" })],
    });
    expect(resolveIntegrationPluginInstallMetadata("not a url", { sourceType: "url" })).toMatchObject({
      sourceMetadata: {
        type: "url",
        display: "URL source",
      },
      trustWarnings: [expect.objectContaining({ code: "unverified_source" })],
    });
  });
});

function referencePluginSource(): string {
  const candidates = [
    path.resolve(process.cwd(), "templates/integration-plugins/reference-integration-plugin"),
    path.resolve(process.cwd(), "../..", "templates/integration-plugins/reference-integration-plugin"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}
