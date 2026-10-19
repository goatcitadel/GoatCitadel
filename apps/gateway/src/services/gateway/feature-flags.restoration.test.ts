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
  it("defaults chatWorkspaceSnapshotV1Enabled on once its restoration proved green, and still supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);
    expect(defaults.chatWorkspaceSnapshotV1Enabled).toBe(true);
    expect(
      buildUpdatedFeatureFlags(defaults, { chatWorkspaceSnapshotV1Enabled: false }).chatWorkspaceSnapshotV1Enabled,
    ).toBe(false);
  });
  it("defaults chatModelCouncilV1Enabled on once its restoration proved green, and still supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);
    expect(defaults.chatModelCouncilV1Enabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, { chatModelCouncilV1Enabled: false }).chatModelCouncilV1Enabled).toBe(
      false,
    );
  });
  it("defaults chatWorkPassportV1Enabled on once its restoration proved green, and still supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);
    expect(defaults.chatWorkPassportV1Enabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, { chatWorkPassportV1Enabled: false }).chatWorkPassportV1Enabled).toBe(
      false,
    );
  });
});
