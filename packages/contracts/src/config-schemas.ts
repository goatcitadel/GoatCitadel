import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool Policy
// ---------------------------------------------------------------------------

// A sandbox jail-root entry must be a non-empty path. An empty array of roots is
// fail-closed (no filesystem access granted); a single empty-string entry is
// fail-open because callers resolve roots with `path.resolve(rootDir, root)`, and
// `path.resolve(rootDir, "")` collapses to `rootDir` itself -- granting the entire
// project root for write / code-mode access. Reject empty and whitespace-only
// entries here so that no jail-root array can silently widen to the working root.
//
// Note: relative entries (e.g. "./workspace") are intentionally accepted. The
// gateway resolves every root against a trusted project `rootDir` before use, and
// all shipped configs declare roots relative to that root. Constraining to
// absolute-only here would reject those legitimate configs at parse time.
const SandboxJailRootSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Sandbox jail root must be a non-empty path (an empty string resolves to the working root).",
});

const ToolLoopDetectionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    historySize: z.number().int().min(2).max(50).default(8),
    warningThreshold: z.number().int().min(2).max(50).default(3),
    criticalThreshold: z.number().int().min(2).max(50).default(4),
    globalThreshold: z.number().int().min(2).max(100).default(6),
    detectors: z
      .object({
        repeated_same_call: z.boolean().default(true),
        no_progress_polling: z.boolean().default(true),
        ping_pong: z.boolean().default(true),
      })
      .default({
        repeated_same_call: true,
        no_progress_polling: true,
        ping_pong: true,
      }),
  })
  .superRefine((value, ctx) => {
    if (value.warningThreshold > value.criticalThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "warningThreshold must be less than or equal to criticalThreshold.",
        path: ["warningThreshold"],
      });
    }
    if (value.criticalThreshold > value.globalThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "criticalThreshold must be less than or equal to globalThreshold.",
        path: ["criticalThreshold"],
      });
    }
  });

// The fields a tool-policy block may carry. The top-level `tools` block applies
// defaults (allow/deny arrays, loop detection); per-agent overrides reuse the
// same field *shapes* but every field is optional (a partial override that is
// merged onto the base policy in `resolveEffectivePolicy`). Sharing the shape
// keeps the two in lock-step so a per-agent `tools.deny` is validated with the
// same rules as the base — instead of being accepted as `z.unknown()` and
// silently dropping a malformed `deny` (running broader than intended) or
// throwing a TypeError mid-evaluation.
const ToolPolicyToolsShape = {
  approvalMode: z.enum(["approve_all", "approve_risky", "bypass"]).optional(),
  profile: z.string().optional(),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  loopDetection: ToolLoopDetectionConfigSchema.default({
    enabled: true,
    historySize: 8,
    warningThreshold: 3,
    criticalThreshold: 4,
    globalThreshold: 6,
    detectors: {
      repeated_same_call: true,
      no_progress_polling: true,
      ping_pong: true,
    },
  }),
} as const;

// Per-agent override: same field shapes as the base tools block but fully
// optional (no defaults injected) and `allow`/`deny` accept only string arrays.
// `.passthrough()` preserves any forward-compatible keys without dropping them.
const PerAgentToolPolicyToolsSchema = z
  .object({
    approvalMode: z.enum(["approve_all", "approve_risky", "bypass"]).optional(),
    profile: z.string().optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    loopDetection: ToolLoopDetectionConfigSchema.optional(),
  })
  .passthrough();

const PerAgentToolPolicySchema = z
  .object({
    tools: PerAgentToolPolicyToolsSchema.optional(),
  })
  .passthrough();

