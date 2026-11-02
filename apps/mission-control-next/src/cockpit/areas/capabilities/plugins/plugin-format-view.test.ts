import { describe, expect, it } from "vitest";
import type { CapabilityPluginIgnoredPart } from "@goatcitadel/contracts";
import { coverageLine, leftOutGroups, pluginTrustLine } from "./plugin-format-view";

describe("plugin format view", () => {
  it("words the coverage line through plural()", () => {
    expect(coverageLine({ usable: 1, total: 1 })).toBe("GoatCitadel can use 1 of this plugin's 1 part.");
    expect(coverageLine({ usable: 1, total: 3 })).toBe("GoatCitadel can use 1 of this plugin's 3 parts.");
    expect(coverageLine({ usable: 3, total: 11 })).toBe("GoatCitadel can use 3 of this plugin's 11 parts.");
  });

  it("labels a Claude Code plugin's trust line, and leaves any other as it was", () => {
    expect(pluginTrustLine({ trust: "unverified", sourceFormat: "claude_code" })).toBe(
      "Claude Code format · Unverified",
    );
    expect(pluginTrustLine({ trust: "unverified" })).toBe("Unverified");
    expect(pluginTrustLine({ trust: "built_in", sourceFormat: "goatcitadel" })).toBe("Built in");
  });

  it("groups left-out parts by the kind the Gateway wrote, in a fixed order, plugin details last", () => {
    const part = (kind: CapabilityPluginIgnoredPart["kind"], label: string): CapabilityPluginIgnoredPart => ({
      kind,
      label,
      path: label,
      reason: "Why.",
    });
    const groups = leftOutGroups([
      part("manifest_field", "userConfig"),
      part("hook", "PreToolUse"),
      part("command", "go"),
      part("command", "stop"),
      part("mcp_server", "local"),
    ]);
    expect(groups.map((group) => [group.label, group.parts.map((item) => item.label)])).toEqual([
      ["Commands", ["go", "stop"]],
      ["Hooks", ["PreToolUse"]],
      ["Apps and servers", ["local"]],
      ["Other plugin details", ["userConfig"]],
    ]);
    expect(leftOutGroups([])).toEqual([]);
  });
});
