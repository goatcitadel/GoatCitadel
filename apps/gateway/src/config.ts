import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthMode, DeploymentProfile, LlmConfigFile, ToolPolicyConfig } from "@goatcitadel/contracts";
import {
  AssistantConfigInputSchema,
  BudgetConfigSchema,
  ConfigValidationError,
  LlmConfigFileSchema,
  ToolPolicyConfigSchema,
  clampInt,
} from "@goatcitadel/contracts";
import { ZodError, type ZodType } from "zod";
import { syncUnifiedConfig } from "./config-sync-lib.js";
import { isVerboseLoggingEnabled } from "./runtime-ux.js";

export interface AssistantConfig {
  environment: string;
  deploymentProfile: DeploymentProfile;
  defaultToolProfile: string;
  dataDir: string;
  transcriptsDir: string;
  auditDir: string;
  workspaceDir: string;
  worktreesDir: string;
  auth: AuthConfig;
  approvalExplainer: ApprovalExplainerConfig;
  memory: MemoryConfig;
  mesh: MeshConfig;
  npu: NpuConfig;
  sqlite: SqliteTuningConfig;
  durable: DurableConfig;
  features: FeatureFlagsConfig;
  budgets: {
    dailyUsdWarning: number;
    dailyUsdHardCap: number;
    sessionTokenHardCap: number;
  };
}

export interface FeatureFlagsConfig {
  durableKernelV1Enabled: boolean;
  replayOverridesV1Enabled: boolean;
  memoryLifecycleAdminV1Enabled: boolean;
  memoryMaintenanceV1Enabled: boolean;
  connectorDiagnosticsV1Enabled: boolean;
  computerUseGuardrailsV1Enabled: boolean;
  bankrBuiltinEnabled: boolean;
  cronReviewQueueV1Enabled: boolean;
  replayRegressionV1Enabled: boolean;
}

export interface MemoryConfig {
  enabled: boolean;
  qmd: {
    enabled: boolean;
    applyToChat: boolean;
    applyToOrchestration: boolean;
    minPromptChars: number;
    maxContextTokens: number;
    headroomTokens: number;
    maxTranscriptEvents: number;
    maxMemoryFiles: number;
    maxBytesPerFile: number;
    allowedExtensions: string[];
    cacheTtlSeconds: number;
    distiller: {
      providerId?: string;
      model?: string;
      timeoutMs: number;
      fallbackCheapModel: string;
    };
  };
}

export interface AuthConfig {
  mode: AuthMode;
  allowLoopbackBypass: boolean;
  token: {
    value?: string;
    queryParam: string;
  };
  basic: {
    username?: string;
    password?: string;
  };
}

export interface ApprovalExplainerConfig {
  enabled: boolean;
  mode: "async";
  minRiskLevel: "caution" | "danger" | "nuclear";
  providerId?: string;
  model?: string;
  timeoutMs: number;
  maxPayloadChars: number;
}

export interface MeshConfig {
  enabled: boolean;
  mode: "lan" | "wan" | "tailnet";
  nodeId: string;
  label?: string;
  advertiseAddress?: string;
  discovery: {
    mdns: boolean;
    staticPeers: string[];
  };
  security: {
    joinTokenEnv: string;
    requireMtls: boolean;
    tailnet: {
      enabled: boolean;
      expectedTailnet?: string;
    };
  };
  leases: {
    ttlSeconds: number;
  };
  replication: {
    batchSize: number;
  };
}

export interface NpuConfig {
  enabled: boolean;
  autoStart: boolean;
  sidecar: {
    baseUrl: string;
    command: string;
    args: string[];
    healthPath: string;
    modelsPath: string;
    startTimeoutMs: number;
    requestTimeoutMs: number;
    restartBudget: {
      windowMs: number;
      maxRestarts: number;
      backoffMs: number;
    };
  };
}

export interface DurableConfig {
  enabled: boolean;
  diagnosticsEnabled: boolean;
  executionEnabled: boolean;
  chatAutoPromoteEnabled: boolean;
  maxAttemptsDefault: number;
}

export interface SqliteTuningConfig {
  cacheSizeKb: number;
  tempStoreMemory: boolean;
  walAutoCheckpointPages: number;
}

