import { describe, expect, it } from "vitest";
import { buildUpdatedFeatureFlags, resolveGatewayFeatureFlags, type GatewayFeatureFlags } from "./feature-flags.js";

const restored = [
  "chatSkillInstructionsV1Enabled",
  "boundedToolExposureV1Enabled",
  "chatProviderFallbackV1Enabled",
  "chatExplicitContextV1Enabled",
  "chatDelegationControlsV1Enabled",
  "chatAutomaticFanoutV1Enabled",
  "scheduledChatTurnsV1Enabled",
  "proactiveHeartbeatTurnsV1Enabled",
  "commitmentScheduledTurnsV1Enabled",
  "chatRequesterMcpV1Enabled",
  "chatStaticMcpV1Enabled",
  "chatMeshCapabilitiesV1Enabled",
  "chatRemotePlacementV1Enabled",
  "chatWorkPassportV1Enabled",
] as const;
describe("restored feature defaults and persistence", () => {
  it("leaves every new restoration disabled when historical configuration omits it", () => {
    const effective = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);
    for (const key of restored) expect(effective[key], key).toBe(false);
  });
  it.each(restored)("preserves explicit %s across unrelated settings changes and supports revocation", (key) => {
    const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);
    const enabled = buildUpdatedFeatureFlags(defaults, { [key]: true });
    expect(enabled[key]).toBe(true);
    const unrelated = buildUpdatedFeatureFlags(enabled, { replayOverridesV1Enabled: true });
    expect(unrelated[key]).toBe(true);
    const restoredSettings = resolveGatewayFeatureFlags(unrelated, defaults);
    expect(restoredSettings[key]).toBe(true);
    expect(buildUpdatedFeatureFlags(restoredSettings, { [key]: false })[key]).toBe(false);
  });
});
