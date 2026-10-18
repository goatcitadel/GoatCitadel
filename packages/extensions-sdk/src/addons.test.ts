import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADDON_MANIFEST_FILENAME, loadAddonAuthorManifest, validateAddonAuthorManifest } from "./addons.js";

describe("extensions sdk add-on manifest helpers", () => {
  it("loads the reference add-on scaffold manifest", async () => {
    const manifest = await loadAddonAuthorManifest(
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "templates",
        "addons",
        "reference-separate-repo-addon",
        ADDON_MANIFEST_FILENAME,
      ),
    );

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.addon.addonId).toBe("reference-addon");
    expect(manifest.addon.runtimeType).toBe("separate_repo_app");
    expect(manifest.addon.requiresSeparateRepoDownload).toBe(true);
    // The launch contract survives validation instead of being stripped as an unknown key.
    expect(manifest.addon.launch).toMatchObject({
      command: "corepack",
      args: ["pnpm", "run", "start"],
      dataFiles: [{ envVar: "REFERENCE_ADDON_DB_PATH", fileName: "reference.db" }],
      health: { url: "http://127.0.0.1:3100/health", readyWhen: { status: "ok" } },
    });
  });

  it("rejects a launch contract whose health probe leaves loopback", async () => {
    const manifest = await loadAddonAuthorManifest(
      path.resolve(
        process.cwd(),
        "..",
        "..",
        "templates",
        "addons",
        "reference-separate-repo-addon",
        ADDON_MANIFEST_FILENAME,
      ),
    );
    const remoteProbe = {
      ...manifest,
      addon: {
        ...manifest.addon,
        launch: {
          ...manifest.addon.launch!,
          health: { ...manifest.addon.launch!.health, url: "http://example.test/health" },
        },
      },
    };

    expect(() => validateAddonAuthorManifest(remoteProbe)).toThrow(/loopback/);
  });

  it("rejects malformed add-on manifests", () => {
    expect(() =>
      validateAddonAuthorManifest({
        schemaVersion: 1,
        addon: {
          addonId: "broken-addon",
        },
      }),
    ).toThrow();
  });
});
