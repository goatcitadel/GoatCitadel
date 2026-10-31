import { z } from "zod";
import { OUTSIDE_ROOT_WRITE_MODES } from "./outside-root-write.js";
import { WEB_SEARCH_NATIVE_ENGINES } from "./web-search.js";

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
// `resolveEffectivePolicy` merges only `allow`, `deny` and `approvalMode` (the
// latter can only tighten, never loosen); `profile` and `loopDetection` are
// accepted for forward compatibility but are not honoured per agent.
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
        /**
         * Exact env key names exempted from the secret-key scrub applied to
         * model-driven child processes (shell/tests/lint/build spawns).
         */
        spawnEnvPassthrough: z.array(z.string().min(1).max(256)).max(64).default([]),
        /**
         * Operator-opened folders outside the write jail, for model-driven
         * filesystem tools only. Validated against the write-root safety rules
         * at load; invalid entries are dropped with a warning.
         */
        operatorWriteRoots: z
          .array(
            z
              .object({
                /** Required unless `preset` is set; a preset entry's path is resolved on the server. */
                path: z.string().max(1024).optional(),
                allowDelete: z.boolean().default(false),
                label: z.string().max(120).optional(),
                preset: z.enum(["os_temp"]).optional(),
                addedAt: z.string().max(64).optional(),
              })
              .strict()
              .refine((root) => root.preset !== undefined || (root.path ?? "").trim().length > 0, {
                message: "Operator write root needs a non-empty path unless it uses a preset.",
                path: ["path"],
              }),
          )
          .max(32)
          .default([]),
        /** Outside-root writes raise an approval only when "approval_required". */
        outsideRootWriteMode: z.enum(OUTSIDE_ROOT_WRITE_MODES).default("deny"),
      })
      .passthrough(),
    /**
     * Hooks-scoped webhook egress. Distinct from `sandbox.networkAllowlist`
     * (tool egress): a non-empty list restricts webhook destinations to the
     * listed hosts; empty means any public https host (the network guard
     * always blocks loopback/private/reserved hosts).
     */
    hooks: z
      .object({
        networkAllowlist: z.array(z.string()).default([]),
      })
      .passthrough()
      .default({ networkAllowlist: [] }),
  })
  .passthrough()
  .transform((value) => {
    // Old profile names remain loadable, but cannot change approval behavior.
    const approvalMode = value.tools.approvalMode ?? "approve_risky";
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
    reasoningEfforts: z
      .array(z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"]))
      .min(1)
      .optional(),
  })
  .passthrough();

export const LlmProviderGoogleCloudConfigSchema = z
  .object({
    projectId: z.string().min(1).max(128).optional(),
    projectIdEnv: z.string().min(1).max(128).optional(),
    location: z.string().min(1).max(64).optional(),
    locationEnv: z.string().min(1).max(128).optional(),
    endpointId: z.string().min(1).max(128).optional(),
  })
  .strict();

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

export const LlmProviderAuthModeSchema = z.enum([
  "api-key",
  "codex-oauth",
  "claude-code-oauth",
  "claude-code-cli-login",
  "google-service-account",
  "google-adc",
  "aws-sigv4",
  "aws-bedrock-api-key",
]);

/** Returns an operator-facing error when an AWS auth mode is paired with a non-Bedrock API style. */
export function describeAwsAuthModeApiStyleMismatch(
  apiStyle: string | undefined,
  authMode: string | undefined,
): string | undefined {
  if ((authMode === "aws-sigv4" || authMode === "aws-bedrock-api-key") && apiStyle !== "bedrock-messages") {
    return `authMode "${authMode}" is only valid with apiStyle "bedrock-messages" (got "${apiStyle ?? "unset"}").`;
  }
  return undefined;
}

/** The only origin the local Claude Code CLI talks to; its profile baseUrl is pinned to it. */
export const CLAUDE_CODE_CLI_EGRESS_BASE_URL = "https://api.anthropic.com/v1";

/** The `claude-code-cli` API style and login auth mode run the operator's local CLI; they belong to that built-in provider only. */
export function describeClaudeCodeCliApiStyleMismatch(
  providerId: string,
  apiStyle: string | undefined,
  authMode?: string,
): string | undefined {
  if (providerId.trim().toLowerCase() === "claude-code-cli") return undefined;
  if (apiStyle === "claude-code-cli") {
    return `apiStyle "claude-code-cli" is only valid for the built-in "claude-code-cli" provider (got "${providerId}").`;
  }
  // The login mode carries subscription usage lineage; no other provider may claim it.
  if (authMode === "claude-code-cli-login") {
    return `authMode "claude-code-cli-login" is only valid for the built-in "claude-code-cli" provider (got "${providerId}").`;
  }
  return undefined;
}

/** The operator's next step for each readiness reason the local Claude Code CLI login probe reports. */
export function describeClaudeCodeCliLoginGuidance(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case "claude_cli_logged_in":
      return "Claude Code is signed in on this machine with your Claude subscription.";
    case "claude_cli_logged_out":
      return "Claude Code is not signed in on this machine. Run claude in a terminal, sign in with /login, then check again.";
    case "claude_cli_not_subscription_login":
      return "Claude Code is signed in with an API key or a cloud provider, not a Claude subscription. Run /login in claude and choose your Claude account, then check again.";
    case "claude_cli_managed_hooks_active":
      return "Organization-managed Claude Code hooks are active, so GoatCitadel will not run this CLI.";
    case "claude_cli_managed_auto_memory":
      return "Organization-managed Claude Code settings force auto-memory on, so GoatCitadel will not run this CLI.";
    case "claude_cli_not_probed":
      return "GoatCitadel has not checked the Claude Code login yet. Check it to continue.";
    default:
      return "The claude CLI was not found or did not answer. Install Claude Code, make sure claude runs in a terminal, then check again.";
  }
}

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
      "claude-code-cli",
    ]),
    defaultModel: z.string(),
    authMode: LlmProviderAuthModeSchema.optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    googleCloud: LlmProviderGoogleCloudConfigSchema.optional(),
    request: LlmProviderRequestConfigSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    capabilities: LlmProviderCapabilitiesSchema.partial().optional(),
  })
  .passthrough()
  .superRefine((provider, ctx) => {
    const message = describeAwsAuthModeApiStyleMismatch(provider.apiStyle, provider.authMode);
    if (message) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authMode"], message });
    }
    const cliMessage = describeClaudeCodeCliApiStyleMismatch(provider.providerId, provider.apiStyle, provider.authMode);
    if (cliMessage) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["apiStyle"], message: cliMessage });
    }
  });

