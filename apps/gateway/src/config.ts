/* eslint-disable max-lines -- runtime config normalization stays together so env, file, and defaults remain aligned. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  A2ABridgeRuntimeConfig,
  AuthMode,
  DeploymentProfile,
  LlmConfigFile,
  ToolApprovalMode,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import {
  AssistantConfigInputSchema,
  BudgetConfigSchema,
  ConfigValidationError,
  LlmConfigFileSchema,
  ToolPolicyConfigSchema,
  clampInt,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { normalizeFirecrawlApiKeyEnvName } from "@goatcitadel/policy-engine";
import { ZodError, type ZodType } from "zod";
import { materializeConfigFilesFromExamples } from "./config-files.js";
import { syncUnifiedConfig } from "./config-sync-lib.js";
import { isVerboseLoggingEnabled } from "./runtime-ux.js";
import { DEFAULT_LLAMACPP_ALIAS } from "./services/llama-cpp-runtime-service.js";

const configLog = logger.child("config");

export interface AssistantConfig {
  environment: string;
  deploymentProfile: DeploymentProfile;
  toolApprovalMode: ToolApprovalMode;
  defaultToolProfile: string;
  dataDir: string;
  transcriptsDir: string;
  auditDir: string;
  capabilities: CapabilityRuntimeConfig;
  workspaceDir: string;
  worktreesDir: string;
  auth: AuthConfig;
  approvalExplainer: ApprovalExplainerConfig;
  shellExplainerPolicy: ShellExplainerPolicyConfig;
  memory: MemoryConfig;
  web: WebRuntimeConfig;
  mesh: MeshConfig;
  a2a: A2ABridgeRuntimeConfig;
  npu: NpuConfig;
  llamaCpp: LlamaCppConfig;
  database: DatabaseRuntimeConfig;
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
  memoryLifecycleAutoForgetEnabled: boolean;
  memoryMaintenanceV1Enabled: boolean;
  connectorDiagnosticsV1Enabled: boolean;
  computerUseGuardrailsV1Enabled: boolean;
  cronReviewQueueV1Enabled: boolean;
  replayRegressionV1Enabled: boolean;
  codeModeV1Enabled: boolean;
  improvementLedgerV1Enabled: boolean;
  improvementActivationV1Enabled: boolean;
}

export interface CapabilityRuntimeConfig {
  candidateRoot: string;
  codeModeArtifactRoot: string;
  tempRoot: string;
  codeModeSandbox: CodeModeSandboxConfig;
  codeModeDockerBackend: CodeModeDockerBackendConfig;
  codeModeAiderAdapter: CodeModeAiderAdapterConfig;
}

export interface CodeModeSandboxConfig {
  mode: "best_effort_host";
  required: boolean;
  bestEffortHostEnabled: boolean;
}

export interface CodeModeDockerBackendConfig {
  enabled: boolean;
  image?: string;
  dockerCommand?: string;
  nodeCommand?: string;
}

export interface CodeModeAiderAdapterConfig {
  enabled: boolean;
  image?: string;
  command?: string;
  model?: string;
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

export interface FirecrawlRuntimeConfig {
  enabled: boolean;
  baseUrl: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  defaultReadBackend: "native" | "firecrawl";
  fallbackToNative: boolean;
}

export interface WebRuntimeConfig {
  firecrawl: FirecrawlRuntimeConfig;
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
  autoRejectOnDanger?: boolean;
  autoRejectDangerThreshold?: "danger" | "nuclear";
}

export interface ShellExplainerPolicyConfig {
  enabled: boolean;
  elevateOnDanger?: "caution" | "danger" | "nuclear";
  autoRejectOnDanger?: boolean;
  autoRejectDangerThreshold?: "danger" | "nuclear";
}

export const DEFAULT_SHELL_EXPLAINER_POLICY: ShellExplainerPolicyConfig = {
  enabled: true,
  elevateOnDanger: "danger",
  autoRejectOnDanger: false,
};

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

export interface LlamaCppConfig {
  enabled: boolean;
  autoStart: boolean;
  server: {
    baseUrl: string;
    command: string;
    extraArgs: string[];
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
  launch: {
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
  };
}

export interface DurableConfig {
  enabled: boolean;
  diagnosticsEnabled: boolean;
  executionEnabled: boolean;
  chatAutoPromoteEnabled: boolean;
  maxAttemptsDefault: number;
  /** Maximum wall-clock time (ms) for a single workflow execution before it is cancelled. Default: 5 minutes. */
  workflowTimeoutMs: number;
}

export interface SqliteTuningConfig {
  cacheSizeKb: number;
  tempStoreMemory: boolean;
  walAutoCheckpointPages: number;
}

export type DatabaseDriver = "sqlite" | "postgres";
export type PostgresRuntimeMode = "bundled" | "managed";
export type PostgresSslMode = "disable" | "prefer" | "require";