export interface BudgetConfig {
  mode: "saver" | "balanced" | "power";
  daily: {
    tokensWarning: number;
    tokensHardCap: number;
    usdWarning: number;
    usdHardCap: number;
  };
  session: {
    tokensHardCap: number;
    turnMaxInputTokens: number;
    turnMaxOutputTokens: number;
  };
}

export interface GatewayRuntimeConfig {
  assistant: AssistantConfig;
  toolPolicy: ToolPolicyConfig;
  budgets: BudgetConfig;
  llm: LlmConfigFile;
  rootDir: string;
  dbPath: string;
}

export async function loadGatewayConfig(rootDir: string): Promise<GatewayRuntimeConfig> {
  const syncResult = await syncUnifiedConfig(rootDir, { createUnifiedIfMissing: true });
  if (syncResult.createdUnified || syncResult.syncedSections.length > 0) {
    const changes = [
      syncResult.createdUnified ? "created config/goatcitadel.json" : undefined,
      ...syncResult.syncedSections.map((name) => `synced ${name}`),
    ].filter(Boolean);
    const prefix = isVerboseLoggingEnabled()
      ? "[goatcitadel:config]"
      : "[goatcitadel]";
    console.info(`${prefix} config sync: ${changes.join(", ")}`);
  }

  const configDir = path.join(rootDir, "config");
  const [assistantRaw, toolPolicyRaw, budgetsRaw, llmRaw] = await Promise.all([
    fs.readFile(path.join(configDir, "assistant.config.json"), "utf8"),
    fs.readFile(path.join(configDir, "tool-policy.json"), "utf8"),
    fs.readFile(path.join(configDir, "budgets.json"), "utf8"),
    readFileWithDefault(path.join(configDir, "llm-providers.json"), defaultLlmConfig()),
  ]);

  const assistantPath = path.join(configDir, "assistant.config.json");
  const toolPolicyPath = path.join(configDir, "tool-policy.json");
  const budgetsPath = path.join(configDir, "budgets.json");
  const llmPath = path.join(configDir, "llm-providers.json");

  const assistantInput = parseAndValidate(assistantRaw, AssistantConfigInputSchema, assistantPath);
  const assistant = withAssistantDefaults(assistantInput as Partial<AssistantConfig>);
  const toolPolicy = parseAndValidate(toolPolicyRaw, ToolPolicyConfigSchema, toolPolicyPath) as ToolPolicyConfig;
  const budgets = parseAndValidate(budgetsRaw, BudgetConfigSchema, budgetsPath) as BudgetConfig;
  const llm = parseAndValidate(llmRaw, LlmConfigFileSchema, llmPath) as LlmConfigFile;

  applyEnvironmentOverrides(assistant);

  toolPolicy.sandbox.writeJailRoots = toolPolicy.sandbox.writeJailRoots.map((root) =>
    path.resolve(rootDir, root),
  );
  toolPolicy.sandbox.readOnlyRoots = toolPolicy.sandbox.readOnlyRoots.map((root) =>
    path.resolve(rootDir, root),
  );

  return {
    assistant,
    toolPolicy,
    budgets,
    llm,
    rootDir,
    dbPath: path.join(rootDir, "data", "index.db"),
  };
}

function parseJsonConfig<T>(raw: string, filePath: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse config JSON at ${filePath}: invalid JSON`);
  }
}

function parseAndValidate<T>(raw: string, schema: ZodType<T>, filePath: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse config JSON at ${filePath}: invalid JSON`);
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      }));
      throw new ConfigValidationError(filePath, issues);
    }
    throw error;
  }
}

