import { describe, expect, it } from "vitest";
import {
  buildUpdatedFeatureFlags,
  configurationFeatureFlags,
  featurePreferenceMetadata,
  resolveGatewayFeatureFlags,
  updateFeaturePreferences,
  type FeatureConfigSources,
} from "./feature-flags.js";

const defaultOn = [
  "chatSkillInstructionsV1Enabled",
  "boundedToolExposureV1Enabled",
  "chatProviderFallbackV1Enabled",
  "chatExplicitContextV1Enabled",
  "chatDelegationControlsV1Enabled",
  "chatAutomaticFanoutV1Enabled",
  "scheduledChatTurnsV1Enabled",
  "proactiveHeartbeatTurnsV1Enabled",
  "commitmentScheduledTurnsV1Enabled",
  "chatStaticMcpV1Enabled",
] as const;
const defaultOff = [
  "chatRequesterMcpV1Enabled",
  "chatMeshCapabilitiesV1Enabled",
  "chatRemotePlacementV1Enabled",
] as const;
describe("restored feature defaults and persistence", () => {
  it("uses shipped availability defaults when a profile omits restored flags", () => {
    const effective = resolveGatewayFeatureFlags(undefined, {});
    for (const key of defaultOn) expect(effective[key], key).toBe(true);
    for (const key of defaultOff) expect(effective[key], key).toBe(false);
  });
  it("keeps a legacy profile opt-out and records the operator's decision to keep it off", () => {
    const flag = "chatSkillInstructionsV1Enabled";
    const sources: FeatureConfigSources = { profile: { [flag]: false }, environment: {} };
    const defaults = configurationFeatureFlags(sources);
    expect(defaults[flag]).toBe(false);
    const review = featurePreferenceMetadata(sources, {});
    expect(review.upgradeReview).toEqual([flag]);

    const stored = updateFeaturePreferences(
      sources,
      {},
      {},
      {
        flags: [flag],
        fingerprint: review.upgradeFingerprint,
        decision: "off",
      },
    );
    expect(resolveGatewayFeatureFlags(stored, defaults)[flag]).toBe(false);
    expect(featurePreferenceMetadata(sources, stored)).toMatchObject({
      sources: { [flag]: "operator" },
      upgradeReview: [],
    });
  });
  it.each([...defaultOn, ...defaultOff])(
    "preserves explicit %s across unrelated settings changes and supports revocation",
    (key) => {
      const defaults = resolveGatewayFeatureFlags(undefined, {});
      const enabled = buildUpdatedFeatureFlags(defaults, { [key]: true });
      expect(enabled[key]).toBe(true);
      const unrelated = buildUpdatedFeatureFlags(enabled, { replayOverridesV1Enabled: true });
      expect(unrelated[key]).toBe(true);
      const restoredSettings = resolveGatewayFeatureFlags(unrelated, defaults);
      expect(restoredSettings[key]).toBe(true);
      expect(buildUpdatedFeatureFlags(restoredSettings, { [key]: false })[key]).toBe(false);
    },
  );
  it("defaults chatExplicitContextBranchesV1Enabled on once its restoration proved green, and still supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {});
    expect(defaults.chatExplicitContextBranchesV1Enabled).toBe(true);
    expect(
      buildUpdatedFeatureFlags(defaults, { chatExplicitContextBranchesV1Enabled: false })
        .chatExplicitContextBranchesV1Enabled,
    ).toBe(false);
  });

  it("defaults chatWorkspaceSnapshotV1Enabled on once its restoration proved green, and still supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {});
    expect(defaults.chatWorkspaceSnapshotV1Enabled).toBe(true);
    expect(
      buildUpdatedFeatureFlags(defaults, { chatWorkspaceSnapshotV1Enabled: false }).chatWorkspaceSnapshotV1Enabled,
    ).toBe(false);
  });
  it("defaults chatModelCouncilV1Enabled on once its restoration proved green, and still supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {});
    expect(defaults.chatModelCouncilV1Enabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, { chatModelCouncilV1Enabled: false }).chatModelCouncilV1Enabled).toBe(
      false,
    );
  });
  it("defaults chatWorkPassportV1Enabled on once its restoration proved green, and still supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {});
    expect(defaults.chatWorkPassportV1Enabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, { chatWorkPassportV1Enabled: false }).chatWorkPassportV1Enabled).toBe(
      false,
    );
  });
});
