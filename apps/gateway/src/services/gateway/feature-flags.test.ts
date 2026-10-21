import { describe, expect, it } from "vitest";
import { buildUpdatedFeatureFlags, resolveGatewayFeatureFlags, type GatewayFeatureFlags } from "./feature-flags.js";

describe("claudeCliToolBridgeEnabled feature flag", () => {
  const defaults = resolveGatewayFeatureFlags(undefined, {} as GatewayFeatureFlags);

  it("defaults to off", () => {
    expect(defaults.claudeCliToolBridgeEnabled).toBe(false);
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