export interface PostgresPoolConfig {
  min: number;
  max: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export interface PostgresRuntimeConfig {
  mode: PostgresRuntimeMode;
  connectionString?: string;
  connectionStringEnv?: string;
  host?: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  passwordEnv?: string;
  ssl: PostgresSslMode;
  pool: PostgresPoolConfig;
  migrationsTable: string;
}

export interface BundledPostgresConfig {
  enabled: boolean;
  dataDir: string;
  port: number;
  binDir?: string;
  autoStart: boolean;
  startTimeoutMs: number;
}

export interface DatabaseRuntimeConfig {
  driver: DatabaseDriver;
  postgres: PostgresRuntimeConfig;
  bundledPostgres: BundledPostgresConfig;
  sqlite: SqliteTuningConfig;
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

/**
 * Tracked config files for the mtime-keyed load cache. Must include every file
 * that {@link loadGatewayConfig} reads + validates directly. `cron-jobs.json` is
 * not read by `loadGatewayConfig` itself; the unified config sync handles it.
 */
const TRACKED_CONFIG_FILES = [
  "assistant.config.json",
  "tool-policy.json",
  "budgets.json",
  "llm-providers.json",
] as const;

interface ConfigMtimeCacheEntry {
  mtimes: Record<string, number>;
  value: GatewayRuntimeConfig;
}

let configMtimeCache: { key: string; entry: ConfigMtimeCacheEntry } | null = null;

/** @internal Test-only: reset the in-memory mtime cache between tests. */
export function __resetConfigMtimeCacheForTests(): void {
  configMtimeCache = null;
}

async function readConfigMtimes(configDir: string, files: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(path.join(configDir, file));
        out[file] = stat.mtimeMs;
      } catch {
        out[file] = 0;
      }
    }),
  );
  return out;
}

function configMtimesEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) {
      return false;
    }
  }
  return true;
}

