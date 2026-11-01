import { describe, expect, it } from "vitest";
import { buildUpdatedFeatureFlags, resolveGatewayFeatureFlags, type GatewayFeatureFlags } from "./feature-flags.js";

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
  const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);

  it("defaults to false and merges a patch", () => {
    expect(defaults.codeModeHostSandboxEnabled).toBe(false);
    expect(buildUpdatedFeatureFlags(defaults, {}).codeModeHostSandboxEnabled).toBe(false);
    expect(buildUpdatedFeatureFlags(defaults, { codeModeHostSandboxEnabled: true }).codeModeHostSandboxEnabled).toBe(
      true,
    );
  });

  it("prefers a stored value over the configured default", () => {
    const configuredOn = { ...defaults, codeModeHostSandboxEnabled: true };
    expect(resolveGatewayFeatureFlags(undefined, configuredOn).codeModeHostSandboxEnabled).toBe(true);
    expect(
      resolveGatewayFeatureFlags({ codeModeHostSandboxEnabled: false }, configuredOn).codeModeHostSandboxEnabled,
    ).toBe(false);
  });
});
