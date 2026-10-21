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
