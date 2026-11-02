import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./http-internal.js";
import { readPluginOwnedRefusal } from "./plugin-owned-refusal.js";

function refusal(status: number, body: unknown) {
  return new ApiRequestError("refused", { kind: "http", method: "POST", path: "/api/v1/x", status, body });
}

describe("readPluginOwnedRefusal", () => {
  it("reads the plugin's sentence and id from a 409 PLUGIN_OWNED refusal", () => {
    const error = refusal(409, {
      error: "From Browser checks. Uninstall it to remove this.",
      code: "PLUGIN_OWNED",
      details: { pluginId: "browser-checks" },
    });

    expect(readPluginOwnedRefusal(error)).toEqual({
      message: "From Browser checks. Uninstall it to remove this.",
      pluginId: "browser-checks",
    });
  });

  it("reads a refusal that names no plugin without an id", () => {
    const error = refusal(409, {
      error: "This came with a plugin. Uninstall it to remove this.",
      code: "PLUGIN_OWNED",
    });

    expect(readPluginOwnedRefusal(error)).toEqual({ message: "This came with a plugin. Uninstall it to remove this." });
  });

  it("leaves every other error to the caller's own words", () => {
    expect(readPluginOwnedRefusal(refusal(409, { error: "Changed.", code: "WRITE_CONFLICT" }))).toBeUndefined();
    expect(readPluginOwnedRefusal(refusal(403, { error: "No.", code: "PLUGIN_OWNED" }))).toBeUndefined();
    expect(readPluginOwnedRefusal(refusal(409, { error: " ", code: "PLUGIN_OWNED" }))).toBeUndefined();
    expect(readPluginOwnedRefusal(refusal(409, "text"))).toBeUndefined();
    expect(readPluginOwnedRefusal(new Error("network"))).toBeUndefined();
  });
});