function applyEnvironmentOverrides(assistant: AssistantConfig): void {
  const deploymentProfile = process.env.GOATCITADEL_DEPLOYMENT_PROFILE?.trim();
  if (
    deploymentProfile === "local_dev"
    || deploymentProfile === "trusted_local"
    || deploymentProfile === "remote_hardened"
  ) {
    assistant.deploymentProfile = deploymentProfile;
  }
  const mode = process.env.GOATCITADEL_AUTH_MODE;
  if (mode === "none" || mode === "token" || mode === "basic") {
    assistant.auth.mode = mode;
  }

  const token = process.env.GOATCITADEL_AUTH_TOKEN;
  if (token) {
    assistant.auth.token.value = token.trim();
  }

  const basicUsername = process.env.GOATCITADEL_AUTH_BASIC_USERNAME;
  if (basicUsername) {
    assistant.auth.basic.username = basicUsername.trim();
  }

  const basicPassword = process.env.GOATCITADEL_AUTH_BASIC_PASSWORD;
  if (basicPassword) {
    assistant.auth.basic.password = basicPassword;
  }

  const allowLoopbackBypass = process.env.GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS;
  if (allowLoopbackBypass) {
    assistant.auth.allowLoopbackBypass = allowLoopbackBypass === "1" || allowLoopbackBypass.toLowerCase() === "true";
  }

  const meshEnabled = process.env.GOATCITADEL_MESH_ENABLED;
  if (meshEnabled) {
    assistant.mesh.enabled = meshEnabled === "1" || meshEnabled.toLowerCase() === "true";
  }

  const meshMode = process.env.GOATCITADEL_MESH_MODE;
  if (meshMode === "lan" || meshMode === "wan" || meshMode === "tailnet") {
    assistant.mesh.mode = meshMode;
  }

  const meshNodeId = process.env.GOATCITADEL_MESH_NODE_ID;
  if (meshNodeId?.trim()) {
    assistant.mesh.nodeId = meshNodeId.trim();
  }

  const npuEnabled = process.env.GOATCITADEL_NPU_ENABLED;
  if (npuEnabled) {
    assistant.npu.enabled = npuEnabled === "1" || npuEnabled.toLowerCase() === "true";
  }

  const npuAutoStart = process.env.GOATCITADEL_NPU_AUTOSTART;
  if (npuAutoStart) {
    assistant.npu.autoStart = npuAutoStart === "1" || npuAutoStart.toLowerCase() === "true";
  }

  const npuBaseUrl = process.env.GOATCITADEL_NPU_SIDECAR_URL;
  if (npuBaseUrl?.trim()) {
    assistant.npu.sidecar.baseUrl = npuBaseUrl.trim();
  }

  const memoryEnabled = process.env.GOATCITADEL_MEMORY_ENABLED;
  if (memoryEnabled) {
    assistant.memory.enabled = memoryEnabled === "1" || memoryEnabled.toLowerCase() === "true";
  }

  const qmdEnabled = process.env.GOATCITADEL_MEMORY_QMD_ENABLED;
  if (qmdEnabled) {
    assistant.memory.qmd.enabled = qmdEnabled === "1" || qmdEnabled.toLowerCase() === "true";
  }

  const durableEnabled = process.env.GOATCITADEL_DURABLE_FOUNDATION_ENABLED;
  if (durableEnabled) {
    assistant.durable.enabled = durableEnabled === "1" || durableEnabled.toLowerCase() === "true";
  }

  const durableDiagnosticsEnabled = process.env.GOATCITADEL_DURABLE_DIAGNOSTICS_ENABLED;
  if (durableDiagnosticsEnabled) {
    assistant.durable.diagnosticsEnabled = durableDiagnosticsEnabled === "1"
      || durableDiagnosticsEnabled.toLowerCase() === "true";
  }

  const durableExecutionEnabled = process.env.GOATCITADEL_DURABLE_EXECUTION_ENABLED;
  if (durableExecutionEnabled) {
    assistant.durable.executionEnabled = durableExecutionEnabled === "1"
      || durableExecutionEnabled.toLowerCase() === "true";
  }

  const durableChatAutoPromoteEnabled = process.env.GOATCITADEL_DURABLE_CHAT_AUTO_PROMOTE_ENABLED;
  if (durableChatAutoPromoteEnabled) {
    assistant.durable.chatAutoPromoteEnabled = durableChatAutoPromoteEnabled === "1"
      || durableChatAutoPromoteEnabled.toLowerCase() === "true";
  }

  const featureFlagMap: Array<[keyof FeatureFlagsConfig, string | undefined]> = [
    ["durableKernelV1Enabled", process.env.GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED],
    ["replayOverridesV1Enabled", process.env.GOATCITADEL_FEATURE_REPLAY_OVERRIDES_V1_ENABLED],
    ["memoryLifecycleAdminV1Enabled", process.env.GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED],
    ["memoryMaintenanceV1Enabled", process.env.GOATCITADEL_FEATURE_MEMORY_MAINTENANCE_V1_ENABLED],
    ["connectorDiagnosticsV1Enabled", process.env.GOATCITADEL_FEATURE_CONNECTOR_DIAGNOSTICS_V1_ENABLED],
    ["computerUseGuardrailsV1Enabled", process.env.GOATCITADEL_FEATURE_COMPUTER_USE_GUARDRAILS_V1_ENABLED],
    ["bankrBuiltinEnabled", process.env.GOATCITADEL_FEATURE_BANKR_BUILTIN_ENABLED],
    ["cronReviewQueueV1Enabled", process.env.GOATCITADEL_FEATURE_CRON_REVIEW_QUEUE_V1_ENABLED],
    ["replayRegressionV1Enabled", process.env.GOATCITADEL_FEATURE_REPLAY_REGRESSION_V1_ENABLED],
  ];
  for (const [flag, raw] of featureFlagMap) {
    if (!raw) {
      continue;
    }
    assistant.features[flag] = raw === "1" || raw.toLowerCase() === "true";
  }

  const sqliteCacheSizeKb = parseIntEnv(process.env.GOATCITADEL_SQLITE_CACHE_SIZE_KB);
  if (sqliteCacheSizeKb !== undefined) {
    assistant.sqlite.cacheSizeKb = clampInt(sqliteCacheSizeKb, assistant.sqlite.cacheSizeKb, 4_096, 262_144);
  }
  const sqliteTempStoreMemory = parseBooleanEnv(process.env.GOATCITADEL_SQLITE_TEMP_STORE_MEMORY);
  if (sqliteTempStoreMemory !== undefined) {
    assistant.sqlite.tempStoreMemory = sqliteTempStoreMemory;
  }
  const sqliteWalAutoCheckpoint = parseIntEnv(process.env.GOATCITADEL_SQLITE_WAL_AUTOCHECKPOINT_PAGES);
  if (sqliteWalAutoCheckpoint !== undefined) {
    assistant.sqlite.walAutoCheckpointPages = clampInt(sqliteWalAutoCheckpoint, assistant.sqlite.walAutoCheckpointPages, 1_000, 20_000);
  }
}

