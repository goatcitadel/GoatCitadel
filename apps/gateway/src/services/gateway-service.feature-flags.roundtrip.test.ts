import { describe, expect, it } from "vitest";
import type { FeatureFlagsConfig } from "../config.js";
import { GatewayService } from "./gateway-service.js";

// Regression guard for the round-3 CRITICAL: kill switches existed in
// FeatureFlagsConfig but were silently dropped by readFeatureFlags()'s
// explicit key list (and applyStoredFeatureFlags() then erased them from the
// live config at init). This test is compile-time exhaustive: adding a key to
// FeatureFlagsConfig without carrying it here fails to build, and failing to
// carry it in readFeatureFlags()/updateFeatureFlags() fails at runtime.
const ALL_FLAGS_SET: Required<FeatureFlagsConfig> = {
  durableKernelV1Enabled: true,
  replayOverridesV1Enabled: true,
  memoryLifecycleAdminV1Enabled: true,
  memoryLifecycleAutoForgetEnabled: true,
  memoryMaintenanceV1Enabled: true,
  connectorDiagnosticsV1Enabled: true,
  computerUseGuardrailsV1Enabled: true,
  cronReviewQueueV1Enabled: true,
  replayRegressionV1Enabled: true,
  codeModeV1Enabled: true,
  improvementLedgerV1Enabled: true,
  improvementActivationV1Enabled: true,
  coworkRuntimeQualityV1Disabled: true,
  orchestrationFinalStreamingV1Disabled: true,
  autonomyV1Disabled: true,
  chatThinkingStreamV1Enabled: true,
  plannerFastPathV1Disabled: true,
  parallelToolExecutionV1Disabled: true,
  streamIdleWatchdogV1Disabled: true,
  plannerFanoutV1Disabled: true,
};

function createFlagHarness(input: { configFeatures: FeatureFlagsConfig; stored?: Partial<FeatureFlagsConfig> }) {
  const settings = new Map<string, { value: unknown }>();
  if (input.stored) {
    settings.set("feature_flags_v1", { value: input.stored });
  }
  return {
    storage: {
      systemSettings: {
        get: (key: string) => settings.get(key),
        set: (key: string, value: unknown) => {
          settings.set(key, { value });
        },
      },
    },
    config: { assistant: { features: input.configFeatures } },
    // updateFeatureFlags reads the current set through this.readFeatureFlags.
    readFeatureFlags: GatewayService.prototype.readFeatureFlags,
    settings,
  };
}

describe("GatewayService feature-flag round-trip", () => {
  it("carries every FeatureFlagsConfig key through readFeatureFlags", () => {
    const harness = createFlagHarness({ configFeatures: { ...ALL_FLAGS_SET } });
    const flags = GatewayService.prototype.readFeatureFlags.call(harness as never);
    for (const key of Object.keys(ALL_FLAGS_SET) as Array<keyof FeatureFlagsConfig>) {
      expect(flags[key], `readFeatureFlags dropped ${key}`).toBe(true);
    }
  });

  it("prefers stored values for the round-3 kill switches", () => {
    const harness = createFlagHarness({
      configFeatures: {
        ...ALL_FLAGS_SET,
        plannerFastPathV1Disabled: false,
        parallelToolExecutionV1Disabled: false,
        streamIdleWatchdogV1Disabled: false,
        plannerFanoutV1Disabled: false,
      },
      stored: {
        plannerFastPathV1Disabled: true,
        parallelToolExecutionV1Disabled: true,
        streamIdleWatchdogV1Disabled: true,
        plannerFanoutV1Disabled: true,
      },
    });
    const flags = GatewayService.prototype.readFeatureFlags.call(harness as never);
    expect(flags.plannerFastPathV1Disabled).toBe(true);
    expect(flags.parallelToolExecutionV1Disabled).toBe(true);
    expect(flags.streamIdleWatchdogV1Disabled).toBe(true);
    expect(flags.plannerFanoutV1Disabled).toBe(true);
  });

  it("persists the round-3 kill switches through updateFeatureFlags without wiping them", () => {
    const harness = createFlagHarness({ configFeatures: { ...ALL_FLAGS_SET, autonomyV1Disabled: false } });
    const next = GatewayService.prototype.updateFeatureFlags.call(harness as never, {
      streamIdleWatchdogV1Disabled: true,
    });
    expect(next.streamIdleWatchdogV1Disabled).toBe(true);
    // A later unrelated update must not wipe the previously-stored value.
    const after = GatewayService.prototype.updateFeatureFlags.call(harness as never, {
      autonomyV1Disabled: true,
    });
    expect(after.streamIdleWatchdogV1Disabled).toBe(true);
    expect(after.plannerFastPathV1Disabled).toBe(true);
  });
});