export async function loadGatewayConfig(rootDir: string): Promise<GatewayRuntimeConfig> {
  const syncResult = await syncUnifiedConfig(rootDir, { createUnifiedIfMissing: true });
  if (syncResult.createdUnified || syncResult.materializedExamples.length > 0 || syncResult.syncedSections.length > 0) {
    const changes = [
      ...syncResult.materializedExamples.map((name) => `materialized ${name} from example`),
      syncResult.createdUnified ? "created config/goatcitadel.json" : undefined,
      ...syncResult.syncedSections.map((name) => `synced ${name}`),
    ].filter(Boolean);
    const prefix = isVerboseLoggingEnabled() ? "[goatcitadel:config]" : "[goatcitadel]";
    // Config sync is intentionally visible so first-run bootstrap is understandable.
    // eslint-disable-next-line no-console
    console.info(`${prefix} config sync: ${changes.join(", ")}`);
  }

  const configDir = path.join(rootDir, "config");

  const cacheKey = path.resolve(rootDir);
  const currentMtimes = await readConfigMtimes(configDir, TRACKED_CONFIG_FILES);
  if (
    configMtimeCache &&
    configMtimeCache.key === cacheKey &&
    configMtimesEqual(configMtimeCache.entry.mtimes, currentMtimes)
  ) {
    configLog.debug("config cache hit (mtime unchanged)", { rootDir: cacheKey });
    return configMtimeCache.entry.value;
  }

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

  toolPolicy.tools.approvalMode = assistant.toolApprovalMode ?? toolPolicy.tools.approvalMode;
  toolPolicy.sandbox.writeJailRoots = toolPolicy.sandbox.writeJailRoots.map((root) => path.resolve(rootDir, root));
  toolPolicy.sandbox.readOnlyRoots = toolPolicy.sandbox.readOnlyRoots.map((root) => path.resolve(rootDir, root));

  const result: GatewayRuntimeConfig = {
    assistant,
    toolPolicy,
    budgets,
    llm,
    rootDir,
    dbPath: path.join(rootDir, assistant.dataDir, "index.db"),
  };

  // Capture mtimes AFTER load so any side-effects from the sync/materialize
  // path (which can mutate split files on first run) are reflected in the
  // cache key. Without this, the next call could think files changed and
  // miss the cache forever.
  const postLoadMtimes = await readConfigMtimes(configDir, TRACKED_CONFIG_FILES);
  configMtimeCache = {
    key: cacheKey,
    entry: { mtimes: postLoadMtimes, value: result },
  };

  return result;
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
    deploymentProfile === "local_dev" ||
    deploymentProfile === "trusted_local" ||
    deploymentProfile === "remote_hardened"
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

  const a2aEnabled = process.env.GOATCITADEL_A2A_ENABLED;
  if (a2aEnabled) {
    assistant.a2a.enabled = a2aEnabled === "1" || a2aEnabled.toLowerCase() === "true";
  }

  const a2aPublicDiscovery = process.env.GOATCITADEL_A2A_PUBLIC_DISCOVERY_ENABLED;
  if (a2aPublicDiscovery) {
    assistant.a2a.publicDiscoveryEnabled = a2aPublicDiscovery === "1" || a2aPublicDiscovery.toLowerCase() === "true";
  }

  const a2aInbound = process.env.GOATCITADEL_A2A_INBOUND_ENABLED;
  if (a2aInbound) {
    assistant.a2a.inbound.enabled = a2aInbound === "1" || a2aInbound.toLowerCase() === "true";
  }

  const a2aBindings = parseA2ABindingsEnv(process.env.GOATCITADEL_A2A_BINDINGS);
  if (a2aBindings.length > 0) {
    assistant.a2a.bindings = a2aBindings;
  }

  const a2aGrpcEnabled = parseBooleanEnv(process.env.GOATCITADEL_A2A_GRPC_ENABLED);
  if (a2aGrpcEnabled !== undefined) {
    assistant.a2a.inbound.grpc.enabled = a2aGrpcEnabled;
  }

  const a2aGrpcHost = process.env.GOATCITADEL_A2A_GRPC_HOST?.trim();
  if (a2aGrpcHost) {
    assistant.a2a.inbound.grpc.host = a2aGrpcHost;
  }

  const a2aGrpcPort = parseIntEnv(process.env.GOATCITADEL_A2A_GRPC_PORT);
  if (a2aGrpcPort !== undefined) {
    assistant.a2a.inbound.grpc.port = clampInt(a2aGrpcPort, 8788, 0, 65_535);
  }

  const a2aOutbound = process.env.GOATCITADEL_A2A_OUTBOUND_ENABLED;
  if (a2aOutbound) {
    assistant.a2a.outbound.enabled = a2aOutbound === "1" || a2aOutbound.toLowerCase() === "true";
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

  const llamaCppEnabled = process.env.GOATCITADEL_LLAMACPP_ENABLED;
  if (llamaCppEnabled) {
    assistant.llamaCpp.enabled = llamaCppEnabled === "1" || llamaCppEnabled.toLowerCase() === "true";
  }

  const llamaCppAutoStart = process.env.GOATCITADEL_LLAMACPP_AUTOSTART;
  if (llamaCppAutoStart) {
    assistant.llamaCpp.autoStart = llamaCppAutoStart === "1" || llamaCppAutoStart.toLowerCase() === "true";
  }

  const llamaCppBaseUrl = process.env.GOATCITADEL_LLAMACPP_URL;
  if (llamaCppBaseUrl?.trim()) {
    assistant.llamaCpp.server.baseUrl = llamaCppBaseUrl.trim();
  }

  const llamaCppCommand = process.env.GOATCITADEL_LLAMACPP_COMMAND;
  if (llamaCppCommand?.trim()) {
    assistant.llamaCpp.server.command = llamaCppCommand.trim();
  }

  const llamaCppModelPath = process.env.GOATCITADEL_LLAMACPP_MODEL_PATH;
  if (llamaCppModelPath?.trim()) {
    assistant.llamaCpp.launch.modelPath = llamaCppModelPath.trim();
  }

  const llamaCppModelsRoot = process.env.GOATCITADEL_LLAMACPP_MODELS_ROOT;
  if (llamaCppModelsRoot?.trim()) {
    assistant.llamaCpp.launch.modelsRootPath = llamaCppModelsRoot.trim();
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
    assistant.durable.diagnosticsEnabled =
      durableDiagnosticsEnabled === "1" || durableDiagnosticsEnabled.toLowerCase() === "true";
  }

  const durableExecutionEnabled = process.env.GOATCITADEL_DURABLE_EXECUTION_ENABLED;
  if (durableExecutionEnabled) {
    assistant.durable.executionEnabled =
      durableExecutionEnabled === "1" || durableExecutionEnabled.toLowerCase() === "true";
  }

  const durableChatAutoPromoteEnabled = process.env.GOATCITADEL_DURABLE_CHAT_AUTO_PROMOTE_ENABLED;
  if (durableChatAutoPromoteEnabled) {
    assistant.durable.chatAutoPromoteEnabled =
      durableChatAutoPromoteEnabled === "1" || durableChatAutoPromoteEnabled.toLowerCase() === "true";
  }

  const featureFlagMap: Array<[keyof FeatureFlagsConfig, string | undefined]> = [
    ["durableKernelV1Enabled", process.env.GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED],
    ["replayOverridesV1Enabled", process.env.GOATCITADEL_FEATURE_REPLAY_OVERRIDES_V1_ENABLED],
    ["memoryLifecycleAdminV1Enabled", process.env.GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED],
    ["memoryLifecycleAutoForgetEnabled", process.env.GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_AUTO_FORGET_ENABLED],
    ["memoryMaintenanceV1Enabled", process.env.GOATCITADEL_FEATURE_MEMORY_MAINTENANCE_V1_ENABLED],
    ["connectorDiagnosticsV1Enabled", process.env.GOATCITADEL_FEATURE_CONNECTOR_DIAGNOSTICS_V1_ENABLED],
    ["computerUseGuardrailsV1Enabled", process.env.GOATCITADEL_FEATURE_COMPUTER_USE_GUARDRAILS_V1_ENABLED],
    ["cronReviewQueueV1Enabled", process.env.GOATCITADEL_FEATURE_CRON_REVIEW_QUEUE_V1_ENABLED],
    ["replayRegressionV1Enabled", process.env.GOATCITADEL_FEATURE_REPLAY_REGRESSION_V1_ENABLED],
    ["codeModeV1Enabled", process.env.GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED],
    ["improvementLedgerV1Enabled", process.env.GOATCITADEL_FEATURE_IMPROVEMENT_LEDGER_V1_ENABLED],
    ["improvementActivationV1Enabled", process.env.GOATCITADEL_FEATURE_IMPROVEMENT_ACTIVATION_V1_ENABLED],
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
    assistant.sqlite.walAutoCheckpointPages = clampInt(
      sqliteWalAutoCheckpoint,
      assistant.sqlite.walAutoCheckpointPages,
      1_000,
      20_000,
    );
  }
  const databaseDriver = process.env.GOATCITADEL_DATABASE_DRIVER?.trim().toLowerCase();
  if (databaseDriver === "sqlite" || databaseDriver === "postgres") {
    assistant.database.driver = databaseDriver;
  }
  const postgresMode = process.env.GOATCITADEL_POSTGRES_MODE?.trim().toLowerCase();
  if (postgresMode === "bundled" || postgresMode === "managed") {
    assistant.database.postgres.mode = postgresMode;
  }
  const postgresConnectionString = process.env.GOATCITADEL_POSTGRES_CONNECTION_STRING?.trim();
  if (postgresConnectionString) {
    assistant.database.postgres.connectionString = postgresConnectionString;
  }
  const postgresConnectionStringEnv = process.env.GOATCITADEL_POSTGRES_CONNECTION_STRING_ENV?.trim();
  if (postgresConnectionStringEnv) {
    assistant.database.postgres.connectionStringEnv = postgresConnectionStringEnv;
    const resolvedConnectionString = process.env[postgresConnectionStringEnv]?.trim();
    if (resolvedConnectionString) {
      assistant.database.postgres.connectionString = resolvedConnectionString;
    }
  }
  const postgresHost = process.env.GOATCITADEL_POSTGRES_HOST?.trim();
  if (postgresHost) {
    assistant.database.postgres.host = postgresHost;
  }
  const postgresPort = parseIntEnv(process.env.GOATCITADEL_POSTGRES_PORT);
  if (postgresPort !== undefined) {
    assistant.database.postgres.port = clampInt(postgresPort, assistant.database.postgres.port, 1, 65_535);
  }
  const postgresDatabase = process.env.GOATCITADEL_POSTGRES_DATABASE?.trim();
  if (postgresDatabase) {
    assistant.database.postgres.database = postgresDatabase;
  }
  const postgresUser = process.env.GOATCITADEL_POSTGRES_USER?.trim();
  if (postgresUser) {
    assistant.database.postgres.user = postgresUser;
  }
  const postgresPassword = process.env.GOATCITADEL_POSTGRES_PASSWORD;
  if (postgresPassword) {
    assistant.database.postgres.password = postgresPassword;
  }
  const postgresPasswordEnv = process.env.GOATCITADEL_POSTGRES_PASSWORD_ENV?.trim();
  if (postgresPasswordEnv) {
    assistant.database.postgres.passwordEnv = postgresPasswordEnv;
    const resolvedPassword = process.env[postgresPasswordEnv];
    if (resolvedPassword) {
      assistant.database.postgres.password = resolvedPassword;
    }
  }
  const postgresSsl = process.env.GOATCITADEL_POSTGRES_SSL?.trim().toLowerCase();
  if (postgresSsl === "disable" || postgresSsl === "prefer" || postgresSsl === "require") {
    assistant.database.postgres.ssl = postgresSsl;
  }
  const postgresPoolMin = parseIntEnv(process.env.GOATCITADEL_POSTGRES_POOL_MIN);
  if (postgresPoolMin !== undefined) {
    assistant.database.postgres.pool.min = clampInt(postgresPoolMin, assistant.database.postgres.pool.min, 0, 100);
  }
  const postgresPoolMax = parseIntEnv(process.env.GOATCITADEL_POSTGRES_POOL_MAX);
  if (postgresPoolMax !== undefined) {
    assistant.database.postgres.pool.max = clampInt(postgresPoolMax, assistant.database.postgres.pool.max, 1, 200);
  }
  const postgresIdleTimeoutMs = parseIntEnv(process.env.GOATCITADEL_POSTGRES_POOL_IDLE_TIMEOUT_MS);
  if (postgresIdleTimeoutMs !== undefined) {
    assistant.database.postgres.pool.idleTimeoutMs = clampInt(
      postgresIdleTimeoutMs,
      assistant.database.postgres.pool.idleTimeoutMs,
      1_000,
      300_000,
    );
  }
  const postgresConnectionTimeoutMs = parseIntEnv(process.env.GOATCITADEL_POSTGRES_POOL_CONNECTION_TIMEOUT_MS);
  if (postgresConnectionTimeoutMs !== undefined) {
    assistant.database.postgres.pool.connectionTimeoutMs = clampInt(
      postgresConnectionTimeoutMs,
      assistant.database.postgres.pool.connectionTimeoutMs,
      1_000,
      120_000,
    );
  }
  const bundledPostgresEnabled = parseBooleanEnv(process.env.GOATCITADEL_BUNDLED_POSTGRES_ENABLED);
  if (bundledPostgresEnabled !== undefined) {
    assistant.database.bundledPostgres.enabled = bundledPostgresEnabled;
  }
  const bundledPostgresDataDir = process.env.GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR?.trim();
  if (bundledPostgresDataDir) {
    assistant.database.bundledPostgres.dataDir = bundledPostgresDataDir;
  }
  const bundledPostgresPort = parseIntEnv(process.env.GOATCITADEL_BUNDLED_POSTGRES_PORT);
  if (bundledPostgresPort !== undefined) {
    assistant.database.bundledPostgres.port = clampInt(
      bundledPostgresPort,
      assistant.database.bundledPostgres.port,
      1,
      65_535,
    );
  }
  const bundledPostgresBinDir = process.env.GOATCITADEL_BUNDLED_POSTGRES_BIN_DIR?.trim();
  if (bundledPostgresBinDir) {
    assistant.database.bundledPostgres.binDir = bundledPostgresBinDir;
  }
  const bundledPostgresAutoStart = parseBooleanEnv(process.env.GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART);
  if (bundledPostgresAutoStart !== undefined) {
    assistant.database.bundledPostgres.autoStart = bundledPostgresAutoStart;
  }
  const bundledPostgresStartTimeoutMs = parseIntEnv(process.env.GOATCITADEL_BUNDLED_POSTGRES_START_TIMEOUT_MS);
  if (bundledPostgresStartTimeoutMs !== undefined) {
    assistant.database.bundledPostgres.startTimeoutMs = clampInt(
      bundledPostgresStartTimeoutMs,
      assistant.database.bundledPostgres.startTimeoutMs,
      1_000,
      120_000,
    );
  }
  const firecrawlEnabled = parseBooleanEnv(process.env.GOATCITADEL_FIRECRAWL_ENABLED);
  if (firecrawlEnabled !== undefined) {
    assistant.web.firecrawl.enabled = firecrawlEnabled;
  }
  const firecrawlBaseUrl = process.env.GOATCITADEL_FIRECRAWL_BASE_URL?.trim();
  if (firecrawlBaseUrl) {
    assistant.web.firecrawl.baseUrl = firecrawlBaseUrl;
  }
  const firecrawlApiKeyEnv = normalizeFirecrawlApiKeyEnvName(process.env.GOATCITADEL_FIRECRAWL_API_KEY_ENV);
  if (firecrawlApiKeyEnv) {
    assistant.web.firecrawl.apiKeyEnv = firecrawlApiKeyEnv;
  }
  const firecrawlTimeoutMs = parseIntEnv(process.env.GOATCITADEL_FIRECRAWL_TIMEOUT_MS);
  if (firecrawlTimeoutMs !== undefined) {
    assistant.web.firecrawl.timeoutMs = clampInt(firecrawlTimeoutMs, assistant.web.firecrawl.timeoutMs, 1_000, 120_000);
  }
  const firecrawlFallbackToNative = parseBooleanEnv(process.env.GOATCITADEL_FIRECRAWL_FALLBACK_TO_NATIVE);
  if (firecrawlFallbackToNative !== undefined) {
    assistant.web.firecrawl.fallbackToNative = firecrawlFallbackToNative;
  }
  const firecrawlDefaultReadBackend = process.env.GOATCITADEL_FIRECRAWL_DEFAULT_READ_BACKEND?.trim().toLowerCase();
  if (firecrawlDefaultReadBackend === "native" || firecrawlDefaultReadBackend === "firecrawl") {
    assistant.web.firecrawl.defaultReadBackend = firecrawlDefaultReadBackend;
  }

  const capabilityCandidateRoot = process.env.GOATCITADEL_CAPABILITY_CANDIDATE_ROOT?.trim();
  if (capabilityCandidateRoot) {
    assistant.capabilities.candidateRoot = capabilityCandidateRoot;
  }
  const codeModeArtifactRoot = process.env.GOATCITADEL_CODE_MODE_ARTIFACT_ROOT?.trim();
  if (codeModeArtifactRoot) {
    assistant.capabilities.codeModeArtifactRoot = codeModeArtifactRoot;
  }
  const codeModeTempRoot = process.env.GOATCITADEL_CODE_MODE_TEMP_ROOT?.trim();
  if (codeModeTempRoot) {
    assistant.capabilities.tempRoot = codeModeTempRoot;
  }
  const codeModeSandboxRequired = parseBooleanEnv(process.env.GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED);
  if (codeModeSandboxRequired !== undefined) {
    assistant.capabilities.codeModeSandbox.required = codeModeSandboxRequired;
  }
  const bestEffortSandboxEnabled = parseBooleanEnv(process.env.GOATCITADEL_CODE_MODE_BEST_EFFORT_SANDBOX_ENABLED);
  if (bestEffortSandboxEnabled !== undefined) {
    assistant.capabilities.codeModeSandbox.bestEffortHostEnabled = bestEffortSandboxEnabled;
  }
  const codeModeDockerBackendEnabled = parseBooleanEnv(process.env.GOATCITADEL_CODE_MODE_DOCKER_BACKEND_ENABLED);
  if (codeModeDockerBackendEnabled !== undefined) {
    assistant.capabilities.codeModeDockerBackend.enabled = codeModeDockerBackendEnabled;
  }
  const codeModeDockerImage = process.env.GOATCITADEL_CODE_MODE_DOCKER_IMAGE?.trim();
  if (codeModeDockerImage) {
    assistant.capabilities.codeModeDockerBackend.image = codeModeDockerImage;
  }
  const codeModeDockerCommand = process.env.GOATCITADEL_CODE_MODE_DOCKER_COMMAND?.trim();
  if (codeModeDockerCommand) {
    assistant.capabilities.codeModeDockerBackend.dockerCommand = codeModeDockerCommand;
  }
  const codeModeDockerNodeCommand = process.env.GOATCITADEL_CODE_MODE_DOCKER_NODE_COMMAND?.trim();
  if (codeModeDockerNodeCommand) {
    assistant.capabilities.codeModeDockerBackend.nodeCommand = codeModeDockerNodeCommand;
  }
  const codeModeAiderAdapterEnabled = parseBooleanEnv(process.env.GOATCITADEL_CODE_MODE_AIDER_ADAPTER_ENABLED);
  if (codeModeAiderAdapterEnabled !== undefined) {
    assistant.capabilities.codeModeAiderAdapter.enabled = codeModeAiderAdapterEnabled;
  }
  const codeModeAiderImage = process.env.GOATCITADEL_CODE_MODE_AIDER_IMAGE?.trim();
  if (codeModeAiderImage) {
    assistant.capabilities.codeModeAiderAdapter.image = codeModeAiderImage;
  }
  const codeModeAiderCommand = process.env.GOATCITADEL_CODE_MODE_AIDER_COMMAND?.trim();
  if (codeModeAiderCommand) {
    assistant.capabilities.codeModeAiderAdapter.command = codeModeAiderCommand;
  }
  const codeModeAiderModel = process.env.GOATCITADEL_CODE_MODE_AIDER_MODEL?.trim();
  if (codeModeAiderModel) {
    assistant.capabilities.codeModeAiderAdapter.model = codeModeAiderModel;
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
  const a2aInput = (input.a2a ?? {}) as Partial<A2ABridgeRuntimeConfig>;
  const a2aInboundInput = (a2aInput.inbound ?? {}) as Partial<A2ABridgeRuntimeConfig["inbound"]>;
  const a2aGrpcInput = (a2aInboundInput.grpc ?? {}) as Partial<A2ABridgeRuntimeConfig["inbound"]["grpc"]>;
  const a2aOutboundInput = (a2aInput.outbound ?? {}) as Partial<A2ABridgeRuntimeConfig["outbound"]>;
  const npuInput = (input.npu ?? {}) as Partial<NpuConfig>;
  const npuSidecar = (npuInput.sidecar ?? {}) as Partial<NpuConfig["sidecar"]>;
  const npuRestart = (npuSidecar.restartBudget ?? {}) as Partial<NpuConfig["sidecar"]["restartBudget"]>;
  const llamaCppInput = (input.llamaCpp ?? {}) as Partial<LlamaCppConfig>;
  const llamaCppServer = (llamaCppInput.server ?? {}) as Partial<LlamaCppConfig["server"]>;
  const llamaCppRestart = (llamaCppServer.restartBudget ?? {}) as Partial<LlamaCppConfig["server"]["restartBudget"]>;
  const llamaCppLaunch = (llamaCppInput.launch ?? {}) as Partial<LlamaCppConfig["launch"]>;
  const sqliteInput = (input.sqlite ?? {}) as Partial<SqliteTuningConfig>;
  const databaseInput = (input.database ?? {}) as Partial<DatabaseRuntimeConfig>;
  const postgresInput = (databaseInput.postgres ?? {}) as Partial<PostgresRuntimeConfig>;
  const postgresPoolInput = (postgresInput.pool ?? {}) as Partial<PostgresPoolConfig>;
  const bundledPostgresInput = (databaseInput.bundledPostgres ?? {}) as Partial<BundledPostgresConfig>;
  const durableInput = (input.durable ?? {}) as Partial<DurableConfig>;
  const capabilitiesInput = (input.capabilities ?? {}) as Partial<CapabilityRuntimeConfig>;
  const featuresInput = (input.features ?? {}) as Partial<FeatureFlagsConfig>;
  const memoryInput = (input.memory ?? {}) as Partial<MemoryConfig>;
  const qmdInput = (memoryInput.qmd ?? {}) as Partial<MemoryConfig["qmd"]>;
  const distillerInput = (qmdInput.distiller ?? {}) as Partial<MemoryConfig["qmd"]["distiller"]>;
  const webInput = (input.web ?? {}) as Partial<WebRuntimeConfig>;
  const firecrawlInput = (webInput.firecrawl ?? {}) as Partial<FirecrawlRuntimeConfig>;
  const sqlite: SqliteTuningConfig = {
    cacheSizeKb: clampInt(sqliteInput.cacheSizeKb, 65_536, 4_096, 262_144),
    tempStoreMemory: sqliteInput.tempStoreMemory ?? true,
    walAutoCheckpointPages: clampInt(sqliteInput.walAutoCheckpointPages, 5_000, 1_000, 20_000),
  };
  const durableBaselineDrift =
    durableInput.enabled === false ||
    durableInput.executionEnabled === false ||
    durableInput.chatAutoPromoteEnabled === false ||
    featuresInput.durableKernelV1Enabled === false;
  if (durableBaselineDrift) {
    configLog.warn("durable baseline drift detected in runtime config; coercing always-on durable execution", {
      durableEnabled: durableInput.enabled,
      durableExecutionEnabled: durableInput.executionEnabled,
      durableChatAutoPromoteEnabled: durableInput.chatAutoPromoteEnabled,
      durableKernelV1Enabled: featuresInput.durableKernelV1Enabled,
    });
  }

  return {
    environment: input.environment ?? "local",
    deploymentProfile: input.deploymentProfile ?? "local_dev",
    toolApprovalMode: input.toolApprovalMode ?? (input.defaultToolProfile === "danger" ? "bypass" : "approve_risky"),
    defaultToolProfile: input.defaultToolProfile ?? "minimal",
    dataDir: input.dataDir ?? "./data",
    transcriptsDir: input.transcriptsDir ?? "./data/transcripts",
    auditDir: input.auditDir ?? "./data/audit",
    capabilities: {
      candidateRoot: capabilitiesInput.candidateRoot ?? "./data/capability-candidates",
      codeModeArtifactRoot: capabilitiesInput.codeModeArtifactRoot ?? "./data/code-mode-artifacts",
      tempRoot: capabilitiesInput.tempRoot ?? "./data/code-mode-temp",
      codeModeSandbox: {
        mode: "best_effort_host",
        required: capabilitiesInput.codeModeSandbox?.required ?? true,
        bestEffortHostEnabled: capabilitiesInput.codeModeSandbox?.bestEffortHostEnabled ?? false,
      },
      codeModeDockerBackend: {
        enabled: capabilitiesInput.codeModeDockerBackend?.enabled ?? false,
        image: capabilitiesInput.codeModeDockerBackend?.image,
        dockerCommand: capabilitiesInput.codeModeDockerBackend?.dockerCommand,
        nodeCommand: capabilitiesInput.codeModeDockerBackend?.nodeCommand,
      },
      codeModeAiderAdapter: {
        enabled: capabilitiesInput.codeModeAiderAdapter?.enabled ?? false,
        image: capabilitiesInput.codeModeAiderAdapter?.image,
        command: capabilitiesInput.codeModeAiderAdapter?.command,
        model: capabilitiesInput.codeModeAiderAdapter?.model,
      },
    },
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
    shellExplainerPolicy: {
      ...DEFAULT_SHELL_EXPLAINER_POLICY,
      ...(input.shellExplainerPolicy ?? {}),
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
    web: {
      firecrawl: {
        enabled: firecrawlInput.enabled ?? false,
        baseUrl: firecrawlInput.baseUrl ?? "http://127.0.0.1:3002",
        apiKeyEnv: normalizeFirecrawlApiKeyEnvName(firecrawlInput.apiKeyEnv),
        timeoutMs: clampInt(firecrawlInput.timeoutMs, 20_000, 1_000, 120_000),
        defaultReadBackend: firecrawlInput.defaultReadBackend ?? "native",
        fallbackToNative: firecrawlInput.fallbackToNative ?? true,
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
    a2a: {
      enabled: a2aInput.enabled ?? false,
      publicDiscoveryEnabled: a2aInput.publicDiscoveryEnabled ?? false,
      protocolVersion: "1.0",
      bindings: a2aInput.bindings ?? ["JSONRPC"],
      inbound: {
        enabled: a2aInboundInput.enabled ?? false,
        grpc: {
          enabled: a2aGrpcInput.enabled ?? false,
          host: a2aGrpcInput.host ?? "127.0.0.1",
          port: clampInt(a2aGrpcInput.port, 8788, 0, 65_535),
        },
        peerCredentials: a2aInboundInput.peerCredentials ?? [],
      },
      outbound: {
        enabled: a2aOutboundInput.enabled ?? false,
        peers: a2aOutboundInput.peers ?? [],
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
    llamaCpp: {
      enabled: llamaCppInput.enabled ?? false,
      autoStart: llamaCppInput.autoStart ?? false,
      server: {
        baseUrl: llamaCppServer.baseUrl ?? "http://127.0.0.1:8080/v1",
        command: llamaCppServer.command ?? "llama-server",
        extraArgs: llamaCppServer.extraArgs ?? [],
        healthPath: llamaCppServer.healthPath ?? "/health",
        modelsPath: llamaCppServer.modelsPath ?? "/v1/models",
        startTimeoutMs: llamaCppServer.startTimeoutMs ?? 20_000,
        requestTimeoutMs: llamaCppServer.requestTimeoutMs ?? 12_000,
        restartBudget: {
          windowMs: llamaCppRestart.windowMs ?? 60_000,
          maxRestarts: llamaCppRestart.maxRestarts ?? 5,
          backoffMs: llamaCppRestart.backoffMs ?? 2_000,
        },
      },
      launch: {
        modelsRootPath: llamaCppLaunch.modelsRootPath,
        modelPath: llamaCppLaunch.modelPath,
        alias: llamaCppLaunch.alias ?? DEFAULT_LLAMACPP_ALIAS,
        ctxSize: clampOptionalInt(llamaCppLaunch.ctxSize, 40_960, 256, 262_144),
        threads: clampOptionalInt(llamaCppLaunch.threads, undefined, 1, 512),
        gpuLayers: clampOptionalInt(llamaCppLaunch.gpuLayers, undefined, 0, 512),
        parallel: clampOptionalInt(llamaCppLaunch.parallel, 1, 1, 128),
        batchSize: clampOptionalInt(llamaCppLaunch.batchSize, 1024, 1, 262_144),
        ubatchSize: clampOptionalInt(llamaCppLaunch.ubatchSize, 512, 1, 262_144),
        flashAttention: llamaCppLaunch.flashAttention ?? true,
      },
    },
    database: {
      driver: databaseInput.driver ?? "postgres",
      postgres: {
        mode: postgresInput.mode ?? "bundled",
        connectionString: postgresInput.connectionString,
        connectionStringEnv: postgresInput.connectionStringEnv,
        host: postgresInput.host,
        port: clampInt(postgresInput.port, 5432, 1, 65_535),
        database: postgresInput.database ?? "goatcitadel",
        user: postgresInput.user,
        password: postgresInput.password,
        passwordEnv: postgresInput.passwordEnv,
        ssl: postgresInput.ssl ?? "prefer",
        pool: {
          min: clampInt(postgresPoolInput.min, 0, 0, 100),
          max: clampInt(postgresPoolInput.max, 10, 1, 200),
          idleTimeoutMs: clampInt(postgresPoolInput.idleTimeoutMs, 30_000, 1_000, 300_000),
          connectionTimeoutMs: clampInt(postgresPoolInput.connectionTimeoutMs, 10_000, 1_000, 120_000),
        },
        migrationsTable: postgresInput.migrationsTable ?? "schema_migrations",
      },
      bundledPostgres: {
        enabled: bundledPostgresInput.enabled ?? true,
        dataDir: bundledPostgresInput.dataDir ?? "./data/postgres",
        port: clampInt(bundledPostgresInput.port, 45_432, 1, 65_535),
        binDir: bundledPostgresInput.binDir,
        autoStart: bundledPostgresInput.autoStart ?? true,
        startTimeoutMs: clampInt(bundledPostgresInput.startTimeoutMs, 90_000, 1_000, 120_000),
      },
      sqlite,
    },
    sqlite,
    durable: {
      enabled: true,
      diagnosticsEnabled: durableInput.diagnosticsEnabled ?? false,
      executionEnabled: true,
      chatAutoPromoteEnabled: true,
      maxAttemptsDefault: Math.max(1, Math.floor(durableInput.maxAttemptsDefault ?? 3)),
      workflowTimeoutMs: clampInt(durableInput.workflowTimeoutMs, 5 * 60_000, 10_000, 30 * 60_000),
    },
    features: {
      durableKernelV1Enabled: true,
      replayOverridesV1Enabled: featuresInput.replayOverridesV1Enabled ?? false,
      memoryLifecycleAdminV1Enabled: featuresInput.memoryLifecycleAdminV1Enabled ?? true,
      memoryLifecycleAutoForgetEnabled: featuresInput.memoryLifecycleAutoForgetEnabled ?? true,
      memoryMaintenanceV1Enabled: featuresInput.memoryMaintenanceV1Enabled ?? false,
      connectorDiagnosticsV1Enabled: featuresInput.connectorDiagnosticsV1Enabled ?? false,
      computerUseGuardrailsV1Enabled: featuresInput.computerUseGuardrailsV1Enabled ?? true,
      cronReviewQueueV1Enabled: featuresInput.cronReviewQueueV1Enabled ?? false,
      replayRegressionV1Enabled: featuresInput.replayRegressionV1Enabled ?? false,
      codeModeV1Enabled: featuresInput.codeModeV1Enabled ?? false,
      improvementLedgerV1Enabled: featuresInput.improvementLedgerV1Enabled ?? false,
      improvementActivationV1Enabled: featuresInput.improvementActivationV1Enabled ?? false,
    },
    budgets: {
      dailyUsdWarning: input.budgets?.dailyUsdWarning ?? 10,
      dailyUsdHardCap: input.budgets?.dailyUsdHardCap ?? 50,
      sessionTokenHardCap: input.budgets?.sessionTokenHardCap ?? 120000,
    },
  };
}

function clampOptionalInt(
  value: number | undefined,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  return clampInt(value, fallback ?? value, min, max);
}

async function readFileWithDefault(filePath: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const configDir = path.dirname(filePath);
      const filename = path.basename(filePath);
      await materializeConfigFilesFromExamples(configDir, [filename]);
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw retryError;
        }
      }
      return fallback;
    }
    throw error;
  }
}

function defaultLlmConfig(): string {
  return JSON.stringify({
    activeProviderId: "",
    activeModel: "",
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      {
        providerId: "openai-codex",
        label: "OpenAI Codex (ChatGPT OAuth)",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiStyle: "openai-codex-responses",
        defaultModel: "gpt-5.5",
        authMode: "codex-oauth",
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
        providerId: "claude-code",
        label: "Claude Code (Claude subscription)",
        baseUrl: "https://api.anthropic.com/v1",
        apiStyle: "anthropic-messages",
        defaultModel: "claude-sonnet-4-6",
        authMode: "claude-code-oauth",
        apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
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
        defaultModel: "openai/gpt-5.4",
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
        defaultModel: "deepseek-v4-pro",
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
        defaultModel: "kimi-k2.6",
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

function parseA2ABindingsEnv(value: string | undefined): A2ABridgeRuntimeConfig["bindings"] {
  if (!value?.trim()) {
    return [];
  }
  const bindings = value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(
      (item): item is A2ABridgeRuntimeConfig["bindings"][number] =>
        item === "JSONRPC" || item === "GRPC" || item === "HTTP_JSON",
    );
  return [...new Set(bindings)];
}
