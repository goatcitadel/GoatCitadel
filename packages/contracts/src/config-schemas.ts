import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool Policy
// ---------------------------------------------------------------------------

export const ToolPolicyConfigSchema = z
  .object({
    profiles: z.record(z.string(), z.array(z.string())).default({}),
    tools: z
      .object({
        profile: z.string(),
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
      })
      .passthrough(),
    agents: z.record(z.string(), z.unknown()).default({}),
    sandbox: z
      .object({
        writeJailRoots: z.array(z.string()),
        readOnlyRoots: z.array(z.string()),
        networkAllowlist: z.array(z.string()).default([]),
        riskyShellPatterns: z.array(z.string()).default([]),
        requireApprovalForRiskyShell: z.boolean().default(true),
      })
      .passthrough(),
  })
  .passthrough();

export type ToolPolicyConfigInput = z.input<typeof ToolPolicyConfigSchema>;

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export const LlmProviderCapabilitiesSchema = z
  .object({
    vision: z.boolean(),
    audio: z.boolean(),
    video: z.boolean(),
    toolCalling: z.boolean(),
    jsonMode: z.boolean(),
    webSearch: z.boolean().optional(),
    reasoning: z.boolean().optional(),
  })
  .passthrough();

export const LlmProviderConfigSchema = z
  .object({
    providerId: z.string(),
    label: z.string(),
    baseUrl: z.string(),
    apiStyle: z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"]),
    defaultModel: z.string(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    capabilities: LlmProviderCapabilitiesSchema.partial().optional(),
  })
  .passthrough();

export const LlmConfigFileSchema = z
  .object({
    activeProviderId: z.string(),
    providers: z.array(LlmProviderConfigSchema),
  })
  .passthrough();

export type LlmConfigFileInput = z.input<typeof LlmConfigFileSchema>;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export const BudgetConfigSchema = z
  .object({
    mode: z.enum(["saver", "balanced", "power"]),
    daily: z
      .object({
        tokensWarning: z.number(),
        tokensHardCap: z.number(),
        usdWarning: z.number(),
        usdHardCap: z.number(),
      })
      .passthrough(),
    session: z
      .object({
        tokensHardCap: z.number(),
        turnMaxInputTokens: z.number(),
        turnMaxOutputTokens: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export type BudgetConfigInput = z.input<typeof BudgetConfigSchema>;

// ---------------------------------------------------------------------------
// Assistant (input -- partial, since withAssistantDefaults fills gaps)
// ---------------------------------------------------------------------------

export const AssistantConfigInputSchema = z
  .object({
    environment: z.string().optional(),
    deploymentProfile: z.enum(["local_dev", "trusted_local", "remote_hardened"]).optional(),
    defaultToolProfile: z.string().optional(),
    dataDir: z.string().optional(),
    transcriptsDir: z.string().optional(),
    auditDir: z.string().optional(),
    workspaceDir: z.string().optional(),
    worktreesDir: z.string().optional(),
    auth: z
      .object({
        mode: z.enum(["none", "token", "basic"]).optional(),
        allowLoopbackBypass: z.boolean().optional(),
        token: z
          .object({
            value: z.string().optional(),
            queryParam: z.string().optional(),
          })
          .passthrough()
          .optional(),
        basic: z
          .object({
            username: z.string().optional(),
            password: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    approvalExplainer: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.literal("async").optional(),
        minRiskLevel: z.enum(["caution", "danger", "nuclear"]).optional(),
        providerId: z.string().optional(),
        model: z.string().optional(),
        timeoutMs: z.number().optional(),
        maxPayloadChars: z.number().optional(),
      })
      .passthrough()
      .optional(),
    memory: z
      .object({
        enabled: z.boolean().optional(),
        qmd: z
          .object({
            enabled: z.boolean().optional(),
            applyToChat: z.boolean().optional(),
            applyToOrchestration: z.boolean().optional(),
            minPromptChars: z.number().optional(),
            maxContextTokens: z.number().optional(),
            headroomTokens: z.number().optional(),
            maxTranscriptEvents: z.number().optional(),
            maxMemoryFiles: z.number().optional(),
            maxBytesPerFile: z.number().optional(),
            allowedExtensions: z.array(z.string()).optional(),
            cacheTtlSeconds: z.number().optional(),
            distiller: z
              .object({
                providerId: z.string().optional(),
                model: z.string().optional(),
                timeoutMs: z.number().optional(),
                fallbackCheapModel: z.string().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    mesh: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["lan", "wan", "tailnet"]).optional(),
        nodeId: z.string().optional(),
        label: z.string().optional(),
        advertiseAddress: z.string().optional(),
        discovery: z
          .object({
            mdns: z.boolean().optional(),
            staticPeers: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
        security: z
          .object({
            joinTokenEnv: z.string().optional(),
            requireMtls: z.boolean().optional(),
            tailnet: z
              .object({
                enabled: z.boolean().optional(),
                expectedTailnet: z.string().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        leases: z
          .object({
            ttlSeconds: z.number().optional(),
          })
          .passthrough()
          .optional(),
        replication: z
          .object({
            batchSize: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    npu: z
      .object({
        enabled: z.boolean().optional(),
        autoStart: z.boolean().optional(),
        sidecar: z
          .object({
            baseUrl: z.string().optional(),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            healthPath: z.string().optional(),
            modelsPath: z.string().optional(),
            startTimeoutMs: z.number().optional(),
            requestTimeoutMs: z.number().optional(),
            restartBudget: z
              .object({
                windowMs: z.number().optional(),
                maxRestarts: z.number().optional(),
                backoffMs: z.number().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    sqlite: z
      .object({
        cacheSizeKb: z.number().optional(),
        tempStoreMemory: z.boolean().optional(),
        walAutoCheckpointPages: z.number().optional(),
      })
      .passthrough()
      .optional(),
    durable: z
      .object({
        enabled: z.boolean().optional(),
        diagnosticsEnabled: z.boolean().optional(),
        executionEnabled: z.boolean().optional(),
        chatAutoPromoteEnabled: z.boolean().optional(),
        maxAttemptsDefault: z.number().optional(),
      })
      .passthrough()
      .optional(),
    features: z
      .object({
        durableKernelV1Enabled: z.boolean().optional(),
        replayOverridesV1Enabled: z.boolean().optional(),
        memoryLifecycleAdminV1Enabled: z.boolean().optional(),
        connectorDiagnosticsV1Enabled: z.boolean().optional(),
        computerUseGuardrailsV1Enabled: z.boolean().optional(),
        bankrBuiltinEnabled: z.boolean().optional(),
        cronReviewQueueV1Enabled: z.boolean().optional(),
        replayRegressionV1Enabled: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    budgets: z
      .object({
        dailyUsdWarning: z.number().optional(),
        dailyUsdHardCap: z.number().optional(),
        sessionTokenHardCap: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AssistantConfigInputType = z.input<typeof AssistantConfigInputSchema>;

// ---------------------------------------------------------------------------
// Cron Jobs
// ---------------------------------------------------------------------------

export const CronJobSchema = z
  .object({
    jobId: z.string(),
    name: z.string(),
    schedule: z.string(),
    enabled: z.boolean(),
  })
  .passthrough();

export const CronJobsConfigSchema = z
  .object({
    jobs: z.array(CronJobSchema),
  })
  .passthrough();

export type CronJobsConfigInput = z.input<typeof CronJobsConfigSchema>;
