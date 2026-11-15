import { describe, expect, it } from "vitest";
import { FEATURE_SWITCHES, featureSwitchHref, isFeatureSwitchFlag } from "./feature-switches";

describe("feature switches", () => {
  it("lists the ten switches in a fixed order with plain labels and Settings anchors", () => {
    expect(FEATURE_SWITCHES.map((entry) => entry.label)).toEqual([
      "Memory administration",
      "Memory maintenance",
      "Skills in Chat",
      "Connectors in Chat",
      "Connector diagnostics",
      "Scheduler review",
      "Engineering learnings",
      "Provider fallback in Chat",
      "Subagents in Chat",
      "Utility model for background jobs",
    ]);
    expect(featureSwitchHref("memoryLifecycleAdminV1Enabled")).toBe(
      "/settings/advanced#feature-switch-memory-administration",
    );
    expect(featureSwitchHref("chatStaticMcpV1Enabled")).toBe("/settings/advanced#feature-switch-connectors-in-chat");
    expect(new Set(FEATURE_SWITCHES.map((entry) => entry.anchor)).size).toBe(10);
    for (const entry of FEATURE_SWITCHES) {
      expect(entry.label).not.toMatch(/V1Enabled|Enabled$/);
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  it("accepts only listed flags", () => {
    expect(isFeatureSwitchFlag("chatSkillInstructionsV1Enabled")).toBe(true);
    expect(isFeatureSwitchFlag("codeModeV1Enabled")).toBe(false);
    expect(isFeatureSwitchFlag(undefined)).toBe(false);
  });
});
