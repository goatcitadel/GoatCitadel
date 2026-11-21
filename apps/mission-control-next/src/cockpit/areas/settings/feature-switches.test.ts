import { describe, expect, it } from "vitest";
import { SHIPPED_FEATURE_CONTROLS, SHIPPED_FEATURE_FLAGS } from "@goatcitadel/contracts";
import { FEATURE_SWITCHES, featureSwitchHref, isFeatureSwitchFlag } from "./feature-switches";

describe("feature switches", () => {
  it("lists all switchable features in catalog order with plain labels and unique Settings anchors", () => {
    expect(FEATURE_SWITCHES.map((entry) => entry.flag)).toEqual(
      SHIPPED_FEATURE_FLAGS.filter((flag) => SHIPPED_FEATURE_CONTROLS[flag].switchable),
    );
    expect(FEATURE_SWITCHES).toHaveLength(50);
    const establishedLabels = [
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
    ];
    expect(FEATURE_SWITCHES.map((entry) => entry.label).filter((label) => establishedLabels.includes(label))).toEqual(
      establishedLabels,
    );
    expect(featureSwitchHref("memoryLifecycleAdminV1Enabled")).toBe(
      "/settings/advanced#feature-switch-memory-administration",
    );
    expect(featureSwitchHref("chatStaticMcpV1Enabled")).toBe("/settings/advanced#feature-switch-connectors-in-chat");
    expect(featureSwitchHref("codeModeV1Enabled")).toBe("/settings/advanced#feature-switch-code-mode");
    expect(new Set(FEATURE_SWITCHES.map((entry) => entry.anchor)).size).toBe(FEATURE_SWITCHES.length);
    for (const entry of FEATURE_SWITCHES) {
      expect(entry.label).not.toMatch(/V1Enabled|Enabled$/);
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  it("accepts only listed flags", () => {
    expect(isFeatureSwitchFlag("chatSkillInstructionsV1Enabled")).toBe(true);
    expect(isFeatureSwitchFlag("codeModeV1Enabled")).toBe(true);
    expect(isFeatureSwitchFlag("computerUseGuardrailsV1Enabled")).toBe(false);
    expect(isFeatureSwitchFlag("unknownFlag")).toBe(false);
    expect(isFeatureSwitchFlag(undefined)).toBe(false);
  });
});
