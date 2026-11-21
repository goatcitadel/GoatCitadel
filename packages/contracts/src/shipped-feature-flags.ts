import type { ChangePlanRuntimeFeatureFlag } from "./change-plan.js";

/** Feature identities and review eligibility, independent of the Settings copy. */
export const SHIPPED_FEATURE_SWITCHABILITY = {
  memoryLifecycleAdminV1Enabled: true,
  memoryCorpusRecallV1Enabled: true,
  backgroundSkillDraftsV1Enabled: true,
  memoryMaintenanceV1Enabled: true,
  chatSkillInstructionsV1Enabled: true,
  chatStaticMcpV1Enabled: true,
  connectorDiagnosticsV1Enabled: true,
  cronReviewQueueV1Enabled: true,
  engineeringLearningsV1Enabled: true,
  chatProviderFallbackV1Enabled: true,
  chatDelegationControlsV1Enabled: true,
  utilityModelRoutingV1Enabled: true,
  memoryConsolidationV1Enabled: true,
  scheduledChatTurnsV1Enabled: true,
  proactiveHeartbeatTurnsV1Enabled: true,
  commitmentScheduledTurnsV1Enabled: true,
  cronEvidenceV1Enabled: true,
  chatContextBudgetVisibilityV1Enabled: true,
  boundedToolExposureV1Enabled: true,
  durableChatFanoutV1Enabled: true,
  chatAutomaticFanoutV1Enabled: true,
  channelVoiceReplyV1Enabled: true,
  replayOverridesV1Enabled: true,
  replayRegressionV1Enabled: true,
  promptRetuneCampaignV1Enabled: true,
  structuredReviewV2Enabled: true,
  delegationScopeExpansionV1Enabled: true,
  memoryLifecycleAutoForgetEnabled: true,
  computerUseGuardrailsV1Enabled: false,
  chatAsyncClarificationV1Enabled: true,
  unifiedComposerPaletteV1Enabled: true,
  attachedContextToolsV1Enabled: true,
  chatSessionStatusV1Enabled: true,
  conversationForksV1Enabled: true,
  notificationRoutingV1Enabled: true,
  chatTimersV1Enabled: true,
  typedRunVariablesV1Enabled: true,
  documentEditingV1Enabled: true,
  channelVoiceInboundV1Enabled: true,
  chatExplicitContextV1Enabled: true,
  chatExplicitContextBranchesV1Enabled: true,
  chatWorkspaceSnapshotV1Enabled: true,
  chatModelCouncilV1Enabled: true,
  chatWorkPassportV1Enabled: true,
  evolutionControlPlaneV1Enabled: false,
  improvementLocalObservationV1Enabled: true,
  chatThinkingStreamV1Enabled: true,
  codeModeV1Enabled: true,
  codeModeHostSandboxEnabled: true,
  browserErrandsEnabled: true,
  claudeCliToolBridgeEnabled: true,
  claudeCliWarmContinuationEnabled: true,
} as const satisfies Partial<Record<ChangePlanRuntimeFeatureFlag, boolean>>;

export type ShippedFeatureFlag = keyof typeof SHIPPED_FEATURE_SWITCHABILITY;
export const SHIPPED_FEATURE_FLAGS = Object.keys(SHIPPED_FEATURE_SWITCHABILITY) as ShippedFeatureFlag[];

export function isShippedFeatureFlag(key: string): key is ShippedFeatureFlag {
  return Object.hasOwn(SHIPPED_FEATURE_SWITCHABILITY, key);
}