export const ToolPolicyConfigSchema = z
  .object({
    profiles: z.record(z.string(), z.array(z.string())).default({}),
    tools: z.object(ToolPolicyToolsShape).passthrough(),
    agents: z.record(z.string(), PerAgentToolPolicySchema).default({}),
    sandbox: z
      .object({
        writeJailRoots: z.array(SandboxJailRootSchema),
        readOnlyRoots: z.array(SandboxJailRootSchema),
        readAccessMode: z.enum(["roots_only", "approval_required", "full_disk"]).default("roots_only"),
        networkAllowlist: z.array(z.string()).default([]),
        riskyShellPatterns: z.array(z.string()).default([]),
        requireApprovalForRiskyShell: z.boolean().default(true),
        riskyArgumentPatterns: z
          .array(
            z.object({
              toolNamePattern: z.string(),
              argumentPath: z.string().optional(),
              valuePatterns: z.array(z.string()),
            }),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .transform((value) => {
    const legacyProfile = value.tools.profile;
    const approvalMode = value.tools.approvalMode ?? (legacyProfile === "danger" ? "bypass" : "approve_risky");
    return {
      ...value,
      tools: {
        ...value.tools,
        approvalMode,
      },
    };
  });

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

export const LlmProviderRequestAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    token: z.string().optional(),
    tokenEnv: z.string().optional(),
    headerName: z.string().optional(),
  }),
  z.object({
    type: z.literal("header"),
    headerName: z.string().min(1),
    value: z.string().optional(),
    valueEnv: z.string().optional(),
    scheme: z.string().optional(),
  }),
  z.object({
    type: z.literal("query"),
    queryParam: z.string().min(1),
    value: z.string().optional(),
    valueEnv: z.string().optional(),
    prefix: z.string().optional(),
  }),
]);

export const LlmProviderRequestProxyAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    token: z.string().optional(),
    tokenEnv: z.string().optional(),
    headerName: z.string().optional(),
  }),
  z.object({
    type: z.literal("header"),
    headerName: z.string().min(1),
    value: z.string().optional(),
    valueEnv: z.string().optional(),
    scheme: z.string().optional(),
  }),
]);

export const LlmProviderRequestTlsSchema = z
  .object({
    insecureSkipVerify: z.boolean().optional(),
    caCertPath: z.string().optional(),
    clientCertPath: z.string().optional(),
    clientKeyPath: z.string().optional(),
    serverName: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasClientCert = Boolean(value.clientCertPath);
    const hasClientKey = Boolean(value.clientKeyPath);
    if (hasClientCert !== hasClientKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TLS clientCertPath and clientKeyPath must be provided together.",
        path: hasClientCert ? ["clientKeyPath"] : ["clientCertPath"],
      });
    }
    if (value.insecureSkipVerify && value.caCertPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TLS caCertPath cannot be combined with insecureSkipVerify.",
        path: ["caCertPath"],
      });
    }
  });

export const LlmProviderRequestProxySchema = z.object({
  url: z.string().url(),
  bypassHosts: z.array(z.string()).optional(),
  auth: LlmProviderRequestProxyAuthSchema.optional(),
  tls: LlmProviderRequestTlsSchema.optional(),
});

export const LlmProviderRequestConfigSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  auth: LlmProviderRequestAuthSchema.optional(),
  proxy: LlmProviderRequestProxySchema.optional(),
  tls: LlmProviderRequestTlsSchema.optional(),
});

export const LlmProviderConfigSchema = z
  .object({
    providerId: z.string(),
    label: z.string(),
    baseUrl: z.string(),
    apiStyle: z.enum([
      "openai-chat-completions",
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "bedrock-messages",
    ]),
    defaultModel: z.string(),
    authMode: z.enum(["api-key", "codex-oauth", "claude-code-oauth"]).optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    request: LlmProviderRequestConfigSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    capabilities: LlmProviderCapabilitiesSchema.partial().optional(),
  })
  .passthrough();

