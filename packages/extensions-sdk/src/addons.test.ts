import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADDON_MANIFEST_FILENAME,
  loadAddonAuthorManifest,
  validateAddonAuthorManifest,
} from "./addons.js";

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