function withAssistantDefaults(input: Partial<AssistantConfig>): AssistantConfig {
  const approvalExplainerDefaults: ApprovalExplainerConfig = {
    enabled: true,
    mode: "async",
    minRiskLevel: "caution",
    timeoutMs: 15000,
    maxPayloadChars: 4000,
  };

  const authInput = (input.auth ?? {}) as Partial<AuthConfig>;
  const tokenInput = (authInput.token ?? {}) as Partial<AuthConfig["token"]>;
  const basicInput = (authInput.basic ?? {}) as Partial<AuthConfig["basic"]>;
  const meshInput = (input.mesh ?? {}) as Partial<MeshConfig>;
  const meshDiscovery = (meshInput.discovery ?? {}) as Partial<MeshConfig["discovery"]>;
  const meshSecurity = (meshInput.security ?? {}) as Partial<MeshConfig["security"]>;
  const meshTailnet = (meshSecurity.tailnet ?? {}) as Partial<MeshConfig["security"]["tailnet"]>;
  const meshLeases = (meshInput.leases ?? {}) as Partial<MeshConfig["leases"]>;
  const meshReplication = (meshInput.replication ?? {}) as Partial<MeshConfig["replication"]>;
  const npuInput = (input.npu ?? {}) as Partial<NpuConfig>;
  const npuSidecar = (npuInput.sidecar ?? {}) as Partial<NpuConfig["sidecar"]>;
  const npuRestart = (npuSidecar.restartBudget ?? {}) as Partial<NpuConfig["sidecar"]["restartBudget"]>;
  const sqliteInput = (input.sqlite ?? {}) as Partial<SqliteTuningConfig>;
  const durableInput = (input.durable ?? {}) as Partial<DurableConfig>;
  const featuresInput = (input.features ?? {}) as Partial<FeatureFlagsConfig>;
  const memoryInput = (input.memory ?? {}) as Partial<MemoryConfig>;
  const qmdInput = (memoryInput.qmd ?? {}) as Partial<MemoryConfig["qmd"]>;
  const distillerInput = (qmdInput.distiller ?? {}) as Partial<MemoryConfig["qmd"]["distiller"]>;

  return {
    environment: input.environment ?? "local",
    deploymentProfile: input.deploymentProfile ?? "local_dev",
    defaultToolProfile: input.defaultToolProfile ?? "minimal",
    dataDir: input.dataDir ?? "./data",
    transcriptsDir: input.transcriptsDir ?? "./data/transcripts",
    auditDir: input.auditDir ?? "./data/audit",
    workspaceDir: input.workspaceDir ?? "./workspace",
    worktreesDir: input.worktreesDir ?? "./.worktrees",
    auth: {
      mode: authInput.mode ?? "none",
      allowLoopbackBypass: authInput.allowLoopbackBypass ?? false,
      token: {
        value: tokenInput.value,
        queryParam: tokenInput.queryParam ?? "access_token",
      },
      basic: {
        username: basicInput.username,
        password: basicInput.password,
      },
    },
    approvalExplainer: {
      ...approvalExplainerDefaults,
      ...(input.approvalExplainer ?? {}),
    },
    memory: {
      enabled: memoryInput.enabled ?? true,
      qmd: {
        enabled: qmdInput.enabled ?? true,
        applyToChat: qmdInput.applyToChat ?? true,
        applyToOrchestration: qmdInput.applyToOrchestration ?? true,
        minPromptChars: qmdInput.minPromptChars ?? 48,
        maxContextTokens: qmdInput.maxContextTokens ?? 1400,
        headroomTokens: qmdInput.headroomTokens ?? 600,
        maxTranscriptEvents: qmdInput.maxTranscriptEvents ?? 80,
        maxMemoryFiles: qmdInput.maxMemoryFiles ?? 36,
        maxBytesPerFile: qmdInput.maxBytesPerFile ?? 64_000,
        allowedExtensions: qmdInput.allowedExtensions ?? [
          ".md",
          ".txt",
          ".json",
          ".yaml",
          ".yml",
          ".log",
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
        ],
        cacheTtlSeconds: qmdInput.cacheTtlSeconds ?? 300,
        distiller: {
          providerId: distillerInput.providerId,
          model: distillerInput.model,
          timeoutMs: distillerInput.timeoutMs ?? 12_000,
          fallbackCheapModel: distillerInput.fallbackCheapModel ?? "gpt-4.1-nano",
        },
      },
    },
    mesh: {
      enabled: meshInput.enabled ?? false,
      mode: meshInput.mode ?? "lan",
      nodeId: meshInput.nodeId ?? `${os.hostname().toLowerCase()}-${process.pid}`,
      label: meshInput.label,
      advertiseAddress: meshInput.advertiseAddress,
      discovery: {
        mdns: meshDiscovery.mdns ?? true,
        staticPeers: meshDiscovery.staticPeers ?? [],
      },
      security: {
        joinTokenEnv: meshSecurity.joinTokenEnv ?? "GOATCITADEL_MESH_JOIN_TOKEN",
        requireMtls: meshSecurity.requireMtls ?? true,
        tailnet: {
          enabled: meshTailnet.enabled ?? false,
          expectedTailnet: meshTailnet.expectedTailnet,
        },
      },
      leases: {
        ttlSeconds: meshLeases.ttlSeconds ?? 30,
      },
      replication: {
        batchSize: meshReplication.batchSize ?? 200,
      },
    },
    npu: {
      enabled: npuInput.enabled ?? false,
      autoStart: npuInput.autoStart ?? false,
      sidecar: {
        baseUrl: npuSidecar.baseUrl ?? "http://127.0.0.1:11440",
        command: npuSidecar.command ?? "python",
        args: npuSidecar.args ?? ["apps/npu-sidecar/server.py"],
        healthPath: npuSidecar.healthPath ?? "/health",
        modelsPath: npuSidecar.modelsPath ?? "/v1/models",
        startTimeoutMs: npuSidecar.startTimeoutMs ?? 20_000,
        requestTimeoutMs: npuSidecar.requestTimeoutMs ?? 12_000,
        restartBudget: {
          windowMs: npuRestart.windowMs ?? 60_000,
          maxRestarts: npuRestart.maxRestarts ?? 5,
          backoffMs: npuRestart.backoffMs ?? 2_000,
        },
      },
    },
    sqlite: {
      cacheSizeKb: clampInt(sqliteInput.cacheSizeKb, 65_536, 4_096, 262_144),
      tempStoreMemory: sqliteInput.tempStoreMemory ?? true,
      walAutoCheckpointPages: clampInt(sqliteInput.walAutoCheckpointPages, 5_000, 1_000, 20_000),
    },
    durable: {
      enabled: durableInput.enabled ?? false,
      diagnosticsEnabled: durableInput.diagnosticsEnabled ?? false,
      executionEnabled: durableInput.executionEnabled ?? false,
      chatAutoPromoteEnabled: durableInput.chatAutoPromoteEnabled ?? false,
      maxAttemptsDefault: Math.max(1, Math.floor(durableInput.maxAttemptsDefault ?? 3)),
    },
    features: {
      durableKernelV1Enabled: featuresInput.durableKernelV1Enabled ?? false,
      replayOverridesV1Enabled: featuresInput.replayOverridesV1Enabled ?? false,
      memoryLifecycleAdminV1Enabled: featuresInput.memoryLifecycleAdminV1Enabled ?? false,
      memoryMaintenanceV1Enabled: featuresInput.memoryMaintenanceV1Enabled ?? false,
      connectorDiagnosticsV1Enabled: featuresInput.connectorDiagnosticsV1Enabled ?? false,
      computerUseGuardrailsV1Enabled: featuresInput.computerUseGuardrailsV1Enabled ?? true,
      bankrBuiltinEnabled: featuresInput.bankrBuiltinEnabled ?? false,
      cronReviewQueueV1Enabled: featuresInput.cronReviewQueueV1Enabled ?? false,
      replayRegressionV1Enabled: featuresInput.replayRegressionV1Enabled ?? false,
    },
    budgets: {
      dailyUsdWarning: input.budgets?.dailyUsdWarning ?? 10,
      dailyUsdHardCap: input.budgets?.dailyUsdHardCap ?? 50,
      sessionTokenHardCap: input.budgets?.sessionTokenHardCap ?? 120000,
    },
  };
}

