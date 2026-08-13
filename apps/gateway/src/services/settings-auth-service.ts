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
  APPROVAL_EXPIRY_ACTOR_ID,
  clampInt,
  ConflictError,
  isGoatError,
  NotFoundError,
  SECRET_REDACTION_MARKER,
  ValidationError,
  type ApprovalCreateInput,
  type ApprovalEffectRecord,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type AuthRuntimeSettings,
  type AuthSettingsUpdateInput,
  type CompanionAuditEventRecord,
  type CompanionPrincipalPurpose,
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
  type LlmProviderConfig,
  type LlmProviderRequestConfig,
  type RealtimeEvent,
  type ToolApprovalMode,
} from "@goatcitadel/contracts";
import type { MeshService } from "@goatcitadel/mesh-core";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import {
  preserveSettingsSecretsForPublicUpdate,
  requiresSettingsPublicProjectionReconciliation,
} from "./provider-settings-public-projection.js";
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
import { LlmService, type LlmRuntimeUpdateInput } from "./llm-service.js";
import type { NpuSidecarService } from "./npu-sidecar-service.js";
import {
  buildCompanionSigningPayload,
  decodeBase64Url,
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
import {
  deriveApprovalResolutionEffectsResult,
  type ApprovalObservabilityEffectInput,
  type ApprovalResolutionEffectEnqueueOptions,
} from "./approval-resolution-effects-service.js";
import { buildApprovalResolutionObservabilityEffects } from "./approval-observability.js";
import type { ApprovalCreateCommitHook } from "./approval-lifecycle-service.js";
import type { ApprovalResolutionContext } from "./approval-types.js";
import type { ApprovalResolveResult } from "./approval-types.js";
import type { DeviceTokenVault } from "./device-token-vault.js";

const settingsLog = logger.child("settings-auth-service");
const MOBILE_PUSH_REGISTRATION_PATH = "/api/v1/mobile/current-device/push";

export interface SettingsRuntimeDependencies {
  readonly config: GatewayRuntimeConfig;
  readonly llmService: Pick<
    LlmService,
    | "deleteProviderApiKey"
    | "getRuntimeConfig"
    | "exportConfigFile"
    | "getProviderSecretStatus"
    | "setProviderApiKey"
    | "updateNetworkAllowlist"
    | "updateRuntimeConfig"
  >;
  readonly meshService: Pick<MeshService, "updateOptions">;
  readonly npuSidecar: Pick<NpuSidecarService, "getStatus" | "updateConfig" | "stop" | "start">;
  readonly llamaCppRuntime: Pick<LlamaCppRuntimeService, "getStatus" | "updateConfig" | "stop" | "start">;
  readFeatureFlags(): Promise<RuntimeSettings["features"]>;
  readSettingsRevision?(): number;
  updateFeatureFlags(patch: Partial<RuntimeSettings["features"]>): Promise<RuntimeSettings["features"]>;
  assertDeploymentProfileUpdate(input: UpdateSettingsInput): void;
  assertFirecrawlRuntimeUpdate(input: UpdateSettingsInput): void;
}

export interface SettingsAuthRuntimeDependencies {
  readonly config: GatewayRuntimeConfig;
  readonly gatewaySql: Storage["gatewaySql"];
  readonly storage: Pick<
    Storage,
    "audit" | "runImmediateTransaction" | "approvals" | "approvalEvents" | "sessionControls"
  >;
  /**
   * In-memory, single-use store for approved device-access tokens. The
   * plaintext token is NEVER persisted at rest; it lives here between approval
   * and the device's first status poll.
   */
  readonly deviceTokenVault: DeviceTokenVault;
  createApproval(input: ApprovalCreateInput, onCreated?: ApprovalCreateCommitHook): Promise<{ approvalId: string }>;
  resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<unknown>;
  enqueueApprovalResolutionEffects(
    approval: ApprovalRequest,
    input: ApprovalResolveInput,
    options?: ApprovalResolutionEffectEnqueueOptions,
  ): Promise<ApprovalEffectRecord[]>;
  enqueueApprovalObservabilityEffects(
    approvalId: string,
    items: readonly ApprovalObservabilityEffectInput[],
  ): Promise<ApprovalEffectRecord[]>;
  listApprovalEffects(approvalId: string): Promise<ApprovalEffectRecord[]>;
  buildApprovalRealtimeLinks(approval: ApprovalRequest): NonNullable<RealtimeEvent["links"]>;
  recordImprovementApprovalResolutionSignal(approval: ApprovalRequest): void;
  handleActivationApprovalResolution(approval: ApprovalRequest): void;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
}

export async function getSettings(deps: SettingsRuntimeDependencies): Promise<RuntimeSettings> {
  const features = await deps.readFeatureFlags();
  return {
    revision: deps.readSettingsRevision?.() ?? 1,
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
  expectedRevision?: number;
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
    utilityProviderId?: string;
    utilityModel?: string;
    upsertProvider?: {
      providerId: string;
      label?: string;
      baseUrl?: string;
      apiStyle?:
        | "openai-chat-completions"
        | "openai-responses"
        | "openai-codex-responses"
        | "anthropic-messages"
        | "bedrock-messages";
      authMode?: LlmProviderConfig["authMode"];
      defaultModel?: string;
      apiKey?: string;
      apiKeyEnv?: string;
      googleCloud?: LlmProviderConfig["googleCloud"];
      capabilities?: LlmProviderConfig["capabilities"];
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

export interface SettingsConfigCandidate {
  config: GatewayRuntimeConfig;
  features: RuntimeSettings["features"];
  llm: ReturnType<LlmService["exportConfigFile"]>;
  settings: RuntimeSettings;
  input: UpdateSettingsInput;
}

const UNSAFE_CONFIG_MUTATION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertProviderConfigMutationIsSecretFree(input: UpdateSettingsInput): void {
  const provider = input.llm?.upsertProvider;
  if (!provider) {
    return;
  }
  const inlineValues = [
    provider.apiKey,
    provider.request?.auth && "token" in provider.request.auth ? provider.request.auth.token : undefined,
    provider.request?.auth && "value" in provider.request.auth ? provider.request.auth.value : undefined,
    provider.request?.proxy?.auth && "token" in provider.request.proxy.auth
      ? provider.request.proxy.auth.token
      : undefined,
    provider.request?.proxy?.auth && "value" in provider.request.proxy.auth
      ? provider.request.proxy.auth.value
      : undefined,
  ];
  if (inlineValues.some((value) => value?.trim() && value.trim() !== SECRET_REDACTION_MARKER)) {
    throw new ValidationError({
      message:
        "Inline provider credentials are not accepted in provider config. Save API keys through the provider secret endpoint and use env references for request/proxy auth.",
    });
  }
}

/**
 * Builds and validates the settings mutation against isolated runtime owners.
 * No live config, owner, persistence, or secure-secret state is mutated.
 */
export async function buildSettingsCandidate(
  deps: SettingsRuntimeDependencies,
  rawInput: UpdateSettingsInput,
): Promise<SettingsConfigCandidate> {
  assertProviderConfigMutationIsSecretFree(rawInput);

  const candidateConfig = structuredClone(deps.config);
  const currentLlm = deps.llmService.exportConfigFile();
  const candidateLlmService = new LlmService(currentLlm, process.env, {
    networkAllowlist: candidateConfig.toolPolicy.sandbox.networkAllowlist,
    enforceNetworkAllowlist: true,
  });
  let candidateFeatures = structuredClone(await deps.readFeatureFlags());
  const noopNpuStatus = () => deps.npuSidecar.getStatus();
  const noopLlamaStatus = () => deps.llamaCppRuntime.getStatus();
  const candidateDeps: SettingsRuntimeDependencies = {
    config: candidateConfig,
    llmService: candidateLlmService,
    meshService: { updateOptions: async () => undefined },
    npuSidecar: {
      getStatus: noopNpuStatus,
      updateConfig: () => undefined,
      stop: async () => noopNpuStatus(),
      start: async () => noopNpuStatus(),
    },
    llamaCppRuntime: {
      getStatus: noopLlamaStatus,
      updateConfig: () => undefined,
      stop: async () => noopLlamaStatus(),
      start: async () => noopLlamaStatus(),
    },
    readFeatureFlags: async () => structuredClone(candidateFeatures),
    readSettingsRevision: () => deps.readSettingsRevision?.() ?? 1,
    updateFeatureFlags: async (patch) => {
      if (patch.durableKernelV1Enabled === false) {
        throw new ValidationError({
          message: "features.durableKernelV1Enabled is a shipped baseline runtime setting and cannot be disabled.",
        });
      }
      candidateFeatures = { ...candidateFeatures, ...patch };
      return structuredClone(candidateFeatures);
    },
    assertDeploymentProfileUpdate: (input) => deps.assertDeploymentProfileUpdate(input),
    assertFirecrawlRuntimeUpdate: (input) => deps.assertFirecrawlRuntimeUpdate(input),
  };

  let settings: RuntimeSettings;
  try {
    settings = await updateSettings(candidateDeps, rawInput);
  } catch (error) {
    if (isGoatError(error)) {
      throw error;
    }
    throw new ValidationError({
      message: error instanceof Error ? error.message : "Invalid settings update.",
    });
  }
  const llm = candidateLlmService.exportConfigFile();
  candidateConfig.llm = structuredClone(llm);
  candidateConfig.assistant.features = structuredClone(candidateFeatures);
  return {
    config: candidateConfig,
    features: candidateFeatures,
    llm,
    settings,
    input: structuredClone(rawInput),
  };
}

export async function updateSettings(
  deps: SettingsRuntimeDependencies,
  rawInput: UpdateSettingsInput,
): Promise<RuntimeSettings> {
  assertProviderConfigMutationIsSecretFree(rawInput);
  const reconciledInput = requiresSettingsPublicProjectionReconciliation(rawInput)
    ? preserveSettingsSecretsForPublicUpdate(await getSettings(deps), rawInput)
    : rawInput;
  const input = sanitizeConfigMutationInput(reconciledInput, "settings") as UpdateSettingsInput;
  deps.assertDeploymentProfileUpdate(input);
  deps.assertFirecrawlRuntimeUpdate(input);

  if (input.deploymentProfile) {
    deps.config.assistant.deploymentProfile = input.deploymentProfile;
  }

  if (input.defaultToolProfile) {
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
  }

  if (input.toolApprovalMode) {
    deps.config.toolPolicy.tools.approvalMode = input.toolApprovalMode;
    deps.config.assistant.toolApprovalMode = input.toolApprovalMode;
    deps.llmService.updateNetworkAllowlist(deps.config.toolPolicy.sandbox.networkAllowlist, {
      enforce: true,
    });
  }

  if (input.budgetMode) {
    deps.config.budgets.mode = input.budgetMode;
  }

  if (input.readAccessMode) {
    deps.config.toolPolicy.sandbox.readAccessMode = input.readAccessMode;
  }

  if (input.networkAllowlist) {
    deps.config.toolPolicy.sandbox.networkAllowlist = input.networkAllowlist
      .map((host_) => host_.trim())
      .filter(Boolean);
    deps.llmService.updateNetworkAllowlist(deps.config.toolPolicy.sandbox.networkAllowlist, {
      enforce: true,
    });
  }

  if (input.auth) {
    updateAuthSettings(deps, input.auth);
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

    await deps.meshService.updateOptions({
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
  }

  if (input.npu) {
    if (input.npu.sidecarUrl !== undefined) {
      const trimmed = input.npu.sidecarUrl.trim();
      if (!trimmed) {
        throw new Error("npu.sidecarUrl cannot be empty");
      }
      deps.config.assistant.npu.sidecar.baseUrl = trimmed;
    }

    deps.config.assistant.npu.enabled = false;
    deps.config.assistant.npu.autoStart = false;
    deps.npuSidecar.updateConfig(deps.config.assistant.npu);
    void deps.npuSidecar.stop("disabled").catch((error) => {
      settingsLog.warn("retired npu sidecar stop failed after settings update", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
  }

  if (input.features) {
    await deps.updateFeatureFlags(input.features);
  }

  if (input.llm) {
    const llmInput = {
      ...input.llm,
      upsertProvider: input.llm.upsertProvider ? { ...input.llm.upsertProvider } : undefined,
    };
    const submittedApiKeyValue = llmInput.upsertProvider?.apiKey?.trim();
    if (llmInput.upsertProvider && submittedApiKeyValue === SECRET_REDACTION_MARKER) {
      llmInput.upsertProvider.apiKey = undefined;
    }
    deps.llmService.updateRuntimeConfig(llmInput satisfies LlmRuntimeUpdateInput);
  }

  return await getSettings(deps);
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
  rawInput: AuthSettingsUpdateInput,
): AuthRuntimeSettings {
  const input = sanitizeConfigMutationInput(rawInput, "auth") as AuthSettingsUpdateInput;
  const currentAuth = deps.config.assistant.auth;
  const nextAuth: GatewayRuntimeConfig["assistant"]["auth"] = {
    ...currentAuth,
    mode: input.mode ?? currentAuth.mode,
    allowLoopbackBypass: input.allowLoopbackBypass ?? currentAuth.allowLoopbackBypass,
    token: {
      ...currentAuth.token,
      value: input.token !== undefined ? input.token.trim() || undefined : currentAuth.token.value,
    },
    basic: {
      ...currentAuth.basic,
      username:
        input.basicUsername !== undefined ? input.basicUsername.trim() || undefined : currentAuth.basic.username,
      password:
        input.basicPassword !== undefined ? input.basicPassword.trim() || undefined : currentAuth.basic.password,
    },
  };
  const candidatePlan = createGatewayAuthCredentialPlan({
    runtimeConfig: {
      ...deps.config,
      assistant: {
        ...deps.config.assistant,
        auth: nextAuth,
      },
    },
    env: process.env,
    configAuth: readAssistantAuthConfigSnapshotSync(deps.config.rootDir),
  });
  assertAuthModeHasEffectiveCredential(candidatePlan);

  deps.config.assistant.auth.mode = nextAuth.mode;
  deps.config.assistant.auth.allowLoopbackBypass = nextAuth.allowLoopbackBypass;
  deps.config.assistant.auth.token.value = nextAuth.token.value;
  deps.config.assistant.auth.basic.username = nextAuth.basic.username;
  deps.config.assistant.auth.basic.password = nextAuth.basic.password;
  return getAuthRuntimeSettings(deps);
}

function sanitizeConfigMutationInput(value: unknown, pathLabel: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeConfigMutationInput(item, `${pathLabel}[${index}]`));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_CONFIG_MUTATION_KEYS.has(key)) {
      throw new Error(`Unsafe config key is not allowed: ${pathLabel}.${key}`);
    }
    out[key] = sanitizeConfigMutationInput((value as Record<string, unknown>)[key], `${pathLabel}.${key}`);
  }
  return out;
}

function assertAuthModeHasEffectiveCredential(plan: AuthRuntimeSettings["plan"]): void {
  if (plan.mode === "token" && !plan.token.configured) {
    throw new ValidationError({
      message: "Token auth mode requires a configured token before it can be saved.",
    });
  }
  if (plan.mode === "basic" && !(plan.basicUsername.configured && plan.basicPassword.configured)) {
    throw new ValidationError({
      message: "Basic auth mode requires both a username and password before it can be saved.",
    });
  }
}

interface AuthDatabaseClockSql {
  readonly nowText: string;
  readonly lockRow: string;
  isFuture(expression: string): string;
  isValidAndExpired(expression: string): string;
  isExpiredOrInvalid(expression: string): string;
}

function getAuthDatabaseClockSql(deps: SettingsAuthRuntimeDependencies): AuthDatabaseClockSql {
  if (deps.gatewaySql.dialect === "postgres") {
    const isCanonical = (expression: string) =>
      `(${expression} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$')`;
    const parsed = (expression: string) => `gc_try_parse_timestamptz(${expression})`;
    return {
      nowText: `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      lockRow: " FOR UPDATE",
      isFuture: (expression) =>
        `COALESCE(${isCanonical(expression)} AND isfinite(${parsed(expression)}) AND ${parsed(
          expression,
        )} > clock_timestamp(), FALSE)`,
      isValidAndExpired: (expression) =>
        `COALESCE(${isCanonical(expression)} AND isfinite(${parsed(expression)}) AND ${parsed(
          expression,
        )} <= clock_timestamp(), FALSE)`,
      isExpiredOrInvalid: (expression) =>
        `NOT COALESCE(${isCanonical(expression)} AND isfinite(${parsed(expression)}) AND ${parsed(
          expression,
        )} > clock_timestamp(), FALSE)`,
    };
  }
  const isCanonical = buildSqliteCanonicalZonedInstantPredicate;
  return {
    nowText: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    lockRow: "",
    isFuture: (expression) => `COALESCE(${isCanonical(expression)} AND julianday(${expression}) > julianday('now'), 0)`,
    isValidAndExpired: (expression) =>
      `COALESCE(${isCanonical(expression)} AND julianday(${expression}) <= julianday('now'), 0)`,
    isExpiredOrInvalid: (expression) =>
      `NOT COALESCE(${isCanonical(expression)} AND julianday(${expression}) > julianday('now'), 0)`,
  };
}

function buildSqliteCanonicalZonedInstantPredicate(expression: string): string {
  const base = `substr(${expression}, 1, 19)`;
  const basePattern = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]";
  const zuluFraction = `substr(${expression}, 21, length(${expression}) - 21)`;
  const offsetFraction = `substr(${expression}, 21, length(${expression}) - 26)`;
  const offsetShape = (signPosition: string) => `
    substr(${expression}, ${signPosition}, 1) IN ('+', '-')
    AND substr(${expression}, ${signPosition} + 3, 1) = ':'
    AND substr(${expression}, ${signPosition} + 1, 2) NOT GLOB '*[^0-9]*'
    AND substr(${expression}, ${signPosition} + 4, 2) NOT GLOB '*[^0-9]*'
  `;
  return `(
    typeof(${expression}) = 'text'
    AND ${base} GLOB '${basePattern}'
    AND (
      (length(${expression}) = 20 AND substr(${expression}, 20, 1) = 'Z')
      OR (length(${expression}) = 25 AND ${offsetShape("20")})
      OR (
        substr(${expression}, 20, 1) = '.'
        AND (
          (
            length(${expression}) >= 22
            AND length(${expression}) <= 30
            AND substr(${expression}, -1, 1) = 'Z'
            AND ${zuluFraction} <> ''
            AND ${zuluFraction} NOT GLOB '*[^0-9]*'
          )
          OR (
            length(${expression}) >= 27
            AND length(${expression}) <= 35
            AND ${offsetShape(`length(${expression}) - 5`)}
            AND ${offsetFraction} <> ''
            AND ${offsetFraction} NOT GLOB '*[^0-9]*'
          )
        )
      )
    )
  )`;
}

async function readDatabaseNowMs(deps: SettingsAuthRuntimeDependencies): Promise<number> {
  const parsed = Date.parse(await deps.gatewaySql.readDatabaseNow());
  if (!Number.isFinite(parsed)) {
    throw new Error("Database clock did not return a valid timestamp.");
  }
  return parsed;
}

async function createCompanionCredentialWindow(deps: SettingsAuthRuntimeDependencies): Promise<{
  issuedAt: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}> {
  const clock = getAuthDatabaseClockSql(deps);
  const row = await (
    await deps.gatewaySql.prepare(
      deps.gatewaySql.dialect === "postgres"
        ? `
          WITH database_clock AS (
            SELECT clock_timestamp() AS now_instant
          )
          SELECT
            to_char(now_instant AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
            to_char(
              (
                now_instant + (CAST(@accessTtlMs AS DOUBLE PRECISION) * interval '1 millisecond')
              ) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS access_token_expires_at,
            to_char(
              (
                now_instant + (CAST(@refreshTtlMs AS DOUBLE PRECISION) * interval '1 millisecond')
              ) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS refresh_token_expires_at
          FROM database_clock
        `
        : `
          SELECT
            ${clock.nowText} AS issued_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', @accessTtlModifier) AS access_token_expires_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', @refreshTtlModifier) AS refresh_token_expires_at
        `,
    )
  ).get<{
    issued_at?: unknown;
    access_token_expires_at?: unknown;
    refresh_token_expires_at?: unknown;
  }>(
    deps.gatewaySql.dialect === "postgres"
      ? {
          accessTtlMs: COMPANION_ACCESS_TOKEN_TTL_MS,
          refreshTtlMs: COMPANION_REFRESH_TOKEN_TTL_MS,
        }
      : {
          accessTtlModifier: `${COMPANION_ACCESS_TOKEN_TTL_MS / 1_000} seconds`,
          refreshTtlModifier: `${COMPANION_REFRESH_TOKEN_TTL_MS / 1_000} seconds`,
        },
  );
  if (
    typeof row?.issued_at !== "string" ||
    typeof row.access_token_expires_at !== "string" ||
    typeof row.refresh_token_expires_at !== "string" ||
    !Number.isFinite(Date.parse(row.issued_at)) ||
    !Number.isFinite(Date.parse(row.access_token_expires_at)) ||
    !Number.isFinite(Date.parse(row.refresh_token_expires_at))
  ) {
    throw new Error("Database clock did not return a valid companion credential window.");
  }
  return {
    issuedAt: row.issued_at,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
  };
}

export class DeviceAccessExpiredAfterCommitError extends ConflictError {
  public readonly mutationCommitted = true;

  public constructor() {
    super({
      message: "Device access request expired before it could be approved.",
    });
    this.name = "DeviceAccessExpiredAfterCommitError";
  }
}

export async function resolveDeviceAccessApproval(
  deps: SettingsAuthRuntimeDependencies,
  currentApproval: ApprovalRequest,
  input: ApprovalResolveInput,
  context?: ApprovalResolutionContext,
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

  const existingRequest = await getAuthDeviceRequestByApprovalId(deps, currentApproval.approvalId);
  if (!existingRequest) {
    throw new NotFoundError("Device access request not found.");
  }

  const request = await expireDeviceAccessRequestIfNeeded(deps, existingRequest);
  if (request.status === "expired") {
    throw new DeviceAccessExpiredAfterCommitError();
  }
  if (request.status !== "pending") {
    throw new ConflictError({
      message: `Approval ${currentApproval.approvalId} is already resolved`,
    });
  }

  const requestStatus: DeviceAccessRequestStatus = input.decision === "approve" ? "approved" : "rejected";
  const deviceToken =
    input.decision === "approve" ? randomBytes(DEVICE_ACCESS_TOKEN_BYTES).toString("base64url") : undefined;
  const tokenWindow = deviceToken
    ? await deps.gatewaySql.createDatabaseTtlWindow(DEVICE_ACCESS_TOKEN_TTL_MS)
    : undefined;
  const resolvedAt = tokenWindow?.createdAt ?? (await deps.gatewaySql.readDatabaseNow());
  const deviceTokenExpiresAt = tokenWindow?.expiresAt;
  const clock = getAuthDatabaseClockSql(deps);
  let approval!: ApprovalRequest;
  let effects: ApprovalEffectRecord[] = [];
  let events: Awaited<ReturnType<SettingsAuthRuntimeDependencies["storage"]["approvalEvents"]["listByApprovalId"]>> =
    [];
  let tokenStoredByThisAttempt = false;

  try {
    await deps.storage.runImmediateTransaction(async () => {
      const requestUpdate = await (
        await deps.gatewaySql.prepare(
          `
        UPDATE auth_device_requests
        SET status = @status,
            resolved_at = @resolvedAt,
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote,
            approved_token_plaintext = NULL,
            approved_token_expires_at = @approvedTokenExpiresAt
        WHERE request_id = @requestId
          AND status = 'pending'
          AND ${clock.isFuture("expires_at")}
      `,
        )
      ).run({
        requestId: request.requestId,
        status: requestStatus,
        resolvedAt,
        resolvedBy: input.resolvedBy,
        resolutionNote: input.resolutionNote ?? null,
        // SECURITY: only the token hash is persisted. The plaintext remains
        // in the process-local single-use vault until the winning status poll.
        approvedTokenExpiresAt: deviceTokenExpiresAt ?? null,
      });
      if (requestUpdate.changes !== 1) {
        throw new ConflictError({
          message: "Device access request is no longer pending or has expired.",
        });
      }

      if (deviceToken) {
        deps.deviceTokenVault.store(request.requestId, deviceToken, deviceTokenExpiresAt, Date.parse(resolvedAt));
        tokenStoredByThisAttempt = true;
      }

      if (context?.remoteToken) {
        await deps.storage.approvals.mergeLinkage(currentApproval.approvalId, {
          connectorId: context.remoteToken.connectorId,
          tokenId: context.remoteToken.tokenId,
        });
      }

      if (deviceToken) {
        await (
          await deps.gatewaySql.prepare(
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
        ).run({
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

      approval = await deps.storage.approvals.resolve(currentApproval.approvalId, input);
      await deps.storage.approvalEvents.append({
        approvalId: currentApproval.approvalId,
        eventType: "resolved",
        actorId: input.resolvedBy,
        payload: {
          decision: input.decision,
          status: approval.status,
        },
      });
      await deps.enqueueApprovalResolutionEffects(approval, input);
      await deps.enqueueApprovalObservabilityEffects(approval.approvalId, [
        ...buildApprovalResolutionObservabilityEffects(approval, input),
        {
          operationId: `auth.device_request.resolve.audit:${request.requestId}`,
          delivery: {
            kind: "audit",
            stream: "approvals",
            payload: {
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
            },
          },
        },
        {
          operationId: `auth.device_request.resolve.realtime:${request.requestId}`,
          delivery: {
            kind: "realtime",
            eventType: "auth_device_request_resolved",
            source: "auth",
            payload: {
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
            options: {
              eventClass: "domain_fact",
              eventAuthority: "retained_stream",
              links: {
                approvalId: currentApproval.approvalId,
              },
              correlationId: currentApproval.approvalId,
            },
          },
        },
      ]);
      effects = await deps.listApprovalEffects(currentApproval.approvalId);
      events = await deps.storage.approvalEvents.listByApprovalId(currentApproval.approvalId);

      // Settle the expiry boundary after every potentially blocking write/read
      // in the transaction. In PostgreSQL an UPDATE can wait on a row lock while
      // retaining the earlier `resolvedAt` bind value; this final fresh-clock
      // check makes that stale timestamp incapable of authorizing a grant after
      // the request's actual deadline. Throwing here rolls back the request,
      // grant, approval, events, effects, and the process-local vault entry.
      const commitRequest = await (
        await deps.gatewaySql.prepare(
          `
            SELECT request_id
            FROM auth_device_requests
            WHERE request_id = @requestId
              AND status = @status
              AND ${clock.isFuture("expires_at")}
            LIMIT 1
          `,
        )
      ).get({ requestId: request.requestId, status: requestStatus });
      if (!commitRequest) {
        throw new ConflictError({
          message: "Device access request expired before the approval transaction committed.",
        });
      }
    });
  } catch (error) {
    if (tokenStoredByThisAttempt) {
      deps.deviceTokenVault.delete(request.requestId);
    }
    throw error;
  }

  return {
    approval,
    effects,
    replay: {
      approval,
      events,
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
  if (!(await deps.gatewaySql.isDatabaseInstantExpired(request.expiresAt))) {
    return request;
  }

  const resolutionInput: ApprovalResolveInput = {
    decision: "reject",
    resolvedBy: APPROVAL_EXPIRY_ACTOR_ID,
    resolutionNote: "Device access request expired before approval.",
  };
  const clock = getAuthDatabaseClockSql(deps);
  let resolvedAt = await deps.gatewaySql.readDatabaseNow();
  let approval: ApprovalRequest | undefined;
  let resolvedRequest: AuthDeviceRequestRecord | undefined;

  await deps.storage.runImmediateTransaction(async () => {
    const requestUpdate = await (
      await deps.gatewaySql.prepare(
        `
        UPDATE auth_device_requests
        SET status = 'expired',
            resolved_at = ${clock.nowText},
            resolved_by = @resolvedBy,
            resolution_note = @resolutionNote
        WHERE request_id = @requestId
          AND status = 'pending'
          AND ${clock.isExpiredOrInvalid("expires_at")}
      `,
      )
    ).run({
      requestId: request.requestId,
      resolvedBy: resolutionInput.resolvedBy,
      resolutionNote: resolutionInput.resolutionNote ?? null,
    });
    if (requestUpdate.changes !== 1) {
      resolvedRequest = await getAuthDeviceRequestById(deps, request.requestId);
      return;
    }

    resolvedRequest = await getAuthDeviceRequestById(deps, request.requestId);
    resolvedAt = resolvedRequest?.resolvedAt ?? (await deps.gatewaySql.readDatabaseNow());

    const currentApproval = await deps.storage.approvals.get(request.approvalId);
    if (currentApproval.status === "pending") {
      approval = await deps.storage.approvals.resolve(request.approvalId, resolutionInput, {
        resolvedAt,
        allowExpired: true,
      });
      await deps.storage.approvalEvents.append({
        approvalId: request.approvalId,
        eventType: "resolved",
        actorId: resolutionInput.resolvedBy,
        payload: {
          decision: resolutionInput.decision,
          status: approval.status,
        },
      });
      await deps.enqueueApprovalResolutionEffects(approval, resolutionInput, { allowExpired: true });
    }
    await deps.enqueueApprovalObservabilityEffects(request.approvalId, [
      ...(approval ? buildApprovalResolutionObservabilityEffects(approval, resolutionInput) : []),
      {
        operationId: `auth.device_request.expire.audit:${request.requestId}`,
        delivery: {
          kind: "audit",
          stream: "approvals",
          payload: {
            event: "auth.device_request.expire",
            requestId: request.requestId,
            approvalId: request.approvalId,
            deviceLabel: request.deviceLabel,
            deviceType: request.deviceType,
            platform: request.platform,
            requestedIp: request.requestedIp,
          },
        },
      },
      {
        operationId: `auth.device_request.expire.realtime:${request.requestId}`,
        delivery: {
          kind: "realtime",
          eventType: "auth_device_request_resolved",
          source: "auth",
          payload: {
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
          options: {
            eventClass: "domain_fact",
            eventAuthority: "retained_stream",
            links: {
              approvalId: request.approvalId,
            },
            correlationId: request.approvalId,
          },
        },
      },
    ]);
    resolvedRequest ??= await getAuthDeviceRequestById(deps, request.requestId);
  });

  return resolvedRequest ?? request;
}

export async function expirePendingDeviceAccessRequests(
  deps: SettingsAuthRuntimeDependencies,
  limit = 100,
): Promise<number> {
  const clock = getAuthDatabaseClockSql(deps);
  const rows = (await (
    await deps.gatewaySql.prepare(
      `
      SELECT request_id
      FROM auth_device_requests
      WHERE status = 'pending'
        AND ${clock.isExpiredOrInvalid("expires_at")}
      ORDER BY expires_at ASC, request_id ASC
      LIMIT @limit
    `,
    )
  ).all({ limit: clampInt(limit, 100, 1, 1000) })) as Array<{ request_id?: unknown }>;
  let expired = 0;
  for (const row of rows) {
    if (typeof row.request_id !== "string") {
      continue;
    }
    const request = await getAuthDeviceRequestById(deps, row.request_id);
    if (!request || request.status !== "pending") {
      continue;
    }
    const reconciled = await expireDeviceAccessRequestIfNeeded(deps, request);
    if (reconciled.status === "expired") {
      expired += 1;
    }
  }
  return expired;
}

// ---------------------------------------------------------------------------
// Device access runtime
// ---------------------------------------------------------------------------

export const DEVICE_ACCESS_PENDING_REQUEST_LIMIT = 25;

class DeviceAccessRequestCapacityError extends Error {
  public readonly statusCode = 429;

  public constructor() {
    super("Too many device access requests are already pending. Wait for an existing request to expire.");
    this.name = "DeviceAccessRequestCapacityError";
  }
}

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
  const { createdAt, expiresAt } = await deps.gatewaySql.createDatabaseTtlWindow(DEVICE_ACCESS_REQUEST_TTL_MS);

  const approval = await deps.createApproval(
    {
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
    },
    async (createdApproval) => {
      await assertDeviceAccessRequestCapacity(deps, createdAt);
      await (
        await deps.gatewaySql.prepare(
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
      ).run({
        requestId,
        approvalId: createdApproval.approvalId,
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
      return [
        {
          operationId: `auth.device_request.create.audit:${requestId}`,
          delivery: {
            kind: "audit",
            stream: "approvals",
            payload: {
              event: "auth.device_request.create",
              requestId,
              approvalId: createdApproval.approvalId,
              deviceLabel,
              deviceType,
              platform,
              requestedOrigin,
              requestedIp,
              correlationId,
              traceId,
              originSurface,
            },
          },
        },
        {
          operationId: `auth.device_request.create.realtime:${requestId}`,
          delivery: {
            kind: "realtime",
            eventType: "auth_device_request_created",
            source: "auth",
            payload: {
              requestId,
              approvalId: createdApproval.approvalId,
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
            options: {
              eventClass: "domain_fact",
              eventAuthority: "retained_stream",
              links: {
                approvalId: createdApproval.approvalId,
              },
              correlationId: createdApproval.approvalId,
            },
          },
        },
      ] satisfies readonly ApprovalObservabilityEffectInput[];
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

async function assertDeviceAccessRequestCapacity(
  deps: SettingsAuthRuntimeDependencies,
  databaseNow: string,
): Promise<void> {
  if (deps.gatewaySql.dialect === "postgres") {
    // SQLite's BEGIN IMMEDIATE already serializes writers. PostgreSQL needs an
    // explicit table lock so concurrent nodes cannot both observe spare room.
    await (await deps.gatewaySql.prepare("LOCK TABLE auth_device_requests IN SHARE ROW EXCLUSIVE MODE")).run();
  }
  const activeExpirySql =
    deps.gatewaySql.dialect === "postgres"
      ? "gc_try_parse_timestamptz(expires_at) > gc_try_parse_timestamptz(@databaseNow)"
      : "julianday(expires_at) > julianday(@databaseNow)";
  const row = await (
    await deps.gatewaySql.prepare(
      `SELECT COUNT(*) AS count
       FROM auth_device_requests
       WHERE status = 'pending' AND ${activeExpirySql}`,
    )
  ).get<{ count: number | string }>({ databaseNow });
  if (Number(row?.count ?? 0) >= DEVICE_ACCESS_PENDING_REQUEST_LIMIT) {
    throw new DeviceAccessRequestCapacityError();
  }
}

export async function getDeviceAccessRequestStatus(
  deps: SettingsAuthRuntimeDependencies,
  requestId: string,
  requestSecret: string,
): Promise<DeviceAccessRequestStatusResponse> {
  const request = await getAuthDeviceRequestById(deps, requestId);
  if (!request) {
    throw new Error("Device access request not found.");
  }
  if (!requestSecret.trim() || !timingSafeStringEqual(hashSensitiveToken(requestSecret), request.requestSecretHash)) {
    throw new Error("Device access request not found.");
  }

  const current = await expireDeviceAccessRequestIfNeeded(deps, request);
  if (current.status === "approved" && !current.deliveredAt) {
    // A process that does not hold the plaintext must never burn the durable
    // handoff marker. This preserves delivery by the approving node in a
    // shared PostgreSQL deployment and after cross-node status polling.
    const databaseNowMs = await readDatabaseNowMs(deps);
    const claimed = deps.deviceTokenVault.claim(current.requestId, databaseNowMs);
    if (!claimed) {
      return mapDeviceAccessStatusResponse(current);
    }
    const deliveredAt = new Date(databaseNowMs).toISOString();
    const clock = getAuthDatabaseClockSql(deps);
    let result: { changes?: number };
    try {
      result = await (
        await deps.gatewaySql.prepare(
          `
      UPDATE auth_device_requests
      SET delivered_at = @deliveredAt,
          approved_token_plaintext = NULL
      WHERE request_id = @requestId
        AND status = 'approved'
        AND delivered_at IS NULL
        AND approved_token_expires_at IS NOT NULL
        AND ${clock.isFuture("approved_token_expires_at")}
    `,
        )
      ).run({
        requestId: current.requestId,
        deliveredAt,
      });
    } catch (error) {
      try {
        deps.deviceTokenVault.store(
          current.requestId,
          claimed.token,
          claimed.deviceTokenExpiresAt,
          await readDatabaseNowMs(deps),
        );
      } catch {
        // Preserve the storage failure. If DB time is unavailable, retaining an
        // operator-equivalent plaintext token would be a fail-open fallback.
      }
      throw error;
    }
    if (result.changes !== 1) {
      // A concurrent poll already won the single-use delivery. This caller must
      // not receive the token. The winning delivery already consumed the
      // durable marker, so the local claim must remain burned.
      const refreshed = await getAuthDeviceRequestById(deps, requestId);
      if (refreshed) {
        return mapDeviceAccessStatusResponse(refreshed);
      }
      return mapDeviceAccessStatusResponse(current);
    }
    return mapDeviceAccessStatusResponse(current, {
      deviceToken: claimed.token,
      deviceTokenExpiresAt: claimed.deviceTokenExpiresAt,
    });
  }

  return mapDeviceAccessStatusResponse(current);
}

export async function getAuthDeviceRequestById(
  deps: SettingsAuthRuntimeDependencies,
  requestId: string,
): Promise<AuthDeviceRequestRecord | undefined> {
  const row = (await (
    await deps.gatewaySql.prepare(
      `
      SELECT *
      FROM auth_device_requests
      WHERE request_id = @requestId
      LIMIT 1
    `,
    )
  ).get({ requestId })) as Record<string, unknown> | undefined;
  return row ? mapAuthDeviceRequestRow(row) : undefined;
}

async function getAuthDeviceRequestByApprovalId(
  deps: SettingsAuthRuntimeDependencies,
  approvalId: string,
): Promise<AuthDeviceRequestRecord | undefined> {
  const row = (await (
    await deps.gatewaySql.prepare(
      `
      SELECT *
      FROM auth_device_requests
      WHERE approval_id = @approvalId
      LIMIT 1
    `,
    )
  ).get({ approvalId })) as Record<string, unknown> | undefined;
  return row ? mapAuthDeviceRequestRow(row) : undefined;
}

export async function listDeviceAccessGrants(
  deps: SettingsAuthRuntimeDependencies,
): Promise<DeviceAccessGrantContractRecord[]> {
  const rows = (await (
    await deps.gatewaySql.prepare(
      `
    SELECT *
    FROM auth_device_grants
    ORDER BY
      CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END,
      COALESCE(last_used_at, created_at) DESC,
      created_at DESC
  `,
    )
  ).all()) as Record<string, unknown>[];
  return rows.map((row) => toDeviceAccessGrantRecord(mapAuthDeviceGrantRow(row)));
}

export async function revokeDeviceAccessGrant(
  deps: SettingsAuthRuntimeDependencies,
  grantId: string,
  revokedBy: string,
  options: { correlationId?: string } = {},
): Promise<DeviceAccessGrantContractRecord> {
  const normalizedGrantId = requireAuthRevokeIdentifier(grantId, "grantId");
  const normalizedRevokedBy = requireAuthRevokeIdentifier(revokedBy, "revokedBy");
  let result!: DeviceAccessGrantContractRecord;
  await deps.storage.runImmediateTransaction(async () => {
    const revokeIdentity = buildAuthControlRevokeIdentity("device_grant", normalizedGrantId, normalizedRevokedBy);
    await deps.storage.sessionControls.revokeByAuthBinding(revokeIdentity);
    const existingRow = (await (
      await deps.gatewaySql.prepare(
        `SELECT * FROM auth_device_grants
         WHERE grant_id = @grantId
         LIMIT 1${deps.gatewaySql.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
    ).get({ grantId: normalizedGrantId })) as Record<string, unknown> | undefined;
    if (!existingRow) throw new NotFoundError("Device access grant not found.");
    const revokedAt = await deps.gatewaySql.readDatabaseNow();
    await (
      await deps.gatewaySql.prepare(
        `UPDATE auth_device_grants
         SET revoked_at = COALESCE(revoked_at, @revokedAt)
         WHERE grant_id = @grantId`,
      )
    ).run({ grantId: normalizedGrantId, revokedAt });
    await (
      await deps.gatewaySql.prepare(
        `UPDATE companion_sessions
         SET revoked_at = COALESCE(revoked_at, @revokedAt)
         WHERE grant_id = @grantId`,
      )
    ).run({ grantId: normalizedGrantId, revokedAt });
    const updatedRow = (await (
      await deps.gatewaySql.prepare("SELECT * FROM auth_device_grants WHERE grant_id = @grantId LIMIT 1")
    ).get({ grantId: normalizedGrantId })) as Record<string, unknown> | undefined;
    result = toDeviceAccessGrantRecord(mapAuthDeviceGrantRow(updatedRow ?? existingRow));
  });

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

  await deps.publishRealtime(
    "auth_device_grant_revoked",
    "auth",
    {
      grantId: result.grantId,
      requestId: result.requestId,
      actorId: result.actorId,
      deviceLabel: result.deviceLabel,
      deviceType: result.deviceType,
      platform: result.platform,
      revokedAt: result.revokedAt,
      revokedBy,
    },
    options.correlationId ? { correlationId: options.correlationId } : undefined,
  );

  return result;
}

export async function getActiveAuthDeviceGrantById(
  deps: SettingsAuthRuntimeDependencies,
  grantId: string,
): Promise<AuthDeviceGrantRecord | undefined> {
  const clock = getAuthDatabaseClockSql(deps);
  const row = (await (
    await deps.gatewaySql.prepare(
      `
      SELECT *
      FROM auth_device_grants
      WHERE grant_id = @grantId
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
      LIMIT 1
    `,
    )
  ).get({ grantId })) as Record<string, unknown> | undefined;
  if (!row) {
    return undefined;
  }
  const grant = mapAuthDeviceGrantRow(row);
  if (grant.revokedAt !== undefined) {
    return undefined;
  }
  if (grant.expiresAt !== undefined) {
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return undefined;
    }
  }
  return grant;
}

export async function validateDeviceAccessToken(
  deps: SettingsAuthRuntimeDependencies,
  token: string,
): Promise<
  { actorId: string; deviceId: string; grantId: string; principalPurpose: CompanionPrincipalPurpose } | undefined
> {
  const tokenHash = hashSensitiveToken(token);
  const clock = getAuthDatabaseClockSql(deps);
  let grant: AuthDeviceGrantRecord | undefined;
  await deps.storage.runImmediateTransaction(async () => {
    const row = (await (
      await deps.gatewaySql.prepare(
        `
          SELECT *
          FROM auth_device_grants
          WHERE token_hash = @tokenHash
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
          LIMIT 1${clock.lockRow}
        `,
      )
    ).get({ tokenHash })) as Record<string, unknown> | undefined;
    if (!row) {
      return;
    }
    const activeGrant = mapAuthDeviceGrantRow(row);
    await (
      await deps.gatewaySql.prepare(
        `
          UPDATE auth_device_grants
          SET last_used_at = ${clock.nowText}
          WHERE grant_id = @grantId
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
        `,
      )
    ).run({ grantId: activeGrant.grantId });
    const finalGrant = await (
      await deps.gatewaySql.prepare(
        `
          SELECT grant_id
          FROM auth_device_grants
          WHERE grant_id = @grantId
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
          LIMIT 1
        `,
      )
    ).get({ grantId: activeGrant.grantId });
    if (finalGrant) {
      grant = activeGrant;
    }
  });

  if (!grant) {
    return undefined;
  }

  return {
    actorId: `device:${grant.grantId}`,
    deviceId: grant.grantId,
    grantId: grant.grantId,
    principalPurpose: grant.principalPurpose,
  };
}

export async function exchangeCompanionSessionFromDeviceGrant(
  deps: SettingsAuthRuntimeDependencies,
  grantId: string,
  input: CompanionSessionExchangeInput,
): Promise<CompanionSessionExchangeResponse> {
  const normalizedGrantId = requireAuthRevokeIdentifier(grantId, "grantId");
  const signingPublicKeyPem = normalizeCompanionSigningPublicKeyPem(input.signingPublicKeyPem);
  assertCompanionSigningPublicKeyPem(signingPublicKeyPem);

  const accessToken = `gcca_${randomBytes(COMPANION_ACCESS_TOKEN_BYTES).toString("base64url")}`;
  const refreshToken = `gccr_${randomBytes(COMPANION_REFRESH_TOKEN_BYTES).toString("base64url")}`;
  const sessionId = randomUUID();
  const clock = getAuthDatabaseClockSql(deps);
  let grant!: AuthDeviceGrantRecord;
  let issuedAt = "";
  let accessTokenExpiresAt = "";
  let refreshTokenExpiresAt = "";
  let metadata: Record<string, unknown> = {};

  await deps.storage.runImmediateTransaction(async () => {
    const replacementActorId = `companion:${sessionId}`;
    await deps.storage.sessionControls.revokeByAuthBinding(
      buildAuthControlRevokeIdentity("device_grant", normalizedGrantId, replacementActorId),
    );
    const grantRow = (await (
      await deps.gatewaySql.prepare(
        `
          SELECT *
          FROM auth_device_grants
          WHERE grant_id = @grantId
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
          LIMIT 1${clock.lockRow}
        `,
      )
    ).get({ grantId: normalizedGrantId })) as Record<string, unknown> | undefined;
    if (!grantRow) {
      throw new NotFoundError("Device access grant not found.");
    }
    grant = mapAuthDeviceGrantRow(grantRow);
    // The purpose is carried immutably from the device grant (a storage trigger
    // asserts grant.purpose === request.purpose); the exchange can never widen it.
    const principalPurpose = grant.principalPurpose;
    ({ issuedAt, accessTokenExpiresAt, refreshTokenExpiresAt } = await createCompanionCredentialWindow(deps));
    metadata = {
      ...grant.metadata,
      clientName: normalizeOptionalDeviceAccessText(input.clientName, 120),
      appVersion: normalizeOptionalDeviceAccessText(input.appVersion, 80),
      bootstrapRepo: "GoatCitadel-mobile",
      contractId: COMPANION_CONTRACT_ID,
    };

    await (
      await deps.gatewaySql.prepare(
        `
      UPDATE companion_sessions
      SET revoked_at = COALESCE(revoked_at, @revokedAt)
      WHERE grant_id = @grantId
        AND revoked_at IS NULL
    `,
      )
    ).run({
      grantId: normalizedGrantId,
      revokedAt: issuedAt,
    });

    await (
      await deps.gatewaySql.prepare(
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
        metadata_json,
        principal_purpose
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
        @metadataJson,
        @principalPurpose
      )
    `,
      )
    ).run({
      sessionId,
      grantId: normalizedGrantId,
      accessTokenHash: hashSensitiveToken(accessToken),
      accessTokenExpiresAt,
      refreshTokenHash: hashSensitiveToken(refreshToken),
      refreshTokenExpiresAt,
      signingPublicKeyPem,
      signatureAlgorithm: COMPANION_SIGNATURE_ALGORITHM,
      createdAt: issuedAt,
      lastRotatedAt: issuedAt,
      metadataJson: JSON.stringify(metadata),
      principalPurpose,
    });

    const finalGrant = await (
      await deps.gatewaySql.prepare(
        `
          SELECT grant_id
          FROM auth_device_grants
          WHERE grant_id = @grantId
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
          LIMIT 1
        `,
      )
    ).get({ grantId });
    if (!finalGrant) {
      throw new ConflictError({
        message: "Device access grant expired before the companion session was committed.",
      });
    }
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
    principalPurpose: grant.principalPurpose,
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

  const nextAccessToken = `gcca_${randomBytes(COMPANION_ACCESS_TOKEN_BYTES).toString("base64url")}`;
  const nextRefreshToken = `gccr_${randomBytes(COMPANION_REFRESH_TOKEN_BYTES).toString("base64url")}`;
  const currentRefreshTokenHash = hashSensitiveToken(refreshToken);
  const clock = getAuthDatabaseClockSql(deps);
  const candidate = await (
    await deps.gatewaySql.prepare(
      `
        SELECT session_id, grant_id
        FROM companion_sessions
        WHERE refresh_token_hash = @refreshTokenHash
        LIMIT 1
      `,
    )
  ).get<{ session_id?: unknown; grant_id?: unknown }>({ refreshTokenHash: currentRefreshTokenHash });
  if (typeof candidate?.session_id !== "string" || typeof candidate.grant_id !== "string") {
    throw new NotFoundError("Companion session not found.");
  }
  let session!: CompanionSessionRecord;
  let issuedAt = "";
  let accessTokenExpiresAt = "";
  let refreshTokenExpiresAt = "";

  await deps.storage.runImmediateTransaction(async () => {
    const grantRow = (await (
      await deps.gatewaySql.prepare(
        `
          SELECT *
          FROM auth_device_grants
          WHERE grant_id = @grantId
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
          LIMIT 1${clock.lockRow}
        `,
      )
    ).get({ grantId: candidate.grant_id })) as Record<string, unknown> | undefined;
    if (!grantRow) {
      throw new NotFoundError("Companion session not found.");
    }
    const sessionRow = (await (
      await deps.gatewaySql.prepare(
        `
          SELECT *
          FROM companion_sessions
          WHERE session_id = @sessionId
            AND grant_id = @grantId
            AND refresh_token_hash = @refreshTokenHash
            AND revoked_at IS NULL
            AND ${clock.isFuture("refresh_token_expires_at")}
          LIMIT 1${clock.lockRow}
        `,
      )
    ).get({
      sessionId: candidate.session_id,
      grantId: candidate.grant_id,
      refreshTokenHash: currentRefreshTokenHash,
    })) as Record<string, unknown> | undefined;
    if (!sessionRow) {
      throw new NotFoundError("Companion session not found.");
    }
    session = mapCompanionSessionRow({
      ...sessionRow,
      device_label: grantRow.device_label,
      device_type: grantRow.device_type,
      platform: grantRow.platform,
      grant_expires_at: grantRow.expires_at,
      grant_revoked_at: grantRow.revoked_at,
    });
    ({ issuedAt, accessTokenExpiresAt, refreshTokenExpiresAt } = await createCompanionCredentialWindow(deps));

    const result = await (
      await deps.gatewaySql.prepare(
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
            AND ${clock.isFuture("refresh_token_expires_at")}
            AND EXISTS (
              SELECT 1
              FROM auth_device_grants g
              WHERE g.grant_id = companion_sessions.grant_id
                AND g.revoked_at IS NULL
                AND (g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})
            )
        `,
      )
    ).run({
      sessionId: session.sessionId,
      currentRefreshTokenHash,
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

    const finalSession = await (
      await deps.gatewaySql.prepare(
        `
          SELECT s.session_id
          FROM companion_sessions s
          INNER JOIN auth_device_grants g
            ON g.grant_id = s.grant_id
          WHERE s.session_id = @sessionId
            AND s.refresh_token_hash = @refreshTokenHash
            AND s.revoked_at IS NULL
            AND ${clock.isFuture("s.refresh_token_expires_at")}
            AND g.revoked_at IS NULL
            AND (g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})
          LIMIT 1
        `,
      )
    ).get({ sessionId: session.sessionId, refreshTokenHash: hashSensitiveToken(nextRefreshToken) });
    if (!finalSession) {
      throw new ConflictError({
        message: "Companion session expired before refresh was committed.",
      });
    }
  });

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
    principalPurpose: session.principalPurpose,
  };
}

export async function getActiveCompanionSessionById(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
): Promise<CompanionSessionRecord | undefined> {
  const clock = getAuthDatabaseClockSql(deps);
  const row = (await (
    await deps.gatewaySql.prepare(
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
          AND s.revoked_at IS NULL
          AND ${clock.isFuture("s.access_token_expires_at")}
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})
        LIMIT 1
      `,
    )
  ).get({ sessionId })) as Record<string, unknown> | undefined;
  if (row) {
    return mapCompanionSessionRow(row);
  }

  await (
    await deps.gatewaySql.prepare(
      `
        UPDATE companion_sessions
        SET revoked_at = COALESCE(revoked_at, ${clock.nowText})
        WHERE session_id = @sessionId
          AND revoked_at IS NULL
          AND (
            ${clock.isExpiredOrInvalid("access_token_expires_at")}
            OR EXISTS (
              SELECT 1
              FROM auth_device_grants g
              WHERE g.grant_id = companion_sessions.grant_id
                AND (
                  g.revoked_at IS NOT NULL
                  OR (g.expires_at IS NOT NULL AND ${clock.isExpiredOrInvalid("g.expires_at")})
                )
            )
          )
      `,
    )
  ).run({ sessionId });
  return undefined;
}

export async function getCompanionSessionById(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
  forUpdate = false,
): Promise<CompanionSessionRecord | undefined> {
  const row = (await (
    await deps.gatewaySql.prepare(
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
      LIMIT 1${forUpdate && deps.gatewaySql.dialect === "postgres" ? " FOR UPDATE OF s" : ""}
    `,
    )
  ).get({
    sessionId,
  })) as Record<string, unknown> | undefined;
  if (!row) {
    return undefined;
  }
  return mapCompanionSessionRow(row);
}

export async function getActiveCompanionSessionByRefreshToken(
  deps: SettingsAuthRuntimeDependencies,
  refreshToken: string,
): Promise<CompanionSessionRecord | undefined> {
  const clock = getAuthDatabaseClockSql(deps);
  const refreshTokenHash = hashSensitiveToken(refreshToken);
  const row = (await (
    await deps.gatewaySql.prepare(
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
        AND s.revoked_at IS NULL
        AND ${clock.isFuture("s.refresh_token_expires_at")}
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})
      LIMIT 1
    `,
    )
  ).get({
    refreshTokenHash,
  })) as Record<string, unknown> | undefined;
  if (row) {
    return mapCompanionSessionRow(row);
  }

  await (
    await deps.gatewaySql.prepare(
      `
        UPDATE companion_sessions
        SET revoked_at = COALESCE(revoked_at, ${clock.nowText})
        WHERE refresh_token_hash = @refreshTokenHash
          AND revoked_at IS NULL
          AND ${clock.isExpiredOrInvalid("refresh_token_expires_at")}
      `,
    )
  ).run({ refreshTokenHash });
  return undefined;
}

export async function getCompanionSessionInfo(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
): Promise<CompanionSessionInfoResponse> {
  const session = await getActiveCompanionSessionById(deps, sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }
  return toCompanionSessionInfoResponse(session);
}

export async function listCompanionSessions(
  deps: SettingsAuthRuntimeDependencies,
  options?: {
    view?: "active" | "all";
    grantId?: string;
    limit?: number;
  },
): Promise<CompanionSessionListResponse> {
  const view = options?.view === "all" ? "all" : "active";
  const limit = clampInt(options?.limit, 50, 1, 200);
  const grantId = options?.grantId?.trim();
  const clock = getAuthDatabaseClockSql(deps);
  const filters = [
    ...(grantId ? ["s.grant_id = @grantId"] : []),
    ...(view === "active"
      ? [
          "s.revoked_at IS NULL",
          clock.isFuture("s.refresh_token_expires_at"),
          "g.revoked_at IS NULL",
          `(g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})`,
        ]
      : []),
  ];
  const query = `
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
    ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY s.created_at DESC, s.session_id DESC
    LIMIT @limit
  `;
  const rows = (await (
    await deps.gatewaySql.prepare(
      `
    ${query}
  `,
    )
  ).all(grantId ? { grantId, limit } : { limit })) as Record<string, unknown>[];

  return {
    items: rows.map(mapCompanionSessionRow).map(toCompanionSessionAdminRecord),
  };
}

export async function getCompanionSessionRecord(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
): Promise<CompanionSessionAdminRecord> {
  const session = await getCompanionSessionById(deps, sessionId);
  if (!session) {
    throw new NotFoundError("Companion session not found.");
  }
  return toCompanionSessionAdminRecord(session);
}

export async function revokeCompanionSession(
  deps: SettingsAuthRuntimeDependencies,
  sessionId: string,
  revokedBy: string,
  options: { correlationId?: string } = {},
): Promise<CompanionSessionRevokeResponse> {
  const normalizedSessionId = requireAuthRevokeIdentifier(sessionId, "sessionId");
  const normalizedRevokedBy = requireAuthRevokeIdentifier(revokedBy, "revokedBy");
  let updated!: CompanionSessionRecord;
  await deps.storage.runImmediateTransaction(async () => {
    const revokeIdentity = buildAuthControlRevokeIdentity(
      "companion_session",
      normalizedSessionId,
      normalizedRevokedBy,
    );
    await deps.storage.sessionControls.revokeByAuthBinding(revokeIdentity);
    const session = await getCompanionSessionById(deps, normalizedSessionId, true);
    if (!session) throw new NotFoundError("Companion session not found.");
    const revokedAt = await deps.gatewaySql.readDatabaseNow();
    await (
      await deps.gatewaySql.prepare(
        `UPDATE companion_sessions
         SET revoked_at = COALESCE(revoked_at, @revokedAt)
         WHERE session_id = @sessionId`,
      )
    ).run({ sessionId: normalizedSessionId, revokedAt });
    updated = (await getCompanionSessionById(deps, normalizedSessionId)) ?? { ...session, revokedAt };
  });
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

  await deps.publishRealtime(
    "auth_companion_session_revoked",
    "auth",
    {
      sessionId: record.sessionId,
      grantId: record.grantId,
      actorId: record.actorId,
      deviceLabel: record.deviceLabel,
      deviceType: record.deviceType,
      platform: record.platform,
      revokedAt: record.revokedAt,
      revokedBy,
    },
    options.correlationId ? { correlationId: options.correlationId } : undefined,
  );

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

  await deps.publishRealtime(
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
  recordApprovalResolutionSignals(deps, approval);
}

export function recordApprovalResolutionSignals(
  deps: Pick<
    SettingsAuthRuntimeDependencies,
    "recordImprovementApprovalResolutionSignal" | "handleActivationApprovalResolution"
  >,
  approval: ApprovalRequest,
): void {
  deps.recordImprovementApprovalResolutionSignal(approval);
  deps.handleActivationApprovalResolution(approval);
}

export async function validateCompanionAccessToken(
  deps: SettingsAuthRuntimeDependencies,
  token: string,
): Promise<CompanionAccessValidationResult | undefined> {
  const tokenHash = hashSensitiveToken(token);
  const clock = getAuthDatabaseClockSql(deps);
  const candidate = await (
    await deps.gatewaySql.prepare(
      `
        SELECT session_id, grant_id
        FROM companion_sessions
        WHERE access_token_hash = @tokenHash
        LIMIT 1
      `,
    )
  ).get<{ session_id?: unknown; grant_id?: unknown }>({ tokenHash });
  if (typeof candidate?.session_id !== "string" || typeof candidate.grant_id !== "string") {
    return undefined;
  }
  let session: CompanionSessionRecord | undefined;

  await deps.storage.runImmediateTransaction(async () => {
    const grantRow = (await (
      await deps.gatewaySql.prepare(
        `
          SELECT *
          FROM auth_device_grants
          WHERE grant_id = @grantId
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR ${clock.isFuture("expires_at")})
          LIMIT 1${clock.lockRow}
        `,
      )
    ).get({ grantId: candidate.grant_id })) as Record<string, unknown> | undefined;
    if (!grantRow) {
      return;
    }
    const sessionRow = (await (
      await deps.gatewaySql.prepare(
        `
          SELECT *
          FROM companion_sessions
          WHERE session_id = @sessionId
            AND grant_id = @grantId
            AND access_token_hash = @tokenHash
            AND revoked_at IS NULL
            AND ${clock.isFuture("access_token_expires_at")}
          LIMIT 1${clock.lockRow}
        `,
      )
    ).get({ sessionId: candidate.session_id, grantId: candidate.grant_id, tokenHash })) as
      | Record<string, unknown>
      | undefined;
    if (!sessionRow) {
      return;
    }
    session = mapCompanionSessionRow({
      ...sessionRow,
      device_label: grantRow.device_label,
      device_type: grantRow.device_type,
      platform: grantRow.platform,
      grant_expires_at: grantRow.expires_at,
      grant_revoked_at: grantRow.revoked_at,
    });

    await (
      await deps.gatewaySql.prepare(
        `
          UPDATE companion_sessions
          SET last_seen_at = ${clock.nowText}
          WHERE session_id = @sessionId
        `,
      )
    ).run({ sessionId: session.sessionId });
    await (
      await deps.gatewaySql.prepare(
        `
          UPDATE auth_device_grants
          SET last_used_at = ${clock.nowText}
          WHERE grant_id = @grantId
        `,
      )
    ).run({ grantId: session.grantId });

    const finalSession = await (
      await deps.gatewaySql.prepare(
        `
          SELECT s.session_id
          FROM companion_sessions s
          INNER JOIN auth_device_grants g
            ON g.grant_id = s.grant_id
          WHERE s.session_id = @sessionId
            AND s.access_token_hash = @tokenHash
            AND s.revoked_at IS NULL
            AND ${clock.isFuture("s.access_token_expires_at")}
            AND g.revoked_at IS NULL
            AND (g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})
          LIMIT 1
        `,
      )
    ).get({ sessionId: session.sessionId, tokenHash });
    if (!finalSession) {
      session = undefined;
    }
  });

  if (!session) {
    return undefined;
  }

  return {
    actorId: `companion:${session.sessionId}`,
    deviceId: session.grantId,
    grantId: session.grantId,
    sessionId: session.sessionId,
    principalPurpose: session.principalPurpose,
  };
}

export async function verifyCompanionRequestSignature(
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
): Promise<void> {
  const session = await getActiveCompanionSessionById(deps, input.sessionId);
  if (!session) {
    return await rejectInactiveCompanionRequest(deps, input);
  }

  if (!(await deps.gatewaySql.isDatabaseInstantWithinSkew(input.timestamp, COMPANION_REQUEST_CLOCK_SKEW_MS))) {
    await rejectStaleCompanionRequest(deps, session, input);
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
  const requestHash = buildCompanionDurableRequestHash({
    method,
    path,
    timestamp: input.timestamp,
    nonce,
    body: input.body,
    signingPayload: payload,
  });
  const signatureBuffer = decodeBase64Url(signature);
  const publicKey = createPublicKey(session.signingPublicKeyPem);
  if (!verify(null, Buffer.from(payload, "utf8"), publicKey, signatureBuffer)) {
    void (await deps.storage.audit.append("approvals", {
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
    }));
    throw new Error("Invalid companion request signature.");
  }

  const clock = getAuthDatabaseClockSql(deps);
  try {
    await deps.storage.runImmediateTransaction(async () => {
      await (
        await deps.gatewaySql.prepare(
          `
            DELETE FROM companion_request_replays
            WHERE ${clock.isValidAndExpired("expires_at")}
          `,
        )
      ).run();

      if (!(await deps.gatewaySql.isDatabaseInstantWithinSkew(input.timestamp, COMPANION_REQUEST_CLOCK_SKEW_MS))) {
        throw new CompanionRequestTimestampBoundaryError();
      }
      const { createdAt, expiresAt } = await deps.gatewaySql.createDatabaseTtlWindow(COMPANION_REQUEST_REPLAY_TTL_MS);
      const inserted = await (
        await deps.gatewaySql.prepare(
          `
            INSERT INTO companion_request_replays (
              session_id,
              nonce,
              method,
              path,
              request_hash,
              created_at,
              expires_at
            )
            SELECT
              @sessionId,
              @nonce,
              @method,
              @path,
              @requestHash,
              @createdAt,
              @expiresAt
            WHERE EXISTS (
              SELECT 1
              FROM companion_sessions s
              INNER JOIN auth_device_grants g
                ON g.grant_id = s.grant_id
              WHERE s.session_id = @sessionId
                AND s.revoked_at IS NULL
                AND ${clock.isFuture("s.access_token_expires_at")}
                AND g.revoked_at IS NULL
                AND (g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})
            )
          `,
        )
      ).run({
        sessionId: session.sessionId,
        nonce,
        method,
        path,
        requestHash,
        createdAt,
        expiresAt,
      });
      if (inserted.changes !== 1) {
        throw new CompanionRequestSessionBoundaryError();
      }

      // The INSERT can wait on a competing nonce. Re-prove all authority at
      // the actual acceptance boundary before committing the tombstone.
      if (
        !(await deps.gatewaySql.isDatabaseInstantWithinSkew(input.timestamp, COMPANION_REQUEST_CLOCK_SKEW_MS)) ||
        !(await deps.gatewaySql.isDatabaseInstantFuture(expiresAt))
      ) {
        throw new CompanionRequestTimestampBoundaryError();
      }
      const finalSession = await (
        await deps.gatewaySql.prepare(
          `
            SELECT s.session_id
            FROM companion_sessions s
            INNER JOIN auth_device_grants g
              ON g.grant_id = s.grant_id
            WHERE s.session_id = @sessionId
              AND s.revoked_at IS NULL
              AND ${clock.isFuture("s.access_token_expires_at")}
              AND g.revoked_at IS NULL
              AND (g.expires_at IS NULL OR ${clock.isFuture("g.expires_at")})
            LIMIT 1
          `,
        )
      ).get({ sessionId: session.sessionId });
      if (!finalSession) {
        throw new CompanionRequestSessionBoundaryError();
      }
    });
  } catch (error) {
    if (error instanceof CompanionRequestTimestampBoundaryError) {
      return await rejectStaleCompanionRequest(deps, session, input);
    }
    if (error instanceof CompanionRequestSessionBoundaryError) {
      return await rejectInactiveCompanionRequest(deps, input, session);
    }
    void (await deps.storage.audit.append("approvals", {
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
    }));
    throw new Error("Companion request replay detected.", { cause: error });
  }

  void (await deps.storage.audit.append("approvals", {
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
  }));
}

class CompanionRequestTimestampBoundaryError extends Error {}

class CompanionRequestSessionBoundaryError extends Error {}

/**
 * The Ed25519 signature always covers the complete canonical request body, but
 * the replay tombstone and audit stream retain this digest. A push token (or an
 * unknown field rejected later by the strict route schema) must therefore not
 * influence that durable digest. Replay authority is the session-scoped nonce
 * primary key; the redacted hash is only an inspectable correlation value.
 */
function buildCompanionDurableRequestHash(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
  signingPayload: string;
}): string {
  if (input.method === "PUT" && input.path === MOBILE_PUSH_REGISTRATION_PATH) {
    const body = isRecord(input.body) ? input.body : {};
    const provider = body.provider === "expo" || body.provider === "fcm" ? body.provider : null;
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    return createHash("sha256")
      .update(
        JSON.stringify({
          kind: "companion_mobile_push_request_redacted_v1",
          method: input.method,
          path: input.path,
          timestamp: input.timestamp.trim(),
          nonce: input.nonce,
          provider,
          enabled,
        }),
        "utf8",
      )
      .digest("hex");
  }
  return createHash("sha256").update(input.signingPayload, "utf8").digest("hex");
}

function requireAuthRevokeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ValidationError({ code: "FIELD_REQUIRED", field });
  if (normalized.length > 256) throw new ValidationError({ field });
  return normalized;
}

function buildAuthControlRevokeIdentity(
  bindingKind: "companion_session" | "device_grant",
  bindingId: string,
  actorId: string,
) {
  const materialSha256 = createHash("sha256")
    .update(JSON.stringify({ version: 1, bindingKind, bindingId, actorId }), "utf8")
    .digest("hex");
  return {
    bindingKind,
    bindingId,
    actorId,
    idempotencyKey: `auth-control-revoke:v1:${materialSha256}`,
    correlationId: `auth-revoke:${materialSha256}`,
  } as const;
}

async function rejectStaleCompanionRequest(
  deps: SettingsAuthRuntimeDependencies,
  session: CompanionSessionRecord,
  input: {
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
  },
): Promise<never> {
  void (await deps.storage.audit.append("approvals", {
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
  }));
  throw new Error("Companion request timestamp is outside the accepted skew window.");
}

async function rejectInactiveCompanionRequest(
  deps: SettingsAuthRuntimeDependencies,
  input: { sessionId: string; method: string; path: string },
  session?: CompanionSessionRecord,
): Promise<never> {
  void (await deps.storage.audit.append("approvals", {
    event: "auth.companion_request.session_inactive",
    actorId: `companion:${session?.sessionId ?? input.sessionId}`,
    deviceId: session?.grantId,
    grantId: session?.grantId,
    companionSessionId: session?.sessionId ?? input.sessionId,
    contractId: session ? COMPANION_CONTRACT_ID : undefined,
    detail: "Companion session is no longer active.",
    method: input.method.toUpperCase(),
    path: input.path,
  }));
  throw new Error("Companion session is no longer active.");
}

function legacyProfileToApprovalMode(profile: string | undefined): ToolApprovalMode {
  return profile === "danger" ? "bypass" : "approve_risky";
}
