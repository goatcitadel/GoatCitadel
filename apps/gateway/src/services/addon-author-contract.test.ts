import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAddonAuthorManifest, validateAddonAuthorManifest } from "./addon-author-contract.js";

// Anchor on this file's location, not process.cwd(), so the test resolves the
// repo-root templates regardless of where the runner is launched from.
// src/services -> repo root is four levels up.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("addon author contract", () => {
  it("validates the reference add-on scaffold manifest", async () => {
    const manifest = await loadAddonAuthorManifest(
      path.resolve(
        repoRoot,
        "templates",
        "addons",
        "reference-separate-repo-addon",
        "goatcitadel.addon.json",
      ),
    );

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.addon.addonId).toBe("reference-addon");
    expect(manifest.addon.runtimeType).toBe("separate_repo_app");
    expect(manifest.addon.requiresSeparateRepoDownload).toBe(true);
  });

  it("rejects malformed author manifests", () => {
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