export const LlmConfigFileSchema = z
  .object({
    activeProviderId: z.string(),
    activeModel: z.string().optional(),
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
    toolApprovalMode: z.enum(["approve_all", "approve_risky", "bypass"]).optional(),
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
        autoRejectOnDanger: z.boolean().optional(),
        autoRejectDangerThreshold: z.enum(["danger", "nuclear"]).optional(),
      })
      .passthrough()
      .optional(),
    shellExplainerPolicy: z
      .object({
        enabled: z.boolean().optional(),
        elevateOnDanger: z.enum(["caution", "danger", "nuclear"]).optional(),
        autoRejectOnDanger: z.boolean().optional(),
        autoRejectDangerThreshold: z.enum(["danger", "nuclear"]).optional(),
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
    web: z
      .object({
        firecrawl: z
          .object({
            enabled: z.boolean().optional(),
            baseUrl: z.string().url().optional(),
            apiKeyEnv: z.string().optional(),
            timeoutMs: z.number().optional(),
            defaultReadBackend: z.enum(["native", "firecrawl"]).optional(),
            fallbackToNative: z.boolean().optional(),
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
    a2a: z
      .object({
        enabled: z.boolean().optional(),
        publicDiscoveryEnabled: z.boolean().optional(),
        protocolVersion: z.literal("1.0").optional(),
        bindings: z.array(z.enum(["JSONRPC", "GRPC", "HTTP_JSON"])).optional(),
        inbound: z
          .object({
            enabled: z.boolean().optional(),
            grpc: z
              .object({
                enabled: z.boolean().optional(),
                host: z.string().optional(),
                port: z.number().int().min(0).max(65_535).optional(),
              })
              .passthrough()
              .optional(),
            peerCredentials: z
              .array(
                z
                  .object({
                    peerId: z.string(),
                    label: z.string().optional(),
                    token: z.string().optional(),
                    tokenEnv: z.string().optional(),
                    scopes: z.array(z.string()).optional(),
                    expiresAt: z.string().optional(),
                    revokedAt: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        outbound: z
          .object({
            enabled: z.boolean().optional(),
            peers: z
              .array(
                z
                  .object({
                    peerId: z.string(),
                    label: z.string().optional(),
                    agentCardUrl: z.string(),
                    grpcUrl: z.string().optional(),
                    token: z.string().optional(),
                    tokenEnv: z.string().optional(),
                    enabled: z.boolean().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
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
    llamaCpp: z
      .object({
        enabled: z.boolean().optional(),
        autoStart: z.boolean().optional(),
        server: z
          .object({
            baseUrl: z.string().optional(),
            command: z.string().optional(),
            extraArgs: z.array(z.string()).optional(),
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
        launch: z
          .object({
            modelsRootPath: z.string().optional(),
            modelPath: z.string().optional(),
            alias: z.string().optional(),
            ctxSize: z.number().optional(),
            threads: z.number().optional(),
            gpuLayers: z.number().optional(),
            parallel: z.number().optional(),
            batchSize: z.number().optional(),
            ubatchSize: z.number().optional(),
            flashAttention: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    database: z
      .object({
        driver: z.enum(["sqlite", "postgres"]).optional(),
        postgres: z
          .object({
            mode: z.enum(["bundled", "managed"]).optional(),
            connectionString: z.string().optional(),
            connectionStringEnv: z.string().optional(),
            host: z.string().optional(),
            port: z.number().optional(),
            database: z.string().optional(),
            user: z.string().optional(),
            password: z.string().optional(),
            passwordEnv: z.string().optional(),
            ssl: z.enum(["disable", "prefer", "require"]).optional(),
            pool: z
              .object({
                min: z.number().optional(),
                max: z.number().optional(),
                idleTimeoutMs: z.number().optional(),
                connectionTimeoutMs: z.number().optional(),
              })
              .passthrough()
              .optional(),
            migrationsTable: z.string().optional(),
          })
          .passthrough()
          .optional(),
        bundledPostgres: z
          .object({
            enabled: z.boolean().optional(),
            dataDir: z.string().optional(),
            port: z.number().optional(),
            binDir: z.string().optional(),
            autoStart: z.boolean().optional(),
            startTimeoutMs: z.number().optional(),
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
    capabilities: z
      .object({
        candidateRoot: z.string().optional(),
        codeModeArtifactRoot: z.string().optional(),
        tempRoot: z.string().optional(),
        codeModeSandbox: z
          .object({
            required: z.boolean().optional(),
            bestEffortHostEnabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        codeModeDockerBackend: z
          .object({
            enabled: z.boolean().optional(),
            image: z.string().optional(),
            dockerCommand: z.string().optional(),
            nodeCommand: z.string().optional(),
          })
          .passthrough()
          .optional(),
        codeModeAiderAdapter: z
          .object({
            enabled: z.boolean().optional(),
            image: z.string().optional(),
            command: z.string().optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    features: z
      .object({
        durableKernelV1Enabled: z.boolean().optional(),
        replayOverridesV1Enabled: z.boolean().optional(),
        memoryLifecycleAdminV1Enabled: z.boolean().optional(),
        memoryLifecycleAutoForgetEnabled: z.boolean().optional(),
        memoryMaintenanceV1Enabled: z.boolean().optional(),
        connectorDiagnosticsV1Enabled: z.boolean().optional(),
        computerUseGuardrailsV1Enabled: z.boolean().optional(),
        cronReviewQueueV1Enabled: z.boolean().optional(),
        replayRegressionV1Enabled: z.boolean().optional(),
        codeModeV1Enabled: z.boolean().optional(),
        improvementLedgerV1Enabled: z.boolean().optional(),
        improvementActivationV1Enabled: z.boolean().optional(),
        // Kill-switch flags for the agentic-runtime-overhaul. The underlying
        // features ship ON by default; setting one of these to `true` disables
        // that feature (default-on with a reversible operator kill switch).
        coworkRuntimeQualityV1Disabled: z.boolean().optional(),
        // Master autonomy kill switch (Phase 1 proactivity / self-improvement).
        // Absent/false ⇒ autonomy ON; `true` halts ALL proactive, scheduled,
        // heartbeat, and self-improvement loops immediately. Single global switch.
        autonomyV1Disabled: z.boolean().optional(),
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
    action: z
      .enum([
        "task",
        "improvement",
        "curator",
        "backup",
        "memory_flush",
        "cost_report",
        "update_review",
        "watchdog",
        "no_agent",
      ])
      .default("task"),
    actionConfig: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
    schedule: z.string(),
    enabled: z.boolean(),
    endAt: z.string().optional(),
    workdir: z.string().optional(),
    contextFrom: z.string().optional(),
    lastRunOutput: z.string().optional(),
    lastRunId: z.string().optional(),
    lastRunStatus: z.enum(["ok", "failed"]).optional(),
    lastFailureAt: z.string().optional(),
    lastFailure: z
      .object({
        message: z.string(),
        code: z.string().optional(),
      })
      .optional(),
    failureCount: z.number().int().nonnegative().optional(),
    backoffUntil: z.string().optional(),
  })
  .passthrough();

export const CronJobsConfigSchema = z
  .object({
    jobs: z.array(CronJobSchema),
  })
  .passthrough();

export type CronJobsConfigInput = z.input<typeof CronJobsConfigSchema>;

// ---------------------------------------------------------------------------
// Agent Subagent Defaults
// ---------------------------------------------------------------------------

export const AgentSubagentDefaultsSchema = z
  .object({
    childTimeoutSeconds: z.number().int().positive().default(600),
    coworkChildTimeoutSeconds: z.number().int().positive().nullable().default(null),
    maxDepth: z.number().int().positive().default(4),
  })
  .passthrough();

export type AgentSubagentDefaultsInput = z.input<typeof AgentSubagentDefaultsSchema>;
export type AgentSubagentDefaults = z.output<typeof AgentSubagentDefaultsSchema>;
