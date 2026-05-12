import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

describe("extensions sdk barrel", () => {
  it("exports add-on and integration plugin helpers", () => {
    expect(sdk.ADDON_MANIFEST_FILENAME).toBe("goatcitadel.addon.json");
    expect(sdk.INTEGRATION_PLUGIN_MANIFEST_FILENAME).toBe("goatcitadel.integration-plugin.json");
    expect(typeof sdk.validateAddonAuthorManifest).toBe("function");
    expect(typeof sdk.validateIntegrationPluginAuthorManifest).toBe("function");
  });
});
