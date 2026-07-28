import type { RuntimeSettings } from "./runtime-settings.js";

export type GatewayFeatureFlags = RuntimeSettings["features"];

export function buildUpdatedFeatureFlags(
  current: GatewayFeatureFlags,
  patch: Partial<GatewayFeatureFlags>,
): GatewayFeatureFlags {
  return {
    durableKernelV1Enabled: true,
    replayOverridesV1Enabled: patch.replayOverridesV1Enabled ?? current.replayOverridesV1Enabled,
    memoryLifecycleAdminV1Enabled: patch.memoryLifecycleAdminV1Enabled ?? current.memoryLifecycleAdminV1Enabled,
    memoryLifecycleAutoForgetEnabled:
      patch.memoryLifecycleAutoForgetEnabled ?? current.memoryLifecycleAutoForgetEnabled,
    memoryMaintenanceV1Enabled: patch.memoryMaintenanceV1Enabled ?? current.memoryMaintenanceV1Enabled,
    connectorDiagnosticsV1Enabled: patch.connectorDiagnosticsV1Enabled ?? current.connectorDiagnosticsV1Enabled,
    computerUseGuardrailsV1Enabled: patch.computerUseGuardrailsV1Enabled ?? current.computerUseGuardrailsV1Enabled,
    cronReviewQueueV1Enabled: patch.cronReviewQueueV1Enabled ?? current.cronReviewQueueV1Enabled,
    replayRegressionV1Enabled: patch.replayRegressionV1Enabled ?? current.replayRegressionV1Enabled,
    codeModeV1Enabled: patch.codeModeV1Enabled ?? current.codeModeV1Enabled,
    improvementLedgerV1Enabled: patch.improvementLedgerV1Enabled ?? current.improvementLedgerV1Enabled,
    improvementActivationV1Enabled: patch.improvementActivationV1Enabled ?? current.improvementActivationV1Enabled,
    promptRetuneCampaignV1Enabled: patch.promptRetuneCampaignV1Enabled ?? current.promptRetuneCampaignV1Enabled,
    structuredReviewV2Enabled: patch.structuredReviewV2Enabled ?? current.structuredReviewV2Enabled,
    delegationScopeExpansionV1Enabled:
      patch.delegationScopeExpansionV1Enabled ?? current.delegationScopeExpansionV1Enabled,
    engineeringLearningsV1Enabled: patch.engineeringLearningsV1Enabled ?? current.engineeringLearningsV1Enabled,
    // Optional flags must be carried through: updateFeatureFlags does a full
    // system_settings write, so omitting them would silently wipe stored values.
    coworkRuntimeQualityV1Disabled: patch.coworkRuntimeQualityV1Disabled ?? current.coworkRuntimeQualityV1Disabled,
    orchestrationFinalStreamingV1Disabled:
      patch.orchestrationFinalStreamingV1Disabled ?? current.orchestrationFinalStreamingV1Disabled,
    autonomyV1Disabled: patch.autonomyV1Disabled ?? current.autonomyV1Disabled,
    chatThinkingStreamV1Enabled: patch.chatThinkingStreamV1Enabled ?? current.chatThinkingStreamV1Enabled,
    channelVoiceInboundV1Enabled: patch.channelVoiceInboundV1Enabled ?? current.channelVoiceInboundV1Enabled,
    signalInboundV1Enabled: patch.signalInboundV1Enabled ?? current.signalInboundV1Enabled,
    plannerFastPathV1Disabled: patch.plannerFastPathV1Disabled ?? current.plannerFastPathV1Disabled,
    parallelToolExecutionV1Disabled: patch.parallelToolExecutionV1Disabled ?? current.parallelToolExecutionV1Disabled,
    streamIdleWatchdogV1Disabled: patch.streamIdleWatchdogV1Disabled ?? current.streamIdleWatchdogV1Disabled,
    plannerFanoutV1Disabled: patch.plannerFanoutV1Disabled ?? current.plannerFanoutV1Disabled,
    subagentFanoutV1Disabled: patch.subagentFanoutV1Disabled ?? current.subagentFanoutV1Disabled,
    channelVoiceReplyV1Enabled: patch.channelVoiceReplyV1Enabled ?? current.channelVoiceReplyV1Enabled,
    memoryConsolidationV1Enabled: patch.memoryConsolidationV1Enabled ?? current.memoryConsolidationV1Enabled,
    cronEvidenceV1Enabled: patch.cronEvidenceV1Enabled ?? current.cronEvidenceV1Enabled,
    utilityModelRoutingV1Enabled: patch.utilityModelRoutingV1Enabled ?? current.utilityModelRoutingV1Enabled,
    chatTurnInterruptionRecoveryV1Disabled:
      patch.chatTurnInterruptionRecoveryV1Disabled ?? current.chatTurnInterruptionRecoveryV1Disabled,
    externalSideEffectReplayJobsV1Disabled:
      patch.externalSideEffectReplayJobsV1Disabled ?? current.externalSideEffectReplayJobsV1Disabled,
  };
}

