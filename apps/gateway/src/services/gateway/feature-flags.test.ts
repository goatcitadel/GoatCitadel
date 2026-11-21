import { describe, expect, it } from "vitest";
import {
  buildUpdatedFeatureFlags,
  configurationFeatureFlags,
  resolveGatewayFeatureFlags,
  type GatewayFeatureFlags,
} from "./feature-flags.js";

describe("indexed corpus recall opt-in", () => {
  it("requires an independent opt-in for background skill drafts", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);
    expect(defaults.backgroundSkillDraftsV1Enabled).toBe(false);
    expect(
      buildUpdatedFeatureFlags(defaults, { backgroundSkillDraftsV1Enabled: true }).backgroundSkillDraftsV1Enabled,
    ).toBe(true);
    expect(
      resolveGatewayFeatureFlags(
        { backgroundSkillDraftsV1Enabled: false },
        { ...defaults, backgroundSkillDraftsV1Enabled: true },
      ).backgroundSkillDraftsV1Enabled,
    ).toBe(false);
  });
  it("stays off without an explicit setting, preserves an opt-in, and supports revocation", () => {
    const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);
    expect(defaults.memoryCorpusRecallV1Enabled).toBe(false);
    expect(
      resolveGatewayFeatureFlags({ memoryCorpusRecallV1Enabled: true }, defaults).memoryCorpusRecallV1Enabled,
    ).toBe(true);
    expect(
      buildUpdatedFeatureFlags(
        { ...defaults, memoryCorpusRecallV1Enabled: true },
        { memoryCorpusRecallV1Enabled: false },
      ).memoryCorpusRecallV1Enabled,
    ).toBe(false);
  });
});

describe("claudeCliToolBridgeEnabled feature flag", () => {
  const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);

  it("defaults on once its live proof passed, and still supports revocation", () => {
    expect(defaults.claudeCliToolBridgeEnabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, { claudeCliToolBridgeEnabled: false }).claudeCliToolBridgeEnabled).toBe(
      false,
    );
  });

  it("keeps an explicit off from configuration or a stored setting", () => {
    const configuredOff = { ...defaults, claudeCliToolBridgeEnabled: false };
    expect(resolveGatewayFeatureFlags(undefined, configuredOff).claudeCliToolBridgeEnabled).toBe(false);
    expect(resolveGatewayFeatureFlags({ claudeCliToolBridgeEnabled: false }, defaults).claudeCliToolBridgeEnabled).toBe(
      false,
    );
  });

  it("buildUpdatedFeatureFlags carries claudeCliToolBridgeEnabled", () => {
    const current: GatewayFeatureFlags = { ...defaults, claudeCliToolBridgeEnabled: true };
    expect(buildUpdatedFeatureFlags(current, {}).claudeCliToolBridgeEnabled).toBe(true);
    expect(buildUpdatedFeatureFlags(current, { claudeCliToolBridgeEnabled: false }).claudeCliToolBridgeEnabled).toBe(
      false,
    );
    expect(buildUpdatedFeatureFlags(defaults, { claudeCliToolBridgeEnabled: true }).claudeCliToolBridgeEnabled).toBe(
      true,
    );
  });

  it("restores a stored value over the configured default", () => {
    expect(resolveGatewayFeatureFlags({ claudeCliToolBridgeEnabled: true }, defaults).claudeCliToolBridgeEnabled).toBe(
      true,
    );
  });
});

describe("claudeCliWarmContinuationEnabled feature flag", () => {
  const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);

  it("warm continuation defaults on once its live proof passed, and still supports revocation", () => {
    expect(defaults.claudeCliWarmContinuationEnabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, {}).claudeCliWarmContinuationEnabled).toBe(true);
    expect(
      buildUpdatedFeatureFlags(defaults, { claudeCliWarmContinuationEnabled: false }).claudeCliWarmContinuationEnabled,
    ).toBe(false);
  });

  it("warm continuation keeps an explicit off from configuration or a stored setting", () => {
    const configuredOff = { ...defaults, claudeCliWarmContinuationEnabled: false };
    expect(resolveGatewayFeatureFlags(undefined, configuredOff).claudeCliWarmContinuationEnabled).toBe(false);
    expect(
      resolveGatewayFeatureFlags({ claudeCliWarmContinuationEnabled: false }, defaults)
        .claudeCliWarmContinuationEnabled,
    ).toBe(false);
  });

  it("warm continuation follows a stored true", () => {
    const stored = { claudeCliWarmContinuationEnabled: true };
    expect(resolveGatewayFeatureFlags(stored, defaults).claudeCliWarmContinuationEnabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, stored).claudeCliWarmContinuationEnabled).toBe(true);
  });
});

describe("codeModeHostSandboxEnabled feature flag", () => {
  const defaults = resolveGatewayFeatureFlags(undefined, {});

  it("defaults on and supports an explicit opt-out", () => {
    expect(defaults.codeModeHostSandboxEnabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, {}).codeModeHostSandboxEnabled).toBe(true);
    expect(buildUpdatedFeatureFlags(defaults, { codeModeHostSandboxEnabled: false }).codeModeHostSandboxEnabled).toBe(
      false,
    );
  });

  it("prefers a stored value over the configured default", () => {
    const configuredOff = { ...defaults, codeModeHostSandboxEnabled: false };
    expect(resolveGatewayFeatureFlags(undefined, configuredOff).codeModeHostSandboxEnabled).toBe(false);
    expect(
      resolveGatewayFeatureFlags({ codeModeHostSandboxEnabled: true }, configuredOff).codeModeHostSandboxEnabled,
    ).toBe(true);
  });

  it("keeps inherited Code Mode unavailable on an advisory-only host", () => {
    const advisory = configurationFeatureFlags({ profile: {}, environment: {}, sandboxRequired: false });
    expect(advisory.codeModeV1Enabled).toBe(false);
  });
});
