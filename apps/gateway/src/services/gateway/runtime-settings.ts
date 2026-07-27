import type {
  AuthRuntimeSettings,
  DeploymentProfile,
  FilesystemReadAccessMode,
  LlamaCppRuntimeStatus,
  LlmRuntimeConfig,
  NpuRuntimeStatus,
  ToolApprovalMode,
} from "@goatcitadel/contracts";

export interface RuntimeSettings {
  /** Monotonic optimistic-concurrency token. Clients must treat it as opaque. */
  revision: number;
  environment: string;
  deploymentProfile: DeploymentProfile;
  toolApprovalMode: ToolApprovalMode;
  defaultToolProfile?: string;
  budgetMode: "saver" | "balanced" | "power";
  workspaceDir: string;
  writeJailRoots: string[];
  readOnlyRoots: string[];
  readAccessMode: FilesystemReadAccessMode;
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
    improvementLedgerV1Enabled: boolean;
    improvementActivationV1Enabled: boolean;
    /** Kill switch for the P0 cowork runtime-quality layer (base prompt, answer-recovery, tool-call repair). Absent/false ⇒ features ON. */
    coworkRuntimeQualityV1Disabled?: boolean;
    /** Kill switch for S1 live terminal-synthesizer token streaming. Absent/false ⇒ feature ON; `true` reverts cowork/code to buffered delivery. */
    orchestrationFinalStreamingV1Disabled?: boolean;
    /** Master autonomy kill switch (Phase 1 proactivity / self-improvement). Absent/false ⇒ autonomy ON; `true` halts all autonomous loops. */
    autonomyV1Disabled?: boolean;
    /** Thinking-display skeleton. Absent/false (default) ⇒ no thinking_delta chunks are emitted; behavior is byte-identical to today. */
    chatThinkingStreamV1Enabled?: boolean;
    /** Unified Chat composer palette. Absent uses the server-configured rollout default. */
    unifiedComposerPaletteV1Enabled?: boolean;
    /** Safe read-only tools over a turn's immutable attached-context snapshot. */
    attachedContextToolsV1Enabled?: boolean;
    /** Inbound channel voice ingestion (B2a). Absent/false (default) ⇒ Telegram/WhatsApp voice keeps today's placeholder/drop behavior. */
    channelVoiceInboundV1Enabled?: boolean;
    /** Deprecated compatibility value; true emits a blocked-setting diagnostic but never enables Signal receive. */
    signalInboundV1Enabled?: boolean;
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