async function readFileWithDefault(filePath: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function defaultLlmConfig(): string {
  return JSON.stringify({
    activeProviderId: "openai",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4-mini",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "anthropic-messages",
        defaultModel: "claude-sonnet-4-6",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      {
        providerId: "google",
        label: "Google (compatible endpoint)",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiStyle: "openai-chat-completions",
        defaultModel: "models/gemini-2.5-flash",
        apiKeyEnv: "GOOGLE_API_KEY",
      },
      {
        providerId: "minimax",
        label: "MiniMax (compatible endpoint)",
        baseUrl: "https://api.minimax.io/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "MiniMax-M2.7",
        apiKeyEnv: "MINIMAX_API_KEY",
      },
      {
        providerId: "openrouter",
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "openai/gpt-5.4-mini",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      {
        providerId: "mistral",
        label: "Mistral",
        baseUrl: "https://api.mistral.ai/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "mistral-small-latest",
        apiKeyEnv: "MISTRAL_API_KEY",
      },
      {
        providerId: "deepseek",
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      {
        providerId: "glm",
        label: "GLM (Z.AI)",
        baseUrl: "https://api.z.ai/api/paas/v4",
        apiStyle: "openai-chat-completions",
        defaultModel: "glm-5",
        apiKeyEnv: "GLM_API_KEY",
      },
      {
        providerId: "moonshot",
        label: "Moonshot (Kimi API)",
        baseUrl: "https://api.moonshot.ai/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "kimi-k2.5",
        apiKeyEnv: "MOONSHOT_API_KEY",
      },
      {
        providerId: "perplexity",
        label: "Perplexity",
        baseUrl: "https://api.perplexity.ai",
        apiStyle: "openai-chat-completions",
        defaultModel: "sonar",
        apiKeyEnv: "PERPLEXITY_API_KEY",
      },
      {
        providerId: "lmstudio",
        label: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "local-model",
        apiKeyEnv: "LM_STUDIO_API_KEY",
      },
      {
        providerId: "ollama",
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "llama3.2",
      },
      {
        providerId: "npu-local",
        label: "NPU Local Sidecar",
        baseUrl: "http://127.0.0.1:11440/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: "phi-3.5-mini-instruct",
      },
    ],
  });
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function parseIntEnv(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
