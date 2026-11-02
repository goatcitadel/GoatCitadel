import { type WebSearchNativeEngine } from "@goatcitadel/contracts";
import type {
  AuthRuntimeSettings,
  DeploymentProfile,
  FilesystemReadAccessMode,
  GlobalToolAccessSummary,
  LlamaCppRuntimeStatus,
  LlmRuntimeConfig,
  NpuRuntimeStatus,
  OutsideRootWriteMode,
  OperatorWriteRootSummary,
  ToolApprovalMode,
  ToolGroupId,
} from "@goatcitadel/contracts";

/** A switchable group an installed plugin keeps off, named so the operator can see which plugin to uninstall. */
export interface PluginToolGroupHoldSummary {
  groupId: ToolGroupId;
  pluginId: string;
  pluginName: string;
}

export interface RuntimeSettings {
  chatFeatureAvailability?: import("../chat-feature-availability.js").ChatFeatureAvailability;
  /** Monotonic optimistic-concurrency token. Clients must treat it as opaque. */
  revision: number;
  environment: string;
  deploymentProfile: DeploymentProfile;
  toolApprovalMode: ToolApprovalMode;
  budgetMode: "saver" | "balanced" | "power";
  workspaceDir: string;
  /** The https address the internet uses to reach this installation. Absent when the operator has not set one. */
  publicWebAddress?: string;
  writeJailRoots: string[];
  readOnlyRoots: string[];
  /** Operator-opened folders outside the write jail, for model-driven filesystem tools only. */
  operatorWriteRoots: OperatorWriteRootSummary[];
  /** The global tool allow and deny lists (agent and permission-profile lists are separate). */
  globalToolAccess: GlobalToolAccessSummary;
  /**
   * Built-in tool groups that are off, in the group map's order: the ones the operator switched off and the ones a
   * plugin holds off. Core is never listed.
   */
  switchedOffToolGroups: readonly ToolGroupId[];
  /**
   * Only the groups the operator switched off themselves, in the group map's order, never a plugin's hold. A tool group
   * Change Plan is checked against this, since a hold never writes the operator's switch.
   */
  operatorSwitchedOffToolGroups: readonly ToolGroupId[];
  /** Each plugin that holds a group off, in the group map's order. A hold never writes the operator's own switch. */
  pluginToolGroupHolds: readonly PluginToolGroupHoldSummary[];
  readAccessMode: FilesystemReadAccessMode;
  /** Whether writes outside every write root may raise an approval ("deny" by default). */
  outsideRootWriteMode?: OutsideRootWriteMode;
  networkAllowlist: string[];
  approvalExplainer: {
    enabled: boolean;
    mode: "async";
    minRiskLevel: "caution" | "danger" | "nuclear";
    providerId?: string;
    model?: string;
    timeoutMs: number;
    maxPayloadChars: number;
    autoRejectOnDanger?: boolean;
    autoRejectDangerThreshold?: "danger" | "nuclear";
  };
  memory: {
    enabled: boolean;
    qmd: {
      enabled: boolean;
      applyToChat: boolean;
      applyToOrchestration: boolean;
      minPromptChars: number;
      maxContextTokens: number;
      cacheTtlSeconds: number;
      distillerProviderId?: string;
      distillerModel?: string;
    };
  };
  web: {
    firecrawl: {
      enabled: boolean;
      baseUrl: string;
      apiKeyEnv?: string;
      timeoutMs: number;
      defaultReadBackend: "native" | "firecrawl";
      fallbackToNative: boolean;
      /** Whether tools may reach the base URL; reads fall back to native when false. */
      baseUrlAllowlisted?: boolean;
    };
    search: {
      engineOrder: WebSearchNativeEngine[];
    };
  };
  auth: AuthRuntimeSettings;
  llm: LlmRuntimeConfig;
  mesh: {
    enabled: boolean;
    mode: "lan" | "wan" | "tailnet";
    nodeId: string;
    mdns: boolean;
    staticPeers: string[];
    requireMtls: boolean;
    tailnetEnabled: boolean;
  };
  npu: {
    enabled: boolean;
    autoStart: boolean;
    sidecarUrl: string;
    status: NpuRuntimeStatus;
  };
  llamaCpp: {
    enabled: boolean;
    autoStart: boolean;
    managementMode: "external" | "managed";
    baseUrl: string;
    command: string;
    extraArgs: string[];
    modelsRootPath?: string;
    modelPath?: string;
    alias: string;
    ctxSize?: number;
    threads?: number;
    gpuLayers?: number;
    parallel?: number;
    batchSize?: number;
    ubatchSize?: number;
    flashAttention?: boolean;
    status: LlamaCppRuntimeStatus;
  };
  features: {
    durableKernelV1Enabled: boolean;
    replayOverridesV1Enabled: boolean;
    memoryLifecycleAdminV1Enabled: boolean;
    memoryLifecycleAutoForgetEnabled: boolean;
    memoryMaintenanceV1Enabled: boolean;
    connectorDiagnosticsV1Enabled: boolean;
    computerUseGuardrailsV1Enabled: boolean;
    cronReviewQueueV1Enabled: boolean;
    replayRegressionV1Enabled: boolean;
    codeModeV1Enabled: boolean;
    /** Runtime switch for the Code Mode host sandbox. Overrides config bestEffortHostEnabled. */
    codeModeHostSandboxEnabled?: boolean;
    improvementLedgerV1Enabled: boolean;
    improvementActivationV1Enabled: boolean;
    promptRetuneCampaignV1Enabled: boolean;
    structuredReviewV2Enabled: boolean;
    delegationScopeExpansionV1Enabled: boolean;
    engineeringLearningsV1Enabled: boolean;
    /** Kill switch for the P0 cowork runtime-quality layer (base prompt, answer-recovery, tool-call repair). Absent/false ⇒ features ON. */
    coworkRuntimeQualityV1Disabled?: boolean;
    /** Kill switch for S1 live terminal-synthesizer token streaming. Absent/false ⇒ feature ON; `true` reverts cowork/code to buffered delivery. */
    orchestrationFinalStreamingV1Disabled?: boolean;
    /** Master autonomy kill switch (Phase 1 proactivity / self-improvement). Absent/false ⇒ autonomy ON; `true` halts all autonomous loops. */
    autonomyV1Disabled?: boolean;
    /** Thinking display. `true` streams one thinking_delta per provider reasoning chunk. Absent/false (default) ⇒ no thinking_delta chunks are emitted; behavior is byte-identical to today. */
    chatThinkingStreamV1Enabled?: boolean;
    /** On-demand context estimates in session.status. Absent/false disables enrichment. */
    chatContextBudgetVisibilityV1Enabled?: boolean;
    chatAsyncClarificationV1Enabled?: boolean;
    /** Unified Chat composer palette. Absent uses the server-configured rollout default. */
    unifiedComposerPaletteV1Enabled?: boolean;
    /** Safe read-only tools over a turn's immutable attached-context snapshot. */
    attachedContextToolsV1Enabled?: boolean;
    /** Canonical Chat session status endpoint, panel, and model-safe projection. */
    chatSessionStatusV1Enabled?: boolean;
    conversationForksV1Enabled?: boolean;
    notificationRoutingV1Enabled?: boolean;
    chatTimersV1Enabled?: boolean;
    typedRunVariablesV1Enabled?: boolean;
    documentEditingV1Enabled?: boolean;
    /** Inbound channel voice ingestion (B2a). On by default; an explicit false restores the pre-voice placeholder/drop behavior for Telegram/WhatsApp/Slack/Discord. */
    channelVoiceInboundV1Enabled?: boolean;
    /** Round-3 kill switch: planner triviality-skip + speed-model drafting. Absent/false ⇒ feature ON. */
    plannerFastPathV1Disabled?: boolean;
    /** Round-3 kill switch: all-read-only tool-batch parallel execution. Absent/false ⇒ feature ON. */
    parallelToolExecutionV1Disabled?: boolean;
    /** Round-3 kill switch: per-chunk provider-stream idle watchdog. Absent/false ⇒ feature ON. */
    streamIdleWatchdogV1Disabled?: boolean;
    /** Round-3 kill switch: planner-declared fan-out (extra worker steps). Absent/false ⇒ feature ON. */
    plannerFanoutV1Disabled?: boolean;
    /** R3-8 kill switch: model-callable `agent.fanout` spawn tool. Absent/false ⇒ feature ON. */
    subagentFanoutV1Disabled?: boolean;
    /** Default-off Chat-native durable agent.fanout aggregate. */
    durableChatFanoutV1Enabled?: boolean;
    chatProviderFallbackV1Enabled?: boolean;
    chatSkillInstructionsV1Enabled?: boolean;
    boundedToolExposureV1Enabled?: boolean;
    scheduledChatTurnsV1Enabled?: boolean;
    chatExplicitContextV1Enabled?: boolean;
    chatAutomaticFanoutV1Enabled?: boolean;
    chatDelegationControlsV1Enabled?: boolean;
    proactiveHeartbeatTurnsV1Enabled?: boolean;
    commitmentScheduledTurnsV1Enabled?: boolean;
    chatMeshCapabilitiesV1Enabled?: boolean;
    chatRemotePlacementV1Enabled?: boolean;
    chatExplicitContextBranchesV1Enabled?: boolean;
    chatWorkspaceSnapshotV1Enabled?: boolean;
    chatModelCouncilV1Enabled?: boolean;
    chatWorkPassportV1Enabled?: boolean;
    chatRequesterMcpV1Enabled?: boolean;
    chatStaticMcpV1Enabled?: boolean;
    /** Lets the local `claude-code-cli` provider call Gateway tools through the per-run MCP bridge. Absent/false => text-only. */
    claudeCliToolBridgeEnabled?: boolean;
    claudeCliWarmContinuationEnabled?: boolean;
    /** Gateway-owned governed Change Plan authority. */
    /** Browser errands in GoatCitadel's own Chrome window on this PC (off by default). */
    browserErrandsEnabled?: boolean;
    evolutionControlPlaneV1Enabled?: boolean;
    /** The operator's own Settings saves and Capabilities installs apply without a separate approval (opt-in; ignored under remote_hardened). */
    settingsApprovalSkipEnabled?: boolean;
    /** Default-on only after the Evolution Control Plane rollout. */
    improvementLocalObservationV1Enabled?: boolean;
    /** Scheduled model evaluation remains opt-in. */
    improvementModelEvaluationV1Enabled?: boolean;
    /** Managed-source evolution remains opt-in and registration-gated. */
    productSourceEvolutionV1Enabled?: boolean;
    /** B2b TTS voice replies to audio-capable channels. Absent/false (default) ⇒ no audio synthesis on the reply path. */
    channelVoiceReplyV1Enabled?: boolean;
    /** Opt-in: weekly governed memory consolidation (propose-only, approval-gated). Absent/false ⇒ job never runs. */
    memoryConsolidationV1Enabled?: boolean;
    /** Opt-in: signed cron_job_executed evidence envelope on every cron run. Absent/false ⇒ no cron evidence, as today. */
    cronEvidenceV1Enabled?: boolean;
    /** Opt-in: routes background LLM calls (improvement scans, judges, classifiers, prompt packs) to the cheap utility-model slot. Absent/false ⇒ today's selection. */
    utilityModelRoutingV1Enabled?: boolean;
    /** Kill switch: disables the boot-time chat-turn interruption reconciler. Absent/false ⇒ reconciler runs on every boot. */
    chatTurnInterruptionRecoveryV1Disabled?: boolean;
    /** Kill switch: disables the production Activepieces `trigger_webhook` external-side-effect replay job. Absent/false ⇒ hook wired (ON by default). */
    externalSideEffectReplayJobsV1Disabled?: boolean;
  };
}
