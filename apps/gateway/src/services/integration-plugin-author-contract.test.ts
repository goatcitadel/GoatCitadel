import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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
        descriptorHealth: expect.objectContaining({
          status: "healthy",
          evidence: expect.objectContaining({
            owner: "gateway",
            descriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
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

  it("preserves manifest tool overrides as pending owner approval entries", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-plugin-manifest-"));
    try {
      fs.writeFileSync(
        path.join(source, INTEGRATION_PLUGIN_MANIFEST_FILENAME),
        JSON.stringify({
          pluginId: "override-plugin",
          label: "Override Plugin",
          version: "1.0.0",
          capabilities: ["channel.send"],
          toolOverrides: [{ toolName: "channel.send", override: true }],
        }),
        "utf8",
      );

      const created = buildInstalledIntegrationPluginRecord({
        now: "2026-03-30T10:00:00.000Z",
        pluginId: "override-plugin",
        source,
      });

      expect(created.toolOverrides).toEqual([
        { toolName: "channel.send", override: true, status: "pending_owner_approval" },
      ]);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
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
      "descriptor.missing",
    ]);
    expect(created.descriptorHealth).toMatchObject({
      status: "warning",
      issues: [expect.objectContaining({ code: "descriptor.missing" })],
    });
  });

  it("quarantines malformed local plugin descriptors with readable evidence", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-plugin-broken-manifest-"));
    try {
      fs.writeFileSync(
        path.join(source, INTEGRATION_PLUGIN_MANIFEST_FILENAME),
        JSON.stringify({
          pluginId: "broken-plugin",
          label: "Broken Plugin",
          version: "1.0.0",
          capabilities: [],
        }),
        "utf8",
      );

      const created = buildInstalledIntegrationPluginRecord({
        now: "2026-03-30T10:00:00.000Z",
        pluginId: "broken-plugin",
        source,
      });

      expect(created.enabled).toBe(false);
      expect(created.integrityStatus).toBe("quarantined");
      expect(created.descriptorHealth).toMatchObject({
        status: "quarantined",
        summary: expect.stringContaining("malformed"),
        issues: [
          expect.objectContaining({
            code: "manifest.too_small",
            severity: "critical",
            message: expect.stringContaining("capabilities"),
          }),
        ],
        evidence: expect.objectContaining({
          owner: "gateway",
          source: "integration_plugin_descriptor",
          status: "quarantined",
        }),
      });
      expect(created.trustWarnings?.map((warning) => warning.code)).toContain("manifest.too_small");
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
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
    const empty = resolveIntegrationPluginInstallMetadata("   ");
    expect(empty).toMatchObject({
      sourceMetadata: {
        type: "unknown",
        display: "Unknown source",
        integrityStatus: "unknown",
      },
    });
    expect(empty.trustWarnings.map((warning) => warning.code)).toEqual(["unverified_source", "descriptor.missing"]);

    const git = resolveIntegrationPluginInstallMetadata("git@github.com:goat/plugin.git");
    expect(git).toMatchObject({
      sourceMetadata: {
        type: "git",
        display: "Git source",
      },
    });
    expect(git.trustWarnings.map((warning) => warning.code)).toEqual(["descriptor.missing"]);

    const npm = resolveIntegrationPluginInstallMetadata("goat-plugin");
    expect(npm).toMatchObject({
      sourceMetadata: {
        type: "npm",
        display: "goat-plugin",
      },
    });
    expect(npm.trustWarnings.map((warning) => warning.code)).toEqual(["descriptor.missing"]);

    expect(resolveIntegrationPluginInstallMetadata("npm:@goat/plugin", { sourceType: "npm" })).toMatchObject({
      sourceMetadata: {
        type: "npm",
        display: "@goat/plugin",
      },
    });
    const manual = resolveIntegrationPluginInstallMetadata("plugin bundle", { sourceType: "manual" });
    expect(manual).toMatchObject({
      sourceMetadata: {
        type: "manual",
        display: "Manual source",
      },
    });
    expect(manual.trustWarnings.map((warning) => warning.code)).toEqual(["unverified_source", "descriptor.missing"]);

    const invalidUrl = resolveIntegrationPluginInstallMetadata("not a url", { sourceType: "url" });
    expect(invalidUrl).toMatchObject({
      sourceMetadata: {
        type: "url",
        display: "URL source",
      },
    });
    expect(invalidUrl.trustWarnings.map((warning) => warning.code)).toEqual([
      "unverified_source",
      "descriptor.missing",
    ]);
  });
});

function referencePluginSource(): string {
  const candidates = [
    path.resolve(process.cwd(), "templates/integration-plugins/reference-integration-plugin"),
    path.resolve(process.cwd(), "../..", "templates/integration-plugins/reference-integration-plugin"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}