export const LlmConfigFileSchema = z
  .object({
    activeProviderId: z.string(),
    activeModel: z.string().optional(),
    defaultThinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]).optional(),
    // Optional cheap utility-model slot for background LLM tasks; only honored
    // when the utilityModelRoutingV1Enabled feature flag is on.
    utilityProviderId: z.string().optional(),
    utilityModel: z.string().optional(),
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
    /** Deprecated config field; accepted only so existing files still parse. */
    defaultToolProfile: z.string().optional(),
    dataDir: z.string().optional(),
    transcriptsDir: z.string().optional(),
    auditDir: z.string().optional(),
    workspaceDir: z.string().optional(),
    worktreesDir: z.string().optional(),
    /** The https address the internet uses to reach this installation. Checked and normalized on load. */
    publicWebAddress: z.string().optional(),
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
        search: z
          .object({
            engineOrder: z.array(z.enum(WEB_SEARCH_NATIVE_ENGINES)).optional(),
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
                    allowedWorkspaceIds: z.array(z.string().trim().min(1)).optional(),
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
        managementMode: z.enum(["external", "managed"]).optional(),
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
            asyncGatewayEnabled: z.boolean().optional(),
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
            stopTimeoutMs: z.number().optional(),
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
            requireDigestPin: z.boolean().optional(),
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
        codeModeHostSandboxEnabled: z.boolean().optional(),
        improvementLedgerV1Enabled: z.boolean().optional(),
        improvementActivationV1Enabled: z.boolean().optional(),
        promptRetuneCampaignV1Enabled: z.boolean().optional(),
        structuredReviewV2Enabled: z.boolean().optional(),
        delegationScopeExpansionV1Enabled: z.boolean().optional(),
        engineeringLearningsV1Enabled: z.boolean().optional(),
        // Kill-switch flags for the agentic-runtime-overhaul. The underlying
        // features ship ON by default; setting one of these to `true` disables
        // that feature (default-on with a reversible operator kill switch).
        coworkRuntimeQualityV1Disabled: z.boolean().optional(),
        // Kill switch for streaming the terminal synthesizer step's real model
        // tokens to the SSE client (default-on); `true` restores the buffered
        // whole-orchestration delivery with the post-hoc synthetic delta split.
        orchestrationFinalStreamingV1Disabled: z.boolean().optional(),
        // Master autonomy kill switch (Phase 1 proactivity / self-improvement).
        // Absent/false ⇒ autonomy ON; `true` halts ALL proactive, scheduled,
        // heartbeat, and self-improvement loops immediately. Single global switch.
        autonomyV1Disabled: z.boolean().optional(),
        // Thinking display: gates the gateway emitting `thinking_delta`
        // stream chunks. Absent/false (default) ⇒ byte-identical to today.
        chatThinkingStreamV1Enabled: z.boolean().optional(),
        // On-demand estimates in session.status. Absent/false keeps the normal hot path unchanged.
        chatContextBudgetVisibilityV1Enabled: z.boolean().optional(),
        chatAsyncClarificationV1Enabled: z.boolean().optional(),
        // B2b: TTS voice replies to audio-capable channels (Telegram voice notes).
        // Absent/false (default) ⇒ byte-identical to today; no synthesis runs.
        channelVoiceReplyV1Enabled: z.boolean().optional(),
        // Inbound channel voice ingestion (Telegram voice notes / WhatsApp
        // audio → transcription → governed turn). Absent/false (default) ⇒
        // byte-identical: parsers keep emitting placeholders / dropping voice.
        channelVoiceInboundV1Enabled: z.boolean().optional(),
        // Weekly governed memory consolidation: mines completed run traces and
        // PROPOSES memory candidates (approval-gated, never auto-applied).
        // Absent/false (default) ⇒ the consolidation job never runs.
        memoryConsolidationV1Enabled: z.boolean().optional(),
        // Records a signed cron_job_executed evidence envelope for every cron
        // run and pins the envelope id on the job record. Absent/false
        // (default) ⇒ cron runs record no evidence, exactly as today.
        cronEvidenceV1Enabled: z.boolean().optional(),
        // Routes background LLM calls (improvement scans, judges, classifiers,
        // prompt packs) to the configured cheap utility-model slot. Absent/false
        // (default) ⇒ background calls keep today's model selection exactly.
        utilityModelRoutingV1Enabled: z.boolean().optional(),
        evolutionControlPlaneV1Enabled: z.boolean().optional(),
        improvementLocalObservationV1Enabled: z.boolean().optional(),
        improvementModelEvaluationV1Enabled: z.boolean().optional(),
        productSourceEvolutionV1Enabled: z.boolean().optional(),
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
        "memory_consolidation",
        "cost_report",
        "update_review",
        "watchdog",
        "no_agent",
        "agent_turn",
      ])
      .default("task"),
    actionConfig: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
    schedule: z.string(),
    enabled: z.boolean(),
    endAt: z.string().optional(),
    workdir: z.string().optional(),
    contextFrom: z.string().optional(),
    citadelId: z.string().optional(),
    lastRunOutput: z.string().optional(),
    lastRunId: z.string().optional(),
    lastRunStatus: z.enum(["ok", "failed", "skipped"]).optional(),
    lastRunEvidenceEnvelopeId: z.string().optional(),
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
