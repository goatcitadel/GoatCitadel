/* eslint-disable max-lines */
/**
 * Settings/auth service.
 *
 * Contract-backed home for the settings/auth runtime surface that still
 * composes through GatewayService.
 *
 * The file now exposes two real host contracts instead of accepting the
 * full GatewayService as a disguised host:
 * - `SettingsRuntimeHost` for runtime config reads/updates
 * - `SettingsAuthRuntimeHost` for device-access and companion-session flows
 *
 * Pattern reference: comms-service.ts, memory-facade-service.ts.
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";
import {
  clampInt,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ApprovalCreateInput,
  type ApprovalResolveInput,
  type AuthRuntimeSettings,
  type AuthSettingsUpdateInput,
  type CompanionAuditEventRecord,
  type CompanionSessionAdminRecord,
  type CompanionSessionExchangeInput,
  type CompanionSessionExchangeResponse,
  type CompanionSessionInfoResponse,
  type CompanionSessionListResponse,
  type CompanionSessionRefreshInput,
  type CompanionSessionRefreshResponse,
  type CompanionSessionRevokeResponse,
  type DeploymentProfile,
  type DeviceAccessGrantRecord as DeviceAccessGrantContractRecord,
  type DeviceAccessRequestCreateInput,
  type DeviceAccessRequestCreateResponse,
  type DeviceAccessRequestStatusResponse,
  type FilesystemReadAccessMode,
  type LlmProviderRequestConfig,
} from "@goatcitadel/contracts";
import type { MeshService } from "@goatcitadel/mesh-core";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { persistProviderApiKeyWithFallback } from "./provider-secret-persistence.js";

const settingsLog = logger.child("settings-auth-service");
import {
  COMPANION_ACCESS_TOKEN_BYTES,
  COMPANION_ACCESS_TOKEN_TTL_MS,
  COMPANION_CONTRACT_ID,
  COMPANION_REFRESH_TOKEN_BYTES,
  COMPANION_REFRESH_TOKEN_TTL_MS,
  COMPANION_REQUEST_CLOCK_SKEW_MS,
  COMPANION_REQUEST_REPLAY_TTL_MS,
  COMPANION_SIGNATURE_ALGORITHM,
  DEVICE_ACCESS_APPROVAL_KIND,
  DEVICE_ACCESS_REQUEST_POLL_AFTER_MS,
  DEVICE_ACCESS_REQUEST_TTL_MS,
  DEVICE_ACCESS_SECRET_BYTES,
  type AuthDeviceGrantRecord,
  type AuthDeviceRequestRecord,
  assertCompanionSigningPublicKeyPem,
  hashSensitiveToken,
  inferPlatformFromUserAgent,
  mapAuthDeviceGrantRow,
  mapDeviceAccessStatusResponse,
  normalizeCompanionSigningPublicKeyPem,
  normalizeDeviceAccessDeviceType,
  normalizeDeviceAccessLabel,
  normalizeOptionalDeviceAccessText,
  timingSafeStringEqual,
  toDeviceAccessGrantRecord,
} from "./device-access-helpers.js";
import {
  createGatewayAuthCredentialPlan,
  readAssistantAuthConfigSnapshotSync,
} from "./gateway/auth-credential-planner.js";
import type { LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";
import type { LlmRuntimeUpdateInput, LlmService } from "./llm-service.js";
import type { NpuSidecarService } from "./npu-sidecar-service.js";
import {
  buildCompanionSigningPayload,
  decodeBase64Url,
  isCompanionSessionCurrentlyActive,
  isCompanionSessionOperatorActive,
  isRecord,
  mapCompanionSessionRow,
  normalizeCompanionAuditEvent,
  normalizeCompanionNonce,
  normalizeCompanionRequestPath,
  normalizeCompanionSignature,
  toCompanionSessionAdminRecord,
  toCompanionSessionInfoResponse,
  type CompanionAccessValidationResult,
  type CompanionSessionRecord,
  type RuntimeSettings,
} from "./gateway-service.js";

export interface SettingsRuntimeHost {
  readonly config: GatewayRuntimeConfig;
  readonly llmService: Pick<
    LlmService,
    | "deleteProviderApiKey"
    | "getRuntimeConfig"
    | "getProviderSecretStatus"
    | "setProviderApiKey"
    | "updateNetworkAllowlist"
    | "updateRuntimeConfig"
  >;
  readonly meshService: Pick<MeshService, "updateOptions">;
  readonly npuSidecar: Pick<NpuSidecarService, "getStatus" | "updateConfig" | "stop" | "start">;
  readonly llamaCppRuntime: Pick<LlamaCppRuntimeService, "getStatus" | "updateConfig" | "stop" | "start">;
  readFeatureFlags(): RuntimeSettings["features"];
  updateFeatureFlags(patch: Partial<RuntimeSettings["features"]>): RuntimeSettings["features"];
  assertDeploymentProfileUpdate(input: UpdateSettingsInput): void;
  assertFirecrawlRuntimeUpdate(input: UpdateSettingsInput): void;
  persistLlmConfig(): void;
  persistToolPolicyConfig(): void;
  persistBudgetsConfig(): void;
  persistAssistantConfig(): void;
}

export interface SettingsAuthRuntimeHost {
  readonly config: GatewayRuntimeConfig;
  readonly gatewaySql: Storage["gatewaySql"];
  readonly storage: Pick<Storage, "audit" | "runImmediateTransaction">;
  createApproval(input: ApprovalCreateInput): Promise<{ approvalId: string }>;
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<unknown>;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
  getAuthDeviceRequestById(requestId: string): AuthDeviceRequestRecord | undefined;
  expireDeviceAccessRequestIfNeeded(request: AuthDeviceRequestRecord): Promise<AuthDeviceRequestRecord>;
  getActiveAuthDeviceGrantById(grantId: string): AuthDeviceGrantRecord | undefined;
  getActiveCompanionSessionByRefreshToken(refreshToken: string): CompanionSessionRecord | undefined;
  getActiveCompanionSessionById(sessionId: string): CompanionSessionRecord | undefined;
  getCompanionSessionById(sessionId: string): CompanionSessionRecord | undefined;
}

export function getSettings(host: SettingsRuntimeHost): RuntimeSettings {
  const features = host.readFeatureFlags();
  return {
    environment: host.config.assistant.environment,
    deploymentProfile: host.config.assistant.deploymentProfile,
    defaultToolProfile: host.config.toolPolicy.tools.profile,
    budgetMode: host.config.budgets.mode,
    workspaceDir: host.config.assistant.workspaceDir,
    writeJailRoots: host.config.toolPolicy.sandbox.writeJailRoots,
    readOnlyRoots: host.config.toolPolicy.sandbox.readOnlyRoots,
    readAccessMode: host.config.toolPolicy.sandbox.readAccessMode ?? "roots_only",
    networkAllowlist: host.config.toolPolicy.sandbox.networkAllowlist,
    approvalExplainer: host.config.assistant.approvalExplainer,
    memory: {
      enabled: host.config.assistant.memory.enabled,
      qmd: {
        enabled: host.config.assistant.memory.qmd.enabled,
        applyToChat: host.config.assistant.memory.qmd.applyToChat,
        applyToOrchestration: host.config.assistant.memory.qmd.applyToOrchestration,
        minPromptChars: host.config.assistant.memory.qmd.minPromptChars,
        maxContextTokens: host.config.assistant.memory.qmd.maxContextTokens,
        cacheTtlSeconds: host.config.assistant.memory.qmd.cacheTtlSeconds,
        distillerProviderId: host.config.assistant.memory.qmd.distiller.providerId,
        distillerModel: host.config.assistant.memory.qmd.distiller.model,
      },
    },
    web: {
      firecrawl: {
        enabled: host.config.assistant.web.firecrawl.enabled,
        baseUrl: host.config.assistant.web.firecrawl.baseUrl,
        apiKeyEnv: host.config.assistant.web.firecrawl.apiKeyEnv,
        timeoutMs: host.config.assistant.web.firecrawl.timeoutMs,
        defaultReadBackend: host.config.assistant.web.firecrawl.defaultReadBackend,
        fallbackToNative: host.config.assistant.web.firecrawl.fallbackToNative,
      },
    },
    auth: getAuthRuntimeSettings(host),
    llm: host.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    }),
    mesh: {
      enabled: host.config.assistant.mesh.enabled,
      mode: host.config.assistant.mesh.mode,
      nodeId: host.config.assistant.mesh.nodeId,
      mdns: host.config.assistant.mesh.discovery.mdns,
      staticPeers: host.config.assistant.mesh.discovery.staticPeers,
      requireMtls: host.config.assistant.mesh.security.requireMtls,
      tailnetEnabled: host.config.assistant.mesh.security.tailnet.enabled,
    },
    npu: {
      enabled: host.config.assistant.npu.enabled,
      autoStart: host.config.assistant.npu.autoStart,
      sidecarUrl: host.config.assistant.npu.sidecar.baseUrl,
      status: host.npuSidecar.getStatus(),
    },
    llamaCpp: {
      enabled: host.config.assistant.llamaCpp.enabled,
      autoStart: host.config.assistant.llamaCpp.autoStart,
      baseUrl: host.config.assistant.llamaCpp.server.baseUrl,
      command: host.config.assistant.llamaCpp.server.command,
      extraArgs: host.config.assistant.llamaCpp.server.extraArgs,
      modelsRootPath: host.config.assistant.llamaCpp.launch.modelsRootPath,
      modelPath: host.config.assistant.llamaCpp.launch.modelPath,
      alias: host.config.assistant.llamaCpp.launch.alias,
      ctxSize: host.config.assistant.llamaCpp.launch.ctxSize,
      threads: host.config.assistant.llamaCpp.launch.threads,
      gpuLayers: host.config.assistant.llamaCpp.launch.gpuLayers,
      parallel: host.config.assistant.llamaCpp.launch.parallel,
      batchSize: host.config.assistant.llamaCpp.launch.batchSize,
      ubatchSize: host.config.assistant.llamaCpp.launch.ubatchSize,
      flashAttention: host.config.assistant.llamaCpp.launch.flashAttention,
      status: host.llamaCppRuntime.getStatus(),
    },
    features,
  };
}

export interface UpdateSettingsInput {
  deploymentProfile?: DeploymentProfile;
  defaultToolProfile?: string;
  budgetMode?: "saver" | "balanced" | "power";
  readAccessMode?: FilesystemReadAccessMode;
  networkAllowlist?: string[];
  auth?: AuthSettingsUpdateInput;
  llm?: {
    activeProviderId?: string;
    activeModel?: string;
    upsertProvider?: {
      providerId: string;
      label?: string;
      baseUrl?: string;
      apiStyle?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
      defaultModel?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      persistSecretToSecureStore?: boolean;
      request?: LlmProviderRequestConfig;
      headers?: Record<string, string>;
    };
  };
  memory?: {
    enabled?: boolean;
    qmdEnabled?: boolean;
    qmdApplyToChat?: boolean;
    qmdApplyToOrchestration?: boolean;
    qmdMaxContextTokens?: number;
    qmdMinPromptChars?: number;
    qmdCacheTtlSeconds?: number;
    qmdDistillerProviderId?: string;
    qmdDistillerModel?: string;
  };
  web?: {
    firecrawl?: {
      enabled?: boolean;
      baseUrl?: string;
      apiKeyEnv?: string;
      timeoutMs?: number;
      defaultReadBackend?: "native" | "firecrawl";
      fallbackToNative?: boolean;
    };
  };
  mesh?: {
    enabled?: boolean;
    mode?: "lan" | "wan" | "tailnet";
    nodeId?: string;
    mdns?: boolean;
    staticPeers?: string[];
    requireMtls?: boolean;
    tailnetEnabled?: boolean;
  };
  npu?: {
    enabled?: boolean;
    autoStart?: boolean;
    sidecarUrl?: string;
  };
  llamaCpp?: {
    enabled?: boolean;
    autoStart?: boolean;
    baseUrl?: string;
    command?: string;
    extraArgs?: string[];
    modelsRootPath?: string;
    modelPath?: string;
    alias?: string;
    ctxSize?: number | null;
    threads?: number | null;
    gpuLayers?: number | null;
    parallel?: number | null;
    batchSize?: number | null;
    ubatchSize?: number | null;
    flashAttention?: boolean | null;
  };
  features?: Partial<RuntimeSettings["features"]>;
}

export function updateSettings(host: SettingsRuntimeHost, input: UpdateSettingsInput): RuntimeSettings {
  host.assertDeploymentProfileUpdate(input);
  host.assertFirecrawlRuntimeUpdate(input);

  let persistAssistant = false;
  let persistToolPolicy = false;
  let persistBudgets = false;
  let persistLlm = false;

  if (input.deploymentProfile) {
    host.config.assistant.deploymentProfile = input.deploymentProfile;
    persistAssistant = true;
  }

  if (input.defaultToolProfile) {
    if (!Object.prototype.hasOwnProperty.call(host.config.toolPolicy.profiles, input.defaultToolProfile)) {
      throw new Error(`Unknown tool profile: ${input.defaultToolProfile}`);
    }
    host.config.toolPolicy.tools.profile = input.defaultToolProfile as typeof host.config.toolPolicy.tools.profile;
    host.config.assistant.defaultToolProfile = input.defaultToolProfile;
    host.llmService.updateNetworkAllowlist(host.config.toolPolicy.sandbox.networkAllowlist, {
      enforce: host.config.toolPolicy.tools.profile !== "danger",
    });
    persistAssistant = true;
    persistToolPolicy = true;
  }

  if (input.budgetMode) {
    host.config.budgets.mode = input.budgetMode;
    persistBudgets = true;
  }

  if (input.readAccessMode) {
    host.config.toolPolicy.sandbox.readAccessMode = input.readAccessMode;
    persistToolPolicy = true;
  }

  if (input.networkAllowlist) {
    host.config.toolPolicy.sandbox.networkAllowlist = input.networkAllowlist
      .map((host_) => host_.trim())
      .filter(Boolean);
    host.llmService.updateNetworkAllowlist(host.config.toolPolicy.sandbox.networkAllowlist, {
      enforce: host.config.toolPolicy.tools.profile !== "danger",
    });
    persistToolPolicy = true;
  }

  if (input.auth) {
    updateAuthSettings(host, input.auth);
    persistAssistant = true;
  }

  if (input.memory) {
    if (input.memory.enabled !== undefined) {
      host.config.assistant.memory.enabled = input.memory.enabled;
    }
    if (input.memory.qmdEnabled !== undefined) {
      host.config.assistant.memory.qmd.enabled = input.memory.qmdEnabled;
    }
    if (input.memory.qmdApplyToChat !== undefined) {
      host.config.assistant.memory.qmd.applyToChat = input.memory.qmdApplyToChat;
    }
    if (input.memory.qmdApplyToOrchestration !== undefined) {
      host.config.assistant.memory.qmd.applyToOrchestration = input.memory.qmdApplyToOrchestration;
    }
    if (input.memory.qmdMaxContextTokens !== undefined) {
      host.config.assistant.memory.qmd.maxContextTokens = Math.max(100, input.memory.qmdMaxContextTokens);
    }
    if (input.memory.qmdMinPromptChars !== undefined) {
      host.config.assistant.memory.qmd.minPromptChars = Math.max(0, input.memory.qmdMinPromptChars);
    }
    if (input.memory.qmdCacheTtlSeconds !== undefined) {
      host.config.assistant.memory.qmd.cacheTtlSeconds = Math.max(10, input.memory.qmdCacheTtlSeconds);
    }
    if (input.memory.qmdDistillerProviderId !== undefined) {
      host.config.assistant.memory.qmd.distiller.providerId = input.memory.qmdDistillerProviderId.trim() || undefined;
    }
    if (input.memory.qmdDistillerModel !== undefined) {
      host.config.assistant.memory.qmd.distiller.model = input.memory.qmdDistillerModel.trim() || undefined;
    }
    persistAssistant = true;
  }

  if (input.web?.firecrawl) {
    const firecrawl = input.web.firecrawl;
    if (firecrawl.enabled !== undefined) {
      host.config.assistant.web.firecrawl.enabled = firecrawl.enabled;
    }
    if (firecrawl.baseUrl !== undefined) {
      const trimmed = firecrawl.baseUrl.trim();
      if (!trimmed) {
        throw new Error("web.firecrawl.baseUrl cannot be empty");
      }
      host.config.assistant.web.firecrawl.baseUrl = trimmed;
    }
    if (firecrawl.apiKeyEnv !== undefined) {
      host.config.assistant.web.firecrawl.apiKeyEnv = firecrawl.apiKeyEnv.trim() || undefined;
    }
    if (firecrawl.timeoutMs !== undefined) {
      host.config.assistant.web.firecrawl.timeoutMs = Math.max(1_000, Math.min(firecrawl.timeoutMs, 120_000));
    }
    if (firecrawl.defaultReadBackend !== undefined) {
      host.config.assistant.web.firecrawl.defaultReadBackend = firecrawl.defaultReadBackend;
    }
    if (firecrawl.fallbackToNative !== undefined) {
      host.config.assistant.web.firecrawl.fallbackToNative = firecrawl.fallbackToNative;
    }
    persistAssistant = true;
  }

  if (input.mesh) {
    if (input.mesh.enabled !== undefined) {
      host.config.assistant.mesh.enabled = input.mesh.enabled;
    }
    if (input.mesh.mode) {
      host.config.assistant.mesh.mode = input.mesh.mode;
    }
    if (input.mesh.nodeId !== undefined) {
      const trimmed = input.mesh.nodeId.trim();
      if (!trimmed) {
        throw new Error("mesh.nodeId cannot be empty");
      }
      host.config.assistant.mesh.nodeId = trimmed;
    }
    if (input.mesh.mdns !== undefined) {
      host.config.assistant.mesh.discovery.mdns = input.mesh.mdns;
    }
    if (input.mesh.staticPeers) {
      host.config.assistant.mesh.discovery.staticPeers = input.mesh.staticPeers
        .map((peer) => peer.trim())
        .filter(Boolean);
    }
    if (input.mesh.requireMtls !== undefined) {
      host.config.assistant.mesh.security.requireMtls = input.mesh.requireMtls;
    }
    if (input.mesh.tailnetEnabled !== undefined) {
      host.config.assistant.mesh.security.tailnet.enabled = input.mesh.tailnetEnabled;
    }

    host.meshService.updateOptions({
      enabled: host.config.assistant.mesh.enabled,
      mode: host.config.assistant.mesh.mode,
      localNodeId: host.config.assistant.mesh.nodeId,
      localNodeLabel: host.config.assistant.mesh.label,
      advertiseAddress: host.config.assistant.mesh.advertiseAddress,
      requireMtls: host.config.assistant.mesh.security.requireMtls,
      tailnetEnabled: host.config.assistant.mesh.security.tailnet.enabled,
      joinToken: process.env[host.config.assistant.mesh.security.joinTokenEnv],
      defaultLeaseTtlSeconds: host.config.assistant.mesh.leases.ttlSeconds,
    });
    persistAssistant = true;
  }

  if (input.npu) {
    if (input.npu.enabled !== undefined) {
      host.config.assistant.npu.enabled = input.npu.enabled;
    }
    if (input.npu.autoStart !== undefined) {
      host.config.assistant.npu.autoStart = input.npu.autoStart;
    }
    if (input.npu.sidecarUrl !== undefined) {
      const trimmed = input.npu.sidecarUrl.trim();
      if (!trimmed) {
        throw new Error("npu.sidecarUrl cannot be empty");
      }
      host.config.assistant.npu.sidecar.baseUrl = trimmed;
    }

    host.npuSidecar.updateConfig(host.config.assistant.npu);
    if (!host.config.assistant.npu.enabled) {
      void host.npuSidecar.stop("disabled").catch((error) => {
        settingsLog.warn("npu sidecar stop failed after settings update", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else if (host.config.assistant.npu.autoStart) {
      void host.npuSidecar.start("config_autostart").catch((error) => {
        settingsLog.error("npu sidecar autostart failed after settings update", error);
      });
    }
    persistAssistant = true;
  }

  if (input.llamaCpp) {
    const hasLlamaField = (field: keyof NonNullable<UpdateSettingsInput["llamaCpp"]>) =>
      Object.prototype.hasOwnProperty.call(input.llamaCpp, field);
    if (input.llamaCpp.enabled !== undefined) {
      host.config.assistant.llamaCpp.enabled = input.llamaCpp.enabled;
    }
    if (input.llamaCpp.autoStart !== undefined) {
      host.config.assistant.llamaCpp.autoStart = input.llamaCpp.autoStart;
    }
    if (input.llamaCpp.baseUrl !== undefined) {
      const trimmed = input.llamaCpp.baseUrl.trim();
      if (!trimmed) {
        throw new Error("llamaCpp.baseUrl cannot be empty");
      }
      host.config.assistant.llamaCpp.server.baseUrl = trimmed;
    }
    if (input.llamaCpp.command !== undefined) {
      const trimmed = input.llamaCpp.command.trim();
      if (!trimmed) {
        throw new Error("llamaCpp.command cannot be empty");
      }
      host.config.assistant.llamaCpp.server.command = trimmed;
    }
    if (input.llamaCpp.extraArgs !== undefined) {
      host.config.assistant.llamaCpp.server.extraArgs = input.llamaCpp.extraArgs
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (input.llamaCpp.modelsRootPath !== undefined) {
      const trimmed = input.llamaCpp.modelsRootPath.trim();
      host.config.assistant.llamaCpp.launch.modelsRootPath = trimmed || undefined;
    }
    if (input.llamaCpp.modelPath !== undefined) {
      const trimmed = input.llamaCpp.modelPath.trim();
      host.config.assistant.llamaCpp.launch.modelPath = trimmed || undefined;
    }
    if (input.llamaCpp.alias !== undefined) {
      const trimmed = input.llamaCpp.alias.trim();
      if (!trimmed) {
        throw new Error("llamaCpp.alias cannot be empty");
      }
      host.config.assistant.llamaCpp.launch.alias = trimmed;
    }
    if (hasLlamaField("ctxSize")) {
      host.config.assistant.llamaCpp.launch.ctxSize =
        input.llamaCpp.ctxSize == null ? undefined : clampInt(input.llamaCpp.ctxSize, 4096, 256, 262_144);
    }
    if (hasLlamaField("threads")) {
      host.config.assistant.llamaCpp.launch.threads =
        input.llamaCpp.threads == null ? undefined : clampInt(input.llamaCpp.threads, 1, 1, 512);
    }
    if (hasLlamaField("gpuLayers")) {
      host.config.assistant.llamaCpp.launch.gpuLayers =
        input.llamaCpp.gpuLayers == null ? undefined : clampInt(input.llamaCpp.gpuLayers, 0, 0, 512);
    }
    if (hasLlamaField("parallel")) {
      host.config.assistant.llamaCpp.launch.parallel =
        input.llamaCpp.parallel == null ? undefined : clampInt(input.llamaCpp.parallel, 1, 1, 128);
    }
    if (hasLlamaField("batchSize")) {
      host.config.assistant.llamaCpp.launch.batchSize =
        input.llamaCpp.batchSize == null ? undefined : clampInt(input.llamaCpp.batchSize, 512, 1, 262_144);
    }
    if (hasLlamaField("ubatchSize")) {
      host.config.assistant.llamaCpp.launch.ubatchSize =
        input.llamaCpp.ubatchSize == null ? undefined : clampInt(input.llamaCpp.ubatchSize, 256, 1, 262_144);
    }
    if (hasLlamaField("flashAttention")) {
      host.config.assistant.llamaCpp.launch.flashAttention = input.llamaCpp.flashAttention ?? undefined;
    }

    host.llamaCppRuntime.updateConfig(host.config.assistant.llamaCpp);
    host.llmService.updateRuntimeConfig({
      upsertProvider: {
        providerId: "llamacpp",
        label: "llama.cpp",
        baseUrl: host.config.assistant.llamaCpp.server.baseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: host.config.assistant.llamaCpp.launch.alias,
      },
    } satisfies LlmRuntimeUpdateInput);
    persistLlm = true;
    if (!host.config.assistant.llamaCpp.enabled) {
      void host.llamaCppRuntime.stop("disabled").catch((error) => {
        settingsLog.warn("llama.cpp runtime stop failed after settings update", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else if (host.config.assistant.llamaCpp.autoStart) {
      void host.llamaCppRuntime.start("config_autostart").catch((error) => {
        settingsLog.error("llama.cpp autostart failed after settings update", error);
      });
    }
    persistAssistant = true;
  }

  if (input.features) {
    host.updateFeatureFlags(input.features);
    persistAssistant = true;
  }

  if (input.llm) {
    const llmInput = {
      ...input.llm,
      upsertProvider: input.llm.upsertProvider ? { ...input.llm.upsertProvider } : undefined,
    };
    const submittedApiKey = llmInput.upsertProvider?.apiKey?.trim();
    if (llmInput.upsertProvider && submittedApiKey) {
      persistProviderApiKeyWithFallback({
        providerId: llmInput.upsertProvider.providerId,
        apiKey: submittedApiKey,
        preferredEnvVar: llmInput.upsertProvider.apiKeyEnv,
        persistToEnv: llmInput.upsertProvider.persistSecretToSecureStore === false,
        rootDir: host.config.rootDir,
        llmService: host.llmService,
      });
      llmInput.upsertProvider.apiKey = undefined;
    }
    host.llmService.updateRuntimeConfig(llmInput satisfies LlmRuntimeUpdateInput);
    persistLlm = true;
  }

  if (persistToolPolicy) {
    host.persistToolPolicyConfig();
  }
  if (persistBudgets) {
    host.persistBudgetsConfig();
  }
  if (persistAssistant) {
    host.persistAssistantConfig();
  }
  if (persistLlm) {
    host.persistLlmConfig();
  }

  return getSettings(host);
}

export function getAuthRuntimeSettings(host: SettingsRuntimeHost): AuthRuntimeSettings {
  const plan = createGatewayAuthCredentialPlan({
    runtimeConfig: host.config,
    env: process.env,
    configAuth: readAssistantAuthConfigSnapshotSync(host.config.rootDir),
  });
  return {
    mode: host.config.assistant.auth.mode,
    allowLoopbackBypass: host.config.assistant.auth.allowLoopbackBypass,
    tokenConfigured: Boolean(host.config.assistant.auth.token.value?.trim()),
    basicConfigured: Boolean(
      host.config.assistant.auth.basic.username?.trim() && host.config.assistant.auth.basic.password?.trim(),
    ),
    plan,
  };
}

export function updateAuthSettings(host: SettingsRuntimeHost, input: AuthSettingsUpdateInput): AuthRuntimeSettings {
  if (input.mode) {
    host.config.assistant.auth.mode = input.mode;
  }
  if (input.allowLoopbackBypass !== undefined) {
    host.config.assistant.auth.allowLoopbackBypass = input.allowLoopbackBypass;
  }
  if (input.token !== undefined) {
    host.config.assistant.auth.token.value = input.token.trim() || undefined;
  }
  if (input.basicUsername !== undefined) {
    host.config.assistant.auth.basic.username = input.basicUsername.trim() || undefined;
  }
  if (input.basicPassword !== undefined) {
    host.config.assistant.auth.basic.password = input.basicPassword.trim() || undefined;
  }
  return getAuthRuntimeSettings(host);
}

// ---------------------------------------------------------------------------
// Device access runtime
// ---------------------------------------------------------------------------

export async function createDeviceAccessRequest(
  host: SettingsAuthRuntimeHost,
  input: DeviceAccessRequestCreateInput,
  context: {
    requestedOrigin?: string;
    requestedIp?: string;
    userAgent?: string;
    correlationId?: string;
    traceId?: string;
    originSurface?: string;
  },
): Promise<DeviceAccessRequestCreateResponse> {
  if (host.config.assistant.auth.mode === "none") {
    throw new Error("Device approvals are not needed when gateway auth mode is none.");
  }

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + DEVICE_ACCESS_REQUEST_TTL_MS).toISOString();
  const requestId = randomUUID();
  const requestSecret = randomBytes(DEVICE_ACCESS_SECRET_BYTES).toString("base64url");
  const deviceType = normalizeDeviceAccessDeviceType(input.deviceType);
  const platform =
    normalizeOptionalDeviceAccessText(input.platform, 120) ?? inferPlatformFromUserAgent(context.userAgent);
  const deviceLabel = normalizeDeviceAccessLabel(input.deviceLabel, {
    deviceType,
    platform,
    userAgent: context.userAgent,
  });
  const requestedOrigin = normalizeOptionalDeviceAccessText(context.requestedOrigin, 240);
  const requestedIp = normalizeOptionalDeviceAccessText(context.requestedIp, 120);
  const userAgent = normalizeOptionalDeviceAccessText(context.userAgent, 512);
  const correlationId = normalizeOptionalDeviceAccessText(context.correlationId, 128);
  const traceId = normalizeOptionalDeviceAccessText(context.traceId, 128);
  const originSurface = normalizeOptionalDeviceAccessText(context.originSurface, 120);

  const approval = await host.createApproval({
    kind: DEVICE_ACCESS_APPROVAL_KIND,
    riskLevel: "danger",
    payload: {
      requestId,
      deviceLabel,
      deviceType,
      platform,
      requestedOrigin,
      requestedIp,
      userAgent,
    },
    preview: {
      title: "Allow new device access",
      requestId,
      deviceLabel,
      deviceType,
      platform,
      requestedOrigin,
      requestedIp,
    },
  });

  try {
    host.gatewaySql
      .prepare(
        `
      INSERT INTO auth_device_requests (
        request_id, approval_id, request_secret_hash, device_label, device_type, platform,
        requested_origin, requested_ip, user_agent, status, created_at, expires_at
      ) VALUES (
        @requestId, @approvalId, @requestSecretHash, @deviceLabel, @deviceType, @platform,
        @requestedOrigin, @requestedIp, @userAgent, @status, @createdAt, @expiresAt
      )
    `,
      )
      .run({
        requestId,
        approvalId: approval.approvalId,
        requestSecretHash: hashSensitiveToken(requestSecret),
        deviceLabel,
        deviceType,
        platform: platform ?? null,
        requestedOrigin: requestedOrigin ?? null,
        requestedIp: requestedIp ?? null,
        userAgent: userAgent ?? null,
        status: "pending",
        createdAt,
        expiresAt,
      });
  } catch (error) {
    try {
      await host.resolveApproval(approval.approvalId, {
        decision: "reject",
        resolvedBy: "system:auth-device-request",
        resolutionNote: "Device request registration failed.",
      });
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }

  await host.storage.audit.append("approvals", {
    event: "auth.device_request.create",
    requestId,
    approvalId: approval.approvalId,
    deviceLabel,
    deviceType,
    platform,
    requestedOrigin,
    requestedIp,
    correlationId,
    traceId,
    originSurface,
  });

  host.publishRealtime("auth_device_request_created", "auth", {
    requestId,
    approvalId: approval.approvalId,
    deviceLabel,
    deviceType,
    platform,
    requestedOrigin,
    requestedIp,
    correlationId,
    traceId,
    originSurface,
    createdAt,
    expiresAt,
  });

  return {
    requestId,
    requestSecret,
    approvalId: approval.approvalId,
    status: "pending",
    expiresAt,
    pollAfterMs: DEVICE_ACCESS_REQUEST_POLL_AFTER_MS,
    message: "Waiting for approval from another authenticated Mission Control session.",
  };
}

export async function getDeviceAccessRequestStatus(
  host: SettingsAuthRuntimeHost,
  requestId: string,
  requestSecret: string,
): Promise<DeviceAccessRequestStatusResponse> {
  const request = host.getAuthDeviceRequestById(requestId);
  if (!request) {
    throw new Error("Device access request not found.");
  }
  if (!requestSecret.trim() || !timingSafeStringEqual(hashSensitiveToken(requestSecret), request.requestSecretHash)) {
    throw new Error("Device access request not found.");
  }

  const current = await host.expireDeviceAccessRequestIfNeeded(request);
  if (current.status === "approved" && !current.deliveredAt) {
    const deliveredAt = new Date().toISOString();
    const result = host.gatewaySql
      .prepare(
        `
      UPDATE auth_device_requests
      SET delivered_at = @deliveredAt,
          approved_token_plaintext = NULL
      WHERE request_id = @requestId
        AND delivered_at IS NULL
    `,
      )
      .run({
        requestId: current.requestId,
        deliveredAt,
      });
    if (result.changes === 0) {
      const refreshed = host.getAuthDeviceRequestById(requestId);
      if (refreshed) {
        return mapDeviceAccessStatusResponse(refreshed);
      }
    }
  }

  return mapDeviceAccessStatusResponse(current);
}

export function listDeviceAccessGrants(host: SettingsAuthRuntimeHost): DeviceAccessGrantContractRecord[] {
  const rows = host.gatewaySql
    .prepare(
      `
    SELECT *
    FROM auth_device_grants
    ORDER BY
      CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,
      COALESCE(last_used_at, created_at) DESC,
      created_at DESC
  `,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => toDeviceAccessGrantRecord(mapAuthDeviceGrantRow(row)));
}

export async function revokeDeviceAccessGrant(
  host: SettingsAuthRuntimeHost,
  grantId: string,
  revokedBy: string,
): Promise<DeviceAccessGrantContractRecord> {
  const existingRow = host.gatewaySql
    .prepare(
      `
    SELECT *
    FROM auth_device_grants
    WHERE grant_id = @grantId
    LIMIT 1
  `,
    )
    .get({ grantId }) as Record<string, unknown> | undefined;
  if (!existingRow) {
    throw new NotFoundError("Device access grant not found.");
  }

  const revokedAt = new Date().toISOString();
  host.gatewaySql
    .prepare(
      `
    UPDATE auth_device_grants
    SET revoked_at = COALESCE(revoked_at, @revokedAt)
    WHERE grant_id = @grantId
  `,
    )
    .run({
      grantId,
      revokedAt,
    });
  host.gatewaySql
    .prepare(
      `
    UPDATE companion_sessions
    SET revoked_at = COALESCE(revoked_at, @revokedAt)
    WHERE grant_id = @grantId
  `,
    )
    .run({
      grantId,
      revokedAt,
    });

  const grant = mapAuthDeviceGrantRow(
    (host.gatewaySql
      .prepare(
        `
      SELECT *
      FROM auth_device_grants
      WHERE grant_id = @grantId
      LIMIT 1
    `,
      )
      .get({ grantId }) as Record<string, unknown> | undefined) ?? existingRow,
  );
  const result = toDeviceAccessGrantRecord(grant);

  await host.storage.audit.append("approvals", {
    event: "auth.device_grant.revoke",
    grantId: result.grantId,
    requestId: result.requestId,
    revokedBy,
    deviceLabel: result.deviceLabel,
    deviceType: result.deviceType,
    platform: result.platform,
    revokedAt: result.revokedAt,
  });

  host.publishRealtime("auth_device_grant_revoked", "auth", {
    grantId: result.grantId,
    requestId: result.requestId,
    actorId: result.actorId,
    deviceLabel: result.deviceLabel,
    deviceType: result.deviceType,
    platform: result.platform,
    revokedAt: result.revokedAt,
    revokedBy,
  });

  return result;
}

export function validateDeviceAccessToken(
  host: SettingsAuthRuntimeHost,
  token: string,
): { actorId: string; deviceId: string; grantId: string } | undefined {
  const tokenHash = hashSensitiveToken(token);
  const now = new Date().toISOString();
  const row = host.gatewaySql
    .prepare(
      `
    SELECT *
    FROM auth_device_grants
    WHERE token_hash = @tokenHash
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > @now)
    LIMIT 1
  `,
    )
    .get({
      tokenHash,
      now,
    }) as Record<string, unknown> | undefined;

  if (!row) {
    return undefined;
  }

  const grant = mapAuthDeviceGrantRow(row);
  host.gatewaySql
    .prepare(
      `
    UPDATE auth_device_grants
    SET last_used_at = @lastUsedAt
    WHERE grant_id = @grantId
  `,
    )
    .run({
      grantId: grant.grantId,
      lastUsedAt: now,
    });

  return {
    actorId: `device:${grant.grantId}`,
    deviceId: grant.grantId,
    grantId: grant.grantId,
  };
}

export async function exchangeCompanionSessionFromDeviceGrant(
  host: SettingsAuthRuntimeHost,
  grantId: string,
  input: CompanionSessionExchangeInput,
): Promise<CompanionSessionExchangeResponse> {
  const grant = host.getActiveAuthDeviceGrantById(grantId);
  if (!grant) {
    throw new NotFoundError("Device access grant not found.");
  }

  const signingPublicKeyPem = normalizeCompanionSigningPublicKeyPem(input.signingPublicKeyPem);
  assertCompanionSigningPublicKeyPem(signingPublicKeyPem);

  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const accessTokenExpiresAt = new Date(now + COMPANION_ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshTokenExpiresAt = new Date(now + COMPANION_REFRESH_TOKEN_TTL_MS).toISOString();
  const accessToken = `gcca_${randomBytes(COMPANION_ACCESS_TOKEN_BYTES).toString("base64url")}`;
  const refreshToken = `gccr_${randomBytes(COMPANION_REFRESH_TOKEN_BYTES).toString("base64url")}`;
  const sessionId = randomUUID();
  const metadata = {
    ...grant.metadata,
    clientName: normalizeOptionalDeviceAccessText(input.clientName, 120),
    appVersion: normalizeOptionalDeviceAccessText(input.appVersion, 80),
    bootstrapRepo: "GoatCitadel-mobile",
    contractId: COMPANION_CONTRACT_ID,
  };

  host.storage.runImmediateTransaction(() => {
    host.gatewaySql
      .prepare(
        `
      UPDATE companion_sessions
      SET revoked_at = COALESCE(revoked_at, @revokedAt)
      WHERE grant_id = @grantId
        AND revoked_at IS NULL
    `,
      )
      .run({
        grantId,
        revokedAt: issuedAt,
      });

    host.gatewaySql
      .prepare(
        `
      INSERT INTO companion_sessions (
        session_id,
        grant_id,
        access_token_hash,
        access_token_expires_at,
        refresh_token_hash,
        refresh_token_expires_at,
        signing_public_key_pem,
        signature_algorithm,
        created_at,
        last_rotated_at,
        metadata_json
      ) VALUES (
        @sessionId,
        @grantId,
        @accessTokenHash,
        @accessTokenExpiresAt,
        @refreshTokenHash,
        @refreshTokenExpiresAt,
        @signingPublicKeyPem,
        @signatureAlgorithm,
        @createdAt,
        @lastRotatedAt,
        @metadataJson
      )
    `,
      )
      .run({
        sessionId,
        grantId,
        accessTokenHash: hashSensitiveToken(accessToken),
        accessTokenExpiresAt,
        refreshTokenHash: hashSensitiveToken(refreshToken),
        refreshTokenExpiresAt,
        signingPublicKeyPem,
        signatureAlgorithm: COMPANION_SIGNATURE_ALGORITHM,
        createdAt: issuedAt,
        lastRotatedAt: issuedAt,
        metadataJson: JSON.stringify(metadata),
      });
  });

  await host.storage.audit.append("approvals", {
    event: "auth.companion_session.exchange",
    actorId: `companion:${sessionId}`,
    deviceId: grant.grantId,
    grantId: grant.grantId,
    companionSessionId: sessionId,
    contractId: COMPANION_CONTRACT_ID,
    signatureAlgorithm: COMPANION_SIGNATURE_ALGORITHM,
    deviceLabel: grant.deviceLabel,
    deviceType: normalizeDeviceAccessDeviceType(grant.deviceType),
    platform: grant.platform,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    metadata,
  });

  return {
    contractId: COMPANION_CONTRACT_ID,
    sessionId,
    grantId: grant.grantId,
    actorId: `companion:${sessionId}`,
    deviceLabel: grant.deviceLabel,
    deviceType: normalizeDeviceAccessDeviceType(grant.deviceType),
    platform: grant.platform,
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    issuedAt,
    signatureAlgorithm: COMPANION_SIGNATURE_ALGORITHM,
  };
}

export async function rotateCompanionSession(
  host: SettingsAuthRuntimeHost,
  input: CompanionSessionRefreshInput,
): Promise<CompanionSessionRefreshResponse> {
  const refreshToken = input.refreshToken.trim();
  if (!refreshToken) {
    throw new ValidationError({
      message: "Refresh token is required.",
    });
  }

  const session = host.getActiveCompanionSessionByRefreshToken(refreshToken);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }

  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const accessTokenExpiresAt = new Date(now + COMPANION_ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshTokenExpiresAt = new Date(now + COMPANION_REFRESH_TOKEN_TTL_MS).toISOString();
  const nextAccessToken = `gcca_${randomBytes(COMPANION_ACCESS_TOKEN_BYTES).toString("base64url")}`;
  const nextRefreshToken = `gccr_${randomBytes(COMPANION_REFRESH_TOKEN_BYTES).toString("base64url")}`;

  const result = host.gatewaySql
    .prepare(
      `
    UPDATE companion_sessions
    SET access_token_hash = @accessTokenHash,
        access_token_expires_at = @accessTokenExpiresAt,
        refresh_token_hash = @refreshTokenHash,
        refresh_token_expires_at = @refreshTokenExpiresAt,
        last_rotated_at = @lastRotatedAt,
        last_seen_at = @lastSeenAt
    WHERE session_id = @sessionId
      AND refresh_token_hash = @currentRefreshTokenHash
      AND revoked_at IS NULL
  `,
    )
    .run({
      sessionId: session.sessionId,
      currentRefreshTokenHash: hashSensitiveToken(refreshToken),
      accessTokenHash: hashSensitiveToken(nextAccessToken),
      accessTokenExpiresAt,
      refreshTokenHash: hashSensitiveToken(nextRefreshToken),
      refreshTokenExpiresAt,
      lastRotatedAt: issuedAt,
      lastSeenAt: issuedAt,
    });
  if (result.changes === 0) {
    throw new ConflictError({
      message: "Companion session refresh token has already been rotated.",
    });
  }

  await host.storage.audit.append("approvals", {
    event: "auth.companion_session.refresh",
    actorId: `companion:${session.sessionId}`,
    deviceId: session.grantId,
    grantId: session.grantId,
    companionSessionId: session.sessionId,
    contractId: COMPANION_CONTRACT_ID,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  });

  return {
    contractId: COMPANION_CONTRACT_ID,
    sessionId: session.sessionId,
    grantId: session.grantId,
    actorId: `companion:${session.sessionId}`,
    accessToken: nextAccessToken,
    accessTokenExpiresAt,
    refreshToken: nextRefreshToken,
    refreshTokenExpiresAt,
    issuedAt,
    signatureAlgorithm: session.signatureAlgorithm,
  };
}

export function getCompanionSessionInfo(
  host: SettingsAuthRuntimeHost,
  sessionId: string,
): CompanionSessionInfoResponse {
  const session = host.getActiveCompanionSessionById(sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }
  return toCompanionSessionInfoResponse(session);
}

export function listCompanionSessions(
  host: SettingsAuthRuntimeHost,
  options?: {
    view?: "active" | "all";
    grantId?: string;
    limit?: number;
  },
): CompanionSessionListResponse {
  const view = options?.view === "all" ? "all" : "active";
  const limit = clampInt(options?.limit, 50, 1, 200);
  const grantId = options?.grantId?.trim();
  const now = new Date().toISOString();
  const query = grantId
    ? `
    SELECT
      s.*,
      g.device_label,
      g.device_type,
      g.platform,
      g.expires_at AS grant_expires_at,
      g.revoked_at AS grant_revoked_at
    FROM companion_sessions s
    INNER JOIN auth_device_grants g
      ON g.grant_id = s.grant_id
    WHERE s.grant_id = @grantId
    ORDER BY s.created_at DESC, s.session_id DESC
    LIMIT @limit
  `
    : `
    SELECT
      s.*,
      g.device_label,
      g.device_type,
      g.platform,
      g.expires_at AS grant_expires_at,
      g.revoked_at AS grant_revoked_at
    FROM companion_sessions s
    INNER JOIN auth_device_grants g
      ON g.grant_id = s.grant_id
    ORDER BY s.created_at DESC, s.session_id DESC
    LIMIT @limit
  `;
  const rows = host.gatewaySql
    .prepare(
      `
    ${query}
  `,
    )
    .all(grantId ? { grantId, limit } : { limit }) as Record<string, unknown>[];

  return {
    items: rows
      .map(mapCompanionSessionRow)
      .filter((session) => view === "all" || isCompanionSessionOperatorActive(session, now))
      .map(toCompanionSessionAdminRecord),
  };
}

export function getCompanionSessionRecord(
  host: SettingsAuthRuntimeHost,
  sessionId: string,
): CompanionSessionAdminRecord {
  const session = host.getCompanionSessionById(sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }
  return toCompanionSessionAdminRecord(session);
}

export async function revokeCompanionSession(
  host: SettingsAuthRuntimeHost,
  sessionId: string,
  revokedBy: string,
): Promise<CompanionSessionRevokeResponse> {
  const session = host.getCompanionSessionById(sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }

  const revokedAt = new Date().toISOString();
  host.gatewaySql
    .prepare(
      `
    UPDATE companion_sessions
    SET revoked_at = COALESCE(revoked_at, @revokedAt)
    WHERE session_id = @sessionId
  `,
    )
    .run({
      sessionId,
      revokedAt,
    });

  const updated = host.getCompanionSessionById(sessionId) ?? {
    ...session,
    revokedAt,
  };
  const record = toCompanionSessionAdminRecord(updated);

  await host.storage.audit.append("approvals", {
    event: "auth.companion_session.revoke",
    actorId: `companion:${record.sessionId}`,
    deviceId: record.grantId,
    grantId: record.grantId,
    companionSessionId: record.sessionId,
    contractId: record.contractId,
    revokedAt: record.revokedAt,
    revokedBy,
    deviceLabel: record.deviceLabel,
    deviceType: record.deviceType,
    platform: record.platform,
  });

  host.publishRealtime("auth_companion_session_revoked", "auth", {
    sessionId: record.sessionId,
    grantId: record.grantId,
    actorId: record.actorId,
    deviceLabel: record.deviceLabel,
    deviceType: record.deviceType,
    platform: record.platform,
    revokedAt: record.revokedAt,
    revokedBy,
  });

  return { session: record };
}

export async function listCompanionAuditEvents(
  host: SettingsAuthRuntimeHost,
  options?: {
    sessionId?: string;
    grantId?: string;
    limit?: number;
  },
): Promise<CompanionAuditEventRecord[]> {
  const sessionId = options?.sessionId?.trim();
  const grantId = options?.grantId?.trim();
  const limit = clampInt(options?.limit, 50, 1, 200);
  const records = await host.storage.audit.list("approvals");

  return records
    .filter((record) => {
      const event = typeof record.event === "string" ? record.event : "";
      if (!event.startsWith("auth.companion_")) {
        return false;
      }
      if (sessionId && record.companionSessionId !== sessionId) {
        return false;
      }
      if (grantId && record.grantId !== grantId) {
        return false;
      }
      return true;
    })
    .sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")))
    .slice(0, limit)
    .map((record) => ({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date(0).toISOString(),
      event: normalizeCompanionAuditEvent(record.event),
      actorId: typeof record.actorId === "string" ? record.actorId : undefined,
      deviceId: typeof record.deviceId === "string" ? record.deviceId : undefined,
      grantId: typeof record.grantId === "string" ? record.grantId : undefined,
      companionSessionId: typeof record.companionSessionId === "string" ? record.companionSessionId : undefined,
      contractId: record.contractId === COMPANION_CONTRACT_ID ? COMPANION_CONTRACT_ID : undefined,
      method: typeof record.method === "string" ? record.method : undefined,
      path: typeof record.path === "string" ? record.path : undefined,
      nonce: typeof record.nonce === "string" ? record.nonce : undefined,
      requestHash: typeof record.requestHash === "string" ? record.requestHash : undefined,
      detail: typeof record.detail === "string" ? record.detail : undefined,
      metadata: isRecord(record.metadata) ? record.metadata : undefined,
    }));
}

export function validateCompanionAccessToken(
  host: SettingsAuthRuntimeHost,
  token: string,
): CompanionAccessValidationResult | undefined {
  const tokenHash = hashSensitiveToken(token);
  const now = new Date().toISOString();
  const row = host.gatewaySql
    .prepare(
      `
    SELECT
      s.*,
      g.device_label,
      g.device_type,
      g.platform,
      g.expires_at AS grant_expires_at,
      g.revoked_at AS grant_revoked_at
    FROM companion_sessions s
    INNER JOIN auth_device_grants g
      ON g.grant_id = s.grant_id
    WHERE s.access_token_hash = @tokenHash
    LIMIT 1
  `,
    )
    .get({
      tokenHash,
    }) as Record<string, unknown> | undefined;
  if (!row) {
    return undefined;
  }

  const session = mapCompanionSessionRow(row);
  if (!isCompanionSessionCurrentlyActive(session, now)) {
    host.gatewaySql
      .prepare(
        `
      UPDATE companion_sessions
      SET revoked_at = COALESCE(revoked_at, @revokedAt)
      WHERE session_id = @sessionId
    `,
      )
      .run({
        sessionId: session.sessionId,
        revokedAt: now,
      });
    return undefined;
  }

  host.gatewaySql
    .prepare(
      `
    UPDATE companion_sessions
    SET last_seen_at = @lastSeenAt
    WHERE session_id = @sessionId
  `,
    )
    .run({
      sessionId: session.sessionId,
      lastSeenAt: now,
    });
  host.gatewaySql
    .prepare(
      `
    UPDATE auth_device_grants
    SET last_used_at = @lastUsedAt
    WHERE grant_id = @grantId
  `,
    )
    .run({
      grantId: session.grantId,
      lastUsedAt: now,
    });

  return {
    actorId: `companion:${session.sessionId}`,
    deviceId: session.grantId,
    grantId: session.grantId,
    sessionId: session.sessionId,
  };
}

export function verifyCompanionRequestSignature(
  host: SettingsAuthRuntimeHost,
  input: {
    sessionId: string;
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    signature: string;
    body: unknown;
  },
): void {
  const session = host.getActiveCompanionSessionById(input.sessionId);
  if (!session) {
    void host.storage.audit.append("approvals", {
      event: "auth.companion_request.session_inactive",
      actorId: `companion:${input.sessionId}`,
      companionSessionId: input.sessionId,
      detail: "Companion session is no longer active.",
      method: input.method.toUpperCase(),
      path: input.path,
    });
    throw new Error("Companion session is no longer active.");
  }

  const timestamp = Date.parse(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > COMPANION_REQUEST_CLOCK_SKEW_MS) {
    void host.storage.audit.append("approvals", {
      event: "auth.companion_request.timestamp_invalid",
      actorId: `companion:${session.sessionId}`,
      deviceId: session.grantId,
      grantId: session.grantId,
      companionSessionId: session.sessionId,
      contractId: COMPANION_CONTRACT_ID,
      detail: "Companion request timestamp is outside the accepted skew window.",
      method: input.method.toUpperCase(),
      path: input.path,
      nonce: input.nonce,
    });
    throw new Error("Companion request timestamp is outside the accepted skew window.");
  }

  const nonce = normalizeCompanionNonce(input.nonce);
  const signature = normalizeCompanionSignature(input.signature);
  const path = normalizeCompanionRequestPath(input.path);
  const payload = buildCompanionSigningPayload({
    method: input.method,
    path,
    timestamp: input.timestamp,
    nonce,
    body: input.body,
  });
  const method = input.method.toUpperCase();
  const requestHash = createHash("sha256").update(payload, "utf8").digest("hex");
  const signatureBuffer = decodeBase64Url(signature);
  const publicKey = createPublicKey(session.signingPublicKeyPem);
  if (!verify(null, Buffer.from(payload, "utf8"), publicKey, signatureBuffer)) {
    void host.storage.audit.append("approvals", {
      event: "auth.companion_request.signature_invalid",
      actorId: `companion:${session.sessionId}`,
      deviceId: session.grantId,
      grantId: session.grantId,
      companionSessionId: session.sessionId,
      contractId: COMPANION_CONTRACT_ID,
      detail: "Invalid companion request signature.",
      method,
      path,
      nonce,
      requestHash,
    });
    throw new Error("Invalid companion request signature.");
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + COMPANION_REQUEST_REPLAY_TTL_MS).toISOString();
  host.gatewaySql
    .prepare(
      `
    DELETE FROM companion_request_replays
    WHERE expires_at <= @now
  `,
    )
    .run({ now });
  try {
    host.gatewaySql
      .prepare(
        `
      INSERT INTO companion_request_replays (
        session_id,
        nonce,
        method,
        path,
        request_hash,
        created_at,
        expires_at
      ) VALUES (
        @sessionId,
        @nonce,
        @method,
        @path,
        @requestHash,
        @createdAt,
        @expiresAt
      )
    `,
      )
      .run({
        sessionId: session.sessionId,
        nonce,
        method,
        path,
        requestHash,
        createdAt: now,
        expiresAt,
      });
  } catch {
    void host.storage.audit.append("approvals", {
      event: "auth.companion_request.replay_rejected",
      actorId: `companion:${session.sessionId}`,
      deviceId: session.grantId,
      grantId: session.grantId,
      companionSessionId: session.sessionId,
      contractId: COMPANION_CONTRACT_ID,
      detail: "Companion request replay detected.",
      method,
      path,
      nonce,
      requestHash,
    });
    throw new Error("Companion request replay detected.");
  }

  void host.storage.audit.append("approvals", {
    event: "auth.companion_request.accepted",
    actorId: `companion:${session.sessionId}`,
    deviceId: session.grantId,
    grantId: session.grantId,
    companionSessionId: session.sessionId,
    contractId: COMPANION_CONTRACT_ID,
    method,
    path,
    nonce,
    requestHash,
  });
}
