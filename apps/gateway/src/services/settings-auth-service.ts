/* eslint-disable max-lines */
/**
 * Settings/auth service.
 *
 * Contract-backed home for the settings/auth runtime surface that still
 * composes through GatewayService.
 *
 * The file now exposes two real deps contracts instead of accepting the
 * full GatewayService as a disguised deps:
 * - `SettingsRuntimeDependencies` for runtime config reads/updates
 * - `SettingsAuthRuntimeDependencies` for device-access and companion-session flows
 *
 * Pattern reference: comms-service.ts, memory-facade-service.ts.
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { logger } from "@goatcitadel/gateway-core";
import { normalizeFirecrawlApiKeyEnvName } from "@goatcitadel/policy-engine";
import {
  clampInt,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ApprovalCreateInput,
  type ApprovalEffectRecord,
  type ApprovalRequest,
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
  type DeviceAccessRequestStatus,
  type DeviceAccessRequestStatusResponse,
  type FilesystemReadAccessMode,
  type LlmProviderRequestConfig,
  type RealtimeEvent,
  type ToolApprovalMode,
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
  DEVICE_ACCESS_TOKEN_BYTES,
  DEVICE_ACCESS_TOKEN_TTL_MS,
  type AuthDeviceGrantRecord,
  type AuthDeviceRequestRecord,
  assertCompanionSigningPublicKeyPem,
  hashSensitiveToken,
  inferPlatformFromUserAgent,
  mapAuthDeviceGrantRow,
  mapAuthDeviceRequestRow,
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
  isCompanionSessionRefreshable,
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
} from "./companion-auth-helpers.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { deriveApprovalResolutionEffectsResult } from "./approval-resolution-effects-service.js";
import type { ApprovalResolveResult } from "./approval-types.js";

export interface SettingsRuntimeDependencies {
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

export interface SettingsAuthRuntimeDependencies {
  readonly config: GatewayRuntimeConfig;
  readonly gatewaySql: Storage["gatewaySql"];
  readonly storage: Pick<Storage, "audit" | "runImmediateTransaction" | "approvals" | "approvalEvents">;
  createApproval(input: ApprovalCreateInput): Promise<{ approvalId: string }>;
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<unknown>;
  enqueueApprovalResolutionEffects(approval: ApprovalRequest, input: ApprovalResolveInput): ApprovalEffectRecord[];
  listApprovalEffects(approvalId: string): ApprovalEffectRecord[];
  buildApprovalRealtimeLinks(approval: ApprovalRequest): NonNullable<RealtimeEvent["links"]>;
  recordImprovementApprovalResolutionSignal(approval: ApprovalRequest): void;
  handleActivationApprovalResolution(approval: ApprovalRequest): void;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
}

export function getSettings(deps: SettingsRuntimeDependencies): RuntimeSettings {
  const features = deps.readFeatureFlags();
  return {
    environment: deps.config.assistant.environment,
    deploymentProfile: deps.config.assistant.deploymentProfile,
    toolApprovalMode:
      deps.config.toolPolicy.tools.approvalMode ?? legacyProfileToApprovalMode(deps.config.toolPolicy.tools.profile),
    defaultToolProfile: deps.config.toolPolicy.tools.profile,
    budgetMode: deps.config.budgets.mode,
    workspaceDir: deps.config.assistant.workspaceDir,
    writeJailRoots: deps.config.toolPolicy.sandbox.writeJailRoots,
    readOnlyRoots: deps.config.toolPolicy.sandbox.readOnlyRoots,
    readAccessMode: deps.config.toolPolicy.sandbox.readAccessMode ?? "roots_only",
    networkAllowlist: deps.config.toolPolicy.sandbox.networkAllowlist,
    approvalExplainer: deps.config.assistant.approvalExplainer,
    memory: {
      enabled: deps.config.assistant.memory.enabled,
      qmd: {
        enabled: deps.config.assistant.memory.qmd.enabled,
        applyToChat: deps.config.assistant.memory.qmd.applyToChat,
        applyToOrchestration: deps.config.assistant.memory.qmd.applyToOrchestration,
        minPromptChars: deps.config.assistant.memory.qmd.minPromptChars,
        maxContextTokens: deps.config.assistant.memory.qmd.maxContextTokens,
        cacheTtlSeconds: deps.config.assistant.memory.qmd.cacheTtlSeconds,
        distillerProviderId: deps.config.assistant.memory.qmd.distiller.providerId,
        distillerModel: deps.config.assistant.memory.qmd.distiller.model,
      },
    },
    web: {
      firecrawl: {
        enabled: deps.config.assistant.web.firecrawl.enabled,
        baseUrl: deps.config.assistant.web.firecrawl.baseUrl,
        apiKeyEnv: deps.config.assistant.web.firecrawl.apiKeyEnv,
        timeoutMs: deps.config.assistant.web.firecrawl.timeoutMs,
        defaultReadBackend: deps.config.assistant.web.firecrawl.defaultReadBackend,
        fallbackToNative: deps.config.assistant.web.firecrawl.fallbackToNative,
      },
    },
    auth: getAuthRuntimeSettings(deps),
    llm: deps.llmService.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    }),
    mesh: {
      enabled: deps.config.assistant.mesh.enabled,
      mode: deps.config.assistant.mesh.mode,
      nodeId: deps.config.assistant.mesh.nodeId,
      mdns: deps.config.assistant.mesh.discovery.mdns,
      staticPeers: deps.config.assistant.mesh.discovery.staticPeers,
      requireMtls: deps.config.assistant.mesh.security.requireMtls,
      tailnetEnabled: deps.config.assistant.mesh.security.tailnet.enabled,
    },
    npu: {
      enabled: deps.config.assistant.npu.enabled,
      autoStart: deps.config.assistant.npu.autoStart,
      sidecarUrl: deps.config.assistant.npu.sidecar.baseUrl,
      status: deps.npuSidecar.getStatus(),
    },
    llamaCpp: {
      enabled: deps.config.assistant.llamaCpp.enabled,
      autoStart: deps.config.assistant.llamaCpp.autoStart,
      baseUrl: deps.config.assistant.llamaCpp.server.baseUrl,
      command: deps.config.assistant.llamaCpp.server.command,
      extraArgs: deps.config.assistant.llamaCpp.server.extraArgs,
      modelsRootPath: deps.config.assistant.llamaCpp.launch.modelsRootPath,
      modelPath: deps.config.assistant.llamaCpp.launch.modelPath,
      alias: deps.config.assistant.llamaCpp.launch.alias,
      ctxSize: deps.config.assistant.llamaCpp.launch.ctxSize,
      threads: deps.config.assistant.llamaCpp.launch.threads,
      gpuLayers: deps.config.assistant.llamaCpp.launch.gpuLayers,
      parallel: deps.config.assistant.llamaCpp.launch.parallel,
      batchSize: deps.config.assistant.llamaCpp.launch.batchSize,
      ubatchSize: deps.config.assistant.llamaCpp.launch.ubatchSize,
      flashAttention: deps.config.assistant.llamaCpp.launch.flashAttention,
      status: deps.llamaCppRuntime.getStatus(),
    },
    features,
  };
}

export interface UpdateSettingsInput {
  deploymentProfile?: DeploymentProfile;
  toolApprovalMode?: ToolApprovalMode;
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
      apiStyle?: "openai-chat-completions" | "openai-responses" | "openai-codex-responses" | "anthropic-messages";
      authMode?: "api-key" | "codex-oauth";
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

export function updateSettings(deps: SettingsRuntimeDependencies, input: UpdateSettingsInput): RuntimeSettings {
  deps.assertDeploymentProfileUpdate(input);
  deps.assertFirecrawlRuntimeUpdate(input);

  let persistAssistant = false;
  let persistToolPolicy = false;
  let persistBudgets = false;
  let persistLlm = false;

  if (input.deploymentProfile) {
    deps.config.assistant.deploymentProfile = input.deploymentProfile;
    persistAssistant = true;
  }

  if (input.toolApprovalMode) {
    deps.config.toolPolicy.tools.approvalMode = input.toolApprovalMode;
    deps.config.assistant.toolApprovalMode = input.toolApprovalMode;
    deps.llmService.updateNetworkAllowlist(deps.config.toolPolicy.sandbox.networkAllowlist, {
      enforce: true,
    });
    persistAssistant = true;
    persistToolPolicy = true;
  } else if (input.defaultToolProfile) {
    const legacyProfiles = deps.config.toolPolicy.profiles ?? {};
    const knownLegacyProfiles =
      Object.keys(legacyProfiles).length === 0 ||
      Object.prototype.hasOwnProperty.call(legacyProfiles, input.defaultToolProfile);
    if (!knownLegacyProfiles) {
      throw new Error(`Unknown legacy tool profile: ${input.defaultToolProfile}`);
    }
    deps.config.toolPolicy.tools.profile = input.defaultToolProfile as typeof deps.config.toolPolicy.tools.profile;
    deps.config.toolPolicy.tools.approvalMode = legacyProfileToApprovalMode(input.defaultToolProfile);
    deps.config.assistant.defaultToolProfile = input.defaultToolProfile;
    deps.llmService.updateNetworkAllowlist(deps.config.toolPolicy.sandbox.networkAllowlist, {
      enforce: true,
    });
    persistAssistant = true;
    persistToolPolicy = true;
  }

  if (input.budgetMode) {
    deps.config.budgets.mode = input.budgetMode;
    persistBudgets = true;
  }

  if (input.readAccessMode) {
    deps.config.toolPolicy.sandbox.readAccessMode = input.readAccessMode;
    persistToolPolicy = true;
  }

  if (input.networkAllowlist) {
    deps.config.toolPolicy.sandbox.networkAllowlist = input.networkAllowlist
      .map((host_) => host_.trim())
      .filter(Boolean);
    deps.llmService.updateNetworkAllowlist(deps.config.toolPolicy.sandbox.networkAllowlist, {
      enforce: true,
    });
    persistToolPolicy = true;
  }

  if (input.auth) {
    updateAuthSettings(deps, input.auth);
    persistAssistant = true;
  }

  if (input.memory) {
    if (input.memory.enabled !== undefined) {
      deps.config.assistant.memory.enabled = input.memory.enabled;
    }
    if (input.memory.qmdEnabled !== undefined) {
      deps.config.assistant.memory.qmd.enabled = input.memory.qmdEnabled;
    }
    if (input.memory.qmdApplyToChat !== undefined) {
      deps.config.assistant.memory.qmd.applyToChat = input.memory.qmdApplyToChat;
    }
    if (input.memory.qmdApplyToOrchestration !== undefined) {
      deps.config.assistant.memory.qmd.applyToOrchestration = input.memory.qmdApplyToOrchestration;
    }
    if (input.memory.qmdMaxContextTokens !== undefined) {
      deps.config.assistant.memory.qmd.maxContextTokens = Math.max(100, input.memory.qmdMaxContextTokens);
    }
    if (input.memory.qmdMinPromptChars !== undefined) {
      deps.config.assistant.memory.qmd.minPromptChars = Math.max(0, input.memory.qmdMinPromptChars);
    }
    if (input.memory.qmdCacheTtlSeconds !== undefined) {
      deps.config.assistant.memory.qmd.cacheTtlSeconds = Math.max(10, input.memory.qmdCacheTtlSeconds);
    }
    if (input.memory.qmdDistillerProviderId !== undefined) {
      deps.config.assistant.memory.qmd.distiller.providerId = input.memory.qmdDistillerProviderId.trim() || undefined;
    }
    if (input.memory.qmdDistillerModel !== undefined) {
      deps.config.assistant.memory.qmd.distiller.model = input.memory.qmdDistillerModel.trim() || undefined;
    }
    persistAssistant = true;
  }

  if (input.web?.firecrawl) {
    const firecrawl = input.web.firecrawl;
    if (firecrawl.enabled !== undefined) {
      deps.config.assistant.web.firecrawl.enabled = firecrawl.enabled;
    }
    if (firecrawl.baseUrl !== undefined) {
      const trimmed = firecrawl.baseUrl.trim();
      if (!trimmed) {
        throw new Error("web.firecrawl.baseUrl cannot be empty");
      }
      deps.config.assistant.web.firecrawl.baseUrl = trimmed;
    }
    if (firecrawl.apiKeyEnv !== undefined) {
      const apiKeyEnv = firecrawl.apiKeyEnv.trim() ? normalizeFirecrawlApiKeyEnvName(firecrawl.apiKeyEnv) : undefined;
      if (firecrawl.apiKeyEnv.trim() && !apiKeyEnv) {
        throw new Error(
          "web.firecrawl.apiKeyEnv must be FIRECRAWL_API_KEY, FIRECRAWL_KEY, or GOATCITADEL_FIRECRAWL_API_KEY",
        );
      }
      deps.config.assistant.web.firecrawl.apiKeyEnv = apiKeyEnv;
    }
    if (firecrawl.timeoutMs !== undefined) {
      deps.config.assistant.web.firecrawl.timeoutMs = Math.max(1_000, Math.min(firecrawl.timeoutMs, 120_000));
    }
    if (firecrawl.defaultReadBackend !== undefined) {
      deps.config.assistant.web.firecrawl.defaultReadBackend = firecrawl.defaultReadBackend;
    }
    if (firecrawl.fallbackToNative !== undefined) {
      deps.config.assistant.web.firecrawl.fallbackToNative = firecrawl.fallbackToNative;
    }
    persistAssistant = true;
  }

  if (input.mesh) {
    if (input.mesh.enabled !== undefined) {
      deps.config.assistant.mesh.enabled = input.mesh.enabled;
    }
    if (input.mesh.mode) {
      deps.config.assistant.mesh.mode = input.mesh.mode;
    }
    if (input.mesh.nodeId !== undefined) {
      const trimmed = input.mesh.nodeId.trim();
      if (!trimmed) {
        throw new Error("mesh.nodeId cannot be empty");
      }
      deps.config.assistant.mesh.nodeId = trimmed;
    }
    if (input.mesh.mdns !== undefined) {
      deps.config.assistant.mesh.discovery.mdns = input.mesh.mdns;
    }
    if (input.mesh.staticPeers) {
      deps.config.assistant.mesh.discovery.staticPeers = input.mesh.staticPeers
        .map((peer) => peer.trim())
        .filter(Boolean);
    }
    if (input.mesh.requireMtls !== undefined) {
      deps.config.assistant.mesh.security.requireMtls = input.mesh.requireMtls;
    }
    if (input.mesh.tailnetEnabled !== undefined) {
      deps.config.assistant.mesh.security.tailnet.enabled = input.mesh.tailnetEnabled;
    }

    deps.meshService.updateOptions({
      enabled: deps.config.assistant.mesh.enabled,
      mode: deps.config.assistant.mesh.mode,
      localNodeId: deps.config.assistant.mesh.nodeId,
      localNodeLabel: deps.config.assistant.mesh.label,
      advertiseAddress: deps.config.assistant.mesh.advertiseAddress,
      requireMtls: deps.config.assistant.mesh.security.requireMtls,
      tailnetEnabled: deps.config.assistant.mesh.security.tailnet.enabled,
      joinToken: process.env[deps.config.assistant.mesh.security.joinTokenEnv],
      defaultLeaseTtlSeconds: deps.config.assistant.mesh.leases.ttlSeconds,
    });
    persistAssistant = true;
  }

  if (input.npu) {
    if (input.npu.enabled !== undefined) {
      deps.config.assistant.npu.enabled = input.npu.enabled;
    }
    if (input.npu.autoStart !== undefined) {
      deps.config.assistant.npu.autoStart = input.npu.autoStart;
    }
    if (input.npu.sidecarUrl !== undefined) {
      const trimmed = input.npu.sidecarUrl.trim();
      if (!trimmed) {
        throw new Error("npu.sidecarUrl cannot be empty");
      }
      deps.config.assistant.npu.sidecar.baseUrl = trimmed;
    }

    deps.npuSidecar.updateConfig(deps.config.assistant.npu);
    if (!deps.config.assistant.npu.enabled) {
      void deps.npuSidecar.stop("disabled").catch((error) => {
        settingsLog.warn("npu sidecar stop failed after settings update", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else if (deps.config.assistant.npu.autoStart) {
      void deps.npuSidecar.start("config_autostart").catch((error) => {
        settingsLog.error("npu sidecar autostart failed after settings update", error);
      });
    }
    persistAssistant = true;
  }

  if (input.llamaCpp) {
    const hasLlamaField = (field: keyof NonNullable<UpdateSettingsInput["llamaCpp"]>) =>
      Object.prototype.hasOwnProperty.call(input.llamaCpp, field);
    if (input.llamaCpp.enabled !== undefined) {
      deps.config.assistant.llamaCpp.enabled = input.llamaCpp.enabled;
    }
    if (input.llamaCpp.autoStart !== undefined) {
      deps.config.assistant.llamaCpp.autoStart = input.llamaCpp.autoStart;
    }
    if (input.llamaCpp.baseUrl !== undefined) {
      const trimmed = input.llamaCpp.baseUrl.trim();
      if (!trimmed) {
        throw new Error("llamaCpp.baseUrl cannot be empty");
      }
      deps.config.assistant.llamaCpp.server.baseUrl = trimmed;
    }
    if (input.llamaCpp.command !== undefined) {
      const trimmed = input.llamaCpp.command.trim();
      if (!trimmed) {
        throw new Error("llamaCpp.command cannot be empty");
      }
      deps.config.assistant.llamaCpp.server.command = trimmed;
    }
    if (input.llamaCpp.extraArgs !== undefined) {
      deps.config.assistant.llamaCpp.server.extraArgs = input.llamaCpp.extraArgs
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (input.llamaCpp.modelsRootPath !== undefined) {
      const trimmed = input.llamaCpp.modelsRootPath.trim();
      deps.config.assistant.llamaCpp.launch.modelsRootPath = trimmed || undefined;
    }
    if (input.llamaCpp.modelPath !== undefined) {
      const trimmed = input.llamaCpp.modelPath.trim();
      deps.config.assistant.llamaCpp.launch.modelPath = trimmed || undefined;
    }
    if (input.llamaCpp.alias !== undefined) {
      const trimmed = input.llamaCpp.alias.trim();
      if (!trimmed) {
        throw new Error("llamaCpp.alias cannot be empty");
      }
      deps.config.assistant.llamaCpp.launch.alias = trimmed;
    }
    if (hasLlamaField("ctxSize")) {
      deps.config.assistant.llamaCpp.launch.ctxSize =
        input.llamaCpp.ctxSize == null ? undefined : clampInt(input.llamaCpp.ctxSize, 4096, 256, 262_144);
    }
    if (hasLlamaField("threads")) {
      deps.config.assistant.llamaCpp.launch.threads =
        input.llamaCpp.threads == null ? undefined : clampInt(input.llamaCpp.threads, 1, 1, 512);
    }
    if (hasLlamaField("gpuLayers")) {
      deps.config.assistant.llamaCpp.launch.gpuLayers =
        input.llamaCpp.gpuLayers == null ? undefined : clampInt(input.llamaCpp.gpuLayers, 0, 0, 512);
    }
    if (hasLlamaField("parallel")) {
      deps.config.assistant.llamaCpp.launch.parallel =
        input.llamaCpp.parallel == null ? undefined : clampInt(input.llamaCpp.parallel, 1, 1, 128);
    }
    if (hasLlamaField("batchSize")) {
      deps.config.assistant.llamaCpp.launch.batchSize =
        input.llamaCpp.batchSize == null ? undefined : clampInt(input.llamaCpp.batchSize, 512, 1, 262_144);
    }
    if (hasLlamaField("ubatchSize")) {
      deps.config.assistant.llamaCpp.launch.ubatchSize =
        input.llamaCpp.ubatchSize == null ? undefined : clampInt(input.llamaCpp.ubatchSize, 256, 1, 262_144);
    }
    if (hasLlamaField("flashAttention")) {
      deps.config.assistant.llamaCpp.launch.flashAttention = input.llamaCpp.flashAttention ?? undefined;
    }

    deps.llamaCppRuntime.updateConfig(deps.config.assistant.llamaCpp);
    deps.llmService.updateRuntimeConfig({
      upsertProvider: {
        providerId: "llamacpp",
        label: "llama.cpp",
        baseUrl: deps.config.assistant.llamaCpp.server.baseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: deps.config.assistant.llamaCpp.launch.alias,
      },
    } satisfies LlmRuntimeUpdateInput);
    persistLlm = true;
    if (!deps.config.assistant.llamaCpp.enabled) {
      void deps.llamaCppRuntime.stop("disabled").catch((error) => {
        settingsLog.warn("llama.cpp runtime stop failed after settings update", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else if (deps.config.assistant.llamaCpp.autoStart) {
      void deps.llamaCppRuntime.start("config_autostart").catch((error) => {
        settingsLog.error("llama.cpp autostart failed after settings update", error);
      });
    }
    persistAssistant = true;
  }

  if (input.features) {
    deps.updateFeatureFlags(input.features);
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
        rootDir: deps.config.rootDir,
        llmService: deps.llmService,
      });
      llmInput.upsertProvider.apiKey = undefined;
    }
    deps.llmService.updateRuntimeConfig(llmInput satisfies LlmRuntimeUpdateInput);
    persistLlm = true;
  }

  if (persistToolPolicy) {
    deps.persistToolPolicyConfig();
  }
  if (persistBudgets) {
    deps.persistBudgetsConfig();
  }
  if (persistAssistant) {
    deps.persistAssistantConfig();
  }
  if (persistLlm) {
    deps.persistLlmConfig();
  }

  return getSettings(deps);
}

export function getAuthRuntimeSettings(deps: SettingsRuntimeDependencies): AuthRuntimeSettings {
  const plan = createGatewayAuthCredentialPlan({
    runtimeConfig: deps.config,
    env: process.env,
    configAuth: readAssistantAuthConfigSnapshotSync(deps.config.rootDir),
  });
  return {
    mode: deps.config.assistant.auth.mode,
    allowLoopbackBypass: deps.config.assistant.auth.allowLoopbackBypass,
    tokenConfigured: Boolean(deps.config.assistant.auth.token.value?.trim()),
    basicConfigured: Boolean(
      deps.config.assistant.auth.basic.username?.trim() && deps.config.assistant.auth.basic.password?.trim(),
    ),
    plan,
  };
}

export function updateAuthSettings(
  deps: SettingsRuntimeDependencies,
  input: AuthSettingsUpdateInput,
): AuthRuntimeSettings {
  if (input.mode) {
    deps.config.assistant.auth.mode = input.mode;
  }
  if (input.allowLoopbackBypass !== undefined) {
    deps.config.assistant.auth.allowLoopbackBypass = input.allowLoopbackBypass;
  }
  if (input.token !== undefined) {
    deps.config.assistant.auth.token.value = input.token.trim() || undefined;
  }
  if (input.basicUsername !== undefined) {
    deps.config.assistant.auth.basic.username = input.basicUsername.trim() || undefined;
  }
  if (input.basicPassword !== undefined) {
    deps.config.assistant.auth.basic.password = input.basicPassword.trim() || undefined;
  }
  return getAuthRuntimeSettings(deps);
}

export async function resolveDeviceAccessApproval(
  deps: SettingsAuthRuntimeDependencies,
  currentApproval: ApprovalRequest,
  input: ApprovalResolveInput,
): Promise<ApprovalResolveResult> {
  if (currentApproval.status !== "pending") {
    throw new ConflictError({
      message: `Approval ${currentApproval.approvalId} is already resolved`,
    });
  }
  if (input.decision === "edit") {
    throw new ValidationError({
      message: "Editing device access approvals is not supported.",
    });
  }

  const existingRequest = getAuthDeviceRequestByApprovalId(deps, currentApproval.approvalId);
  if (!existingRequest) {
    throw new NotFoundError("Device access request not found.");
  }

  const request = await expireDeviceAccessRequestIfNeeded(deps, existingRequest);
  if (request.status === "expired") {
    throw new ConflictError({
      message: "Device access request expired before it could be approved.",
    });
  }
  if (request.status !== "pending") {
    throw new ConflictError({
      message: `Approval ${currentApproval.approvalId} is already resolved`,
    });
  }

  const resolvedAt = new Date().toISOString();
  const requestStatus: DeviceAccessRequestStatus = input.decision === "approve" ? "approved" : "rejected";
  const deviceToken =
    input.decision === "approve" ? randomBytes(DEVICE_ACCESS_TOKEN_BYTES).toString("base64url") : undefined;
  const deviceTokenExpiresAt = deviceToken
    ? new Date(Date.now() + DEVICE_ACCESS_TOKEN_TTL_MS).toISOString()
    : undefined;
  let approval: ApprovalRequest;

  deps.storage.runImmediateTransaction(() => {
    if (deviceToken) {
      deps.gatewaySql
        .prepare(
          `
          INSERT INTO auth_device_grants (
            grant_id, request_id, token_hash, device_label, device_type, platform,
            granted_by, created_at, expires_at, metadata_json
          ) VALUES (
            @grantId, @requestId, @tokenHash, @deviceLabel, @deviceType, @platform,
            @grantedBy, @createdAt, @expiresAt, @metadataJson
          )
        `,
        )
        .run({
          grantId: randomUUID(),
          requestId: request.requestId,
          tokenHash: hashSensitiveToken(deviceToken),
          deviceLabel: request.deviceLabel,
          deviceType: request.deviceType,
          platform: request.platform ?? null,
          grantedBy: input.resolvedBy,
          createdAt: resolvedAt,
          expiresAt: deviceTokenExpiresAt ?? null,
          metadataJson: JSON.stringify({
            approvalId: currentApproval.approvalId,
            requestedOrigin: request.requestedOrigin,
            requestedIp: request.requestedIp,
          }),
        });
    }

    deps.gatewaySql
      .prepare(
        `
        UPDATE auth_device_requests
        SET status = @status,
            resolved_at = @resolvedAt,
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote,
            approved_token_plaintext = @approvedTokenPlaintext,
            approved_token_expires_at = @approvedTokenExpiresAt
        WHERE request_id = @requestId
          AND status = 'pending'
      `,
      )
      .run({
        requestId: request.requestId,
        status: requestStatus,
        resolvedAt,
        resolvedBy: input.resolvedBy,
        resolutionNote: input.resolutionNote ?? null,
        approvedTokenPlaintext: deviceToken ?? null,
        approvedTokenExpiresAt: deviceTokenExpiresAt ?? null,
      });

    approval = deps.storage.approvals.resolve(currentApproval.approvalId, input);
    deps.storage.approvalEvents.append({
      approvalId: currentApproval.approvalId,
      eventType: "resolved",
      actorId: input.resolvedBy,
      payload: {
        decision: input.decision,
        status: approval.status,
      },
    });
  });

  deps.enqueueApprovalResolutionEffects(approval!, input);
  await recordApprovalResolution(deps, approval!, input);
  await deps.storage.audit.append("approvals", {
    event: "auth.device_request.resolve",
    requestId: request.requestId,
    approvalId: currentApproval.approvalId,
    status: requestStatus,
    resolvedBy: input.resolvedBy,
    deviceLabel: request.deviceLabel,
    deviceType: request.deviceType,
    platform: request.platform,
    requestedIp: request.requestedIp,
    deviceTokenExpiresAt,
  });

  deps.publishRealtime(
    "auth_device_request_resolved",
    "auth",
    {
      requestId: request.requestId,
      approvalId: currentApproval.approvalId,
      status: requestStatus,
      resolvedAt,
      resolvedBy: input.resolvedBy,
      deviceLabel: request.deviceLabel,
      deviceType: request.deviceType,
      platform: request.platform,
      requestedIp: request.requestedIp,
      deviceTokenExpiresAt,
    },
    {
      eventClass: "domain_fact",
      eventAuthority: "retained_stream",
      links: {
        approvalId: currentApproval.approvalId,
      },
      correlationId: currentApproval.approvalId,
    },
  );

  const effects = deps.listApprovalEffects(currentApproval.approvalId);
  return {
    approval: approval!,
    effects,
    replay: {
      approval: approval!,
      events: deps.storage.approvalEvents.listByApprovalId(currentApproval.approvalId),
      effects,
    },
    durableRunId: effects.find((effect) => effect.effectKind === "approval_wait_wake")?.targetId,
    resolutionEffects: deriveApprovalResolutionEffectsResult(effects),
  };
}

export async function expireDeviceAccessRequestIfNeeded(
  deps: SettingsAuthRuntimeDependencies,
  request: AuthDeviceRequestRecord,
): Promise<AuthDeviceRequestRecord> {
  if (request.status !== "pending") {
    return request;
  }
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
    return request;
  }

  const resolutionInput: ApprovalResolveInput = {
    decision: "reject",
    resolvedBy: "system:auth-device-expiry",
    resolutionNote: "Device access request expired before approval.",
  };
  const resolvedAt = new Date().toISOString();
  let approval: ApprovalRequest | undefined;

  deps.storage.runImmediateTransaction(() => {
    deps.gatewaySql
      .prepare(
        `
        UPDATE auth_device_requests
        SET status = 'expired',
            resolved_at = @resolvedAt,
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote
        WHERE request_id = @requestId
          AND status = 'pending'
      `,
      )
      .run({
        requestId: request.requestId,
        resolvedAt,
        resolvedBy: resolutionInput.resolvedBy,
        resolutionNote: resolutionInput.resolutionNote ?? null,
      });

    const currentApproval = deps.storage.approvals.get(request.approvalId);
    if (currentApproval.status === "pending") {
      approval = deps.storage.approvals.resolve(request.approvalId, resolutionInput);
      deps.storage.approvalEvents.append({
        approvalId: request.approvalId,
        eventType: "resolved",
        actorId: resolutionInput.resolvedBy,
        payload: {
          decision: resolutionInput.decision,
          status: approval.status,
        },
      });
    }
  });

  if (approval) {
    deps.enqueueApprovalResolutionEffects(approval, resolutionInput);
    await recordApprovalResolution(deps, approval, resolutionInput);
  }
  await deps.storage.audit.append("approvals", {
    event: "auth.device_request.expire",
    requestId: request.requestId,
    approvalId: request.approvalId,
    deviceLabel: request.deviceLabel,
    deviceType: request.deviceType,
    platform: request.platform,
    requestedIp: request.requestedIp,
  });

  deps.publishRealtime(
    "auth_device_request_resolved",
    "auth",
    {
      requestId: request.requestId,
      approvalId: request.approvalId,
      status: "expired",
      resolvedAt,
      resolvedBy: resolutionInput.resolvedBy,
      deviceLabel: request.deviceLabel,
      deviceType: request.deviceType,
      platform: request.platform,
      requestedIp: request.requestedIp,
    },
    {
      eventClass: "domain_fact",
      eventAuthority: "retained_stream",
      links: {
        approvalId: request.approvalId,
      },
      correlationId: request.approvalId,
    },
  );

  return (
    getAuthDeviceRequestById(deps, request.requestId) ?? {
      ...request,
      status: "expired",
      resolvedAt,
      resolvedBy: resolutionInput.resolvedBy,
      resolutionNote: resolutionInput.resolutionNote,
    }
  );
}

// ---------------------------------------------------------------------------
// Device access runtime
// ---------------------------------------------------------------------------

export async function createDeviceAccessRequest(
  deps: SettingsAuthRuntimeDependencies,
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
  if (deps.config.assistant.auth.mode === "none") {
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

  const approval = await deps.createApproval({
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
    deps.gatewaySql
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
      await deps.resolveApproval(approval.approvalId, {
        decision: "reject",
        resolvedBy: "system:auth-device-request",
        resolutionNote: "Device request registration failed.",
      });
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }

  await deps.storage.audit.append("approvals", {
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

  deps.publishRealtime(
    "auth_device_request_created",
    "auth",
    {
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
    },
    {
      eventClass: "domain_fact",
      eventAuthority: "retained_stream",
      links: {
        approvalId: approval.approvalId,
      },
      correlationId: approval.approvalId,
    },
  );

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
  deps: SettingsAuthRuntimeDependencies,
  requestId: string,
  requestSecret: string,
): Promise<DeviceAccessRequestStatusResponse> {
  const request = getAuthDeviceRequestById(deps, requestId);
  if (!request) {
    throw new Error("Device access request not found.");
  }
  if (!requestSecret.trim() || !timingSafeStringEqual(hashSensitiveToken(requestSecret), request.requestSecretHash)) {
    throw new Error("Device access request not found.");
  }

  const current = await expireDeviceAccessRequestIfNeeded(deps, request);
  if (current.status === "approved" && !current.deliveredAt) {
    const deliveredAt = new Date().toISOString();
    const result = deps.gatewaySql
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
      const refreshed = getAuthDeviceRequestById(deps, requestId);
      if (refreshed) {
        return mapDeviceAccessStatusResponse(refreshed);
      }
    }
  }

  return mapDeviceAccessStatusResponse(current);
}

export function getAuthDeviceRequestById(
  deps: SettingsAuthRuntimeDependencies,
  requestId: string,
): AuthDeviceRequestRecord | undefined {
  const row = deps.gatewaySql
    .prepare(
      `
      SELECT *
      FROM auth_device_requests
      WHERE request_id = @requestId
      LIMIT 1
    `,
    )
    .get({ requestId }) as Record<string, unknown> | undefined;
  return row ? mapAuthDeviceRequestRow(row) : undefined;
}

function getAuthDeviceRequestByApprovalId(
  deps: SettingsAuthRuntimeDependencies,
  approvalId: string,
): AuthDeviceRequestRecord | undefined {
  const row = deps.gatewaySql
    .prepare(
      `
      SELECT *
      FROM auth_device_requests
      WHERE approval_id = @approvalId
      LIMIT 1
    `,
    )
    .get({ approvalId }) as Record<string, unknown> | undefined;
  return row ? mapAuthDeviceRequestRow(row) : undefined;
}

export function listDeviceAccessGrants(deps: SettingsAuthRuntimeDependencies): DeviceAccessGrantContractRecord[] {
  const rows = deps.gatewaySql
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
  deps: SettingsAuthRuntimeDependencies,
  grantId: string,
  revokedBy: string,
): Promise<DeviceAccessGrantContractRecord> {
  const existingRow = deps.gatewaySql
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
  deps.gatewaySql
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
  deps.gatewaySql
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
    (deps.gatewaySql
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

  await deps.storage.audit.append("approvals", {
    event: "auth.device_grant.revoke",
    grantId: result.grantId,
    requestId: result.requestId,
    revokedBy,
    deviceLabel: result.deviceLabel,
    deviceType: result.deviceType,
    platform: result.platform,
    revokedAt: result.revokedAt,
  });

  deps.publishRealtime("auth_device_grant_revoked", "auth", {
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

export function getActiveAuthDeviceGrantById(
  deps: SettingsAuthRuntimeDependencies,
  grantId: string,
): AuthDeviceGrantRecord | undefined {
  const now = new Date().toISOString();
  const row = deps.gatewaySql
    .prepare(
      `
      SELECT *
      FROM auth_device_grants
      WHERE grant_id = @grantId
      LIMIT 1
    `,
    )
    .get({ grantId }) as Record<string, unknown> | undefined;
  if (!row) {
    return undefined;
  }
  const grant = mapAuthDeviceGrantRow(row);
  if (grant.revokedAt) {
    return undefined;
  }
  if (grant.expiresAt) {
    const expiresAt = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.parse(now)) {
      return undefined;
    }
  }
  return grant;
}

export function validateDeviceAccessToken(
  deps: SettingsAuthRuntimeDependencies,
  token: string,
): { actorId: string; deviceId: string; grantId: string } | undefined {
  const tokenHash = hashSensitiveToken(token);
  const now = new Date().toISOString();
  const row = deps.gatewaySql
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
  deps.gatewaySql
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
  deps: SettingsAuthRuntimeDependencies,
  grantId: string,
  input: CompanionSessionExchangeInput,
): Promise<CompanionSessionExchangeResponse> {
  const grant = getActiveAuthDeviceGrantById(deps, grantId);
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

  deps.storage.runImmediateTransaction(() => {
    deps.gatewaySql
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

    deps.gatewaySql
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

  await deps.storage.audit.append("approvals", {
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
  deps: SettingsAuthRuntimeDependencies,
  input: CompanionSessionRefreshInput,
): Promise<CompanionSessionRefreshResponse> {
  const refreshToken = input.refreshToken.trim();
  if (!refreshToken) {
    throw new ValidationError({
      message: "Refresh token is required.",
    });
  }

  const session = getActiveCompanionSessionByRefreshToken(deps, refreshToken);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }

  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const accessTokenExpiresAt = new Date(now + COMPANION_ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshTokenExpiresAt = new Date(now + COMPANION_REFRESH_TOKEN_TTL_MS).toISOString();
  const nextAccessToken = `gcca_${randomBytes(COMPANION_ACCESS_TOKEN_BYTES).toString("base64url")}`;
  const nextRefreshToken = `gccr_${randomBytes(COMPANION_REFRESH_TOKEN_BYTES).toString("base64url")}`;

  const result = deps.gatewaySql
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

  await deps.storage.audit.append("approvals", {
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

export function getActiveCompanionSessionById(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
): CompanionSessionRecord | undefined {
  const now = new Date().toISOString();
  const session = getCompanionSessionById(deps, sessionId);
  if (!session) {
    return undefined;
  }
  if (!isCompanionSessionCurrentlyActive(session, now)) {
    deps.gatewaySql
      .prepare(
        `
        UPDATE companion_sessions
        SET revoked_at = COALESCE(revoked_at, @revokedAt)
        WHERE session_id = @sessionId
      `,
      )
      .run({
        sessionId,
        revokedAt: now,
      });
    return undefined;
  }
  return session;
}

export function getCompanionSessionById(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
): CompanionSessionRecord | undefined {
  const row = deps.gatewaySql
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
      WHERE s.session_id = @sessionId
      LIMIT 1
    `,
    )
    .get({
      sessionId,
    }) as Record<string, unknown> | undefined;
  if (!row) {
    return undefined;
  }
  return mapCompanionSessionRow(row);
}

export function getActiveCompanionSessionByRefreshToken(
  deps: SettingsAuthRuntimeDependencies,
  refreshToken: string,
): CompanionSessionRecord | undefined {
  const now = new Date().toISOString();
  const row = deps.gatewaySql
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
      WHERE s.refresh_token_hash = @refreshTokenHash
      LIMIT 1
    `,
    )
    .get({
      refreshTokenHash: hashSensitiveToken(refreshToken),
    }) as Record<string, unknown> | undefined;
  if (!row) {
    return undefined;
  }
  const session = mapCompanionSessionRow(row);
  if (!isCompanionSessionRefreshable(session, now)) {
    deps.gatewaySql
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
  return session;
}

export function getCompanionSessionInfo(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
): CompanionSessionInfoResponse {
  const session = getActiveCompanionSessionById(deps, sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }
  return toCompanionSessionInfoResponse(session);
}

export function listCompanionSessions(
  deps: SettingsAuthRuntimeDependencies,
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
  const rows = deps.gatewaySql
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
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
): CompanionSessionAdminRecord {
  const session = getCompanionSessionById(deps, sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }
  return toCompanionSessionAdminRecord(session);
}

export async function revokeCompanionSession(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
  revokedBy: string,
): Promise<CompanionSessionRevokeResponse> {
  const session = getCompanionSessionById(deps, sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }

  const revokedAt = new Date().toISOString();
  deps.gatewaySql
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

  const updated = getCompanionSessionById(deps, sessionId) ?? {
    ...session,
    revokedAt,
  };
  const record = toCompanionSessionAdminRecord(updated);

  await deps.storage.audit.append("approvals", {
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

  deps.publishRealtime("auth_companion_session_revoked", "auth", {
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
  deps: SettingsAuthRuntimeDependencies,
  options?: {
    sessionId?: string;
    grantId?: string;
    limit?: number;
  },
): Promise<CompanionAuditEventRecord[]> {
  const sessionId = options?.sessionId?.trim();
  const grantId = options?.grantId?.trim();
  const limit = clampInt(options?.limit, 50, 1, 200);
  const records = await deps.storage.audit.list("approvals");

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

export async function recordApprovalResolution(
  deps: SettingsAuthRuntimeDependencies,
  approval: ApprovalRequest,
  input: ApprovalResolveInput,
): Promise<void> {
  await deps.storage.audit.append("approvals", {
    event: "approval.resolve",
    approvalId: approval.approvalId,
    status: approval.status,
    resolvedBy: input.resolvedBy,
    decision: input.decision,
  });

  deps.publishRealtime(
    "approval_resolved",
    "approvals",
    {
      approvalId: approval.approvalId,
      status: approval.status,
      decision: input.decision,
      resolvedBy: input.resolvedBy,
    },
    {
      eventClass: "domain_fact",
      eventAuthority: "retained_stream",
      links: deps.buildApprovalRealtimeLinks(approval),
      correlationId: approval.approvalId,
    },
  );
  deps.recordImprovementApprovalResolutionSignal(approval);
  deps.handleActivationApprovalResolution(approval);
}

export function validateCompanionAccessToken(
  deps: SettingsAuthRuntimeDependencies,
  token: string,
): CompanionAccessValidationResult | undefined {
  const tokenHash = hashSensitiveToken(token);
  const now = new Date().toISOString();
  const row = deps.gatewaySql
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
    deps.gatewaySql
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

  deps.gatewaySql
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
  deps.gatewaySql
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
  deps: SettingsAuthRuntimeDependencies,
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
  const session = getActiveCompanionSessionById(deps, input.sessionId);
  if (!session) {
    void deps.storage.audit.append("approvals", {
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
    void deps.storage.audit.append("approvals", {
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
    void deps.storage.audit.append("approvals", {
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
  deps.gatewaySql
    .prepare(
      `
    DELETE FROM companion_request_replays
    WHERE expires_at <= @now
  `,
    )
    .run({ now });
  try {
    deps.gatewaySql
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
    void deps.storage.audit.append("approvals", {
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

  void deps.storage.audit.append("approvals", {
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

function legacyProfileToApprovalMode(profile: string | undefined): ToolApprovalMode {
  return profile === "danger" ? "bypass" : "approve_risky";
}
