import { describe, expect, it } from "vitest";
import type { FeatureFlagsConfig } from "../config.js";
import { updateSettingsSchema } from "./dashboard.js";

// Finding-adjacent regression guard (Phase 3.2): feature flags live in
// FeatureFlagsConfig but must ALSO be accepted by the settings PATCH schema —
// a separate plumbing site. Zod strips unknown keys, so a flag missing here is
// silently dropped from PATCH /api/v1/system/settings (only togglable via env +
// restart). The 5 round-3 kill switches (plannerFastPath / parallelToolExecution
// / streamIdleWatchdog / plannerFanout / subagentFanout) were exactly this gap.
//
// This object is COMPILE-TIME exhaustive: adding a key to FeatureFlagsConfig
// without listing it here fails to build, forcing whoever adds a flag to
// consciously decide whether it is PATCH-toggleable.
const EXPECTED_PATCH_TOGGLEABLE: Record<keyof FeatureFlagsConfig, true> = {
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
  channelVoiceInboundV1Enabled: true,
  channelVoiceReplyV1Enabled: true,
  signalInboundV1Enabled: true,
  plannerFastPathV1Disabled: true,
  parallelToolExecutionV1Disabled: true,
  streamIdleWatchdogV1Disabled: true,
  plannerFanoutV1Disabled: true,
  subagentFanoutV1Disabled: true,
  memoryConsolidationV1Enabled: true,
  cronEvidenceV1Enabled: true,
  utilityModelRoutingV1Enabled: true,
  chatTurnInterruptionRecoveryV1Disabled: true,
};

describe("settings PATCH schema feature-flag coverage (Phase 3.2)", () => {
  const featuresShape = updateSettingsSchema.shape.features.unwrap().shape;

  it("accepts every FeatureFlagsConfig key (none silently dropped)", () => {
    const missing = (Object.keys(EXPECTED_PATCH_TOGGLEABLE) as Array<keyof FeatureFlagsConfig>).filter(
      (key) => !(key in featuresShape),
    );
    expect(missing).toEqual([]);
  });

  it("actually preserves the round-3 kill switches through a parse", () => {
    const parsed = updateSettingsSchema.parse({
      features: {
        plannerFastPathV1Disabled: true,
        parallelToolExecutionV1Disabled: true,
        streamIdleWatchdogV1Disabled: true,
        plannerFanoutV1Disabled: true,
        subagentFanoutV1Disabled: true,
      },
    });
    expect(parsed.features).toMatchObject({
      plannerFastPathV1Disabled: true,
      parallelToolExecutionV1Disabled: true,
      streamIdleWatchdogV1Disabled: true,
      plannerFanoutV1Disabled: true,
      subagentFanoutV1Disabled: true,
    });
  });
});
