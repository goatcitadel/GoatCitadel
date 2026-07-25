import path from "node:path";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_PLUGIN_MANIFEST_FILENAME,
  INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES,
  loadIntegrationPluginAuthorManifest,
  resolveIntegrationPluginAuthorManifestSource,
  validateIntegrationPluginAuthorManifest,
  validateIntegrationPluginAuthorManifestDetailed,
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

  it("returns readable descriptor health issues for malformed manifests", () => {
    const result = validateIntegrationPluginAuthorManifestDetailed({
      pluginId: "broken",
      label: "Broken",
      version: "1.0.0",
      capabilities: [],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "manifest.too_small",
        severity: "critical",
        message: expect.stringContaining("capabilities"),
        action: expect.stringContaining("Fix goatcitadel.integration-plugin.json"),
      }),
    ]);
  });

  it("returns descriptor hashes for valid manifests without changing normalized output", () => {
    const result = validateIntegrationPluginAuthorManifestDetailed({
      pluginId: "reference-integration-plugin",
      label: "Reference Integration Plugin",
      version: "0.1.0",
      capabilities: ["reference.install", "reference.install"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.capabilities).toEqual(["reference.install"]);
      expect(result.descriptorHash).toMatch(/^[a-f0-9]{64}$/);
    }
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

  it("bounds descriptor metadata before parsing and quarantines oversized local sources", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(process.cwd(), "tmp-integration-plugin-oversized-"));
    const manifestPath = path.join(tempDir, INTEGRATION_PLUGIN_MANIFEST_FILENAME);
    await fsPromises.writeFile(manifestPath, "x".repeat(INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES + 1), "utf8");

    await expect(loadIntegrationPluginAuthorManifest(manifestPath)).rejects.toThrow(/byte limit/i);
    expect(resolveIntegrationPluginAuthorManifestSource(tempDir)).toMatchObject({
      source: tempDir,
      manifestPath,
      manifestError: expect.stringMatching(/byte limit/i),
    });

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("keeps async descriptor reads bounded when an opened file grows after fstat", async () => {
    const close = vi.fn(async () => undefined);
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(0x78, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    const open = vi.spyOn(fsPromises, "open").mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: 1 }),
      read,
      close,
    } as never);

    try {
      await expect(loadIntegrationPluginAuthorManifest("growing-integration-plugin.json")).rejects.toThrow(
        /byte limit/i,
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]?.[2]).toBe(INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES + 1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it("keeps sync descriptor reads bounded when an opened file grows after fstat", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(process.cwd(), "tmp-integration-plugin-growing-sync-"));
    const manifestPath = path.join(tempDir, INTEGRATION_PLUGIN_MANIFEST_FILENAME);
    await fsPromises.writeFile(manifestPath, "{}", "utf8");
    const open = vi.spyOn(fs, "openSync").mockReturnValueOnce(123);
    const fstat = vi.spyOn(fs, "fstatSync").mockReturnValueOnce({ isFile: () => true, size: 2 } as never);
    const read = vi.spyOn(fs, "readSync").mockImplementationOnce((_descriptor, buffer, offset, length) => {
      (buffer as Buffer).fill(0x78, offset, offset + length);
      return length;
    });
    const close = vi.spyOn(fs, "closeSync").mockImplementationOnce(() => undefined);

    try {
      expect(resolveIntegrationPluginAuthorManifestSource(tempDir)).toMatchObject({
        source: tempDir,
        manifestPath,
        manifestError: expect.stringMatching(/byte limit/i),
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]?.[3]).toBe(INTEGRATION_PLUGIN_MANIFEST_MAX_BYTES + 1);
      expect(close).toHaveBeenCalledWith(123);
    } finally {
      close.mockRestore();
      read.mockRestore();
      fstat.mockRestore();
      open.mockRestore();
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
