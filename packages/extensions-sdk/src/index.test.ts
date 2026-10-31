import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

describe("extensions sdk barrel", () => {
  it("exports the tool directory helpers and the plugin manifest tools", () => {
    expect(Object.keys(sdk).sort()).toEqual([
      "PLUGIN_LIMITS",
      "PLUGIN_MANIFEST_FILENAME",
      "buildToolSchemaRefIndex",
      "dereferenceEffectiveToolSchema",
      "findEffectiveToolByName",
      "listEffectiveCallableTools",
      "loadPluginManifest",
      "parsePluginManifest",
      "pluginManifestSchema",
      "validateCompactToolDirectorySnapshot",
    ]);
  });
});