export function resolveGatewayFeatureFlags(
  stored: Partial<GatewayFeatureFlags> | undefined,
  fromConfig: GatewayFeatureFlags,
): GatewayFeatureFlags {
  return {
    durableKernelV1Enabled: true,
    replayOverridesV1Enabled: stored?.replayOverridesV1Enabled ?? fromConfig.replayOverridesV1Enabled,
    memoryLifecycleAdminV1Enabled: stored?.memoryLifecycleAdminV1Enabled ?? fromConfig.memoryLifecycleAdminV1Enabled,
    memoryLifecycleAutoForgetEnabled:
      stored?.memoryLifecycleAutoForgetEnabled ?? fromConfig.memoryLifecycleAutoForgetEnabled ?? true,
    memoryMaintenanceV1Enabled: stored?.memoryMaintenanceV1Enabled ?? fromConfig.memoryMaintenanceV1Enabled,
    connectorDiagnosticsV1Enabled: stored?.connectorDiagnosticsV1Enabled ?? fromConfig.connectorDiagnosticsV1Enabled,
    computerUseGuardrailsV1Enabled: stored?.computerUseGuardrailsV1Enabled ?? fromConfig.computerUseGuardrailsV1Enabled,
    cronReviewQueueV1Enabled: stored?.cronReviewQueueV1Enabled ?? fromConfig.cronReviewQueueV1Enabled,
    replayRegressionV1Enabled: stored?.replayRegressionV1Enabled ?? fromConfig.replayRegressionV1Enabled,
    codeModeV1Enabled: stored?.codeModeV1Enabled ?? fromConfig.codeModeV1Enabled,
    improvementLedgerV1Enabled: stored?.improvementLedgerV1Enabled ?? fromConfig.improvementLedgerV1Enabled,
    improvementActivationV1Enabled: stored?.improvementActivationV1Enabled ?? fromConfig.improvementActivationV1Enabled,
    promptRetuneCampaignV1Enabled: stored?.promptRetuneCampaignV1Enabled ?? fromConfig.promptRetuneCampaignV1Enabled,
    structuredReviewV2Enabled: stored?.structuredReviewV2Enabled ?? fromConfig.structuredReviewV2Enabled,
    delegationScopeExpansionV1Enabled:
      stored?.delegationScopeExpansionV1Enabled ?? fromConfig.delegationScopeExpansionV1Enabled,
    engineeringLearningsV1Enabled: stored?.engineeringLearningsV1Enabled ?? fromConfig.engineeringLearningsV1Enabled,
    coworkRuntimeQualityV1Disabled: stored?.coworkRuntimeQualityV1Disabled ?? fromConfig.coworkRuntimeQualityV1Disabled,
    orchestrationFinalStreamingV1Disabled:
      stored?.orchestrationFinalStreamingV1Disabled ?? fromConfig.orchestrationFinalStreamingV1Disabled,
    autonomyV1Disabled: stored?.autonomyV1Disabled ?? fromConfig.autonomyV1Disabled,
    chatThinkingStreamV1Enabled: stored?.chatThinkingStreamV1Enabled ?? fromConfig.chatThinkingStreamV1Enabled,
    channelVoiceInboundV1Enabled: stored?.channelVoiceInboundV1Enabled ?? fromConfig.channelVoiceInboundV1Enabled,
    signalInboundV1Enabled: stored?.signalInboundV1Enabled ?? fromConfig.signalInboundV1Enabled,
    plannerFastPathV1Disabled: stored?.plannerFastPathV1Disabled ?? fromConfig.plannerFastPathV1Disabled,
    parallelToolExecutionV1Disabled:
      stored?.parallelToolExecutionV1Disabled ?? fromConfig.parallelToolExecutionV1Disabled,
    streamIdleWatchdogV1Disabled: stored?.streamIdleWatchdogV1Disabled ?? fromConfig.streamIdleWatchdogV1Disabled,
    plannerFanoutV1Disabled: stored?.plannerFanoutV1Disabled ?? fromConfig.plannerFanoutV1Disabled,
    subagentFanoutV1Disabled: stored?.subagentFanoutV1Disabled ?? fromConfig.subagentFanoutV1Disabled,
    channelVoiceReplyV1Enabled: stored?.channelVoiceReplyV1Enabled ?? fromConfig.channelVoiceReplyV1Enabled,
    memoryConsolidationV1Enabled: stored?.memoryConsolidationV1Enabled ?? fromConfig.memoryConsolidationV1Enabled,
    cronEvidenceV1Enabled: stored?.cronEvidenceV1Enabled ?? fromConfig.cronEvidenceV1Enabled,
    utilityModelRoutingV1Enabled: stored?.utilityModelRoutingV1Enabled ?? fromConfig.utilityModelRoutingV1Enabled,
    chatTurnInterruptionRecoveryV1Disabled:
      stored?.chatTurnInterruptionRecoveryV1Disabled ?? fromConfig.chatTurnInterruptionRecoveryV1Disabled,
    externalSideEffectReplayJobsV1Disabled:
      stored?.externalSideEffectReplayJobsV1Disabled ?? fromConfig.externalSideEffectReplayJobsV1Disabled,
  };
}

export function didDisengageAutonomyKillSwitch(current: GatewayFeatureFlags, next: GatewayFeatureFlags): boolean {
  return current.autonomyV1Disabled === true && next.autonomyV1Disabled !== true;
}
