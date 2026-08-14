/* eslint-disable max-lines -- LLM transport and provider normalization are intentionally centralized until provider seams are split further. */
import { createHash, randomUUID } from "node:crypto";
import { lookup as nodeDnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import {
  logger,
  ModelUsageAccountingService,
  ModelUsageDispatchUncertainError,
  ModelUsageSettlementError,
  type ModelUsageAttemptHandle,
} from "@goatcitadel/gateway-core";
import { assertExistingPathRealpathAllowed, assertHostAllowed } from "@goatcitadel/policy-engine";
import {
  BoundedResponseReadError,
  type BoundedResponseReadErrorCode,
  readBoundedResponseText,
} from "./bounded-response-reader.js";
import { parseProviderJsonResponse } from "./llm-response-parsing.js";
import { extractProviderOwnedOutputCapErrorText, resolveOutputCapRecovery } from "./llm-output-cap-recovery.js";
import { Agent, ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import type {
  ChatCompletionRequest,
  ChatCompletionReasoningReceipt,
  ChatCompletionResponse,
  ChatThinkingLevel,
  ChatProviderFailureRecord,
  ImageAssetInput,
  ImageGenerationRequest,
  ImageGenerationResponse,
  LlmProviderRequestAuthConfig,
  LlmProviderRequestConfig,
  LlmProviderRequestProxyAuthConfig,
  LlmProviderRequestTlsConfig,
  LlmApiStyle,
  LlmConfigFile,
  LlmModelDiscoverySource,
  LlmModelMetadataManifest,
  LlmModelReasoningMetadata,
  LlmModelRecord,
  LlmModelPreviewRequest,
  LlmModelPreviewResponse,
  ModelUsageAttributionContext,
  LlmProviderConfig,
  LlmProviderCapabilities,
  ProviderModelCatalogSnapshot,
  LlmProviderSummary,
  LlmRuntimeConfig,
} from "@goatcitadel/contracts";
import {
  canonicalJsonString,
  ExternalServiceError,
  findProviderTemplate,
  inferProviderForModelId,
  providerAllowsForeignModelIds,
  providerRecognizesModelId,
  SECRET_REDACTION_MARKER,
} from "@goatcitadel/contracts";
import { clampSummaryReserveTokens, type ClampSummaryReserveResult } from "./chat-compaction.js";
import { sanitizeMessages, stripInternalToolEffectMetadataForProvider } from "./chat-message-sanitize.js";
import { loadLlmModelMetadataManifest, lookupExactModelMetadata, lookupModelMetadata } from "./llm-model-metadata.js";
import {
  GoogleCloudAuthService,
  type GoogleCloudCredentialSource,
  type GoogleCloudCredentialType,
} from "./google-cloud-auth-service.js";
import { resolveLlmReasoningProfile } from "./llm-reasoning-profile.js";
import { anthropicProviderAdapter } from "./llm-provider-anthropic.js";
import {
  createLlmProviderAdapterRegistry,
  type LlmProviderAdapterHost,
  type LlmProviderAdapterRegistry,
  type LlmProviderJsonRequestInput,
  type LlmProviderResolution,
  type LlmTrackedJsonDispatch,
} from "./llm-provider-adapter.js";
import {
  applyEstimatedCostToChatResponse,
  applyEstimatedCostToStreamChunk,
  observeProviderUsageWithTrustedEstimate,
  resolveModelPricingLineage,
} from "./llm-pricing.js";
import {
  OpenAICodexOAuthService,
  type OpenAICodexDevicePollResponse,
  type OpenAICodexDeviceStartResponse,
  type OpenAICodexOAuthStatus,
} from "./openai-codex-oauth-service.js";
import {
  isSecretStoreUnavailableLikeError,
  SecretStoreService,
  SecretStoreUnavailableError,
} from "./secret-store-service.js";

const log = logger.child("llm-service");
const MAX_PROVIDER_ERROR_BODY_BYTES = 64 * 1024;
const PROVIDER_ERROR_BODY_TIMEOUT_MS = 5000;
const MAX_PROVIDER_SSE_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_SSE_EVENTS = 2048;
// Responses Lite can emit thousands of bounded reasoning/control deltas before
// the first visible output chunk. Keep arbitrary provider streams on the tighter
// default while retaining byte, event, and request-time bounds for this route.
const MAX_OPENAI_CODEX_RESPONSES_LITE_SSE_EVENTS = 64 * 1024;

export interface LlmRuntimeUpdateInput {
  activeProviderId?: string;
  activeModel?: string;
  defaultThinkingLevel?: ChatThinkingLevel;
  utilityProviderId?: string;
  utilityModel?: string;
  upsertProvider?: {
    providerId: string;
    label?: string;
    baseUrl?: string;
    apiStyle?: LlmApiStyle;
    defaultModel?: string;
    authMode?: LlmProviderConfig["authMode"];
    apiKey?: string;
    apiKeyEnv?: string;
    request?: LlmProviderRequestConfig;
    headers?: Record<string, string>;
    googleCloud?: LlmProviderConfig["googleCloud"];
    capabilities?: LlmProviderConfig["capabilities"];
  };
}

type ResolvedProvider = LlmProviderResolution & {
  credentialType?: GoogleCloudCredentialType;
  credentialSource?: GoogleCloudCredentialSource;
};

interface ProviderRequestTarget {
  url: string;
  headers: Record<string, string>;
  dispatcher?: Dispatcher;
}

interface ModelDiscoveryResult {
  items: LlmModelRecord[];
  source: LlmModelDiscoverySource;
  warning?: string;
}

interface ModelDiscoveryCacheEntry {
  cachedAt: number;
  result: ModelDiscoveryResult;
  origin: "memory" | "disk";
}

interface ModelDiscoveryCacheKeys {
  exact: string;
  persisted: string;
}

interface PersistedModelCatalogFile {
  version: 1;
  snapshots: ProviderModelCatalogSnapshot[];
}

export interface LlmServiceOptions {
  networkAllowlist?: string[];
  enforceNetworkAllowlist?: boolean;
  tlsPathPolicy?: {
    writeJailRoots: string[];
    readOnlyRoots: string[];
  };
  secretStore?: SecretStoreService;
  openAICodexOAuthFetch?: typeof fetch;
  /**
   * Explicit path to the LLM model metadata manifest. Highest precedence.
   * Falls back to `GOATCITADEL_LLM_MODEL_METADATA_PATH` then a default path
   * colocated with `configFilePath` (or `config/llm-model-metadata.json`).
   */
  modelMetadataPath?: string;
  /**
   * Optional path of the provider config file. Used to derive the default
   * model metadata manifest path when `modelMetadataPath` is unset.
   */
  configFilePath?: string;
  /**
   * Optional secret-free model catalog cache path. When present, startup can
   * serve a stale local catalog immediately and refresh provider metadata
   * after readiness instead of blocking on remote model discovery.
   */
  modelCatalogCachePath?: string;
  /**
   * Optional DNS lookup override used by the provider request dispatcher's
   * DNS-rebinding-safe guard. Defaults to Node's `dns.lookup`. Injected in
   * tests to simulate a host that resolves to a private/metadata address at
   * fetch time; production leaves this unset.
   */
  dnsLookup?: ProviderDnsLookupFn;
  /**
   * Process-local authority for the canonical llama.cpp runtime. The Gateway
   * implementation binds the configured provider endpoint to the runtime
   * endpoint before acquiring; arbitrary provider URLs never reach the owner.
   */
  localServiceLeaseAcquirer?: LlmLocalServiceLeaseAcquirer;
  /** Canonical per-network-attempt accounting owner. */
  modelUsageAccounting?: ModelUsageAccountingService;
  /** Injected only for deterministic auth integration tests. */
  googleCloudAuthService?: GoogleCloudAuthService;
}

export interface LlmLocalServiceLease {
  release(): void | Promise<void>;
}

export interface LlmLocalServiceLeaseRequest {
  providerId: string;
  baseUrl: string;
  purpose: "chat_completion" | "model_discovery";
  signal?: AbortSignal;
}

export type LlmLocalServiceLeaseAcquirer = (
  request: LlmLocalServiceLeaseRequest,
) => Promise<LlmLocalServiceLease | undefined>;

export interface LlmProviderSecretStatusOptions {
  includeKeychain?: boolean;
  useCache?: boolean;
}

export interface LlmListProvidersOptions extends LlmProviderSecretStatusOptions {
  includeKeychainForProviderId?: string;
}

export interface LlmProviderSecretStatus {
  providerId: string;
  hasApiKey: boolean;
  apiKeySource: "inline" | "env" | "keychain" | "none";
  hasKeychainSecret: boolean;
  apiKeyRef?: string;
}

interface SecretStatusCacheEntry {
  status: LlmProviderSecretStatus;
  cachedAt: number;
}

function normalizeConfiguredActiveModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeConfiguredProviderId(providerId: string | undefined): string | undefined {
  const trimmed = providerId?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveProviderEnvironmentValue(
  configured: string | undefined,
  envName: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const direct = configured?.trim();
  if (direct) return direct;
  const key = envName?.trim();
  return key ? env[key]?.trim() || undefined : undefined;
}

const DISALLOWED_BASE_HOSTS = new Set(["0.0.0.0", "169.254.169.254", "metadata.google.internal", "100.100.100.200"]);
const SECRET_STATUS_CACHE_TTL_MS = 60_000;
type UndiciAgentConnectOptions = Exclude<
  NonNullable<NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"]>,
  (...args: unknown[]) => unknown
>;
type UndiciProxyTlsOptions = Extract<ConstructorParameters<typeof ProxyAgent>[0], object>["requestTls"];
type UndiciConnectOptions = UndiciAgentConnectOptions & UndiciProxyTlsOptions;
type FetchRequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

// Node-style `dns.lookup` callback signature (what undici's `connect.lookup`
// expects). Kept structurally identical to `node:dns`'s `lookup` so the real
// resolver drops straight in and tests can inject a rebinding resolver.
export type ProviderDnsLookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

export class LlmService {
  private static readonly MODEL_DISCOVERY_TTL_MS = 60_000;
  private readonly providers = new Map<string, LlmProviderConfig>();
  private readonly secretStore: SecretStoreService;
  private readonly openAICodexOAuth: OpenAICodexOAuthService;
  private readonly googleCloudAuth: GoogleCloudAuthService;
  private readonly secretStatusCache = new Map<string, SecretStatusCacheEntry>();
  private readonly modelDiscoveryCache = new Map<string, ModelDiscoveryCacheEntry>();
  // Per-process opaque tokens that key the in-memory model-discovery cache by credential WITHOUT
  // deriving anything from the API key. A fast unsalted digest of a credential is exactly what CodeQL
  // js/insufficient-password-hash flags, and a slow KDF would be wrong on this hot, in-memory path;
  // this token is random, stable per key for cache hits, reveals nothing about the key, and is cleared
  // with the cache on config change.
  private readonly modelDiscoveryAuthTokens = new Map<string, string>();
  private readonly modelDiscoveryInFlight = new Map<string, Promise<ModelDiscoveryResult>>();
  private readonly requestDispatcherCache = new Map<string, Dispatcher>();
  private readonly providerAdapters: LlmProviderAdapterRegistry = createLlmProviderAdapterRegistry([
    anthropicProviderAdapter,
  ]);
  private readonly providerAdapterHost: LlmProviderAdapterHost = {
    buildRequestTarget: (resolved, purpose, endpointUrl) => this.buildRequestTarget(resolved, purpose, endpointUrl),
    postJsonRequest: (input) => this.postTrackedJsonRequest(input),
    retryOutputCapFailure: (input) => this.retryTrackedOutputCapFailure(input),
  };
  private networkAllowlist: string[];
  private enforceNetworkAllowlist: boolean;
  private readonly tlsPathPolicy: LlmServiceOptions["tlsPathPolicy"];
  private readonly dnsLookup: ProviderDnsLookupFn;
  private activeProviderId: string;
  private activeModel: string;
  private defaultThinkingLevel: ChatThinkingLevel;
  private utilityProviderId: string;
  private utilityModel: string;
  private readonly modelMetadata: LlmModelMetadataManifest;
  private readonly modelCatalogCachePath: string | undefined;
  private readonly localServiceLeaseAcquirer: LlmLocalServiceLeaseAcquirer | undefined;
  private readonly modelUsageAccounting: ModelUsageAccountingService | undefined;

  public constructor(
    config: LlmConfigFile,
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: LlmServiceOptions = {},
  ) {
    this.secretStore = options.secretStore ?? new SecretStoreService();
    this.openAICodexOAuth = new OpenAICodexOAuthService(this.secretStore, options.openAICodexOAuthFetch ?? fetch);
    this.googleCloudAuth = options.googleCloudAuthService ?? new GoogleCloudAuthService({ env: this.env });
    this.networkAllowlist = [...(options.networkAllowlist ?? [])];
    this.enforceNetworkAllowlist = options.enforceNetworkAllowlist ?? true;
    this.tlsPathPolicy = options.tlsPathPolicy;
    this.dnsLookup = options.dnsLookup ?? nodeDnsLookup;
    this.localServiceLeaseAcquirer = options.localServiceLeaseAcquirer;
    this.modelUsageAccounting = options.modelUsageAccounting;
    this.activeProviderId = "";
    this.activeModel = "";
    this.defaultThinkingLevel = config.defaultThinkingLevel ?? "standard";
    this.utilityProviderId = "";
    this.utilityModel = "";
    this.modelCatalogCachePath = options.modelCatalogCachePath ?? this.env.GOATCITADEL_LLM_MODEL_CATALOG_CACHE_PATH;

    const metadataPath =
      options.modelMetadataPath ??
      this.env.GOATCITADEL_LLM_MODEL_METADATA_PATH ??
      defaultModelMetadataPath(options.configFilePath);
    const { manifest, errors } = loadLlmModelMetadataManifest(metadataPath);
    for (const message of errors) {
      log.warn(message, { path: metadataPath });
    }
    this.modelMetadata = manifest;

    for (const provider of config.providers) {
      this.providers.set(provider.providerId, normalizeProvider(provider));
    }

    if (this.providers.size === 0) {
      throw new Error("LLM configuration must include at least one provider");
    }
    this.hydrateModelDiscoveryCacheFromDisk();

    const configuredUtilityProviderId = normalizeConfiguredProviderId(config.utilityProviderId);
    if (configuredUtilityProviderId && this.providers.has(configuredUtilityProviderId)) {
      this.utilityProviderId = configuredUtilityProviderId;
      this.utilityModel = config.utilityModel?.trim() ?? "";
    }

    const configuredActiveProviderId = normalizeConfiguredProviderId(config.activeProviderId);
    if (!configuredActiveProviderId) {
      return;
    }

    const active = this.providers.get(configuredActiveProviderId);
    if (!active) {
      throw new Error(`Unknown LLM provider: ${configuredActiveProviderId}`);
    }

    this.activeProviderId = active.providerId;
    this.activeModel =
      resolveConfiguredModelForProvider(active, config.activeModel, {
        fallbackModel: active.defaultModel,
        onMismatch: "fallback",
      }) ?? "";
  }

  public updateNetworkAllowlist(allowlist: string[], options?: { enforce?: boolean }): void {
    this.networkAllowlist = [...allowlist];
    if (options?.enforce !== undefined) {
      this.enforceNetworkAllowlist = options.enforce;
    }
    this.clearRequestDispatcherCache();
  }

  public listProviders(options: LlmListProvidersOptions = {}): LlmProviderSummary[] {
    const includeKeychainDefault = options.includeKeychain ?? false;
    return Array.from(this.providers.values()).map((provider) => {
      const includeKeychain =
        options.includeKeychainForProviderId === provider.providerId ? true : includeKeychainDefault;
      const authMode = resolveProviderAuthMode(provider);
      const oauthStatus = isOpenAICodexProvider(provider) ? this.openAICodexOAuth.getStatus() : undefined;
      const googleAuthReadiness =
        authMode === "google-adc"
          ? this.googleCloudAuth.inspectReadiness({
              providerId: provider.providerId,
              credentialMode: "adc",
              projectId: resolveProviderEnvironmentValue(
                provider.googleCloud?.projectId,
                provider.googleCloud?.projectIdEnv,
                this.env,
              ),
              location: resolveProviderEnvironmentValue(
                provider.googleCloud?.location,
                provider.googleCloud?.locationEnv,
                this.env,
              ),
              endpointId: provider.googleCloud?.endpointId,
            })
          : undefined;
      const status = googleAuthReadiness
        ? {
            providerId: provider.providerId,
            hasApiKey: googleAuthReadiness.status === "configured" || googleAuthReadiness.status === "ready",
            apiKeySource: "none" as const,
            hasKeychainSecret: false,
            apiKeyRef: undefined,
          }
        : oauthStatus
          ? {
              providerId: provider.providerId,
              hasApiKey: oauthStatus.connected,
              apiKeySource: oauthStatus.connected ? ("keychain" as const) : ("none" as const),
              hasKeychainSecret: oauthStatus.connected,
              apiKeyRef: oauthStatus.connected ? "keychain:goatcitadel:provider:openai-codex:oauth" : undefined,
            }
          : this.getProviderSecretStatus(provider.providerId, {
              includeKeychain,
              useCache: options.useCache,
            });
      return {
        providerId: provider.providerId,
        label: provider.label,
        baseUrl: provider.baseUrl,
        apiStyle: provider.apiStyle,
        resolvedApiStyle: resolveProviderExecutionApiStyle(provider, provider.defaultModel),
        defaultModel: provider.defaultModel,
        authMode,
        googleCloud: provider.googleCloud,
        oauthStatus,
        authReadiness: googleAuthReadiness,
        hasApiKey: status.hasApiKey,
        apiKeySource: status.apiKeySource,
        hasKeychainSecret: status.hasKeychainSecret,
        apiKeyRef: status.apiKeyRef,
        capabilities: inferProviderCapabilities(provider),
      };
    });
  }

  /** Resolve the per-model token-estimate multiplier from model metadata (default 1). */
  public getModelTokenMultiplier(providerId: string | undefined, model: string | undefined): number {
    if (!providerId || !model) {
      return 1;
    }
    const multiplier = lookupModelMetadata(this.modelMetadata, providerId, model)?.tokenMultiplier;
    return typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  }

  /**
   * Return the server-owned context window for the exact frozen route.
   *
   * This deliberately does not consult provider discovery records or fall back
   * to the active model: routed-context admission must be budgeted against the
   * same provider/model pair that will cross the provider boundary.
   */
  public getModelContextWindow(providerId: string, model: string): number | undefined {
    const contextWindow = lookupModelMetadata(this.modelMetadata, providerId, model)?.contextWindow;
    return Number.isSafeInteger(contextWindow) && (contextWindow ?? 0) > 0 ? contextWindow : undefined;
  }

  /** Exact server-owned reasoning metadata used by Change Plan validation. */
  public getModelReasoningMetadata(providerId: string, model: string): LlmModelReasoningMetadata | undefined {
    const reasoning = lookupExactModelMetadata(this.modelMetadata, providerId, model)?.reasoning;
    return reasoning
      ? {
          supportedEfforts: [...reasoning.supportedEfforts],
          ...(reasoning.providerEffortMap ? { providerEffortMap: { ...reasoning.providerEffortMap } } : {}),
        }
      : undefined;
  }

  /** Secret-free fingerprint of every configured selector that can change an exact model transport route. */
  public getProviderRouteConfigFingerprint(providerId: string, model: string): string | undefined {
    const provider = this.providers.get(providerId);
    const contextWindowTokens = this.getModelContextWindow(providerId, model);
    if (!provider || !contextWindowTokens) {
      return undefined;
    }
    return fingerprintProviderRouteConfig(provider, model, contextWindowTokens);
  }

  public getRuntimeConfig(
    options: { includeKeychainForActiveProvider?: boolean; useCache?: boolean } = {},
  ): LlmRuntimeConfig {
    const activeMeta = this.activeProviderId
      ? lookupModelMetadata(this.modelMetadata, this.activeProviderId, this.activeModel)
      : undefined;
    const providers = this.listProviders({
      includeKeychain: false,
      includeKeychainForProviderId: options.includeKeychainForActiveProvider ? this.activeProviderId : undefined,
      useCache: options.useCache,
    }).map((provider) => {
      const providerModel = provider.providerId === this.activeProviderId ? this.activeModel : provider.defaultModel;
      const providerMeta = lookupModelMetadata(this.modelMetadata, provider.providerId, providerModel);
      return {
        ...provider,
        activeModelContextWindow: provider.activeModelContextWindow ?? providerMeta?.contextWindow,
        activeModelOutputTokenLimit: provider.activeModelOutputTokenLimit ?? providerMeta?.outputTokenLimit,
      };
    });
    return {
      activeProviderId: this.activeProviderId,
      activeModel: this.activeModel,
      defaultThinkingLevel: this.defaultThinkingLevel,
      utilityProviderId: this.utilityProviderId || undefined,
      utilityModel: this.utilityModel || undefined,
      activeModelContextWindow: activeMeta?.contextWindow,
      activeModelOutputTokenLimit: activeMeta?.outputTokenLimit,
      providers,
    };
  }

  public updateRuntimeConfig(input: LlmRuntimeUpdateInput): LlmRuntimeConfig {
    this.modelDiscoveryCache.clear();
    this.modelDiscoveryInFlight.clear();
    this.modelDiscoveryAuthTokens.clear();
    if (input.defaultThinkingLevel !== undefined) {
      this.defaultThinkingLevel = input.defaultThinkingLevel;
    }
    if (input.upsertProvider) {
      const existing = this.providers.get(input.upsertProvider.providerId);
      const isCodexOAuthProvider = input.upsertProvider.providerId.trim().toLowerCase() === "openai-codex";
      const submittedApiKeyValue = input.upsertProvider.apiKey?.trim();
      const submittedApiKey =
        isCodexOAuthProvider || submittedApiKeyValue === SECRET_REDACTION_MARKER ? undefined : submittedApiKeyValue;
      if (submittedApiKey) {
        this.setProviderApiKey(input.upsertProvider.providerId, submittedApiKey);
      }

      const merged: LlmProviderConfig = normalizeProvider({
        providerId: input.upsertProvider.providerId,
        label: input.upsertProvider.label ?? existing?.label ?? input.upsertProvider.providerId,
        baseUrl:
          preserveProjectedProviderString(existing?.baseUrl, input.upsertProvider.baseUrl) ??
          existing?.baseUrl ??
          "http://127.0.0.1:1234/v1",
        apiStyle: normalizeProviderApiStyle(
          input.upsertProvider.providerId,
          input.upsertProvider.apiStyle ?? existing?.apiStyle,
        ),
        defaultModel:
          input.upsertProvider.defaultModel ??
          existing?.defaultModel ??
          defaultModelForProvider(input.upsertProvider.providerId),
        authMode:
          input.upsertProvider.authMode ??
          existing?.authMode ??
          defaultAuthModeForProvider(input.upsertProvider.providerId),
        apiKey: isCodexOAuthProvider
          ? undefined
          : submittedApiKey
            ? undefined
            : (preserveProjectedProviderString(existing?.apiKey, input.upsertProvider.apiKey) ?? existing?.apiKey),
        apiKeyEnv: isCodexOAuthProvider ? undefined : (input.upsertProvider.apiKeyEnv ?? existing?.apiKeyEnv),
        googleCloud: mergeGoogleCloudConfig(existing?.googleCloud, input.upsertProvider.googleCloud),
        request: mergeProviderRequestConfig(existing?.request, input.upsertProvider.request),
        headers: mergeProviderHeaders(existing?.headers, input.upsertProvider.headers),
        capabilities: input.upsertProvider.capabilities ?? existing?.capabilities,
      });
      this.providers.set(merged.providerId, merged);
      this.googleCloudAuth.invalidate(merged.providerId);
      this.secretStatusCache.delete(merged.providerId);
      this.clearRequestDispatcherCache();
    }

    const hasActiveProviderId = Object.prototype.hasOwnProperty.call(input, "activeProviderId");
    const hasActiveModel = Object.prototype.hasOwnProperty.call(input, "activeModel");

    if (hasActiveProviderId) {
      const providerId = normalizeConfiguredProviderId(input.activeProviderId);
      if (!providerId) {
        this.activeProviderId = "";
        this.activeModel = "";
      } else {
        const provider = this.providers.get(providerId);
        if (!provider) {
          throw new Error(`Unknown LLM provider: ${providerId}`);
        }
        this.activeProviderId = provider.providerId;
        this.activeModel =
          resolveConfiguredModelForProvider(provider, hasActiveModel ? input.activeModel : undefined, {
            fallbackModel: provider.defaultModel,
            onMismatch: "throw",
          }) ?? "";
      }
    } else if (hasActiveModel) {
      if (!this.activeProviderId) {
        if (normalizeConfiguredActiveModel(input.activeModel)) {
          throw new Error("Select an active LLM provider before choosing a model.");
        }
        this.activeModel = "";
      } else {
        const provider = this.providers.get(this.activeProviderId);
        if (!provider) {
          throw new Error(`Unknown LLM provider: ${this.activeProviderId}`);
        }
        this.activeModel =
          resolveConfiguredModelForProvider(provider, input.activeModel, {
            fallbackModel: provider.defaultModel,
            onMismatch: "throw",
          }) ?? "";
      }
    }

    const hasUtilityProviderId = Object.prototype.hasOwnProperty.call(input, "utilityProviderId");
    const hasUtilityModel = Object.prototype.hasOwnProperty.call(input, "utilityModel");
    if (hasUtilityProviderId) {
      const utilityProviderId = normalizeConfiguredProviderId(input.utilityProviderId);
      if (!utilityProviderId) {
        this.utilityProviderId = "";
        this.utilityModel = "";
      } else {
        const provider = this.providers.get(utilityProviderId);
        if (!provider) {
          throw new Error(`Unknown LLM provider: ${utilityProviderId}`);
        }
        this.utilityProviderId = provider.providerId;
        if (hasUtilityModel) {
          this.utilityModel = input.utilityModel?.trim() ?? "";
        }
      }
    } else if (hasUtilityModel) {
      if (!this.utilityProviderId && input.utilityModel?.trim()) {
        throw new Error("Select a utility LLM provider before choosing a utility model.");
      }
      this.utilityModel = input.utilityModel?.trim() ?? "";
    }

    return this.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
  }

  /**
   * Replaces the complete provider/routing snapshot after validating it into
   * local state. Assignments happen only after every provider and active route
   * has been normalized, so callers can safely use the prior export for
   * deterministic rollback.
   */
  public replaceRuntimeConfig(config: LlmConfigFile): LlmRuntimeConfig {
    const nextProviders = new Map<string, LlmProviderConfig>();
    for (const provider of config.providers) {
      const normalized = normalizeProvider(provider);
      nextProviders.set(normalized.providerId, normalized);
    }
    if (nextProviders.size === 0) {
      throw new Error("LLM configuration must include at least one provider");
    }

    const nextActiveProviderId = normalizeConfiguredProviderId(config.activeProviderId) ?? "";
    const nextActiveProvider = nextActiveProviderId ? nextProviders.get(nextActiveProviderId) : undefined;
    if (nextActiveProviderId && !nextActiveProvider) {
      throw new Error(`Unknown LLM provider: ${nextActiveProviderId}`);
    }
    const nextActiveModel = nextActiveProvider
      ? (resolveConfiguredModelForProvider(nextActiveProvider, config.activeModel, {
          fallbackModel: nextActiveProvider.defaultModel,
          onMismatch: "throw",
        }) ?? "")
      : "";

    const nextUtilityProviderId = normalizeConfiguredProviderId(config.utilityProviderId) ?? "";
    if (nextUtilityProviderId && !nextProviders.has(nextUtilityProviderId)) {
      throw new Error(`Unknown utility LLM provider: ${nextUtilityProviderId}`);
    }
    const nextUtilityModel = nextUtilityProviderId ? (config.utilityModel?.trim() ?? "") : "";

    this.providers.clear();
    for (const [providerId, provider] of nextProviders) {
      this.providers.set(providerId, provider);
    }
    this.activeProviderId = nextActiveProviderId;
    this.activeModel = nextActiveModel;
    this.utilityProviderId = nextUtilityProviderId;
    this.utilityModel = nextUtilityModel;
    this.secretStatusCache.clear();
    this.modelDiscoveryCache.clear();
    this.modelDiscoveryInFlight.clear();
    this.modelDiscoveryAuthTokens.clear();
    this.clearRequestDispatcherCache();
    return this.getRuntimeConfig({ includeKeychainForActiveProvider: true, useCache: true });
  }

  public getProviderSecretStatus(
    providerId: string,
    options: LlmProviderSecretStatusOptions = {},
  ): LlmProviderSecretStatus {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }

    if (resolveProviderAuthMode(provider) === "google-adc") {
      const readiness = this.googleCloudAuth.inspectReadiness({
        providerId: provider.providerId,
        credentialMode: "adc",
        projectId: resolveProviderEnvironmentValue(
          provider.googleCloud?.projectId,
          provider.googleCloud?.projectIdEnv,
          this.env,
        ),
        location: resolveProviderEnvironmentValue(
          provider.googleCloud?.location,
          provider.googleCloud?.locationEnv,
          this.env,
        ),
        endpointId: provider.googleCloud?.endpointId,
      });
      return {
        providerId: provider.providerId,
        hasApiKey: readiness.status === "configured" || readiness.status === "ready",
        apiKeySource: "none",
        hasKeychainSecret: false,
      };
    }

    const includeKeychain = options.includeKeychain ?? true;
    const useCache = options.useCache ?? true;
    const cached = useCache ? this.getCachedSecretStatus(provider.providerId) : undefined;

    if (!includeKeychain) {
      if (cached?.apiKeySource === "keychain" && cached.hasApiKey) {
        return cached;
      }
      return this.buildQuickSecretStatus(provider);
    }

    if (cached) {
      return cached;
    }

    const keychainSecret = this.readKeychainApiKey(provider.providerId);
    let status: LlmProviderSecretStatus;
    if (keychainSecret) {
      status = {
        providerId: provider.providerId,
        hasApiKey: true,
        apiKeySource: "keychain",
        hasKeychainSecret: true,
        apiKeyRef: `keychain:goatcitadel:provider:${provider.providerId}`,
      };
    } else {
      status = this.buildQuickSecretStatus(provider);
    }
    if (useCache) {
      this.setCachedSecretStatus(status);
    }
    return status;
  }

  public setProviderApiKey(providerId: string, apiKey: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    if (isOpenAICodexProvider(provider)) {
      throw new Error("OpenAI Codex uses ChatGPT OAuth. Connect it through the OpenAI Codex OAuth flow.");
    }
    try {
      this.secretStore.setProviderApiKey(providerId, apiKey);
    } catch (error) {
      if (isSecretStoreUnavailableLikeError(error)) {
        throw new Error("Secure keychain is unavailable on this host. Use apiKeyEnv for env-backed secrets.", {
          cause: error,
        });
      }
      throw error;
    }
    this.setCachedSecretStatus({
      providerId,
      hasApiKey: true,
      apiKeySource: "keychain",
      hasKeychainSecret: true,
      apiKeyRef: `keychain:goatcitadel:provider:${providerId}`,
    });
    this.googleCloudAuth.invalidate(providerId);
  }

  /** @internal Secret-owner seam. Never expose the returned value through a route or projection. */
  public readProviderKeychainApiKeyForPersistence(providerId: string): string | undefined {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    if (isOpenAICodexProvider(provider)) {
      throw new Error("OpenAI Codex uses ChatGPT OAuth. Connect it through the OpenAI Codex OAuth flow.");
    }
    return this.secretStore.getProviderApiKey(providerId);
  }

  /** @internal Read-only availability probe used to choose an explicit secret owner. */
  public isProviderKeychainAvailable(): boolean {
    return this.secretStore.isAvailable();
  }

  /** @internal Captures only the legacy inline API-key field for exact owner compensation. */
  public readInlineProviderApiKeyForPersistence(providerId: string): string | undefined {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    return provider.apiKey;
  }

  /** @internal Restores the exact pre-transaction inline API-key owner state. */
  public restoreInlineProviderApiKeyForPersistence(providerId: string, apiKey: string | undefined): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    this.providers.set(providerId, { ...provider, apiKey });
    this.secretStatusCache.delete(providerId);
    this.googleCloudAuth.invalidate(providerId);
  }

  /** @internal Invalidates source/status after an env-backed owner mutation. */
  public invalidateProviderSecretStatus(providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    this.secretStatusCache.delete(providerId);
    this.googleCloudAuth.invalidate(providerId);
    this.modelDiscoveryCache.clear();
    this.modelDiscoveryInFlight.clear();
    this.modelDiscoveryAuthTokens.clear();
  }

  public deleteProviderApiKey(providerId: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    if (isOpenAICodexProvider(provider)) {
      throw new Error("OpenAI Codex uses ChatGPT OAuth. Disconnect it through the OpenAI Codex OAuth flow.");
    }
    try {
      this.secretStore.deleteProviderApiKey(providerId);
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        throw new Error("Secure keychain is unavailable on this host.", { cause: error });
      }
      throw error;
    }
    this.setCachedSecretStatus(this.buildQuickSecretStatus(provider));
    this.googleCloudAuth.invalidate(providerId);
  }

  public getOpenAICodexOAuthStatus(): OpenAICodexOAuthStatus {
    return this.openAICodexOAuth.getStatus();
  }

  public async startOpenAICodexOAuthDeviceFlow(
    options: {
      credentialAccount?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<OpenAICodexDeviceStartResponse> {
    this.assertKnownOpenAICodexProvider();
    return this.openAICodexOAuth.startDeviceFlow(options);
  }

  public async pollOpenAICodexOAuthDeviceFlow(
    flowId: string,
    options: { expectedCredentialAccount?: string } = {},
  ): Promise<OpenAICodexDevicePollResponse> {
    this.assertKnownOpenAICodexProvider();
    return this.openAICodexOAuth.pollDeviceFlow(flowId, options);
  }

  /** @internal Plan-scoped OAuth custody. Public provider projections never expose the account name. */
  public getOpenAICodexOAuthCredentialStatus(credentialAccount: string): OpenAICodexOAuthStatus {
    return this.openAICodexOAuth.getStatus(credentialAccount);
  }

  /** @internal Exact Change Plan apply seam; the OAuth service owns the credential move. */
  public promoteOpenAICodexOAuthCredential(credentialAccount: string): OpenAICodexOAuthStatus {
    return this.openAICodexOAuth.promoteCredential(credentialAccount);
  }

  /** @internal Cancellation/expiry cleanup for a plan-scoped OAuth credential. */
  public discardOpenAICodexOAuthCredential(credentialAccount: string): void {
    this.openAICodexOAuth.discardCredential(credentialAccount);
  }

  public deleteOpenAICodexOAuthCredential(): OpenAICodexOAuthStatus {
    return this.openAICodexOAuth.deleteCredential();
  }

  public clearInlineProviderApiKey(providerId: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    if (!provider.apiKey) {
      return;
    }
    this.providers.set(providerId, {
      ...provider,
      apiKey: undefined,
    });
    this.secretStatusCache.delete(providerId);
  }

  public exportConfigFile(): LlmConfigFile {
    return {
      activeProviderId: this.activeProviderId,
      activeModel: this.activeModel,
      defaultThinkingLevel: this.defaultThinkingLevel,
      utilityProviderId: this.utilityProviderId || undefined,
      utilityModel: this.utilityModel || undefined,
      providers: Array.from(this.providers.values()).map((provider) => ({
        ...provider,
        // SECURITY (codex finding #15): The LLM config endpoint serializes
        // this object. We must strip ALL secret-bearing transport fields,
        // not just `apiKey` and top-level `headers`. `provider.request` (and
        // `provider.proxy`, if present in the type) can hold inline
        // `request.auth.token`, `request.auth.value`, `request.proxy.auth.*`,
        // and `request.headers` with `Authorization`/`X-API-Key`-style
        // values. Without scrubbing them, a device/companion token could
        // read transport credentials that were never apiKey-redacted.
        apiKey: undefined,
        headers: undefined,
        request: scrubProviderRequestSecrets(provider.request),
      })),
    };
  }

  /** @internal Exact in-memory owner snapshot for reverse compensation only. */
  public snapshotRuntimeConfigForPersistence(): LlmConfigFile {
    return {
      activeProviderId: this.activeProviderId,
      activeModel: this.activeModel,
      defaultThinkingLevel: this.defaultThinkingLevel,
      utilityProviderId: this.utilityProviderId || undefined,
      utilityModel: this.utilityModel || undefined,
      providers: Array.from(this.providers.values()).map((provider) => structuredClone(provider)),
    };
  }

  public async listModels(providerId?: string): Promise<LlmModelRecord[]> {
    const resolved = await this.resolveProvider(providerId);
    const result = await this.fetchModelsForResolvedProvider(resolved);
    return result.items.map((record) => this.enrichModelRecord(resolved.provider.providerId, record));
  }

  public async listModelsWithSource(providerId?: string): Promise<ModelDiscoveryResult> {
    const resolved = await this.resolveProvider(providerId);
    const result = await this.fetchModelsForResolvedProvider(resolved);
    return {
      ...result,
      items: result.items.map((record) => this.enrichModelRecord(resolved.provider.providerId, record)),
    };
  }

  public async previewModels(input: LlmModelPreviewRequest): Promise<LlmModelPreviewResponse> {
    const existing = this.providers.get(input.providerId);
    assertPreviewEnvironmentReferencesBound(existing, input);
    // SECURITY (codex finding #25a, #30): The preview endpoint accepts an
    // arbitrary `baseUrl` and an existing `providerId`. Previously the code
    // happily fell back to the existing provider's stored apiKey/apiKeyEnv/
    // keychain entry when the caller omitted a key, even when the caller's
    // baseUrl pointed at an attacker-controlled host. That turned the
    // endpoint into a credential-exfil primitive: a lower-privileged actor
    // who knew a providerId but could not read its key could POST
    // `{providerId, baseUrl: "https://attacker.example"}` and the gateway
    // would Authorization-bearer that secret to the attacker.
    //
    // We now refuse to inherit secret material when the caller-supplied
    // baseUrl is on a different origin than the existing provider's
    // configured baseUrl. The caller may still preview an arbitrary baseUrl
    // — they just have to supply the secret value themselves. Environment
    // references remain bound to the saved provider and proxy configuration.
    const originsMatch = previewHostsMatch(existing?.baseUrl, input.baseUrl);
    const proxyRouteMatches = previewProxyRoutesMatch(existing?.request, input.request);
    const inheritFromExisting = !existing || (originsMatch && proxyRouteMatches);
    const provider = normalizeProvider({
      providerId: input.providerId,
      label: existing?.label ?? input.providerId,
      baseUrl: input.baseUrl,
      apiStyle: normalizeProviderApiStyle(input.providerId, input.apiStyle ?? existing?.apiStyle),
      defaultModel: existing?.defaultModel ?? defaultModelForProvider(input.providerId),
      apiKey: input.apiKey ?? (inheritFromExisting ? existing?.apiKey : undefined),
      apiKeyEnv: input.apiKeyEnv ?? (inheritFromExisting ? existing?.apiKeyEnv : undefined),
      request: input.request ?? (inheritFromExisting ? existing?.request : undefined),
      headers: input.headers ?? (inheritFromExisting ? existing?.headers : undefined),
    });
    const explicitPreviewApiKey =
      input.apiKey?.trim() || (input.apiKeyEnv ? this.env[input.apiKeyEnv]?.trim() : undefined);
    const resolved: ResolvedProvider = {
      provider,
      // When the caller's baseUrl host does not match the configured
      // provider, do NOT fall back to the keychain — `resolveApiKey`
      // checks keychain by providerId, which would otherwise return the
      // saved credential for the configured (matching) host.
      apiKey: explicitPreviewApiKey || (inheritFromExisting ? this.resolveApiKey(provider) : undefined),
    };
    const fallbackCatalog = buildFallbackModelCatalog(provider.providerId, provider.defaultModel);

    try {
      const result = await this.fetchModelsForResolvedProvider(resolved);
      if (result.items.length > 0) {
        return {
          items: mergeModelCatalogs(result.items, fallbackCatalog).map((record) =>
            this.enrichModelRecord(provider.providerId, record),
          ),
          source: result.source,
          warning: result.warning,
        };
      }
    } catch (error) {
      if (fallbackCatalog.length > 0) {
        return {
          items: fallbackCatalog.map((record) => this.enrichModelRecord(provider.providerId, record)),
          source: "error_fallback",
          warning: (error as Error).message,
        };
      }
      throw error;
    }

    return {
      items: fallbackCatalog.map((record) => this.enrichModelRecord(provider.providerId, record)),
      source: "template_fallback",
      warning: "Provider returned no models. Falling back to the recommended default model.",
    };
  }

  public clampActiveModelSummaryReserve(requested: number): ClampSummaryReserveResult {
    const meta = this.activeProviderId
      ? lookupModelMetadata(this.modelMetadata, this.activeProviderId, this.activeModel)
      : undefined;
    return clampSummaryReserveTokens(requested, meta?.outputTokenLimit);
  }

  private enrichModelRecord(providerId: string, record: LlmModelRecord): LlmModelRecord {
    const meta = lookupModelMetadata(this.modelMetadata, providerId, record.id);
    if (!meta) return record;
    return {
      ...record,
      contextWindow: record.contextWindow ?? meta.contextWindow,
      outputTokenLimit: record.outputTokenLimit ?? meta.outputTokenLimit,
    };
  }

  private async postTrackedJsonRequest(input: LlmProviderJsonRequestInput): Promise<LlmTrackedJsonDispatch> {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const dispatchAbort = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([timeoutSignal, input.signal, dispatchAbort.signal])
      : AbortSignal.any([timeoutSignal, dispatchAbort.signal]);
    const requestInit: FetchRequestInitWithDispatcher = {
      method: "POST",
      headers: input.target.headers,
      body: JSON.stringify(input.payload),
      signal,
      redirect: "manual",
      dispatcher: input.target.dispatcher,
    };
    const outputCapField = resolveOutputCapPayloadField(input.payload);
    const minimumEffectiveOutputTokenCap = input.outputCapRecovery?.minimumEffectiveOutputTokenCap;
    if (
      minimumEffectiveOutputTokenCap !== undefined &&
      (!Number.isSafeInteger(minimumEffectiveOutputTokenCap) ||
        minimumEffectiveOutputTokenCap <= 0 ||
        !outputCapField ||
        minimumEffectiveOutputTokenCap > outputCapField.value)
    ) {
      throw new TypeError("Provider output-cap recovery semantic floor is invalid for the effective request payload.");
    }
    const requestedOutputTokenCap = outputCapField
      ? (input.outputCapRecovery?.requestedOutputTokenCap ?? outputCapField.value)
      : undefined;
    const reservation = await this.modelUsageAccounting?.prepareDispatch({
      source: "llm_service",
      attribution: input.attribution,
      requestedProviderId: input.requestedProviderId,
      requestedModelId: input.requestedModelId,
      effectiveProviderId: input.resolved.provider.providerId,
      effectiveModelId: input.model,
      effectiveApiStyle: resolveProviderExecutionApiStyle(input.resolved.provider, input.model),
      transportAttemptIndex: input.transportAttemptIndex,
      ...(outputCapField && requestedOutputTokenCap
        ? {
            outputCap: {
              requestedOutputTokenCap,
              effectiveOutputTokenCap: outputCapField.value,
              disposition:
                input.transportRetry?.reason === "metadata_compatibility"
                  ? "preserved_retry"
                  : input.outputCapRecovery?.recoverySourceEventId
                    ? "reduced_retry"
                    : "initial",
              recoverySourceEventId: input.outputCapRecovery?.recoverySourceEventId,
              recoveryReasonCode: input.outputCapRecovery?.recoverySourceEventId ? "safe_lower_cap" : undefined,
              providerAvailableTokens: input.outputCapRecovery?.providerAvailableTokens,
              providerMinimumTokens: input.outputCapRecovery?.providerMinimumTokens,
              requestInputEstimate: input.outputCapRecovery?.requestInputEstimate,
              configuredContextWindowTokens: input.outputCapRecovery?.configuredContextWindowTokens,
              safetyMarginTokens: input.outputCapRecovery?.safetyMarginTokens,
              evidenceFormat: input.outputCapRecovery?.evidenceFormat,
            },
          }
        : {}),
      transportRetry: input.transportRetry,
      credential: this.resolveModelUsageCredentialLineage(input.resolved as ResolvedProvider),
      pricing: resolveModelPricingLineage(input.resolved.provider.providerId, input.model),
    });

    let pending: Promise<Response>;
    try {
      pending = fetch(input.target.url, requestInit);
    } catch (error) {
      await reservation?.abandon();
      rethrowIfProviderNetworkBlocked(error);
      throw error;
    }
    let usage: ModelUsageAttemptHandle | undefined;
    try {
      usage = await reservation?.accept();
    } catch (cause) {
      dispatchAbort.abort();
      void pending.catch(() => undefined);
      await reservation?.markDispatchUnknown();
      const error = new ModelUsageDispatchUncertainError(
        "Provider dispatch outcome is uncertain; same-generation retry is blocked pending reconciliation",
        { eventId: reservation?.eventId, cause },
      );
      throw error;
    }
    try {
      const response = await pending;
      const baseResult = {
        response,
        ...(usage ? { usage } : {}),
        lastTransportAttemptIndex: input.transportAttemptIndex,
        effectivePayload: input.payload,
        outputCapRetriesRemaining: input.outputCapRecovery?.retriesRemaining ?? 0,
        ...(requestedOutputTokenCap === undefined ? {} : { logicalRequestedOutputTokenCap: requestedOutputTokenCap }),
        ...(minimumEffectiveOutputTokenCap === undefined ? {} : { minimumEffectiveOutputTokenCap }),
      };
      if (
        response.ok ||
        !isOutputCapRecoveryHttpStatus(response.status) ||
        !input.outputCapRecovery ||
        input.outputCapRecovery.retriesRemaining <= 0
      ) {
        return baseResult;
      }
      if (!outputCapField) {
        return baseResult;
      }
      let errorText: string;
      try {
        errorText = await readProviderErrorBody("provider output-cap probe", response.clone());
      } catch {
        return baseResult;
      }
      const providerErrorText = extractProviderOwnedOutputCapErrorText(errorText);
      if (!providerErrorText) {
        return baseResult;
      }
      return (
        (await this.retryTrackedOutputCapFailure({
          ...input,
          dispatched: baseResult,
          providerErrorText,
        })) ?? baseResult
      );
    } catch (error) {
      if (error instanceof ModelUsageSettlementError) throw error;
      await usage?.fail(error);
      rethrowIfProviderNetworkBlocked(error);
      throw error;
    }
  }

  private async retryTrackedOutputCapFailure(
    input: LlmProviderJsonRequestInput & {
      dispatched: LlmTrackedJsonDispatch;
      providerErrorText: string;
      providerFailureEvidence?: unknown;
    },
  ): Promise<LlmTrackedJsonDispatch | undefined> {
    const outputCapField = resolveOutputCapPayloadField(input.dispatched.effectivePayload);
    if (!outputCapField || input.dispatched.outputCapRetriesRemaining <= 0) return undefined;
    const requestedOutputTokenCap = input.dispatched.logicalRequestedOutputTokenCap ?? outputCapField.value;
    const decision = resolveOutputCapRecovery({
      errorText: input.providerErrorText,
      requestedOutputTokenCap,
      effectiveOutputTokenCap: outputCapField.value,
      configuredContextWindowTokens: this.getModelContextWindow(input.resolved.provider.providerId, input.model),
      requestPayload: input.dispatched.effectivePayload,
      tokenMultiplier: this.getModelTokenMultiplier(input.resolved.provider.providerId, input.model),
    });
    if (!decision.retry) return undefined;
    if (
      input.dispatched.minimumEffectiveOutputTokenCap !== undefined &&
      decision.effectiveOutputTokenCap < input.dispatched.minimumEffectiveOutputTokenCap
    ) {
      // A generic context-window recovery must never reduce a provider request
      // below a semantic floor such as Anthropic's governed reasoning reserve.
      // Leave the original failure authoritative and do not dispatch a request
      // that cannot preserve the caller's requested reasoning posture.
      return undefined;
    }
    const outputCapError = new Error(input.providerErrorText);
    outputCapError.name = "ProviderOutputCapError";
    observeProviderFailureUsage(input.dispatched.usage, input.providerFailureEvidence, {
      providerId: input.resolved.provider.providerId,
      model: input.model,
    });
    await input.dispatched.usage?.fail(outputCapError);
    const retryPayload = {
      ...input.dispatched.effectivePayload,
      [outputCapField.field]: decision.effectiveOutputTokenCap,
    };
    const usage = input.dispatched.usage;
    const retried = await this.postTrackedJsonRequest({
      ...input,
      transportAttemptIndex: (input.dispatched.lastTransportAttemptIndex ?? input.transportAttemptIndex) + 1,
      payload: retryPayload,
      outputCapRecovery: {
        requestedOutputTokenCap,
        minimumEffectiveOutputTokenCap: input.dispatched.minimumEffectiveOutputTokenCap,
        retriesRemaining: input.dispatched.outputCapRetriesRemaining - 1,
        recoverySourceEventId: usage?.eventId,
        providerAvailableTokens: decision.providerAvailableOutputTokens,
        providerMinimumTokens: decision.providerMinimumOutputTokens,
        requestInputEstimate: decision.requestInputTokenEstimate,
        configuredContextWindowTokens: decision.configuredContextWindowTokens,
        safetyMarginTokens: decision.safetyMarginTokens,
        evidenceFormat: decision.evidenceFormat,
      },
      ...(usage
        ? {
            transportRetry: {
              parentEventId: usage.eventId,
              reason: "output_cap_recovery" as const,
            },
          }
        : {}),
    });
    return {
      ...retried,
      priorModelUsageEventIds: [...(usage ? [usage.eventId] : []), ...(retried.priorModelUsageEventIds ?? [])],
    };
  }

  private async postTrackedMultipartRequest(input: {
    resolved: ResolvedProvider;
    model: string;
    requestedProviderId?: string;
    requestedModelId?: string;
    attribution: ModelUsageAttributionContext;
    transportAttemptIndex: number;
    target: ProviderRequestTarget;
    formData: FormData;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ response: Response; usage?: ModelUsageAttemptHandle }> {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const dispatchAbort = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([timeoutSignal, input.signal, dispatchAbort.signal])
      : AbortSignal.any([timeoutSignal, dispatchAbort.signal]);
    const requestInit: FetchRequestInitWithDispatcher = {
      method: "POST",
      headers: input.target.headers,
      body: input.formData,
      signal,
      redirect: "manual",
      dispatcher: input.target.dispatcher,
    };
    const reservation = await this.modelUsageAccounting?.prepareDispatch({
      source: "llm_service",
      attribution: input.attribution,
      requestedProviderId: input.requestedProviderId,
      requestedModelId: input.requestedModelId,
      effectiveProviderId: input.resolved.provider.providerId,
      effectiveModelId: input.model,
      effectiveApiStyle: resolveProviderExecutionApiStyle(input.resolved.provider, input.model),
      transportAttemptIndex: input.transportAttemptIndex,
      credential: this.resolveModelUsageCredentialLineage(input.resolved),
      pricing: resolveModelPricingLineage(input.resolved.provider.providerId, input.model),
    });
    let pending: Promise<Response>;
    try {
      pending = fetch(input.target.url, requestInit);
    } catch (error) {
      await reservation?.abandon();
      rethrowIfProviderNetworkBlocked(error);
      throw error;
    }
    let usage: ModelUsageAttemptHandle | undefined;
    try {
      usage = await reservation?.accept();
    } catch (cause) {
      dispatchAbort.abort();
      void pending.catch(() => undefined);
      await reservation?.markDispatchUnknown();
      const error = new ModelUsageDispatchUncertainError(
        "Provider dispatch outcome is uncertain; same-generation retry is blocked pending reconciliation",
        { eventId: reservation?.eventId, cause },
      );
      throw error;
    }
    try {
      return { response: await pending, usage };
    } catch (error) {
      if (error instanceof ModelUsageSettlementError) throw error;
      await usage?.fail(error);
      rethrowIfProviderNetworkBlocked(error);
      throw error;
    }
  }

  private resolveModelUsageCredentialLineage(resolved: ResolvedProvider): {
    credentialType: "api_key" | "oauth" | "service_account" | "adc" | "unknown";
    usagePool: "standard" | "subscription" | "local" | "unknown";
    credentialSource: "inline" | "env" | "keychain" | "oauth" | "adc" | "none" | "unknown";
    credentialConfigFingerprint: string;
  } {
    const provider = resolved.provider;
    const authMode = resolveProviderAuthMode(provider);
    const local = isLocalBillingProvider(provider.providerId);
    const requestAuth = provider.request?.auth;
    const requestAuthSource = resolveRequestAuthSource(requestAuth);
    const source =
      resolved.credentialType === "adc"
        ? "adc"
        : resolved.credentialType === "service_account"
          ? resolved.credentialSource === "env"
            ? "env"
            : "keychain"
          : authMode === "codex-oauth" || authMode === "claude-code-oauth"
            ? "oauth"
            : requestAuthSource !== "none"
              ? requestAuthSource
              : this.getProviderSecretStatus(provider.providerId, { includeKeychain: true }).apiKeySource;
    return {
      credentialType:
        resolved.credentialType ??
        (authMode === "codex-oauth" || authMode === "claude-code-oauth"
          ? "oauth"
          : resolved.apiKey || requestAuth
            ? "api_key"
            : "unknown"),
      usagePool:
        authMode === "codex-oauth" || authMode === "claude-code-oauth" ? "subscription" : local ? "local" : "standard",
      credentialSource: local && source === "none" ? "none" : source,
      credentialConfigFingerprint: fingerprintProviderCredentialConfig(provider),
    };
  }

  public async generateImage(
    request: ImageGenerationRequest,
    attributionInput: ModelUsageAttributionContext = {},
  ): Promise<ImageGenerationResponse> {
    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new Error("images requires a non-empty prompt");
    }
    const attribution = normalizeModelUsageAttribution(attributionInput, "image_generation");

    const resolved = await this.resolveProvider(request.providerId, { requireAuth: true });
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    if (!supportsImageGenerationProvider(resolved.provider.providerId)) {
      throw new Error("Image generation currently requires an OpenAI, OpenAI Codex, or Google-compatible provider.");
    }

    const model = request.model?.trim() || defaultImageModelForProvider(resolved.provider.providerId);
    const operation =
      Array.isArray(request.referenceImages) && request.referenceImages.length > 0 ? "edit" : "generate";

    if (isOpenAICodexProvider(resolved.provider)) {
      const response = await this.generateOpenAICodexImage(request, resolved, model, operation, attribution);
      return attachImageGenerationEvidence(response, request, {
        providerId: resolved.provider.providerId,
        model,
        operation,
        prompt,
      });
    }

    if (operation === "edit") {
      const target = this.buildRequestTarget(
        resolved,
        "chat",
        `${resolved.provider.baseUrl}/images/edits`,
        "multipart",
      );
      const formData = new FormData();
      formData.set("model", model);
      formData.set("prompt", prompt);
      if (request.n !== undefined) formData.set("n", String(request.n));
      if (request.responseFormat && supportsImageResponseFormat(model)) {
        formData.set("response_format", request.responseFormat);
      }
      if (request.quality) formData.set("quality", request.quality);
      if (request.background) formData.set("background", request.background);
      if (request.outputFormat) formData.set("output_format", request.outputFormat);
      if (request.moderation) formData.set("moderation", request.moderation);
      if (request.size) formData.set("size", request.size);

      const imageField = (request.referenceImages?.length ?? 0) > 1 ? "image[]" : "image";
      for (const image of request.referenceImages ?? []) {
        formData.append(imageField, decodeImageAssetToBlob(image), image.fileName ?? "reference.png");
      }
      if (request.maskImage) {
        formData.set("mask", decodeImageAssetToBlob(request.maskImage), request.maskImage.fileName ?? "mask.png");
      }

      const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
      const dispatched = await this.postTrackedMultipartRequest({
        resolved,
        model,
        requestedProviderId: attribution.requestedProviderId ?? request.providerId,
        requestedModelId: attribution.requestedModelId ?? request.model,
        attribution,
        transportAttemptIndex: 0,
        target,
        formData,
        timeoutMs,
      });
      try {
        if (isRedirect(dispatched.response.status)) {
          throw new Error(`image edit blocked redirect (${dispatched.response.status})`);
        }
        if (!dispatched.response.ok) {
          throw new Error(await buildHttpError("image edit", dispatched.response));
        }
        const json = await parseProviderJsonResponse("image edit", dispatched.response);
        observeProviderPayloadUsage(
          dispatched.usage,
          isRecord(json.usage) ? json.usage : undefined,
          firstNonEmptyString(json.model),
          { providerId: resolved.provider.providerId, model },
        );
        const imageResponse = adaptImageGenerationResponse(json, {
          providerId: resolved.provider.providerId,
          model,
          operation,
        });
        const terminal = await dispatched.usage?.succeed();
        const withUsage = terminal ? { ...imageResponse, modelUsageEventIds: [terminal.eventId] } : imageResponse;
        return attachImageGenerationEvidence(withUsage, request, {
          providerId: resolved.provider.providerId,
          model,
          operation,
          prompt,
        });
      } catch (error) {
        if (error instanceof ModelUsageSettlementError) throw error;
        await dispatched.usage?.fail(error);
        throw error;
      }
    }

    const target = this.buildRequestTarget(resolved, "chat", `${resolved.provider.baseUrl}/images/generations`);
    const payload: Record<string, unknown> = {
      model,
      prompt,
    };
    if (request.n !== undefined) payload.n = request.n;
    if (request.size) payload.size = request.size;
    if (request.quality) payload.quality = request.quality;
    if (request.background) payload.background = request.background;
    if (request.outputFormat) payload.output_format = request.outputFormat;
    if (request.responseFormat && supportsImageResponseFormat(model)) {
      payload.response_format = request.responseFormat;
    }
    if (request.moderation) payload.moderation = request.moderation;

    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    const dispatched = await this.postTrackedJsonRequest({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      target,
      payload,
      timeoutMs,
    });
    try {
      if (isRedirect(dispatched.response.status)) {
        throw new Error(`image generation blocked redirect (${dispatched.response.status})`);
      }
      if (!dispatched.response.ok) {
        throw new Error(await buildHttpError("image generation", dispatched.response));
      }
      const json = await parseProviderJsonResponse("image generation", dispatched.response);
      observeProviderPayloadUsage(
        dispatched.usage,
        isRecord(json.usage) ? json.usage : undefined,
        firstNonEmptyString(json.model),
        { providerId: resolved.provider.providerId, model },
      );
      const imageResponse = adaptImageGenerationResponse(json, {
        providerId: resolved.provider.providerId,
        model,
        operation,
      });
      const terminal = await dispatched.usage?.succeed();
      const withUsage = terminal ? { ...imageResponse, modelUsageEventIds: [terminal.eventId] } : imageResponse;
      return attachImageGenerationEvidence(withUsage, request, {
        providerId: resolved.provider.providerId,
        model,
        operation,
        prompt,
      });
    } catch (error) {
      if (error instanceof ModelUsageSettlementError) throw error;
      await dispatched.usage?.fail(error);
      throw error;
    }
  }

  private async generateOpenAICodexImage(
    request: ImageGenerationRequest,
    resolved: ResolvedProvider,
    model: string,
    operation: "generate" | "edit",
    attribution: ModelUsageAttributionContext,
  ): Promise<ImageGenerationResponse> {
    const referenceImages = request.referenceImages ?? [];
    if (referenceImages.length > 5) {
      throw new Error("OpenAI Codex image generation supports at most 5 reference images.");
    }
    if (request.maskImage) {
      throw new Error("OpenAI Codex image generation does not support mask images in v1.");
    }
    const count = request.n ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 4) {
      throw new Error("OpenAI Codex image generation supports 1 to 4 results.");
    }

    const target = this.buildRequestTarget(resolved, "responses", `${resolved.provider.baseUrl}/responses`);
    target.headers.Accept = "text/event-stream";
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 180000);
    const data: ImageGenerationResponse["data"] = [];
    const eventIds: string[] = [];
    let effectiveModel = model;
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: request.prompt.trim() },
      ...referenceImages.map((image) => ({
        type: "input_image",
        image_url: toImageDataUrl(image),
        detail: "auto",
      })),
    ];

    for (let index = 0; index < count; index += 1) {
      let dispatched: LlmTrackedJsonDispatch;
      try {
        dispatched = await this.postTrackedJsonRequest({
          resolved,
          model,
          requestedProviderId: attribution.requestedProviderId ?? request.providerId,
          requestedModelId: attribution.requestedModelId ?? request.model,
          attribution,
          transportAttemptIndex: index,
          target,
          payload: buildOpenAICodexImagePayload(request, model, content),
          timeoutMs,
        });
      } catch (error) {
        if (error instanceof ModelUsageSettlementError) throw error;
        throw normalizeOpenAICodexImageResponseError(error);
      }
      if (dispatched.usage) eventIds.push(dispatched.usage.eventId);
      try {
        if (isRedirect(dispatched.response.status)) {
          throw new Error(`OpenAI Codex image generation blocked redirect (${dispatched.response.status})`);
        }
        if (!dispatched.response.ok) {
          throw new Error(await buildHttpError("OpenAI Codex image generation", dispatched.response));
        }
        const adapted = await adaptOpenAICodexImageResponse(dispatched.response, model, timeoutMs);
        data.push(...adapted.data);
        effectiveModel = adapted.model ?? effectiveModel;
        observeProviderPayloadUsage(dispatched.usage, adapted.usage, adapted.model, {
          providerId: resolved.provider.providerId,
          model,
        });
        await dispatched.usage?.succeed();
      } catch (error) {
        if (error instanceof ModelUsageSettlementError) throw error;
        const surfacedError = normalizeOpenAICodexImageResponseError(error);
        observeProviderFailureUsage(dispatched.usage, surfacedError, {
          providerId: resolved.provider.providerId,
          model,
        });
        await dispatched.usage?.fail(surfacedError);
        throw surfacedError;
      }
    }

    return {
      providerId: resolved.provider.providerId,
      model: effectiveModel,
      operation,
      data: data.slice(0, 4),
      ...(eventIds.length > 0 ? { modelUsageEventIds: eventIds } : {}),
    };
  }

  private assertKnownOpenAICodexProvider(): void {
    if (!this.providers.has("openai-codex")) {
      throw new Error("Unknown LLM provider: openai-codex");
    }
  }

  public async chatCompletions(
    request: ChatCompletionRequest,
    attributionInput: ModelUsageAttributionContext = {},
  ): Promise<ChatCompletionResponse> {
    if (!request.messages || request.messages.length === 0) {
      throw new Error("chat/completions requires at least one message");
    }

    // Provider-agnostic correctness pass: guarantee tool calls and tool results
    // are paired before any payload is built, so Anthropic / OpenAI-Responses
    // never 400 on an orphan tool_result or a tool_use with no matching result.
    // This is the single chokepoint every provider style funnels through.
    const sanitizedRequest = withSanitizedMessages(request);
    const attribution = normalizeModelUsageAttribution(attributionInput, "chat_initial");

    const resolved = await this.resolveProvider(sanitizedRequest.providerId, { requireAuth: true });
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const lease = await this.acquireLocalServiceLease(resolved, "chat_completion", sanitizedRequest.signal);
    try {
      const model = this.resolveRequestModel(resolved.provider, sanitizedRequest.model);
      const reasoning = resolveLlmReasoningProfile({
        request: sanitizedRequest,
        providerId: resolved.provider.providerId,
        providerCapabilities: inferProviderCapabilities(resolved.provider),
        modelMetadata: lookupExactModelMetadata(this.modelMetadata, resolved.provider.providerId, model),
        attribution,
      });
      const apiStyle = resolveProviderExecutionApiStyle(resolved.provider, model);
      const providerAdapter = this.providerAdapters.get(apiStyle);
      let completion: ChatCompletionResponse;
      if (providerAdapter) {
        completion = await providerAdapter.chatCompletions(
          reasoning.request,
          resolved,
          model,
          this.providerAdapterHost,
          reasoning.attribution,
        );
      } else {
        switch (apiStyle) {
          case "openai-codex-responses":
          case "openai-responses":
            completion = await this.executeOpenAiResponses(reasoning.request, resolved, model, reasoning.attribution);
            break;
          case "bedrock-messages":
            throw new Error("AWS Bedrock messages API style is not yet supported in this version");
          default:
            completion = await this.executeChatCompletions(reasoning.request, resolved, model, reasoning.attribution);
        }
      }
      return attachReasoningReceipt(stripPrivateReasoningFromCompletion(completion), reasoning.receipt);
    } finally {
      await this.releaseLocalServiceLease(lease);
    }
  }

  public async *chatCompletionsStream(
    request: ChatCompletionRequest,
    attributionInput: ModelUsageAttributionContext = {},
  ): AsyncGenerator<Record<string, unknown>> {
    if (!request.messages || request.messages.length === 0) {
      throw new Error("chat/completions requires at least one message");
    }

    // See chatCompletions: pair tool calls/results once at the shared chokepoint
    // so every provider style sends an API-valid message list.
    const sanitizedRequest = withSanitizedMessages(request);
    const attribution = normalizeModelUsageAttribution(attributionInput, "chat_initial");

    const resolved = await this.resolveProvider(sanitizedRequest.providerId, { requireAuth: true });
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const lease = await this.acquireLocalServiceLease(resolved, "chat_completion", sanitizedRequest.signal);
    try {
      const model = this.resolveRequestModel(resolved.provider, sanitizedRequest.model);
      const reasoning = resolveLlmReasoningProfile({
        request: sanitizedRequest,
        providerId: resolved.provider.providerId,
        providerCapabilities: inferProviderCapabilities(resolved.provider),
        modelMetadata: lookupExactModelMetadata(this.modelMetadata, resolved.provider.providerId, model),
        attribution,
      });
      const apiStyle = resolveProviderExecutionApiStyle(resolved.provider, model);
      const providerAdapter = this.providerAdapters.get(apiStyle);
      let stream: AsyncGenerator<Record<string, unknown>>;
      if (providerAdapter) {
        stream = providerAdapter.chatCompletionsStream(
          reasoning.request,
          resolved,
          model,
          this.providerAdapterHost,
          reasoning.attribution,
        );
      } else {
        switch (apiStyle) {
          case "openai-codex-responses":
          case "openai-responses":
            stream = this.executeOpenAiResponsesStream(reasoning.request, resolved, model, reasoning.attribution);
            break;
          case "bedrock-messages":
            throw new Error("AWS Bedrock messages API style is not yet supported in this version");
          default:
            stream = this.executeChatCompletionsStream(reasoning.request, resolved, model, reasoning.attribution);
        }
      }
      for await (const chunk of stream) {
        yield attachReasoningReceiptToChunk(stripPrivateReasoningFromChunk(chunk), reasoning.receipt);
      }
    } finally {
      await this.releaseLocalServiceLease(lease);
    }
  }

  public resolveExecutionApiStyle(providerId?: string, model?: string): LlmApiStyle {
    const selectedId = normalizeConfiguredProviderId(providerId) ?? this.activeProviderId;
    if (!selectedId) {
      throw new Error("No active LLM provider is configured. Select a provider first.");
    }
    const provider = this.providers.get(selectedId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${selectedId}`);
    }
    const resolvedModel = this.resolveRequestModel(provider, model);
    return resolveProviderExecutionApiStyle(provider, resolvedModel);
  }

  private async executeChatCompletions(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse> {
    const normalizedMessages = normalizeProviderMessages(request.messages, model);

    const payload: Record<string, unknown> = {
      model,
      messages: normalizedMessages,
      stream: request.stream ?? false,
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.top_p !== undefined) payload.top_p = request.top_p;
    applyMaxTokensPayloadField({
      payload,
      providerId: resolved.provider.providerId,
      model,
      maxTokens: request.max_tokens,
    });
    if (request.tools !== undefined) payload.tools = request.tools;
    if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
    if (request.parallel_tool_calls !== undefined) payload.parallel_tool_calls = request.parallel_tool_calls;
    if (request.stop !== undefined) payload.stop = request.stop;
    if (request.response_format !== undefined) payload.response_format = request.response_format;
    applyProviderSpecificChatOptions({
      payload,
      providerId: resolved.provider.providerId,
      model,
      request,
    });
    if (request.metadata !== undefined) payload.metadata = request.metadata;

    const target = this.buildRequestTarget(resolved, "chat", `${resolved.provider.baseUrl}/chat/completions`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    const eventIds: string[] = [];
    let dispatched = await this.postTrackedJsonRequest({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      target,
      payload,
      timeoutMs,
      signal: request.signal,
      outputCapRecovery: {
        requestedOutputTokenCap: request.max_tokens,
        retriesRemaining: 1,
      },
    });
    eventIds.push(...(dispatched.priorModelUsageEventIds ?? []));
    if (dispatched.usage) eventIds.push(dispatched.usage.eventId);
    try {
      if (isRedirect(dispatched.response.status)) {
        throw new Error(`chat completion blocked redirect (${dispatched.response.status})`);
      }

      if (!dispatched.response.ok) {
        const errorText = await readProviderErrorBody("chat completion", dispatched.response);
        if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
          const metadataError = createProviderMetadataCompatibilityError(
            buildHttpErrorFromText(
              "chat completion",
              dispatched.response.status,
              dispatched.response.statusText,
              errorText,
            ),
          );
          await dispatched.usage?.fail(metadataError);
          const retryParentEventId = dispatched.usage?.eventId;
          const fallbackPayload = { ...dispatched.effectivePayload };
          delete fallbackPayload.metadata;
          dispatched = await this.postTrackedJsonRequest({
            resolved,
            model,
            requestedProviderId: attribution.requestedProviderId ?? request.providerId,
            requestedModelId: attribution.requestedModelId ?? request.model,
            attribution,
            transportAttemptIndex: (dispatched.lastTransportAttemptIndex ?? 0) + 1,
            target,
            payload: fallbackPayload,
            timeoutMs,
            signal: request.signal,
            outputCapRecovery: {
              requestedOutputTokenCap: dispatched.logicalRequestedOutputTokenCap,
              retriesRemaining: dispatched.outputCapRetriesRemaining,
            },
            ...(retryParentEventId
              ? {
                  transportRetry: {
                    parentEventId: retryParentEventId,
                    reason: "metadata_compatibility" as const,
                  },
                }
              : {}),
          });
          eventIds.push(...(dispatched.priorModelUsageEventIds ?? []));
          if (dispatched.usage) eventIds.push(dispatched.usage.eventId);
          if (isRedirect(dispatched.response.status)) {
            throw new Error(`chat completion blocked redirect (${dispatched.response.status})`);
          }
          if (!dispatched.response.ok) {
            throw new Error(await buildHttpError("chat completion", dispatched.response));
          }
        } else {
          throw new Error(
            buildHttpErrorFromText(
              "chat completion",
              dispatched.response.status,
              dispatched.response.statusText,
              errorText,
            ),
          );
        }
      }

      const providerCompletion = await parseProviderJsonResponse<ChatCompletionResponse>(
        "chat completion",
        dispatched.response,
      );
      const completion = applyEstimatedCostToChatResponseWithSource(providerCompletion, {
        providerId: resolved.provider.providerId,
        model,
      });
      observeProviderUsageWithTrustedEstimate(dispatched.usage, providerCompletion.usage, completion.usage);
      dispatched.usage?.observeNormalized({ effectiveModelId: completion.model });
      await dispatched.usage?.succeed();
      return eventIds.length > 0 ? { ...completion, modelUsageEventIds: eventIds } : completion;
    } catch (error) {
      if (error instanceof ModelUsageSettlementError) throw error;
      await dispatched.usage?.fail(error);
      throw error;
    }
  }

  private async *executeChatCompletionsStream(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
    attribution: ModelUsageAttributionContext,
  ): AsyncGenerator<Record<string, unknown>> {
    const normalizedMessages = normalizeProviderMessages(request.messages, model);

    const payload: Record<string, unknown> = {
      model,
      messages: normalizedMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.top_p !== undefined) payload.top_p = request.top_p;
    applyMaxTokensPayloadField({
      payload,
      providerId: resolved.provider.providerId,
      model,
      maxTokens: request.max_tokens,
    });
    if (request.tools !== undefined) payload.tools = request.tools;
    if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
    if (request.parallel_tool_calls !== undefined) payload.parallel_tool_calls = request.parallel_tool_calls;
    if (request.stop !== undefined) payload.stop = request.stop;
    if (request.response_format !== undefined) payload.response_format = request.response_format;
    applyProviderSpecificChatOptions({
      payload,
      providerId: resolved.provider.providerId,
      model,
      request,
    });
    if (request.metadata !== undefined) payload.metadata = request.metadata;

    const target = this.buildRequestTarget(resolved, "chat", `${resolved.provider.baseUrl}/chat/completions`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    const eventIds: string[] = [];
    let dispatched = await this.postTrackedJsonRequest({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      target,
      payload,
      timeoutMs,
      signal: request.signal,
      outputCapRecovery: {
        requestedOutputTokenCap: request.max_tokens,
        retriesRemaining: 1,
      },
    });
    attemptLoop: while (true) {
      // eslint-disable-next-line no-useless-assignment -- async-generator cancellation reaches finally between yields.
      let terminal = false;
      let providerTerminal = false;
      let emittedVisibleChunk = false;
      appendUniqueUsageEventIds(eventIds, dispatched);
      try {
        if (isRedirect(dispatched.response.status)) {
          throw new Error(`chat completion blocked redirect (${dispatched.response.status})`);
        }

        if (!dispatched.response.ok) {
          const errorText = await readProviderErrorBody("chat completion", dispatched.response);
          if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
            const metadataError = createProviderMetadataCompatibilityError(
              buildHttpErrorFromText(
                "chat completion",
                dispatched.response.status,
                dispatched.response.statusText,
                errorText,
              ),
            );
            await dispatched.usage?.fail(metadataError);
            const retryParentEventId = dispatched.usage?.eventId;
            const fallbackPayload = { ...dispatched.effectivePayload };
            delete fallbackPayload.metadata;
            dispatched = await this.postTrackedJsonRequest({
              resolved,
              model,
              requestedProviderId: attribution.requestedProviderId ?? request.providerId,
              requestedModelId: attribution.requestedModelId ?? request.model,
              attribution,
              transportAttemptIndex: (dispatched.lastTransportAttemptIndex ?? 0) + 1,
              target,
              payload: fallbackPayload,
              timeoutMs,
              signal: request.signal,
              outputCapRecovery: {
                requestedOutputTokenCap: dispatched.logicalRequestedOutputTokenCap,
                retriesRemaining: dispatched.outputCapRetriesRemaining,
              },
              ...(retryParentEventId
                ? {
                    transportRetry: {
                      parentEventId: retryParentEventId,
                      reason: "metadata_compatibility" as const,
                    },
                  }
                : {}),
            });
            appendUniqueUsageEventIds(eventIds, dispatched);
            if (isRedirect(dispatched.response.status)) {
              throw new Error(`chat completion blocked redirect (${dispatched.response.status})`);
            }
            if (!dispatched.response.ok) {
              throw new Error(await buildHttpError("chat completion", dispatched.response));
            }
          } else {
            throw new Error(
              buildHttpErrorFromText(
                "chat completion",
                dispatched.response.status,
                dispatched.response.statusText,
                errorText,
              ),
            );
          }
        }

        for await (const event of streamJsonSseResponse(dispatched.response, {
          onDone: () => {
            providerTerminal = true;
          },
        })) {
          await dispatched.usage?.renewLease();
          const providerErrorText = readOpenAiCompatibleStreamErrorText(event);
          if (providerErrorText) {
            const failure = attachProviderUsageEvidence(createProviderStreamError(providerErrorText), event);
            const recovered = !emittedVisibleChunk
              ? await this.retryTrackedOutputCapFailure({
                  resolved,
                  model,
                  requestedProviderId: attribution.requestedProviderId ?? request.providerId,
                  requestedModelId: attribution.requestedModelId ?? request.model,
                  attribution,
                  transportAttemptIndex: dispatched.lastTransportAttemptIndex ?? 0,
                  target,
                  payload: dispatched.effectivePayload,
                  timeoutMs,
                  signal: request.signal,
                  outputCapRecovery: {
                    requestedOutputTokenCap: dispatched.logicalRequestedOutputTokenCap,
                    retriesRemaining: dispatched.outputCapRetriesRemaining,
                  },
                  dispatched,
                  providerErrorText,
                  providerFailureEvidence: failure,
                })
              : undefined;
            if (recovered) {
              terminal = true;
              dispatched = recovered;
              continue attemptLoop;
            }
            throw failure;
          }
          const chunk = applyEstimatedCostToStreamChunkWithSource(event, {
            providerId: resolved.provider.providerId,
            model,
          });
          if (hasChatStreamFinishReason(chunk)) providerTerminal = true;
          observeProviderUsageWithTrustedEstimate(dispatched.usage, event.usage, chunk.usage);
          dispatched.usage?.observeNormalized({ effectiveModelId: firstNonEmptyString(chunk.model) });
          emittedVisibleChunk = true;
          yield attachStreamUsageEvents(chunk, eventIds);
        }
        if (!providerTerminal) throw new Error("Chat completion stream ended before a terminal marker");
        await dispatched.usage?.succeed();
        terminal = true;
        return;
      } catch (error) {
        if (error instanceof ModelUsageSettlementError) {
          terminal = true;
          throw error;
        }
        await dispatched.usage?.fail(error);
        terminal = true;
        throw error;
      } finally {
        if (!terminal) await dispatched.usage?.cancel(new Error("stream consumer cancelled"));
      }
    }
  }

  private async executeOpenAiResponses(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse> {
    const payload = buildOpenAiResponsesPayload(request, model, resolved.provider);
    const codexResponsesProvider = isOpenAICodexResponsesProvider(resolved.provider);
    if (codexResponsesProvider) {
      payload.stream = true;
    }
    const target = this.buildRequestTarget(resolved, "responses", `${resolved.provider.baseUrl}/responses`);
    applyOpenAICodexResponsesLiteHeader(target.headers, resolved.provider, model);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    let dispatched = await this.postTrackedJsonRequest({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      target,
      payload,
      timeoutMs,
      signal: request.signal,
      outputCapRecovery: {
        requestedOutputTokenCap: request.max_tokens,
        retriesRemaining: 1,
      },
    });
    while (true) {
      try {
        if (isRedirect(dispatched.response.status)) {
          throw new Error(`responses request blocked redirect (${dispatched.response.status})`);
        }
        if (!dispatched.response.ok) {
          throw new Error(await buildHttpError("responses request", dispatched.response));
        }

        let rawCompletion: ChatCompletionResponse;
        if (codexResponsesProvider && dispatched.response.body) {
          try {
            rawCompletion = await collectOpenAiResponsesStreamCompletion(
              dispatched.response,
              model,
              resolveProviderSseEventLimit(resolved.provider, model),
            );
          } catch (error) {
            const providerErrorText = readProviderOwnedOutputCapFailureText(error);
            const recovered = providerErrorText
              ? await this.retryTrackedOutputCapFailure({
                  resolved,
                  model,
                  requestedProviderId: attribution.requestedProviderId ?? request.providerId,
                  requestedModelId: attribution.requestedModelId ?? request.model,
                  attribution,
                  transportAttemptIndex: dispatched.lastTransportAttemptIndex ?? 0,
                  target,
                  payload: dispatched.effectivePayload,
                  timeoutMs,
                  signal: request.signal,
                  outputCapRecovery: {
                    requestedOutputTokenCap: dispatched.logicalRequestedOutputTokenCap,
                    retriesRemaining: dispatched.outputCapRetriesRemaining,
                  },
                  dispatched,
                  providerErrorText,
                  providerFailureEvidence: error,
                })
              : undefined;
            if (recovered) {
              dispatched = recovered;
              continue;
            }
            throw error;
          }
        } else {
          const json = await parseProviderJsonResponse("responses request", dispatched.response);
          if (json.status === "failed") {
            const failure = buildResponsesStreamFailureError({ type: "response.failed", response: json });
            const providerErrorText = readProviderOwnedOutputCapFailureText(failure);
            const recovered = providerErrorText
              ? await this.retryTrackedOutputCapFailure({
                  resolved,
                  model,
                  requestedProviderId: attribution.requestedProviderId ?? request.providerId,
                  requestedModelId: attribution.requestedModelId ?? request.model,
                  attribution,
                  transportAttemptIndex: dispatched.lastTransportAttemptIndex ?? 0,
                  target,
                  payload: dispatched.effectivePayload,
                  timeoutMs,
                  signal: request.signal,
                  outputCapRecovery: {
                    requestedOutputTokenCap: dispatched.logicalRequestedOutputTokenCap,
                    retriesRemaining: dispatched.outputCapRetriesRemaining,
                  },
                  dispatched,
                  providerErrorText,
                  providerFailureEvidence: failure,
                })
              : undefined;
            if (recovered) {
              dispatched = recovered;
              continue;
            }
            throw failure;
          }
          rawCompletion = adaptOpenAiResponsesResponse(json);
        }
        const completion = applyEstimatedCostToChatResponseWithSource(rawCompletion, {
          providerId: resolved.provider.providerId,
          model,
        });
        observeProviderUsageWithTrustedEstimate(dispatched.usage, rawCompletion.usage, completion.usage);
        dispatched.usage?.observeNormalized({ effectiveModelId: completion.model });
        const terminal = await dispatched.usage?.succeed();
        const eventIds = [...(dispatched.priorModelUsageEventIds ?? [])];
        if (terminal) eventIds.push(terminal.eventId);
        return eventIds.length > 0 ? { ...completion, modelUsageEventIds: eventIds } : completion;
      } catch (error) {
        if (error instanceof ModelUsageSettlementError) throw error;
        observeProviderFailureUsage(dispatched.usage, error, {
          providerId: resolved.provider.providerId,
          model,
        });
        await dispatched.usage?.fail(error);
        throw error;
      }
    }
  }

  private async *executeOpenAiResponsesStream(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
    attribution: ModelUsageAttributionContext,
  ): AsyncGenerator<Record<string, unknown>> {
    const payload = buildOpenAiResponsesPayload(request, model, resolved.provider);
    payload.stream = true;

    const target = this.buildRequestTarget(resolved, "responses", `${resolved.provider.baseUrl}/responses`);
    applyOpenAICodexResponsesLiteHeader(target.headers, resolved.provider, model);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    let dispatched = await this.postTrackedJsonRequest({
      resolved,
      model,
      requestedProviderId: attribution.requestedProviderId ?? request.providerId,
      requestedModelId: attribution.requestedModelId ?? request.model,
      attribution,
      transportAttemptIndex: 0,
      target,
      payload,
      timeoutMs,
      signal: request.signal,
      outputCapRecovery: {
        requestedOutputTokenCap: request.max_tokens,
        retriesRemaining: 1,
      },
    });
    attemptLoop: while (true) {
      const accounting = dispatched.usage;
      const eventIds = [...(dispatched.priorModelUsageEventIds ?? []), ...(accounting ? [accounting.eventId] : [])];
      // eslint-disable-next-line no-useless-assignment -- async-generator cancellation reaches finally between yields.
      let terminal = false;
      let providerTerminal = false;
      let emittedVisibleChunk = false;
      try {
        if (isRedirect(dispatched.response.status)) {
          throw new Error(`responses request blocked redirect (${dispatched.response.status})`);
        }
        if (!dispatched.response.ok) {
          throw new Error(await buildHttpError("responses request", dispatched.response));
        }

        const contentType = dispatched.response.headers.get("content-type")?.toLowerCase() ?? "";
        const shouldParseAsSse =
          isOpenAICodexResponsesProvider(resolved.provider) || contentType.includes("text/event-stream");
        if (!shouldParseAsSse || !dispatched.response.body) {
          const json = await parseProviderJsonResponse("responses stream", dispatched.response);
          if (json.status === "failed") {
            const failure = buildResponsesStreamFailureError({ type: "response.failed", response: json });
            const providerErrorText = readProviderOwnedOutputCapFailureText(failure);
            const recovered = providerErrorText
              ? await this.retryTrackedOutputCapFailure({
                  resolved,
                  model,
                  requestedProviderId: attribution.requestedProviderId ?? request.providerId,
                  requestedModelId: attribution.requestedModelId ?? request.model,
                  attribution,
                  transportAttemptIndex: dispatched.lastTransportAttemptIndex ?? 0,
                  target,
                  payload: dispatched.effectivePayload,
                  timeoutMs,
                  signal: request.signal,
                  outputCapRecovery: {
                    requestedOutputTokenCap: dispatched.logicalRequestedOutputTokenCap,
                    retriesRemaining: dispatched.outputCapRetriesRemaining,
                  },
                  dispatched,
                  providerErrorText,
                  providerFailureEvidence: failure,
                })
              : undefined;
            if (recovered) {
              terminal = true;
              dispatched = recovered;
              continue attemptLoop;
            }
            throw failure;
          }
          const providerCompletion = adaptOpenAiResponsesResponse(json);
          const completion = applyEstimatedCostToChatResponseWithSource(providerCompletion, {
            providerId: resolved.provider.providerId,
            model,
          });
          observeProviderUsageWithTrustedEstimate(accounting, providerCompletion.usage, completion.usage);
          accounting?.observeNormalized({ effectiveModelId: completion.model });
          await accounting?.succeed();
          terminal = true;
          yield attachStreamUsageEvents(completion as Record<string, unknown>, eventIds);
          return;
        }

        const streamedFunctionCallIndexes = new Map<string, number>();
        let nextStreamedFunctionCallIndex = 0;
        const resolveStreamedFunctionCallIndex = (
          event: Record<string, unknown>,
          item: Record<string, unknown>,
        ): number => {
          const key =
            firstNonEmptyString(item.call_id, item.id, event.item_id) ?? `anonymous:${nextStreamedFunctionCallIndex}`;
          const existingIndex = streamedFunctionCallIndexes.get(key);
          if (existingIndex !== undefined) {
            return existingIndex;
          }
          const assignedIndex = nextStreamedFunctionCallIndex;
          nextStreamedFunctionCallIndex += 1;
          streamedFunctionCallIndexes.set(key, assignedIndex);
          return assignedIndex;
        };

        for await (const event of streamJsonSseResponse(dispatched.response, {
          forceSse: shouldParseAsSse,
          maxEvents: resolveProviderSseEventLimit(resolved.provider, model),
        })) {
          await accounting?.renewLease();
          const eventType = typeof event.type === "string" ? event.type : "";
          if (eventType === "response.output_text.delta") {
            emittedVisibleChunk = true;
            yield attachStreamUsageEvents(
              {
                id: String(event.item_id ?? event.response_id ?? event.id ?? "response"),
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: String(event.delta ?? ""),
                    },
                  },
                ],
              },
              eventIds,
            );
            continue;
          }

          if (eventType === "response.output_item.done") {
            const item = isRecord(event.item) ? event.item : undefined;
            if (item?.type === "function_call") {
              const toolCallIndex = resolveStreamedFunctionCallIndex(event, item);
              emittedVisibleChunk = true;
              yield attachStreamUsageEvents(
                {
                  id: String(item.id ?? event.item_id ?? "response"),
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolCallIndex,
                            id: String(item.call_id ?? item.id ?? "call"),
                            type: "function",
                            function: {
                              name: String(item.name ?? ""),
                              arguments: String(item.arguments ?? "{}"),
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                eventIds,
              );
            }
            continue;
          }

          if (eventType === "response.completed" && isRecord(event.response)) {
            const adapted = adaptOpenAiResponsesResponse(event.response);
            const finalChunk = applyEstimatedCostToStreamChunkWithSource(
              {
                id: adapted.id,
                model: adapted.model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason:
                      streamedFunctionCallIndexes.size > 0
                        ? "tool_calls"
                        : (adapted.choices?.[0]?.finish_reason ?? "stop"),
                  },
                ],
                usage: adapted.usage,
              },
              {
                providerId: resolved.provider.providerId,
                model,
              },
            );
            observeProviderUsageWithTrustedEstimate(accounting, adapted.usage, finalChunk.usage);
            accounting?.observeNormalized({ effectiveModelId: firstNonEmptyString(finalChunk.model) });
            providerTerminal = true;
            emittedVisibleChunk = true;
            yield attachStreamUsageEvents(finalChunk, eventIds);
            continue;
          }

          if (eventType === "response.failed") {
            const failure = buildResponsesStreamFailureError(event);
            const providerErrorText = readProviderOwnedOutputCapFailureText(failure);
            const recovered =
              !emittedVisibleChunk && providerErrorText
                ? await this.retryTrackedOutputCapFailure({
                    resolved,
                    model,
                    requestedProviderId: attribution.requestedProviderId ?? request.providerId,
                    requestedModelId: attribution.requestedModelId ?? request.model,
                    attribution,
                    transportAttemptIndex: dispatched.lastTransportAttemptIndex ?? 0,
                    target,
                    payload: dispatched.effectivePayload,
                    timeoutMs,
                    signal: request.signal,
                    outputCapRecovery: {
                      requestedOutputTokenCap: dispatched.logicalRequestedOutputTokenCap,
                      retriesRemaining: dispatched.outputCapRetriesRemaining,
                    },
                    dispatched,
                    providerErrorText,
                    providerFailureEvidence: failure,
                  })
                : undefined;
            if (recovered) {
              terminal = true;
              dispatched = recovered;
              continue attemptLoop;
            }
            throw failure;
          }
        }
        if (!providerTerminal) throw new Error("Responses stream ended before response.completed");
        await accounting?.succeed();
        terminal = true;
        return;
      } catch (error) {
        if (error instanceof ModelUsageSettlementError) {
          terminal = true;
          throw error;
        }
        observeProviderFailureUsage(accounting, error, {
          providerId: resolved.provider.providerId,
          model,
        });
        await accounting?.fail(error);
        terminal = true;
        throw error;
      } finally {
        if (!terminal) await accounting?.cancel(new Error("stream consumer cancelled"));
      }
    }
  }

  private async resolveProvider(
    providerId?: string,
    options: { requireAuth?: boolean } = {},
  ): Promise<ResolvedProvider> {
    const selectedId = normalizeConfiguredProviderId(providerId) ?? this.activeProviderId;
    if (!selectedId) {
      throw new Error("No active LLM provider is configured. Select a provider first.");
    }
    const provider = this.providers.get(selectedId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${selectedId}`);
    }

    const authMode = resolveProviderAuthMode(provider);
    if (authMode === "google-service-account" || authMode === "google-adc") {
      const secretStatus =
        authMode === "google-service-account"
          ? this.getProviderSecretStatus(provider.providerId, { includeKeychain: true, useCache: false })
          : undefined;
      if (secretStatus?.apiKeySource === "inline") {
        throw new Error(
          "Vertex AI service-account credentials must be stored in the Gateway keychain or referenced by apiKeyEnv.",
        );
      }
      const serviceAccountJson = authMode === "google-service-account" ? this.resolveApiKey(provider) : undefined;
      const cloud = await this.googleCloudAuth.resolve({
        providerId: provider.providerId,
        credentialMode: authMode === "google-service-account" ? "service-account" : "adc",
        serviceAccountJson,
        serviceAccountSource:
          secretStatus?.apiKeySource === "env"
            ? "env"
            : secretStatus?.apiKeySource === "keychain"
              ? "keychain"
              : undefined,
        projectId: resolveProviderEnvironmentValue(
          provider.googleCloud?.projectId,
          provider.googleCloud?.projectIdEnv,
          this.env,
        ),
        location: resolveProviderEnvironmentValue(
          provider.googleCloud?.location,
          provider.googleCloud?.locationEnv,
          this.env,
        ),
        endpointId: provider.googleCloud?.endpointId,
      });
      return {
        provider: { ...provider, baseUrl: cloud.baseUrl },
        apiKey: cloud.accessToken,
        credentialType: cloud.credentialType,
        credentialSource: cloud.credentialSource,
      };
    }

    const apiKey = isOpenAICodexProvider(provider)
      ? options.requireAuth
        ? await this.openAICodexOAuth.resolveAccessToken()
        : undefined
      : this.resolveApiKey(provider);
    if (options.requireAuth && provider.providerId.trim().toLowerCase() === "fireworks" && !apiKey) {
      throw new Error("Fireworks requires a configured API key before provider dispatch.");
    }
    return { provider, apiKey };
  }

  private async acquireLocalServiceLease(
    resolved: ResolvedProvider,
    purpose: LlmLocalServiceLeaseRequest["purpose"],
    signal?: AbortSignal,
  ): Promise<LlmLocalServiceLease | undefined> {
    if (resolved.provider.providerId.trim().toLowerCase() !== "llamacpp" || !this.localServiceLeaseAcquirer) {
      return undefined;
    }
    return this.localServiceLeaseAcquirer({
      providerId: resolved.provider.providerId,
      baseUrl: resolved.provider.baseUrl,
      purpose,
      signal,
    });
  }

  private async releaseLocalServiceLease(lease: LlmLocalServiceLease | undefined): Promise<void> {
    if (!lease) {
      return;
    }
    try {
      await lease.release();
    } catch (error) {
      log.warn("Failed to release local provider lease", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveRequestModel(provider: LlmProviderConfig, requestedModel?: string): string {
    const fallbackModel =
      provider.providerId === this.activeProviderId
        ? (normalizeConfiguredActiveModel(this.activeModel) ?? provider.defaultModel)
        : provider.defaultModel;

    const resolvedModel = resolveConfiguredModelForProvider(provider, requestedModel, {
      fallbackModel,
      onMismatch: "throw",
    });
    if (!resolvedModel) {
      throw new Error(`No model is configured for ${provider.label}. Select a model first.`);
    }
    return resolvedModel;
  }

  private resolveApiKey(provider: LlmProviderConfig): string | undefined {
    const keychain = this.readKeychainApiKey(provider.providerId);
    if (keychain) {
      return keychain;
    }
    if (provider.apiKeyEnv) {
      const envValue = this.env[provider.apiKeyEnv];
      if (envValue && envValue.trim()) {
        return envValue.trim();
      }
    }
    if (provider.apiKey && provider.apiKey.trim()) {
      return provider.apiKey.trim();
    }
    return undefined;
  }

  private readKeychainApiKey(providerId: string): string | undefined {
    try {
      return this.secretStore.getProviderApiKey(providerId);
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return undefined;
      }
      return undefined;
    }
  }

  private assertProviderHostAllowed(baseUrl: string): void {
    if (!this.enforceNetworkAllowlist) {
      return;
    }
    // When an explicit runtime allowlist is configured, enforce it here at the
    // hostname level. When it is empty (the default), this hostname check is a
    // no-op — but the provider request dispatcher still applies a fetch-time,
    // DNS-rebinding-safe resolved-IP guard (see createProviderGuardedLookup),
    // so a host that re-resolves to a private/metadata/loopback address at
    // fetch time is blocked even with an empty allowlist. See Finding 4.
    if (this.networkAllowlist.length === 0) {
      return;
    }
    assertHostAllowed(baseUrl, this.networkAllowlist);
  }

  private buildHeaders(
    resolved: ResolvedProvider,
    purpose: "chat" | "models" | "responses" | "messages" = "chat",
    bodyKind: "json" | "multipart" = "json",
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...(bodyKind === "json" ? { "Content-Type": "application/json" } : {}),
      ...(resolved.provider.request?.headers ?? {}),
    };
    const explicitAuth = resolved.provider.request?.auth;
    const useAnthropicNativeHeaders =
      isAnthropicApiKeyProvider(resolved.provider) && (purpose === "models" || purpose === "messages");
    const useClaudeCodeOAuthHeaders =
      isClaudeCodeOAuthProvider(resolved.provider) && (purpose === "models" || purpose === "messages");

    delete headers.Authorization;
    delete headers["x-api-key"];
    applyRequestAuthHeaders(headers, explicitAuth, this.env, resolved.apiKey);
    if (useClaudeCodeOAuthHeaders && !explicitAuth && resolved.apiKey) {
      headers.Authorization = `Bearer ${resolved.apiKey}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
      delete headers["x-api-key"];
    } else if (useAnthropicNativeHeaders && !explicitAuth && resolved.apiKey) {
      headers["x-api-key"] = resolved.apiKey;
      delete headers.Authorization;
    } else if (!explicitAuth && resolved.apiKey) {
      headers.Authorization = `Bearer ${resolved.apiKey}`;
    }
    if (useAnthropicNativeHeaders || useClaudeCodeOAuthHeaders) {
      headers["anthropic-version"] = "2023-06-01";
    }
    return headers;
  }

  private buildRequestTarget(
    resolved: ResolvedProvider,
    purpose: "chat" | "models" | "responses" | "messages",
    endpoint: string,
    bodyKind: "json" | "multipart" = "json",
  ): ProviderRequestTarget {
    const headers = this.buildHeaders(resolved, purpose, bodyKind);
    const dispatcher = this.resolveRequestDispatcher(endpoint, resolved.provider.request);
    const auth = resolved.provider.request?.auth;
    if (!auth || auth.type !== "query") {
      return { url: endpoint, headers, dispatcher };
    }
    const secret = resolveRequestAuthSecret(auth, this.env, resolved.apiKey);
    if (!secret) {
      return { url: endpoint, headers, dispatcher };
    }
    const url = new URL(endpoint);
    url.searchParams.set(auth.queryParam, `${auth.prefix ?? ""}${secret}`);
    return {
      url: url.toString(),
      headers,
      dispatcher,
    };
  }

  private resolveRequestDispatcher(
    endpoint: string,
    requestConfig: LlmProviderRequestConfig | undefined,
  ): Dispatcher | undefined {
    const targetUrl = new URL(endpoint);
    // SECURITY (Finding 4): every provider request now runs through a dispatcher
    // carrying a DNS-rebinding-safe guarded lookup — including the common case
    // with no proxy/TLS, which previously fell through to the unguarded global
    // fetch dispatcher. A configured proxy resolves the origin at the proxy, so
    // the local lookup cannot see it there; that path is deliberate operator
    // egress and still passes the hostname allowlist check upstream.
    const usesProxy = Boolean(
      requestConfig?.proxy && !shouldBypassProxy(targetUrl.hostname, requestConfig.proxy.bypassHosts),
    );
    const guardedLookup = usesProxy
      ? undefined
      : createProviderGuardedLookup(endpoint, this.dnsLookup, () => this.networkAllowlist);

    const cacheKey = buildRequestDispatcherCacheKey(targetUrl, requestConfig);
    const cached = this.requestDispatcherCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const dispatcher = createRequestDispatcher(targetUrl, requestConfig, this.env, this.tlsPathPolicy, guardedLookup);
    if (!dispatcher) {
      return undefined;
    }
    this.requestDispatcherCache.set(cacheKey, dispatcher);
    return dispatcher;
  }

  private clearRequestDispatcherCache(): void {
    for (const dispatcher of this.requestDispatcherCache.values()) {
      const close = (dispatcher as { close?: () => Promise<void> }).close;
      if (typeof close === "function") {
        void close.call(dispatcher).catch((error) => {
          log.debug("request dispatcher close failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    this.requestDispatcherCache.clear();
  }

  private buildQuickSecretStatus(provider: LlmProviderConfig): LlmProviderSecretStatus {
    const envSecret = provider.apiKeyEnv ? this.env[provider.apiKeyEnv]?.trim() : undefined;
    const inlineSecret = provider.apiKey?.trim();
    if (envSecret) {
      return {
        providerId: provider.providerId,
        hasApiKey: true,
        apiKeySource: "env",
        hasKeychainSecret: false,
        apiKeyRef: provider.apiKeyEnv,
      };
    }
    if (inlineSecret) {
      return {
        providerId: provider.providerId,
        hasApiKey: true,
        apiKeySource: "inline",
        hasKeychainSecret: false,
      };
    }
    return {
      providerId: provider.providerId,
      hasApiKey: false,
      apiKeySource: "none",
      hasKeychainSecret: false,
      apiKeyRef: provider.apiKeyEnv,
    };
  }

  private getCachedSecretStatus(providerId: string): LlmProviderSecretStatus | undefined {
    const cached = this.secretStatusCache.get(providerId);
    if (!cached) {
      return undefined;
    }
    if (Date.now() - cached.cachedAt > SECRET_STATUS_CACHE_TTL_MS) {
      this.secretStatusCache.delete(providerId);
      return undefined;
    }
    return cached.status;
  }

  private setCachedSecretStatus(status: LlmProviderSecretStatus): void {
    this.secretStatusCache.set(status.providerId, {
      status,
      cachedAt: Date.now(),
    });
  }

  private getModelDiscoveryAuthCacheToken(apiKey: string): string {
    let token = this.modelDiscoveryAuthTokens.get(apiKey);
    if (token === undefined) {
      token = randomUUID();
      this.modelDiscoveryAuthTokens.set(apiKey, token);
    }
    return token;
  }

  private async fetchModelsForResolvedProvider(resolved: ResolvedProvider): Promise<ModelDiscoveryResult> {
    const keys = this.buildModelDiscoveryCacheKeys(resolved);
    const now = Date.now();
    const cached = this.modelDiscoveryCache.get(keys.exact) ?? this.modelDiscoveryCache.get(keys.persisted);
    if (cached) {
      const ageMs = now - cached.cachedAt;
      if (ageMs < LlmService.MODEL_DISCOVERY_TTL_MS) {
        log.debug("model catalog cache hit", {
          providerId: resolved.provider.providerId,
          ageMs,
          itemCount: cached.result.items.length,
        });
        return cached.result;
      }

      // Stale-while-revalidate: if younger than 1 hour, return cached immediately
      // and trigger a background refresh. Disk-hydrated bootstrap entries are
      // also returned immediately even when older so Gateway readiness never
      // waits on remote provider catalog hydration.
      if (ageMs < 3600_000 || cached.origin === "disk") {
        log.debug("model catalog cache hit (stale, revalidating in background)", {
          providerId: resolved.provider.providerId,
          ageMs,
          itemCount: cached.result.items.length,
          origin: cached.origin,
        });

        const inFlight = this.modelDiscoveryInFlight.get(keys.exact);
        if (!inFlight) {
          const pending = this.fetchModelsForResolvedProviderUncached(resolved)
            .then((result) => {
              if (result.source !== "error_fallback") {
                this.setModelDiscoveryCacheEntry(keys, result, Date.now(), resolved, { persist: true });
              }
              return result;
            })
            .catch((error) => {
              log.warn("model catalog background revalidation failed", {
                providerId: resolved.provider.providerId,
                error: error instanceof Error ? error.message : String(error),
              });
              return cached.result;
            })
            .finally(() => {
              this.modelDiscoveryInFlight.delete(keys.exact);
            });
          this.modelDiscoveryInFlight.set(keys.exact, pending);
        }
        return markStaleModelDiscoveryResult(cached.result, cached.origin);
      }
    }
    // Stampede protection: coalesce concurrent cold-cache callers onto a single fetch.
    const inFlight = this.modelDiscoveryInFlight.get(keys.exact);
    if (inFlight) {
      return inFlight;
    }
    const pending = this.fetchModelsForResolvedProviderUncached(resolved)
      .then((result) => {
        // Cache live + template_fallback (successful fetches with known catalog), but
        // skip error_fallback so transient network errors retry on the next call.
        if (result.source !== "error_fallback") {
          this.setModelDiscoveryCacheEntry(keys, result, Date.now(), resolved, { persist: true });
        }
        return result;
      })
      .finally(() => {
        this.modelDiscoveryInFlight.delete(keys.exact);
      });
    this.modelDiscoveryInFlight.set(keys.exact, pending);
    return pending;
  }

  private buildModelDiscoveryCacheKeys(resolved: ResolvedProvider): ModelDiscoveryCacheKeys {
    const persisted = buildPersistedModelDiscoveryCacheKey(resolved.provider.providerId, resolved.provider.baseUrl);
    let exact = `${resolved.provider.providerId}::${resolved.provider.baseUrl}`;
    if (resolved.apiKey) {
      exact += `::auth_${this.getModelDiscoveryAuthCacheToken(resolved.apiKey)}`;
    }
    return { exact, persisted };
  }

  private setModelDiscoveryCacheEntry(
    keys: ModelDiscoveryCacheKeys,
    result: ModelDiscoveryResult,
    cachedAt: number,
    resolved: ResolvedProvider,
    options: { persist: boolean },
  ): void {
    const entry: ModelDiscoveryCacheEntry = {
      cachedAt,
      result,
      origin: "memory",
    };
    this.modelDiscoveryCache.set(keys.exact, entry);
    this.modelDiscoveryCache.set(keys.persisted, entry);
    if (options.persist && result.source !== "error_fallback") {
      this.persistModelDiscoverySnapshot(resolved.provider, result, cachedAt);
    }
  }

  private hydrateModelDiscoveryCacheFromDisk(): void {
    const snapshots = this.readPersistedModelCatalogSnapshots();
    if (snapshots.length === 0) {
      return;
    }
    for (const snapshot of snapshots) {
      const provider = this.providers.get(snapshot.providerId);
      if (!provider || provider.baseUrl !== snapshot.baseUrl) {
        continue;
      }
      const cachedAt = Date.parse(snapshot.cachedAt);
      if (!Number.isFinite(cachedAt) || snapshot.items.length === 0) {
        continue;
      }
      this.modelDiscoveryCache.set(buildPersistedModelDiscoveryCacheKey(snapshot.providerId, snapshot.baseUrl), {
        cachedAt,
        origin: "disk",
        result: {
          items: snapshot.items,
          source: snapshot.source,
          warning: snapshot.warning,
        },
      });
    }
  }

  private persistModelDiscoverySnapshot(
    provider: LlmProviderConfig,
    result: ModelDiscoveryResult,
    cachedAt: number,
  ): void {
    if (!this.modelCatalogCachePath || result.source === "error_fallback" || result.items.length === 0) {
      return;
    }
    try {
      const existing = this.readPersistedModelCatalogSnapshots().filter(
        (snapshot) => !(snapshot.providerId === provider.providerId && snapshot.baseUrl === provider.baseUrl),
      );
      const snapshot = buildProviderModelCatalogSnapshot(provider, result, cachedAt);
      const payload: PersistedModelCatalogFile = {
        version: 1,
        snapshots: [...existing, snapshot],
      };
      mkdirSync(path.dirname(this.modelCatalogCachePath), { recursive: true });
      writeFileSync(this.modelCatalogCachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch (error) {
      log.warn("failed to persist model catalog cache", {
        providerId: provider.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private readPersistedModelCatalogSnapshots(): ProviderModelCatalogSnapshot[] {
    if (!this.modelCatalogCachePath || !existsSync(this.modelCatalogCachePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(this.modelCatalogCachePath, "utf8")) as Partial<PersistedModelCatalogFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.snapshots)) {
        return [];
      }
      return parsed.snapshots.filter(isProviderModelCatalogSnapshot);
    } catch (error) {
      log.warn("failed to read model catalog cache", {
        path: this.modelCatalogCachePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async fetchModelsForResolvedProviderUncached(resolved: ResolvedProvider): Promise<ModelDiscoveryResult> {
    const fallback = buildFallbackModelCatalog(resolved.provider.providerId, resolved.provider.defaultModel);
    if (isOpenAICodexProvider(resolved.provider)) {
      return {
        items: fallback,
        source: "template_fallback",
        warning:
          "OpenAI Codex model catalog is sourced from GoatCitadel's template because ChatGPT OAuth does not expose a stable /models endpoint.",
      };
    }
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const target = this.buildRequestTarget(resolved, "models", `${resolved.provider.baseUrl}/models`);
    const discoverySignal = AbortSignal.timeout(15_000);
    const lease = await this.acquireLocalServiceLease(resolved, "model_discovery", discoverySignal);

    try {
      const requestInit: FetchRequestInitWithDispatcher = {
        method: "GET",
        headers: target.headers,
        signal: discoverySignal,
        redirect: "manual",
        dispatcher: target.dispatcher,
      };
      let response: Response;
      try {
        response = await fetch(target.url, requestInit);
      } catch (error) {
        rethrowIfProviderNetworkBlocked(error);
        throw error;
      }

      if (isRedirect(response.status)) {
        throw new Error(`model listing blocked redirect (${response.status})`);
      }

      if (!response.ok) {
        if (fallback.length > 0) {
          return {
            items: fallback,
            source: "error_fallback",
            warning: await buildHttpError("model listing", response),
          };
        }
        throw new Error(await buildHttpError("model listing", response));
      }

      const json = await parseProviderJsonResponse<unknown>("model listing", response);
      const items = normalizeModelRecords(json);
      if (items.length > 0) {
        return { items, source: "live" };
      }
      return {
        items: fallback,
        source: "template_fallback",
        warning: "Provider returned no models. Falling back to GoatCitadel's provider template.",
      };
    } catch (error) {
      // An SSRF/rebinding block must never be masked by a template-model
      // fallback — surface it so the caller sees the provider was blocked.
      if (error instanceof ProviderNetworkBlockedError) {
        throw error;
      }
      if (fallback.length > 0) {
        return { items: fallback, source: "error_fallback", warning: (error as Error).message };
      }
      throw error;
    } finally {
      await this.releaseLocalServiceLease(lease);
    }
  }
}

function buildPersistedModelDiscoveryCacheKey(providerId: string, baseUrl: string): string {
  return `${providerId}::${baseUrl}::persisted`;
}

function markStaleModelDiscoveryResult(result: ModelDiscoveryResult, origin: "memory" | "disk"): ModelDiscoveryResult {
  if (origin !== "disk") {
    return result;
  }
  return {
    ...result,
    warning:
      result.warning ?? "Loaded from local model catalog cache; remote provider refresh is running in background.",
  };
}

function buildProviderModelCatalogSnapshot(
  provider: LlmProviderConfig,
  result: ModelDiscoveryResult,
  cachedAt: number,
): ProviderModelCatalogSnapshot {
  const items = result.items.map((item) => ({ ...item }));
  return {
    snapshotId: `model-catalog-${provider.providerId}-${createHash("sha256")
      .update(`${provider.providerId}\0${provider.baseUrl}\0${cachedAt}`)
      .digest("hex")
      .slice(0, 16)}`,
    providerId: provider.providerId,
    baseUrl: provider.baseUrl,
    createdAt: new Date().toISOString(),
    cachedAt: new Date(cachedAt).toISOString(),
    source: result.source === "live" ? "live" : "template_fallback",
    status: result.source === "live" ? "fresh" : "fallback",
    items,
    itemCount: items.length,
    catalogHash: buildModelCatalogHash(items),
    warning: result.warning,
  };
}

function buildModelCatalogHash(items: LlmModelRecord[]): string {
  const normalized = [...items].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function isProviderModelCatalogSnapshot(value: unknown): value is ProviderModelCatalogSnapshot {
  const record = value as Partial<ProviderModelCatalogSnapshot> | undefined;
  return Boolean(
    record &&
    typeof record.snapshotId === "string" &&
    typeof record.providerId === "string" &&
    typeof record.baseUrl === "string" &&
    typeof record.cachedAt === "string" &&
    (record.source === "live" || record.source === "template_fallback") &&
    Array.isArray(record.items) &&
    record.items.every(isLlmModelRecord),
  );
}

function isLlmModelRecord(value: unknown): value is LlmModelRecord {
  const record = value as Partial<LlmModelRecord> | undefined;
  return Boolean(record && typeof record.id === "string" && record.id.trim().length > 0);
}

function normalizeProvider(provider: LlmProviderConfig): LlmProviderConfig {
  const base = provider.baseUrl.trim().replace(/\/+$/, "");
  validateProviderBaseUrl(base);
  const canonicalBase = canonicalizeProviderUrl(provider.providerId, base);
  const withV1 = shouldAppendV1(provider.providerId, canonicalBase) ? `${canonicalBase}/v1` : canonicalBase;
  return {
    ...provider,
    baseUrl: withV1,
    apiStyle: normalizeProviderApiStyle(provider.providerId, provider.apiStyle),
    authMode:
      provider.providerId === "openai-codex"
        ? "codex-oauth"
        : provider.providerId === "claude-code"
          ? "claude-code-oauth"
          : (provider.authMode ?? defaultAuthModeForProvider(provider.providerId)),
    googleCloud: normalizeGoogleCloudConfig(provider.googleCloud),
    request: normalizeProviderRequestConfig(provider.request, provider.headers),
    headers: undefined,
  };
}

function normalizeProviderRequestConfig(
  request: LlmProviderRequestConfig | undefined,
  legacyHeaders: Record<string, string> | undefined,
): LlmProviderRequestConfig | undefined {
  const headers = {
    ...(legacyHeaders ?? {}),
    ...(request?.headers ?? {}),
  };
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key.trim(), value] as const)
      .filter(([key, value]) => key.length > 0 && typeof value === "string"),
  );
  const normalizedRequest: LlmProviderRequestConfig = {
    ...(request ?? {}),
    headers: Object.keys(normalizedHeaders).length > 0 ? normalizedHeaders : undefined,
  };
  if (!normalizedRequest.headers && !normalizedRequest.auth && !normalizedRequest.proxy && !normalizedRequest.tls) {
    return undefined;
  }
  return normalizedRequest;
}

function normalizeGoogleCloudConfig(config: LlmProviderConfig["googleCloud"]): LlmProviderConfig["googleCloud"] {
  if (!config) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(config)
      .map(([key, value]) => [key, value?.trim()] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  ) as LlmProviderConfig["googleCloud"];
  return normalized && Object.keys(normalized).length > 0 ? normalized : undefined;
}

// SECURITY (codex finding #25a, #30): Compare the origin of two provider
// base URLs. Used by `previewModels` to decide whether the caller-supplied
// baseUrl is the same provider origin as the configured one;
// if not, inheriting stored secrets is unsafe.
export function previewHostsMatch(configuredBaseUrl: string | undefined, requestedBaseUrl: string): boolean {
  if (!configuredBaseUrl?.trim()) {
    return true;
  }
  try {
    const configured = new URL(configuredBaseUrl).origin.toLowerCase();
    const requested = new URL(requestedBaseUrl).origin.toLowerCase();
    return configured === requested;
  } catch {
    return false;
  }
}

function previewProxyRoutesMatch(
  existingRequest: LlmProviderRequestConfig | undefined,
  previewRequest: LlmProviderRequestConfig | undefined,
): boolean {
  if (!previewRequest) {
    return true;
  }
  const configuredProxyUrl = existingRequest?.proxy?.url?.trim();
  const requestedProxyUrl = previewRequest.proxy?.url?.trim();
  if (!configuredProxyUrl && !requestedProxyUrl) {
    return true;
  }
  if (!configuredProxyUrl || !requestedProxyUrl) {
    return false;
  }
  return previewHostsMatch(configuredProxyUrl, requestedProxyUrl);
}

function assertPreviewEnvironmentReferencesBound(
  existing: LlmProviderConfig | undefined,
  input: LlmModelPreviewRequest,
): void {
  const apiKeyEnv = input.apiKeyEnv?.trim();
  const requestAuthEnv = readRequestAuthEnvironmentReference(input.request?.auth);
  const proxyAuthEnv = readRequestAuthEnvironmentReference(input.request?.proxy?.auth);
  if (!apiKeyEnv && !requestAuthEnv && !proxyAuthEnv) {
    return;
  }
  if (!existing || !previewHostsMatch(existing.baseUrl, input.baseUrl)) {
    throw new Error("Preview environment credentials require a matching saved provider origin.");
  }
  if (apiKeyEnv && apiKeyEnv !== existing.apiKeyEnv?.trim()) {
    throw new Error("Preview apiKeyEnv must match the saved provider environment reference.");
  }
  if (requestAuthEnv) {
    const existingRequestAuthEnv = readRequestAuthEnvironmentReference(existing.request?.auth);
    if (requestAuthEnv !== existingRequestAuthEnv) {
      throw new Error("Preview request auth environment reference must match the saved provider configuration.");
    }
  }
  if (proxyAuthEnv) {
    const requestedProxyUrl = input.request?.proxy?.url;
    const existingProxyUrl = existing.request?.proxy?.url;
    const existingProxyAuthEnv = readRequestAuthEnvironmentReference(existing.request?.proxy?.auth);
    if (
      !requestedProxyUrl ||
      !existingProxyUrl ||
      !previewHostsMatch(existingProxyUrl, requestedProxyUrl) ||
      proxyAuthEnv !== existingProxyAuthEnv
    ) {
      throw new Error("Preview proxy auth environment reference must match the saved proxy configuration.");
    }
  }
  if ((apiKeyEnv || requestAuthEnv) && input.request?.proxy) {
    const existingProxyUrl = existing.request?.proxy?.url;
    if (!existingProxyUrl || !previewHostsMatch(existingProxyUrl, input.request.proxy.url)) {
      throw new Error("Preview requests using environment credentials require the saved provider proxy.");
    }
  }
}

function readRequestAuthEnvironmentReference(
  auth: LlmProviderRequestAuthConfig | LlmProviderRequestProxyAuthConfig | undefined,
): string | undefined {
  if (!auth) {
    return undefined;
  }
  return (auth.type === "bearer" ? auth.tokenEnv : auth.valueEnv)?.trim() || undefined;
}

// SECURITY (codex finding #15): Strip every secret-bearing field from a
// provider request config before serializing it for the LLM config
// endpoint. The endpoint is reachable to authenticated principals
// including device/companion tokens, and the raw `provider.request` object
// previously contained inline `auth.token`, `auth.value`, `proxy.auth.*`,
// and `headers["Authorization"]` values.
//
// We KEEP the non-secret fields (envVar names, tls.caFingerprint, proxy
// URL) so the UI can show which transport is in use, but never the values
// themselves. Env-var name fields are non-secret on their own — they merely
// tell the operator which env variable holds the real value.
function scrubProviderRequestSecrets(
  request: LlmProviderRequestConfig | undefined,
): LlmProviderRequestConfig | undefined {
  if (!request) {
    return undefined;
  }
  const cleaned: LlmProviderRequestConfig = {};
  if (request.auth) {
    if (request.auth.type === "bearer") {
      const auth: LlmProviderRequestAuthConfig = { type: "bearer" };
      if (request.auth.headerName) {
        auth.headerName = request.auth.headerName;
      }
      if (request.auth.tokenEnv) {
        // env-var NAME is fine to disclose; the value of the env var is not.
        auth.tokenEnv = request.auth.tokenEnv;
      }
      // Drop `auth.token` (inline literal secret).
      cleaned.auth = auth;
    } else if (request.auth.type === "header") {
      const auth: LlmProviderRequestAuthConfig = {
        type: "header",
        headerName: request.auth.headerName,
      };
      if (request.auth.scheme) {
        auth.scheme = request.auth.scheme;
      }
      if (request.auth.valueEnv) {
        auth.valueEnv = request.auth.valueEnv;
      }
      // Drop `auth.value` (inline literal secret).
      cleaned.auth = auth;
    }
  }
  if (request.proxy) {
    const proxyClean: NonNullable<LlmProviderRequestConfig["proxy"]> = { url: request.proxy.url };
    if (request.proxy.bypassHosts && request.proxy.bypassHosts.length > 0) {
      proxyClean.bypassHosts = [...request.proxy.bypassHosts];
    }
    if (request.proxy.auth) {
      if (request.proxy.auth.type === "bearer") {
        const auth: LlmProviderRequestProxyAuthConfig = { type: "bearer" };
        if (request.proxy.auth.headerName) {
          auth.headerName = request.proxy.auth.headerName;
        }
        if (request.proxy.auth.tokenEnv) {
          auth.tokenEnv = request.proxy.auth.tokenEnv;
        }
        proxyClean.auth = auth;
      } else if (request.proxy.auth.type === "header") {
        const auth: LlmProviderRequestProxyAuthConfig = {
          type: "header",
          headerName: request.proxy.auth.headerName,
        };
        if (request.proxy.auth.scheme) {
          auth.scheme = request.proxy.auth.scheme;
        }
        if (request.proxy.auth.valueEnv) {
          auth.valueEnv = request.proxy.auth.valueEnv;
        }
        proxyClean.auth = auth;
      }
    }
    if (request.proxy.tls) {
      proxyClean.tls = scrubTlsConfig(request.proxy.tls);
    }
    cleaned.proxy = proxyClean;
  }
  if (request.tls) {
    cleaned.tls = scrubTlsConfig(request.tls);
  }
  // `request.headers` is intentionally dropped — its keys are arbitrary and
  // every Authorization/Cookie/X-API-Key header value would otherwise leak.
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function mergeProviderRequestConfig(
  existing: LlmProviderRequestConfig | undefined,
  incoming: LlmProviderRequestConfig | undefined,
): LlmProviderRequestConfig | undefined {
  if (!incoming) {
    return existing ? structuredClone(existing) : undefined;
  }
  const merged: LlmProviderRequestConfig = { ...structuredClone(existing), ...structuredClone(incoming) };
  merged.headers = mergeProviderHeaders(existing?.headers, incoming.headers);
  merged.auth = mergeProviderAuthConfig(existing?.auth, incoming.auth);
  if (incoming.proxy) {
    merged.proxy = {
      ...structuredClone(existing?.proxy),
      ...structuredClone(incoming.proxy),
      url: preserveProjectedProviderString(existing?.proxy?.url, incoming.proxy.url) ?? incoming.proxy.url,
      auth: mergeProviderAuthConfig(existing?.proxy?.auth, incoming.proxy.auth),
      tls: mergeProviderTlsConfig(existing?.proxy?.tls, incoming.proxy.tls),
    };
  } else if (existing?.proxy) {
    merged.proxy = structuredClone(existing.proxy);
  }
  merged.tls = mergeProviderTlsConfig(existing?.tls, incoming.tls);
  return merged;
}

function mergeProviderHeaders(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  return { ...existing, ...incoming };
}

function mergeGoogleCloudConfig(
  existing: LlmProviderConfig["googleCloud"],
  incoming: LlmProviderConfig["googleCloud"],
): LlmProviderConfig["googleCloud"] {
  if (!incoming) return existing ? { ...existing } : undefined;
  return { ...existing, ...incoming };
}

function mergeProviderAuthConfig<T extends LlmProviderRequestAuthConfig | LlmProviderRequestProxyAuthConfig>(
  existing: T | undefined,
  incoming: T | undefined,
): T | undefined {
  if (!incoming) {
    return existing ? structuredClone(existing) : undefined;
  }
  if (!existing || existing.type !== incoming.type) {
    return structuredClone(incoming);
  }
  const raw = existing as unknown as Record<string, unknown>;
  const update = incoming as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...raw, ...update };
  for (const key of ["token", "value"] as const) {
    if (update[key] === SECRET_REDACTION_MARKER) {
      merged[key] = raw[key];
    }
  }
  return merged as unknown as T;
}

function mergeProviderTlsConfig(
  existing: LlmProviderRequestTlsConfig | undefined,
  incoming: LlmProviderRequestTlsConfig | undefined,
): LlmProviderRequestTlsConfig | undefined {
  if (!incoming) {
    return existing ? structuredClone(existing) : undefined;
  }
  return { ...structuredClone(existing), ...structuredClone(incoming) };
}

function preserveProjectedProviderString(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  return incoming?.includes(SECRET_REDACTION_MARKER) ? existing : incoming;
}

// Helper: TLS config in this contract has only non-secret fields (paths
// and flags), but file paths can reveal local layout, so we keep only the
// shape that's safe to surface to ordinary authenticated callers.
function scrubTlsConfig(tls: LlmProviderRequestTlsConfig): LlmProviderRequestTlsConfig {
  const cleaned: LlmProviderRequestTlsConfig = {};
  if (typeof tls.insecureSkipVerify === "boolean") {
    cleaned.insecureSkipVerify = tls.insecureSkipVerify;
  }
  if (tls.serverName) {
    cleaned.serverName = tls.serverName;
  }
  // caCertPath / clientCertPath / clientKeyPath omitted — they reveal local
  // filesystem layout and indirectly hint at which secrets are in play.
  return cleaned;
}

function normalizeProviderApiStyle(providerId: string, apiStyle: LlmApiStyle | undefined): LlmApiStyle {
  if (providerId === "openai-codex") {
    return "openai-codex-responses";
  }
  if (
    apiStyle === "openai-chat-completions" ||
    apiStyle === "openai-responses" ||
    apiStyle === "openai-codex-responses" ||
    apiStyle === "anthropic-messages" ||
    apiStyle === "bedrock-messages"
  ) {
    return apiStyle;
  }
  if (providerId === "openai") {
    return "openai-responses";
  }
  if (providerId === "anthropic" || providerId === "claude-code") {
    return "anthropic-messages";
  }
  return "openai-chat-completions";
}

function resolveProviderExecutionApiStyle(provider: LlmProviderConfig, model: string): LlmApiStyle {
  if (isOpenAICodexProvider(provider)) {
    return "openai-codex-responses";
  }

  if (provider.providerId === "openai") {
    if (provider.apiStyle === "openai-chat-completions") {
      return "openai-chat-completions";
    }
    return isOpenAiResponsesPreferredModel(model) ? "openai-responses" : "openai-chat-completions";
  }

  if (provider.providerId === "anthropic" || provider.providerId === "claude-code") {
    return provider.apiStyle === "openai-chat-completions" ? "openai-chat-completions" : "anthropic-messages";
  }

  return provider.apiStyle === "openai-responses" || provider.apiStyle === "openai-codex-responses"
    ? "openai-chat-completions"
    : provider.apiStyle;
}

function isOpenAiResponsesPreferredModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^gpt-5(?:$|[.-])/.test(normalized);
}

function resolveConfiguredModelForProvider(
  provider: LlmProviderConfig,
  model: string | undefined,
  options: {
    fallbackModel?: string;
    onMismatch: "fallback" | "throw";
  },
): string | undefined {
  const normalizedModel = normalizeConfiguredActiveModel(model);
  if (!normalizedModel) {
    return options.fallbackModel ? normalizeRequestedModel(provider.providerId, options.fallbackModel) : undefined;
  }

  const foreignProviderId = inferForeignProviderForModel(provider.providerId, normalizedModel);
  if (foreignProviderId) {
    if (options.onMismatch === "throw") {
      throw new Error(
        `Model ${normalizedModel} belongs to ${foreignProviderId}; switch providers or choose a ${provider.providerId} model.`,
      );
    }
    return options.fallbackModel ? normalizeRequestedModel(provider.providerId, options.fallbackModel) : undefined;
  }

  return normalizeRequestedModel(provider.providerId, normalizedModel);
}

function inferForeignProviderForModel(providerId: string, model: string): string | undefined {
  if (providerAllowsForeignModelIds(providerId)) {
    return undefined;
  }
  if (providerRecognizesModelId(providerId, model)) {
    return undefined;
  }
  const ownerProviderId = inferProviderForModelId(model);
  if (!ownerProviderId || ownerProviderId === providerId) {
    return undefined;
  }
  if (providerId === "claude-code" && ownerProviderId === "anthropic") {
    return undefined;
  }
  return ownerProviderId;
}

function normalizeRequestedModel(providerId: string, model: string): string {
  const trimmed = model.trim();
  if (providerId === "claude-code") {
    return trimmed.replace(/^claude-code\//i, "");
  }
  if (providerId === "openai-codex") {
    return trimmed.replace(/^openai-codex\//i, "");
  }
  if (providerId !== "google") {
    return trimmed;
  }

  if (!trimmed || trimmed.startsWith("models/")) {
    return trimmed;
  }

  if (/^(gemini|gemma)-/i.test(trimmed)) {
    return `models/${trimmed}`;
  }

  return trimmed;
}

/**
 * Data-driven provider URL canonicalization rules.
 * Adding a new provider URL quirk is a config change, not a code change.
 */
const PROVIDER_URL_CANONICALIZATION: Record<string, { match: RegExp; replace: string }[]> = {
  google: [{ match: /\/v1beta\/openai\/v1$/i, replace: "/v1beta/openai" }],
  moonshot: [{ match: /api\.moonshot\.cn/i, replace: "api.moonshot.ai" }],
  minimax: [{ match: /api\.minimax\.chat/i, replace: "api.minimax.io" }],
};

function canonicalizeProviderUrl(providerId: string, baseUrl: string): string {
  if (providerId === "openai-codex") {
    return "https://chatgpt.com/backend-api/codex";
  }
  const rules = PROVIDER_URL_CANONICALIZATION[providerId];
  if (rules) {
    let result = baseUrl;
    for (const rule of rules) {
      if (rule.match.test(result)) {
        result = result.replace(rule.match, rule.replace);
      }
    }
    return result;
  }

  // Perplexity needs pathname-level logic that doesn't fit the simple match/replace model.
  if (providerId === "perplexity") {
    const parsed = new URL(baseUrl);
    const urlPath = parsed.pathname.replace(/\/+$/, "");
    if (urlPath === "/v1" || urlPath === "/api/v1") {
      parsed.pathname = "/";
      return parsed.toString().replace(/\/+$/, "");
    }
  }

  return baseUrl;
}

function buildFallbackModelCatalog(providerId: string, defaultModel: string | undefined): LlmModelRecord[] {
  const template = findProviderTemplate(providerId);
  const ids = new Set<string>();

  const pushId = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) {
      ids.add(trimmed);
    }
  };

  pushId(defaultModel);
  for (const model of template?.knownModels ?? []) {
    pushId(model);
  }

  return Array.from(ids, (id) => ({ id }));
}

function defaultModelMetadataPath(configFilePath: string | undefined): string {
  if (!configFilePath) {
    return findNearestModelMetadataPath(process.cwd()) ?? "config/llm-model-metadata.json";
  }
  return path.join(path.dirname(configFilePath), "llm-model-metadata.json");
}

function findNearestModelMetadataPath(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "config", "llm-model-metadata.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function normalizeModelRecords(payload: unknown): LlmModelRecord[] {
  const records = extractModelRecordArray(payload);
  const normalized: LlmModelRecord[] = [];
  for (const record of records) {
    const id = extractModelId(record);
    if (!id) {
      continue;
    }
    normalized.push({
      id,
      label: extractModelLabel(record, id),
      ownedBy:
        typeof record.owned_by === "string"
          ? record.owned_by
          : typeof record.ownedBy === "string"
            ? record.ownedBy
            : undefined,
      created:
        typeof record.created === "number"
          ? record.created
          : typeof record.created_at === "number"
            ? record.created_at
            : typeof record.createdAt === "number"
              ? record.createdAt
              : undefined,
      contextWindow: extractPositiveInteger(
        // `context_length` is the OpenRouter/aggregator field name.
        record.context_length ?? record.context_window ?? record.contextWindow ?? record.max_context_length,
      ),
      outputTokenLimit: extractPositiveInteger(
        record.max_output_tokens ??
          record.output_token_limit ??
          record.outputTokenLimit ??
          // OpenRouter nests the completion cap under top_provider.
          (isPlainRecord(record.top_provider) ? record.top_provider.max_completion_tokens : undefined),
      ),
    });
  }
  return normalized;
}

function extractModelLabel(record: Record<string, unknown>, id: string): string | undefined {
  const candidates = [record.label, record.display_name, record.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed && trimmed !== id) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function extractPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : undefined;
}

function mergeModelCatalogs(primary: LlmModelRecord[], fallback: LlmModelRecord[]): LlmModelRecord[] {
  const merged: LlmModelRecord[] = [];
  const seen = new Set<string>();
  for (const record of [...primary, ...fallback]) {
    const id = record.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push({
      ...record,
      id,
    });
  }
  return merged;
}

function extractModelRecordArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(isPlainRecord);
  }
  if (!isPlainRecord(payload)) {
    return [];
  }

  const candidates = [payload.data, payload.items, payload.models];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isPlainRecord);
    }
  }

  return [];
}

function extractModelId(record: Record<string, unknown>): string | undefined {
  const candidates = [record.id, record.name, record.model];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shouldAppendV1(providerId: string, baseUrl: string): boolean {
  if (providerId === "perplexity" || providerId === "openai-codex" || providerId === "vertex") {
    return false;
  }
  const parsed = new URL(baseUrl);
  const path = parsed.pathname.replace(/\/+$/, "");

  // No path segment -> default to OpenAI-style /v1.
  if (!path || path === "/") {
    return true;
  }

  // Already points at v1 explicitly.
  if (/\/v1$/i.test(path)) {
    return false;
  }

  // Keep provider-specific versioned paths (e.g. /api/paas/v4, /v1beta/openai).
  if (/\/v\d+(?:\.\d+)?$/i.test(path) || /\/openai$/i.test(path)) {
    return false;
  }

  return true;
}

async function buildHttpError(action: string, response: Response): Promise<string> {
  const text = await readProviderErrorBody(action, response);
  const snippet = text.slice(0, 400);
  return `${action} failed (${response.status} ${response.statusText}): ${snippet}`;
}

async function readProviderErrorBody(action: string, response: Response): Promise<string> {
  return readBoundedResponseText(response, {
    maxBytes: MAX_PROVIDER_ERROR_BODY_BYTES,
    timeoutMs: PROVIDER_ERROR_BODY_TIMEOUT_MS,
    label: action,
  });
}

function buildHttpErrorFromText(action: string, status: number, statusText: string, text: string): string {
  const snippet = text.slice(0, 400);
  return `${action} failed (${status} ${statusText}): ${snippet}`;
}

// Re-exported for backward compatibility; the implementation now lives in
// ./llm-response-parsing.ts so provider adapters can import it without a cycle.
export { parseProviderJsonResponse };

function resolveRequestAuthSecret(
  auth: LlmProviderRequestAuthConfig,
  env: NodeJS.ProcessEnv,
  fallbackApiKey?: string,
): string | undefined {
  if (auth.type === "bearer") {
    return auth.token?.trim() || (auth.tokenEnv ? env[auth.tokenEnv]?.trim() : undefined) || fallbackApiKey;
  }
  if (auth.type === "header") {
    return auth.value?.trim() || (auth.valueEnv ? env[auth.valueEnv]?.trim() : undefined) || fallbackApiKey;
  }
  return auth.value?.trim() || (auth.valueEnv ? env[auth.valueEnv]?.trim() : undefined) || fallbackApiKey;
}

function applyRequestAuthHeaders(
  headers: Record<string, string>,
  auth: LlmProviderRequestAuthConfig | undefined,
  env: NodeJS.ProcessEnv,
  fallbackApiKey?: string,
): void {
  if (!auth) {
    return;
  }
  const secret = resolveRequestAuthSecret(auth, env, fallbackApiKey);
  if (!secret) {
    return;
  }
  if (auth.type === "query") {
    return;
  }
  if (auth.type === "bearer") {
    headers[auth.headerName?.trim() || "Authorization"] = `Bearer ${secret}`;
    return;
  }
  headers[auth.headerName] = auth.scheme ? `${auth.scheme} ${secret}` : secret;
}

function isMetadataStoreCompatibilityError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("metadata") &&
    normalized.includes("store") &&
    (normalized.includes("only allowed") || normalized.includes("enabled"))
  );
}

function createProviderMetadataCompatibilityError(message: string): Error {
  const error = new Error(message);
  error.name = "ProviderMetadataCompatibilityError";
  return error;
}

function resolveChatCompletionTimeoutMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeModelUsageAttribution(
  input: ModelUsageAttributionContext,
  defaultCallKind: NonNullable<ModelUsageAttributionContext["callKind"]>,
): ModelUsageAttributionContext {
  return {
    ...input,
    operationId: input.operationId?.trim() || `llm:${randomUUID()}`,
    dispatchGeneration: input.dispatchGeneration?.trim() || randomUUID(),
    callKind: input.callKind ?? defaultCallKind,
    attemptIndex: input.attemptIndex ?? 0,
    fallbackIndex: input.fallbackIndex ?? 0,
    repairIndex: input.repairIndex ?? 0,
  };
}

function attachStreamUsageEvents<T extends Record<string, unknown>>(value: T, eventIds: string[]): T {
  if (eventIds.length === 0) return value;
  return {
    ...value,
    model_usage_event_id: eventIds[eventIds.length - 1],
    model_usage_event_ids: [...eventIds],
  };
}

function attachReasoningReceipt(
  response: ChatCompletionResponse,
  receipt: ChatCompletionReasoningReceipt | undefined,
): ChatCompletionResponse {
  if (!receipt) return response;
  return {
    ...response,
    routing: {
      ...(response.routing ?? {}),
      reasoning: receipt,
    },
  };
}

function attachReasoningReceiptToChunk(
  chunk: Record<string, unknown>,
  receipt: ChatCompletionReasoningReceipt | undefined,
): Record<string, unknown> {
  if (!receipt) return chunk;
  return {
    ...chunk,
    routing: {
      ...(isRecord(chunk.routing) ? chunk.routing : {}),
      reasoning: receipt,
    },
  };
}

const PRIVATE_REASONING_RESPONSE_FIELDS = new Set([
  "analysis",
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "thinking",
]);
const MAX_PUBLIC_RESPONSE_SANITIZE_NODES = 50_000;

function stripPrivateReasoningFromCompletion(response: ChatCompletionResponse): ChatCompletionResponse {
  return sanitizeProviderResponseForPublicProjection(response as Record<string, unknown>) as ChatCompletionResponse;
}

function stripPrivateReasoningFromChunk(chunk: Record<string, unknown>): Record<string, unknown> {
  return sanitizeProviderResponseForPublicProjection(chunk);
}

export function sanitizeProviderResponseForPublicProjection(chunk: Record<string, unknown>): Record<string, unknown> {
  const sanitized = Object.create(null) as Record<string, unknown>;
  const seen = new WeakSet<object>();
  seen.add(chunk);
  let visitedNodes = 1;
  const pending: Array<{
    source: Record<string, unknown> | unknown[];
    target: Record<string, unknown> | unknown[];
  }> = [{ source: chunk, target: sanitized }];

  const cloneValue = (value: unknown): unknown => {
    visitedNodes += 1;
    if (visitedNodes > MAX_PUBLIC_RESPONSE_SANITIZE_NODES) {
      throw new Error("Provider response exceeded the public sanitization node limit.");
    }
    if (!Array.isArray(value) && !isRecord(value)) return value;
    if (seen.has(value)) {
      throw new Error("Provider response contained a cyclic or aliased object graph.");
    }
    seen.add(value);
    const target: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : (Object.create(null) as Record<string, unknown>);
    pending.push({ source: value, target });
    return target;
  };

  // Provider JSON can place private reasoning metadata below arbitrary vendor
  // envelopes, content parts, or stream-delta extensions. Walk the complete
  // bounded response graph iteratively so deeply nested payloads cannot escape
  // the filter or exhaust the JavaScript call stack. Tool-call argument strings
  // and every non-private public field remain byte-for-byte unchanged.
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) break;
    if (Array.isArray(next.source) && Array.isArray(next.target)) {
      for (const value of next.source) next.target.push(cloneValue(value));
      continue;
    }
    if (Array.isArray(next.source) || Array.isArray(next.target)) continue;
    for (const [key, value] of Object.entries(next.source)) {
      if (isPrivateReasoningResponseField(key)) continue;
      Object.defineProperty(next.target, key, {
        value: cloneValue(value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return sanitized;
}

function isPrivateReasoningResponseField(key: string): boolean {
  const normalized = key.trim().toLowerCase().replaceAll("-", "_");
  return (
    PRIVATE_REASONING_RESPONSE_FIELDS.has(normalized) ||
    normalized === "reasoningcontent" ||
    normalized === "reasoningdetails" ||
    normalized === "thinkingcontent" ||
    normalized === "internal_reasoning" ||
    normalized === "chain_of_thought"
  );
}

function hasChatStreamFinishReason(chunk: Record<string, unknown>): boolean {
  if (!Array.isArray(chunk.choices)) return false;
  return chunk.choices.some(
    (choice) => isRecord(choice) && choice.finish_reason !== undefined && choice.finish_reason !== null,
  );
}

function isLocalBillingProvider(providerId: string): boolean {
  return new Set(["genie-ir20", "llamacpp", "lmstudio", "localai", "ollama"]).has(providerId.trim().toLowerCase());
}

function normalizeSecretFreeProviderEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-provider-url";
  }
}

function projectProviderRequestAuthShape(auth: LlmProviderRequestAuthConfig | undefined) {
  if (!auth) {
    return undefined;
  }
  if (auth.type === "bearer") {
    return {
      type: auth.type,
      headerName: auth.headerName?.trim().toLowerCase(),
      tokenEnv: auth.tokenEnv,
    };
  }
  if (auth.type === "header") {
    return {
      type: auth.type,
      headerName: auth.headerName.trim().toLowerCase(),
      valueEnv: auth.valueEnv,
      scheme: auth.scheme,
    };
  }
  return {
    type: auth.type,
    queryParam: auth.queryParam,
    valueEnv: auth.valueEnv,
    prefix: auth.prefix,
  };
}

function projectProviderTlsShape(tls: LlmProviderRequestTlsConfig | undefined) {
  return tls
    ? {
        insecureSkipVerify: Boolean(tls.insecureSkipVerify),
        caCertPath: tls.caCertPath,
        clientCertPath: tls.clientCertPath,
        clientKeyPath: tls.clientKeyPath,
        serverName: tls.serverName?.trim().toLowerCase(),
      }
    : undefined;
}

function fingerprintProviderCredentialConfig(provider: LlmProviderConfig): string {
  const secretFree = {
    providerId: provider.providerId,
    endpoint: normalizeSecretFreeProviderEndpoint(provider.baseUrl),
    apiStyle: provider.apiStyle,
    authMode: resolveProviderAuthMode(provider),
    apiKeyEnv: provider.apiKeyEnv,
    googleCloud: provider.googleCloud,
    requestAuth: projectProviderRequestAuthShape(provider.request?.auth),
    headerNames: Object.keys(provider.request?.headers ?? provider.headers ?? {})
      .map((name) => name.trim().toLowerCase())
      .sort(),
  };
  return createHash("sha256").update(canonicalJsonString(secretFree)).digest("hex");
}

function fingerprintProviderRouteConfig(
  provider: LlmProviderConfig,
  model: string,
  contextWindowTokens: number,
): string {
  const proxy = provider.request?.proxy;
  const secretFree = {
    schemaVersion: "llm.provider-route-config.v1",
    providerId: provider.providerId,
    model,
    contextWindowTokens,
    resolvedApiStyle: resolveProviderExecutionApiStyle(provider, model),
    credentialConfigFingerprint: fingerprintProviderCredentialConfig(provider),
    capabilities: inferProviderCapabilities(provider),
    requestTransport: {
      tls: projectProviderTlsShape(provider.request?.tls),
      proxy: proxy
        ? {
            endpoint: normalizeSecretFreeProviderEndpoint(proxy.url),
            bypassHosts: [...(proxy.bypassHosts ?? [])].map((host) => host.trim().toLowerCase()).sort(),
            auth: projectProviderRequestAuthShape(proxy.auth),
            tls: projectProviderTlsShape(proxy.tls),
          }
        : undefined,
    },
  };
  return createHash("sha256").update(canonicalJsonString(secretFree)).digest("hex");
}

function resolveRequestAuthSource(auth: LlmProviderRequestAuthConfig | undefined): "inline" | "env" | "none" {
  if (!auth) return "none";
  if (auth.type === "bearer") {
    if (auth.token?.trim()) return "inline";
    return auth.tokenEnv?.trim() ? "env" : "none";
  }
  if (auth.value?.trim()) return "inline";
  return auth.valueEnv?.trim() ? "env" : "none";
}

function applyMaxTokensPayloadField(input: {
  payload: Record<string, unknown>;
  providerId: string;
  model: string;
  maxTokens: number | undefined;
}): void {
  if (input.maxTokens === undefined) {
    return;
  }
  if (shouldUseMaxCompletionTokens(input.providerId, input.model)) {
    input.payload.max_completion_tokens = input.maxTokens;
    return;
  }
  input.payload.max_tokens = input.maxTokens;
}

function resolveOutputCapPayloadField(
  payload: Readonly<Record<string, unknown>>,
): { field: "max_tokens" | "max_completion_tokens" | "max_output_tokens"; value: number } | undefined {
  const candidates = (["max_tokens", "max_completion_tokens", "max_output_tokens"] as const)
    .map((field) => ({ field, value: payload[field] }))
    .filter(
      (
        candidate,
      ): candidate is { field: "max_tokens" | "max_completion_tokens" | "max_output_tokens"; value: number } =>
        Number.isSafeInteger(candidate.value) && (candidate.value as number) > 0,
    );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isOutputCapRecoveryHttpStatus(status: number): boolean {
  // Known provider output-cap rejections are client/request-shape failures.
  // Never turn auth, rate-limit, redirect, or server failures into redispatch.
  return status === 400 || status === 413 || status === 422;
}

function shouldUseMaxCompletionTokens(providerId: string, model: string): boolean {
  if (providerId !== "openai") {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return /^gpt-5(?:$|[.-])/.test(normalized);
}

function createRequestDispatcher(
  targetUrl: URL,
  requestConfig: LlmProviderRequestConfig | undefined,
  env: NodeJS.ProcessEnv,
  tlsPathPolicy: LlmServiceOptions["tlsPathPolicy"],
  guardedLookup?: ProviderDnsLookupFn,
): Dispatcher | undefined {
  const tlsOptions =
    targetUrl.protocol === "https:" ? buildRequestTlsOptions(requestConfig?.tls, tlsPathPolicy) : undefined;
  const proxy = requestConfig?.proxy;
  if (proxy && !shouldBypassProxy(targetUrl.hostname, proxy.bypassHosts)) {
    const proxyHeaders = buildProxyRequestHeaders(proxy.auth, env);
    return new ProxyAgent({
      uri: proxy.url,
      headers: proxyHeaders,
      proxyTls: buildRequestTlsOptions(proxy.tls, tlsPathPolicy),
      requestTls: tlsOptions,
    });
  }
  // Non-proxy path: always attach the guarded lookup (merged with any TLS
  // overrides) so the resolved-IP guard runs even when no TLS override exists.
  // Without a guarded lookup and without TLS options there is nothing to
  // configure, so returning undefined (default dispatcher) is acceptable.
  const connect: UndiciConnectOptions | undefined = guardedLookup
    ? { ...(tlsOptions ?? {}), lookup: guardedLookup }
    : tlsOptions;
  if (!connect) {
    return undefined;
  }
  return new Agent({
    connect,
  });
}

function buildRequestDispatcherCacheKey(targetUrl: URL, requestConfig: LlmProviderRequestConfig | undefined): string {
  const useProxy = Boolean(
    requestConfig?.proxy && !shouldBypassProxy(targetUrl.hostname, requestConfig.proxy.bypassHosts),
  );
  return JSON.stringify({
    origin: targetUrl.origin,
    useProxy,
    proxyUrl: useProxy ? requestConfig?.proxy?.url : undefined,
    proxyAuth: useProxy ? (requestConfig?.proxy?.auth ?? undefined) : undefined,
    proxyTls: useProxy ? (requestConfig?.proxy?.tls ?? undefined) : undefined,
    tls: requestConfig?.tls ?? undefined,
  });
}

function buildRequestTlsOptions(
  tlsConfig: LlmProviderRequestTlsConfig | undefined,
  tlsPathPolicy: LlmServiceOptions["tlsPathPolicy"],
): UndiciConnectOptions | undefined {
  if (!tlsConfig) {
    return undefined;
  }

  const connectOptions: UndiciConnectOptions = {};
  let hasTlsOverride = false;

  if (tlsConfig.insecureSkipVerify !== undefined) {
    connectOptions.rejectUnauthorized = !tlsConfig.insecureSkipVerify;
    hasTlsOverride = true;
  }
  if (tlsConfig.serverName) {
    connectOptions.servername = tlsConfig.serverName;
    hasTlsOverride = true;
  }
  if (tlsConfig.caCertPath) {
    connectOptions.ca = readTlsFile(tlsConfig.caCertPath, tlsPathPolicy);
    hasTlsOverride = true;
  }
  if (tlsConfig.clientCertPath) {
    connectOptions.cert = readTlsFile(tlsConfig.clientCertPath, tlsPathPolicy);
    hasTlsOverride = true;
  }
  if (tlsConfig.clientKeyPath) {
    connectOptions.key = readTlsFile(tlsConfig.clientKeyPath, tlsPathPolicy);
    hasTlsOverride = true;
  }

  return hasTlsOverride ? connectOptions : undefined;
}

function readTlsFile(filePath: string, tlsPathPolicy: LlmServiceOptions["tlsPathPolicy"]): Buffer {
  if (tlsPathPolicy) {
    assertExistingPathRealpathAllowed(filePath, tlsPathPolicy.writeJailRoots, tlsPathPolicy.readOnlyRoots);
  }
  return readFileSync(filePath);
}

function buildProxyRequestHeaders(
  auth: LlmProviderRequestProxyAuthConfig | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!auth) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  applyRequestAuthHeaders(headers, auth, env);
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function shouldBypassProxy(hostname: string, bypassHosts: string[] | undefined): boolean {
  if (!bypassHosts || bypassHosts.length === 0) {
    return false;
  }
  const normalizedHostname = hostname.trim().toLowerCase();
  return bypassHosts.some((entry) => matchesBypassHostEntry(normalizedHostname, entry));
}

function matchesBypassHostEntry(hostname: string, entry: string): boolean {
  const normalizedEntry = entry.trim().toLowerCase();
  if (!normalizedEntry) {
    return false;
  }
  if (normalizedEntry === hostname) {
    return true;
  }
  if (normalizedEntry.startsWith("*.")) {
    const suffix = normalizedEntry.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  if (normalizedEntry.startsWith(".")) {
    return hostname.endsWith(normalizedEntry);
  }
  return false;
}

function validateProviderBaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid provider baseUrl: ${rawUrl}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported provider protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new Error("Provider baseUrl must include a hostname");
  }

  if (DISALLOWED_BASE_HOSTS.has(host)) {
    throw new Error(`Provider host ${host} is blocked`);
  }

  if (host === "localhost" || host === "::1" || host === "127.0.0.1") {
    return;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4 && isPrivateOrReservedIpv4(host)) {
    throw new Error(`Provider host ${host} is a private/reserved IPv4 address`);
  }
  if (ipVersion === 6 && isBlockedIpv6(host)) {
    throw new Error(`Provider host ${host} is a private/reserved IPv6 address`);
  }

  if (host.endsWith(".local")) {
    throw new Error(`Provider host ${host} is a local network domain`);
  }
}

function stripIpv6Brackets(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Decode an IPv4-mapped IPv6 literal (`::ffff:a.b.c.d`, its uncompressed
// `0:0:0:0:0:ffff:…` variants, and Node's `::ffff:hhhh:hhhh` normalisation)
// to its dotted-quad IPv4 form so the IPv4 reserved-range check applies. Without
// this, `::ffff:169.254.169.254` (or a resolver returning that mapped form)
// would slip past the IPv4 metadata block.
function extractIpv4MappedAddress(ipv6Lower: string): string | undefined {
  const canonical = ipv6Lower.replace(/^(?:0{1,4}:){2,5}ffff:/, "::ffff:").replace(/^0{1,4}:ffff:/, "::ffff:");
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(canonical);
  if (dotted) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (hex) {
    const high = Number.parseInt(hex[1] ?? "", 16);
    const low = Number.parseInt(hex[2] ?? "", 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      const octet = (value: number, shift: number) => (value >>> shift) & 0xff;
      return [octet(high, 8), octet(high, 0), octet(low, 8), octet(low, 0)].join(".");
    }
  }
  return undefined;
}

// True when a *resolved* IP address is private/reserved per the exact same
// policy `validateProviderBaseUrl` applies to a literal host string (loopback
// and RFC1918/link-local/metadata ranges), so the fetch-time guard never blocks
// anything the save-time check already permits (notably the tailnet
// 100.64.0.0/10 range, which this policy deliberately does NOT treat as
// private).
function isBlockedResolvedIp(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (DISALLOWED_BASE_HOSTS.has(normalized)) {
    return true;
  }
  const family = isIP(normalized);
  if (family === 4) {
    return isPrivateOrReservedIpv4(normalized);
  }
  if (family === 6) {
    const mapped = extractIpv4MappedAddress(normalized);
    if (mapped) {
      return isPrivateOrReservedIpv4(mapped);
    }
    return isBlockedIpv6(normalized);
  }
  return false;
}

function isLoopbackResolvedIp(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function isConfiguredLoopbackHost(hostOrUrl: string): boolean {
  let host: string;
  try {
    host = new URL(hostOrUrl).hostname.toLowerCase();
  } catch {
    host = hostOrUrl.trim().toLowerCase();
  }
  host = stripIpv6Brackets(host);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isConfiguredDockerHostAliasExplicitlyAllowlisted(
  hostOrUrl: string,
  networkAllowlist: readonly string[],
): boolean {
  let hostname: string;
  let authority: string;
  try {
    const parsed = new URL(hostOrUrl);
    hostname = stripIpv6Brackets(parsed.hostname.toLowerCase());
    authority = parsed.host.toLowerCase();
  } catch {
    hostname = stripIpv6Brackets(hostOrUrl.trim().toLowerCase());
    authority = hostname;
  }
  if (hostname !== "host.docker.internal") {
    return false;
  }
  return networkAllowlist.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === hostname || normalized === authority;
  });
}

function isRfc1918Ipv4(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  const ipv4 = isIP(normalized) === 6 ? extractIpv4MappedAddress(normalized) : normalized;
  if (!ipv4 || isIP(ipv4) !== 4) {
    return false;
  }
  const parts = ipv4.split(".").map((part) => Number(part));
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Sentinel embedded in the guarded-lookup error. undici surfaces a lookup
// failure as `TypeError: fetch failed` with the real reason on `error.cause`,
// so this marker lets the fetch helpers recognise and re-surface an SSRF block
// (and stop it from being silently masked by a template-model fallback).
const PROVIDER_ADDRESS_BLOCKED_MESSAGE =
  "Provider host resolved to a private, metadata, or reserved address and was blocked";

// Distinct error so the model-discovery fallback path can rethrow an SSRF block
// instead of degrading it to a template-model fallback.
export class ProviderNetworkBlockedError extends Error {
  public constructor(message: string = PROVIDER_ADDRESS_BLOCKED_MESSAGE) {
    super(message);
    this.name = "ProviderNetworkBlockedError";
  }
}

// Walk an error's `cause` chain looking for the guarded-lookup block sentinel.
// Returns a clean `ProviderNetworkBlockedError` when found (so callers see a
// stable, redaction-safe "blocked" message rather than undici's opaque
// "fetch failed"), otherwise `undefined`.
function asProviderNetworkBlock(error: unknown): ProviderNetworkBlockedError | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 6; depth += 1) {
    if (current.message.includes(PROVIDER_ADDRESS_BLOCKED_MESSAGE)) {
      return new ProviderNetworkBlockedError();
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// Re-throw a clean block error when `error` is (or wraps) a guarded-lookup
// block; otherwise return so the caller can handle the original error.
function rethrowIfProviderNetworkBlocked(error: unknown): void {
  const blocked = asProviderNetworkBlock(error);
  if (blocked) {
    throw blocked;
  }
}

// The DNS-rebinding decision core: given the configured provider URL/host and an
// address it resolved to at fetch time, return the offending address when it
// must be blocked, or `undefined` when the connection may proceed.
//
// Loopback resolved addresses are permitted ONLY when the configured host is a
// loopback literal (localhost/127.0.0.1/::1) — this is how a legitimately-local
// runtime (llama.cpp, Ollama, LM Studio) keeps reaching 127.0.0.1 while a remote
// host that rebinds to loopback is blocked. Docker's exact host alias may resolve
// to an RFC1918 bridge address only while that exact hostname or configured
// authority is explicitly allowlisted, so containerized GoatCitadel can reach an
// operator-configured host runtime without letting wildcard/suffix grants open
// private DNS destinations. The exception deliberately excludes loopback,
// link-local/metadata, multicast, and other reserved addresses.
// Exported for unit coverage.
export function findBlockedResolvedProviderAddress(
  hostOrUrl: string,
  resolvedAddress: string,
  networkAllowlist: readonly string[] = [],
): string | undefined {
  if (isConfiguredDockerHostAliasExplicitlyAllowlisted(hostOrUrl, networkAllowlist) && isRfc1918Ipv4(resolvedAddress)) {
    return undefined;
  }
  if (isLoopbackResolvedIp(resolvedAddress)) {
    return isConfiguredLoopbackHost(hostOrUrl) ? undefined : resolvedAddress;
  }
  return isBlockedResolvedIp(resolvedAddress) ? resolvedAddress : undefined;
}

function findBlockedResolvedProviderAddressList(
  hostOrUrl: string,
  address: string | LookupAddress[],
  networkAllowlist: readonly string[],
): string | undefined {
  const candidates = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
  for (const candidate of candidates) {
    const blocked = findBlockedResolvedProviderAddress(hostOrUrl, candidate, networkAllowlist);
    if (blocked) {
      return blocked;
    }
  }
  return undefined;
}

// Wrap a Node-style DNS lookup so that, after resolution, any private/reserved/
// rebinding address fails the lookup (and therefore the connection) before a
// socket is opened. Mirrors the guarded-lookup pattern used by the policy-engine
// network guard, but applies llm-service's own provider-host policy so the
// fetch-time block stays consistent with validateProviderBaseUrl.
function createProviderGuardedLookup(
  hostOrUrl: string,
  dnsLookup: ProviderDnsLookupFn,
  getNetworkAllowlist: () => readonly string[],
): ProviderDnsLookupFn {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family);
        return;
      }
      const blocked = findBlockedResolvedProviderAddressList(hostOrUrl, address, getNetworkAllowlist());
      if (blocked) {
        callback(new Error(PROVIDER_ADDRESS_BLOCKED_MESSAGE), address, family);
        return;
      }
      callback(null, address, family);
    });
  };
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }

  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function parseSseFramePayloads(dataLines: string[]): Array<Record<string, unknown> | "[DONE]"> {
  if (dataLines.length === 0) {
    return [];
  }

  const joined = dataLines.join("\n").trim();
  if (joined === "[DONE]") {
    return ["[DONE]"];
  }

  const parsedJoined = tryParseJsonRecord(joined);
  if (parsedJoined) {
    return [parsedJoined];
  }

  const parsedLines: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const line of dataLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "[DONE]") {
      parsedLines.push("[DONE]");
      continue;
    }
    const parsed = tryParseJsonRecord(trimmed);
    if (parsed) {
      parsedLines.push(parsed);
    }
  }
  return parsedLines;
}

function tryParseJsonRecord(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed provider chunks
  }
  return null;
}

async function* streamJsonSseResponse(
  response: Response,
  options?: { forceSse?: boolean; maxEvents?: number; onDone?: () => void },
): AsyncGenerator<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body) {
    const json = await parseProviderJsonResponse("provider stream", response);
    yield json;
    return;
  }
  if (!options?.forceSse && !contentType.includes("text/event-stream")) {
    const json = await parseProviderJsonResponse("provider stream", response);
    yield json;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;
  let eventCount = 0;
  const maxEvents = options?.maxEvents ?? MAX_PROVIDER_SSE_EVENTS;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_PROVIDER_SSE_BYTES) {
        await reader.cancel();
        throw new Error(`provider stream exceeded ${MAX_PROVIDER_SSE_BYTES} bytes.`);
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/g);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split(/\r?\n/g)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .filter(Boolean);
        for (const payload of parseSseFramePayloads(dataLines)) {
          if (payload === "[DONE]") {
            options?.onDone?.();
            return;
          }
          eventCount += 1;
          if (eventCount > maxEvents) {
            await reader.cancel();
            throw new Error(`provider stream exceeded ${maxEvents} events.`);
          }
          yield payload;
        }
      }
    }
    if (buffer.trim()) {
      const dataLines = buffer
        .split(/\r?\n/g)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .filter(Boolean);
      for (const payload of parseSseFramePayloads(dataLines)) {
        if (payload === "[DONE]") {
          options?.onDone?.();
          return;
        }
        eventCount += 1;
        if (eventCount > maxEvents) {
          throw new Error(`provider stream exceeded ${maxEvents} events.`);
        }
        yield payload;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Returns a request whose messages are pairing-sanitized. The original request
 * is never mutated; when sanitizing changes nothing the same array is reused so
 * callers and tests can rely on referential stability for unchanged history.
 */
function withSanitizedMessages(request: ChatCompletionRequest): ChatCompletionRequest {
  const sanitized = sanitizeMessages(request.messages);
  const tools = stripInternalToolEffectMetadataForProvider(request.tools);
  if (
    sanitized.length === request.messages.length &&
    sanitized.every((m, i) => m === request.messages[i]) &&
    tools === request.tools
  ) {
    return request;
  }
  return { ...request, messages: sanitized, tools };
}

function buildOpenAiResponsesPayload(
  request: ChatCompletionRequest,
  model: string,
  provider: Pick<LlmProviderConfig, "providerId" | "apiStyle">,
): Record<string, unknown> {
  if (provider.providerId.trim().toLowerCase() === "openai") {
    validateOpenAiRequestCompatibility(request, model);
  }
  const { instructions, input: standardInput } = buildOpenAiResponsesInput(request.messages);
  const codexResponsesLite = usesOpenAICodexResponsesLite(provider, model);
  const mappedTools = mapOpenAiResponsesTools(request.tools);
  const codexInput = codexResponsesLite
    ? standardInput.map((item) => (typeof item.type === "string" ? item : { type: "message", ...item }))
    : standardInput;
  const input = codexResponsesLite
    ? [
        {
          type: "additional_tools",
          role: "developer",
          tools: Array.isArray(mappedTools) ? mappedTools : [],
        },
        ...(instructions
          ? [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: instructions }],
              },
            ]
          : []),
        ...codexInput,
      ]
    : codexInput;
  const payload: Record<string, unknown> = {
    model,
    input,
  };

  if (instructions && !codexResponsesLite) {
    payload.instructions = instructions;
  }
  if (!isOpenAICodexResponsesProvider(provider)) {
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.top_p !== undefined) payload.top_p = request.top_p;
  }
  if (request.max_tokens !== undefined && !isOpenAICodexResponsesProvider(provider)) {
    payload.max_output_tokens = request.max_tokens;
  }
  if (request.reasoning?.effort) payload.reasoning = { effort: request.reasoning.effort };
  if (request.verbosity)
    payload.text = { ...(isRecord(payload.text) ? payload.text : {}), verbosity: request.verbosity };
  if (request.response_format !== undefined && !isOpenAICodexResponsesProvider(provider)) {
    payload.text = {
      ...(isRecord(payload.text) ? payload.text : {}),
      format: request.response_format,
    };
    if (isJsonObjectResponseFormat(request.response_format)) {
      payload.input = ensureJsonKeywordInResponsesInput(input);
    }
  }
  if (request.tools !== undefined && !codexResponsesLite) payload.tools = mappedTools;
  if (request.tool_choice !== undefined) payload.tool_choice = mapOpenAiResponsesToolChoice(request.tool_choice);
  if (codexResponsesLite) {
    payload.tool_choice = "auto";
    payload.parallel_tool_calls = false;
    payload.reasoning = {
      ...(isRecord(payload.reasoning) ? payload.reasoning : {}),
      context: "all_turns",
    };
  } else if (request.parallel_tool_calls !== undefined) {
    payload.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (request.metadata !== undefined) payload.metadata = request.metadata;
  if (request.service_tier && !isOpenAICodexResponsesProvider(provider)) payload.service_tier = request.service_tier;
  if (request.prompt_cache_retention) payload.prompt_cache_retention = request.prompt_cache_retention;

  applyOpenAiResponsesProviderDefaults(payload, provider, model);

  return payload;
}

function applyOpenAiResponsesProviderDefaults(
  payload: Record<string, unknown>,
  provider: Pick<LlmProviderConfig, "providerId" | "apiStyle">,
  model: string,
): void {
  if (!isOpenAICodexResponsesProvider(provider)) {
    return;
  }

  payload.store = false;
  if (!isOpenAIGpt5Model(model)) {
    return;
  }

  if (!hasOwn(payload, "parallel_tool_calls")) {
    payload.parallel_tool_calls = true;
  }

  const text = isRecord(payload.text) ? { ...payload.text } : {};
  if (!hasOwn(text, "verbosity")) {
    text.verbosity = "low";
    payload.text = text;
  }
}

function isOpenAICodexResponsesProvider(provider: Pick<LlmProviderConfig, "providerId" | "apiStyle">): boolean {
  return provider.providerId.trim().toLowerCase() === "openai-codex" || provider.apiStyle === "openai-codex-responses";
}

function usesOpenAICodexResponsesLite(
  provider: Pick<LlmProviderConfig, "providerId" | "apiStyle">,
  model: string,
): boolean {
  return isOpenAICodexResponsesProvider(provider) && /^gpt-5\.6-(?:sol|terra|luna)$/iu.test(model.trim());
}

function resolveProviderSseEventLimit(
  provider: Pick<LlmProviderConfig, "providerId" | "apiStyle">,
  model: string,
): number {
  return usesOpenAICodexResponsesLite(provider, model)
    ? MAX_OPENAI_CODEX_RESPONSES_LITE_SSE_EVENTS
    : MAX_PROVIDER_SSE_EVENTS;
}

function applyOpenAICodexResponsesLiteHeader(
  headers: Record<string, string>,
  provider: Pick<LlmProviderConfig, "providerId" | "apiStyle">,
  model: string,
): void {
  if (usesOpenAICodexResponsesLite(provider, model)) {
    headers["x-openai-internal-codex-responses-lite"] = "true";
  }
}

async function collectOpenAiResponsesStreamCompletion(
  response: Response,
  model: string,
  maxEvents: number,
): Promise<ChatCompletionResponse> {
  let outputText = "";
  const streamedOutputItems: Array<Record<string, unknown>> = [];
  for await (const event of streamJsonSseResponse(response, { forceSse: true, maxEvents })) {
    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType === "response.output_text.delta") {
      outputText += String(event.delta ?? "");
      continue;
    }
    if (eventType === "response.output_item.done" && isRecord(event.item)) {
      streamedOutputItems.push(event.item);
      continue;
    }
    if (eventType === "response.completed" && isRecord(event.response)) {
      const providerOutput = Array.isArray(event.response.output) ? event.response.output.filter(isRecord) : [];
      const completion = adaptOpenAiResponsesResponse({
        ...event.response,
        ...(providerOutput.length === 0 && streamedOutputItems.length > 0 ? { output: streamedOutputItems } : {}),
      });
      const message = completion.choices?.[0]?.message as Record<string, unknown> | undefined;
      if (outputText && (typeof message?.content !== "string" || message.content.length === 0)) {
        return {
          ...completion,
          choices: [
            {
              index: 0,
              message: { ...message, role: "assistant", content: outputText },
              finish_reason: completion.choices?.[0]?.finish_reason ?? "stop",
            },
          ],
        };
      }
      return completion;
    }
    if (eventType === "response.failed") {
      throw buildResponsesStreamFailureError(event);
    }
  }

  throw new Error(
    `Responses stream for ${model} ended before response.completed${outputText ? ` after ${outputText.length} text characters` : ""}`,
  );
}

function applyEstimatedCostToChatResponseWithSource(
  response: ChatCompletionResponse,
  input: { providerId?: string; model?: string },
): ChatCompletionResponse {
  const providerReportedCost = hasUsageCost(response.usage);
  return annotateChatResponseUsageCostSource(
    applyEstimatedCostToChatResponse(response, input),
    providerReportedCost ? "provider_reported" : "estimated",
  );
}

function applyEstimatedCostToStreamChunkWithSource(
  chunk: Record<string, unknown>,
  input: { providerId?: string; model?: string },
): Record<string, unknown> {
  const providerReportedCost = hasUsageCost(chunk.usage);
  return annotateStreamChunkUsageCostSource(
    applyEstimatedCostToStreamChunk(chunk, input),
    providerReportedCost ? "provider_reported" : "estimated",
  );
}

function annotateChatResponseUsageCostSource(
  response: ChatCompletionResponse,
  source: "provider_reported" | "estimated",
): ChatCompletionResponse {
  if (!isRecord(response.usage) || !hasUsageCost(response.usage)) {
    return response;
  }
  return {
    ...response,
    usage: {
      ...response.usage,
      cost_source: source,
    },
  };
}

function annotateStreamChunkUsageCostSource(
  chunk: Record<string, unknown>,
  source: "provider_reported" | "estimated",
): Record<string, unknown> {
  if (!isRecord(chunk.usage) || !hasUsageCost(chunk.usage)) {
    return chunk;
  }
  return {
    ...chunk,
    usage: {
      ...chunk.usage,
      cost_source: source,
    },
  };
}

function hasUsageCost(usage: unknown): boolean {
  if (!isRecord(usage)) {
    return false;
  }
  return readFiniteNumber(usage.cost_usd) !== undefined || readFiniteNumber(usage.total_cost_usd) !== undefined;
}

function buildResponsesStreamFailureError(event: Record<string, unknown>): Error {
  const provider = readResponsesProviderFailure(event);
  const details = [provider?.code, provider?.message].filter((value): value is string => Boolean(value));
  const message = details.length > 0 ? `responses stream failed: ${details.join(" - ")}` : "responses stream failed";
  const error = provider ? new Error(message, { cause: provider }) : new Error(message);
  if (provider) {
    (error as Error & { providerFailure?: ChatProviderFailureRecord }).providerFailure = provider;
  }
  const response = isRecord(event.response) ? event.response : undefined;
  if (isRecord(response?.usage)) {
    (error as Error & { providerUsage?: Record<string, unknown> }).providerUsage = response.usage;
  }
  const providerModel = firstNonEmptyString(response?.model);
  if (providerModel) {
    (error as Error & { providerModel?: string }).providerModel = providerModel;
  }
  return error;
}

function readProviderUsageFromError(error: unknown): Record<string, unknown> | undefined {
  return error instanceof Error && isRecord((error as Error & { providerUsage?: unknown }).providerUsage)
    ? (error as Error & { providerUsage: Record<string, unknown> }).providerUsage
    : undefined;
}

function readProviderModelFromError(error: unknown): string | undefined {
  return error instanceof Error
    ? firstNonEmptyString((error as Error & { providerModel?: unknown }).providerModel)
    : undefined;
}

function readProviderOwnedOutputCapFailureText(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const providerFailure = (error as Error & { providerFailure?: unknown }).providerFailure;
  if (!isRecord(providerFailure)) return undefined;
  return extractProviderOwnedOutputCapErrorText(JSON.stringify({ error: providerFailure }));
}

function readOpenAiCompatibleStreamErrorText(event: Record<string, unknown>): string | undefined {
  const eventType = firstNonEmptyString(event.type);
  const rawError = event.error;
  if (rawError === undefined && eventType !== "error") return undefined;
  const providerError =
    typeof rawError === "string"
      ? rawError
      : isRecord(rawError)
        ? rawError
        : {
            ...(firstNonEmptyString(event.code) ? { code: firstNonEmptyString(event.code) } : {}),
            ...(firstNonEmptyString(event.message) ? { message: firstNonEmptyString(event.message) } : {}),
          };
  return extractProviderOwnedOutputCapErrorText(JSON.stringify({ error: providerError }));
}

function createProviderStreamError(message: string): Error {
  const error = new Error(message);
  error.name = "ProviderStreamError";
  return error;
}

function appendUniqueUsageEventIds(target: string[], dispatched: LlmTrackedJsonDispatch): void {
  const seen = new Set(target);
  for (const eventId of [
    ...(dispatched.priorModelUsageEventIds ?? []),
    ...(dispatched.usage ? [dispatched.usage.eventId] : []),
  ]) {
    if (seen.has(eventId)) continue;
    target.push(eventId);
    seen.add(eventId);
  }
}

function observeProviderPayloadUsage(
  observer: ModelUsageAttemptHandle | undefined,
  providerUsage: unknown,
  effectiveModelId: string | undefined,
  input: { providerId?: string; model?: string },
): void {
  const priced = applyEstimatedCostToStreamChunkWithSource(
    {
      ...(providerUsage === undefined ? {} : { usage: providerUsage }),
      ...(effectiveModelId ? { model: effectiveModelId } : {}),
    },
    input,
  );
  observeProviderUsageWithTrustedEstimate(observer, providerUsage, isRecord(priced.usage) ? priced.usage : undefined);
  if (effectiveModelId) observer?.observeNormalized({ effectiveModelId });
}

function observeProviderFailureUsage(
  observer: ModelUsageAttemptHandle | undefined,
  error: unknown,
  input: { providerId?: string; model?: string },
): void {
  observeProviderPayloadUsage(observer, readProviderUsageFromError(error), readProviderModelFromError(error), input);
}

function attachProviderUsageEvidence(error: Error, payload: Record<string, unknown> | undefined): Error {
  if (isRecord(payload?.usage)) {
    (error as Error & { providerUsage?: Record<string, unknown> }).providerUsage = payload.usage;
  }
  const providerModel = firstNonEmptyString(payload?.model);
  if (providerModel) {
    (error as Error & { providerModel?: string }).providerModel = providerModel;
  }
  return error;
}

function readResponsesProviderFailure(event: Record<string, unknown>): ChatProviderFailureRecord | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  const responseError = isRecord(response?.error) ? response.error : undefined;
  const eventError = isRecord(event.error) ? event.error : undefined;
  const stringError = typeof event.error === "string" ? event.error : undefined;
  const provider: ChatProviderFailureRecord = {
    code: firstNonEmptyString(responseError?.code, eventError?.code, event.code),
    message: firstNonEmptyString(responseError?.message, eventError?.message, event.message, stringError),
    status: firstNonEmptyString(response?.status, event.status),
    responseId: firstNonEmptyString(response?.id, event.response_id, event.id),
    type: firstNonEmptyString(responseError?.type, eventError?.type),
  };
  return Object.values(provider).some(Boolean) ? provider : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isOpenAIGpt5Model(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model.trim());
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonObjectResponseFormat(format: ChatCompletionRequest["response_format"]): boolean {
  return isRecord(format) && format.type === "json_object";
}

function ensureJsonKeywordInResponsesInput(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (responsesInputContainsJsonKeyword(input)) {
    return input;
  }

  const patched = input.map((item) => ({ ...item }));
  for (const item of patched) {
    if (typeof item.role !== "string" || !Array.isArray(item.content)) {
      continue;
    }
    for (const block of item.content) {
      if (!isRecord(block) || typeof block.text !== "string") {
        continue;
      }
      const normalizedType = typeof block.type === "string" ? block.type : "";
      if (normalizedType !== "input_text" && normalizedType !== "output_text") {
        continue;
      }
      block.text = `Return json.\n\n${block.text}`;
      return patched;
    }
  }

  return [
    {
      role: "user",
      content: [{ type: "input_text", text: "Return json." }],
    },
    ...patched,
  ];
}

function responsesInputContainsJsonKeyword(input: Array<Record<string, unknown>>): boolean {
  for (const item of input) {
    if (!Array.isArray(item.content)) {
      continue;
    }
    for (const block of item.content) {
      if (!isRecord(block) || typeof block.text !== "string") {
        continue;
      }
      if (/\bjson\b/i.test(block.text)) {
        return true;
      }
    }
  }
  return false;
}

function mapOpenAiResponsesTools(tools: ChatCompletionRequest["tools"]): ChatCompletionRequest["tools"] {
  if (!Array.isArray(tools)) {
    return tools;
  }
  return tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || typeof tool.name === "string") {
      return tool;
    }
    const fn = isRecord(tool.function) ? tool.function : undefined;
    if (!fn) {
      return tool;
    }
    const mapped: Record<string, unknown> = {
      ...tool,
      ...fn,
    };
    delete mapped.function;
    return mapped;
  });
}

function mapOpenAiResponsesToolChoice(
  toolChoice: ChatCompletionRequest["tool_choice"],
): ChatCompletionRequest["tool_choice"] {
  if (!isRecord(toolChoice) || toolChoice.type !== "function" || typeof toolChoice.name === "string") {
    return toolChoice;
  }
  const fn = isRecord(toolChoice.function) ? toolChoice.function : undefined;
  if (!fn || typeof fn.name !== "string" || !fn.name.trim()) {
    return toolChoice;
  }
  const mapped: Record<string, unknown> = {
    ...toolChoice,
    name: fn.name,
  };
  delete mapped.function;
  return mapped as ChatCompletionRequest["tool_choice"];
}

function buildOpenAiResponsesInput(messages: ChatCompletionRequest["messages"]): {
  instructions?: string;
  input: Array<Record<string, unknown>>;
} {
  const instructionParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const record = toPlainRecord(message);
    if (message.role === "system" || message.role === "developer") {
      const text = normalizeStringMessageContent(message.content);
      if (text) {
        instructionParts.push(text);
      }
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: normalizeToolOutputContent(message.content),
      });
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    const content = mapOpenAiResponsesContent(message.role, message.content);
    if (content.length > 0) {
      input.push({ role, content });
    }

    if (message.role === "assistant" && record && Array.isArray(record.tool_calls)) {
      for (const toolCall of record.tool_calls) {
        if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
          continue;
        }
        input.push({
          type: "function_call",
          call_id: String(toolCall.id ?? randomToolCallId()),
          name: String(toolCall.function.name ?? ""),
          arguments: String(toolCall.function.arguments ?? "{}"),
        });
      }
    }
  }

  return {
    instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
    input,
  };
}

function mapOpenAiResponsesContent(
  role: ChatCompletionRequest["messages"][number]["role"],
  content: ChatCompletionRequest["messages"][number]["content"],
): Array<Record<string, unknown>> {
  const textBlockType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content.trim() ? [{ type: textBlockType, text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map((block) => {
      if (!isRecord(block)) {
        return undefined;
      }
      if (block.type === "input_text" || block.type === "input_image" || block.type === "input_file") {
        return block;
      }
      if (block.type === "text" || block.type === "output_text") {
        const text = String(block.text ?? "");
        return text.trim() ? { type: textBlockType, text } : undefined;
      }
      return block;
    })
    .filter((block): block is Record<string, unknown> => Boolean(block));
}

function adaptOpenAiResponsesResponse(json: Record<string, unknown>): ChatCompletionResponse {
  const output = Array.isArray(json.output) ? json.output.filter(isRecord) : [];
  const assistantMessages = output.filter((item) => item.type === "message" && item.role === "assistant");
  const assistantMessage = assistantMessages[0];
  const toolCalls = dedupeToolCalls(
    output
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        id: String(item.call_id ?? item.id ?? randomToolCallId()),
        type: "function",
        function: {
          name: String(item.name ?? ""),
          arguments: String(item.arguments ?? "{}"),
        },
      })),
  );
  const content = assistantMessage
    ? extractOpenAiResponsesMessageText(assistantMessage)
    : String(json.output_text ?? "");
  const finishReason = toolCalls.length > 0 ? "tool_calls" : mapOpenAiResponsesFinishReason(json);

  return {
    id: typeof json.id === "string" ? json.id : undefined,
    object: "chat.completion",
    created: typeof json.created_at === "number" ? json.created_at : undefined,
    model: typeof json.model === "string" ? json.model : undefined,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(assistantMessage?.phase ? { phase: assistantMessage.phase } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: isRecord(json.usage) ? json.usage : undefined,
  };
}

function extractOpenAiResponsesMessageText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  return content
    .filter((part) => part.type === "output_text" || part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("");
}

function mapOpenAiResponsesFinishReason(json: Record<string, unknown>): string {
  if (json.status === "incomplete" && isRecord(json.incomplete_details)) {
    if (json.incomplete_details.reason === "max_output_tokens") {
      return "length";
    }
  }
  return "stop";
}

function normalizeToolOutputContent(
  content: ChatCompletionRequest["messages"][number]["content"],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }
  return mapOpenAiResponsesContent("tool", content);
}

function normalizeStringMessageContent(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(isRecord)
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
}

function dedupeToolCalls<T extends { id: string }>(toolCalls: T[]): T[] {
  const seen = new Set<string>();
  return toolCalls.filter((toolCall) => {
    if (seen.has(toolCall.id)) {
      return false;
    }
    seen.add(toolCall.id);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function randomToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function decodeImageAssetToBlob(input: { bytesBase64: string; mimeType?: string }): Blob {
  const bytes = decodeStrictBase64(input.bytesBase64, "image asset");
  const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([payload], {
    type: input.mimeType?.trim() || "image/png",
  });
}

const OPENAI_CODEX_IMAGE_RESPONSES_MODEL = "gpt-5.4";
const OPENAI_CODEX_IMAGE_INSTRUCTIONS = "You are an image generation assistant.";
const OPENAI_CODEX_IMAGE_RESPONSE_LABEL = "OpenAI Codex image generation";
const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_IMAGE_SSE_EVENTS = 512;
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_BASE64_CHARS = 64 * 1024 * 1024;
const IMAGE_DATA_URL_PATTERN = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

function buildOpenAICodexImagePayload(
  request: ImageGenerationRequest,
  model: string,
  content: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    model,
    size: request.size ?? "1024x1024",
  };
  if (request.quality) imageTool.quality = request.quality;
  if (request.outputFormat) imageTool.output_format = request.outputFormat;
  if (request.background) imageTool.background = request.background;

  return {
    model: OPENAI_CODEX_IMAGE_RESPONSES_MODEL,
    input: [
      {
        role: "user",
        content,
      },
    ],
    instructions: OPENAI_CODEX_IMAGE_INSTRUCTIONS,
    tools: [imageTool],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  };
}

function toImageDataUrl(image: ImageAssetInput): string {
  const mimeType = image.mimeType?.trim() || "image/png";
  assertStrictBase64(image.bytesBase64, "image asset");
  return `data:${mimeType};base64,${image.bytesBase64}`;
}

async function adaptOpenAICodexImageResponse(
  response: Response,
  model: string,
  timeoutMs: number,
): Promise<{ data: ImageGenerationResponse["data"]; usage?: Record<string, unknown>; model?: string }> {
  const body = await readBoundedResponseText(response, {
    maxBytes: MAX_CODEX_IMAGE_SSE_BYTES,
    timeoutMs,
    label: OPENAI_CODEX_IMAGE_RESPONSE_LABEL,
  });
  if (!body.trim()) {
    throw new BoundedResponseReadError(
      "body_missing",
      `${OPENAI_CODEX_IMAGE_RESPONSE_LABEL} response body was empty.`,
      OPENAI_CODEX_IMAGE_RESPONSE_LABEL,
    );
  }
  const events = parseOpenAICodexImageEvents(body);
  const failure = events.find((event) => event.type === "response.failed" || event.type === "error");
  if (failure) {
    const failureResponse = isRecord(failure.response) ? failure.response : failure;
    const error = isRecord(failure.error)
      ? failure.error
      : isRecord(failureResponse.error)
        ? failureResponse.error
        : undefined;
    const message =
      (typeof error?.message === "string" ? error.message : undefined) ??
      (typeof failure.message === "string" ? failure.message : undefined) ??
      "OpenAI Codex image generation failed";
    throw attachProviderUsageEvidence(new Error(message), failureResponse);
  }
  const completedEvent = events.find((event) => event.type === "response.completed" && isRecord(event.response));
  if (!completedEvent || !isRecord(completedEvent.response)) {
    throw new BoundedResponseReadError(
      "body_incomplete",
      `OpenAI Codex image generation for ${model} ended before response.completed.`,
      OPENAI_CODEX_IMAGE_RESPONSE_LABEL,
    );
  }

  try {
    const outputItemImages = events
      .filter((event) => {
        const item = isRecord(event.item) ? event.item : undefined;
        return event.type === "response.output_item.done" && item?.type === "image_generation_call";
      })
      .map((event) => (isRecord(event.item) ? toOpenAICodexImageResult(event.item) : undefined))
      .filter((item): item is ImageGenerationResponse["data"][number] => Boolean(item));

    const completedImages = events
      .filter((event) => event.type === "response.completed" && isRecord(event.response))
      .flatMap((event) => {
        const responsePayload = event.response as Record<string, unknown>;
        const output = Array.isArray(responsePayload.output) ? responsePayload.output : [];
        return output
          .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "image_generation_call")
          .map(toOpenAICodexImageResult)
          .filter((item): item is ImageGenerationResponse["data"][number] => Boolean(item));
      });

    const results = outputItemImages.length > 0 ? outputItemImages : completedImages;
    if (results.length === 0) {
      throw new BoundedResponseReadError(
        "body_no_payload",
        `OpenAI Codex image generation returned no images for ${model}.`,
        OPENAI_CODEX_IMAGE_RESPONSE_LABEL,
      );
    }
    return {
      data: results.slice(0, 4),
      ...(isRecord(completedEvent.response.usage) ? { usage: completedEvent.response.usage } : {}),
      ...(firstNonEmptyString(completedEvent.response.model)
        ? { model: firstNonEmptyString(completedEvent.response.model) }
        : {}),
    };
  } catch (error) {
    throw attachProviderUsageEvidence(
      error instanceof Error ? error : new Error(String(error)),
      completedEvent.response,
    );
  }
}

function parseOpenAICodexImageEvents(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      if (isRecord(parsed)) {
        events.push(parsed);
      }
    } catch {
      throw new BoundedResponseReadError(
        "body_parse",
        `${OPENAI_CODEX_IMAGE_RESPONSE_LABEL} response body contained malformed SSE JSON.`,
        OPENAI_CODEX_IMAGE_RESPONSE_LABEL,
      );
    }
    if (events.length > MAX_CODEX_IMAGE_SSE_EVENTS) {
      throw new BoundedResponseReadError(
        "body_event_limit",
        "OpenAI Codex image generation response exceeded event limit.",
        OPENAI_CODEX_IMAGE_RESPONSE_LABEL,
      );
    }
  }
  return events;
}

function normalizeOpenAICodexImageResponseError(error: unknown): unknown {
  if (error instanceof BoundedResponseReadError) {
    return toOpenAICodexImageExternalServiceError(error.code);
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    // OpenAI Codex image dispatch does not accept a caller cancellation signal;
    // an abort while reading this response is therefore the governed request deadline.
    return toOpenAICodexImageExternalServiceError("body_timeout");
  }
  return error;
}

function toOpenAICodexImageExternalServiceError(code: BoundedResponseReadErrorCode): ExternalServiceError {
  const failureByCode: Record<BoundedResponseReadErrorCode, { message: string; reason: string; retryable: boolean }> = {
    body_timeout: {
      message: "OpenAI Codex image generation timed out before the provider finished sending the response.",
      reason: "response_body_timeout",
      retryable: true,
    },
    body_limit: {
      message: "OpenAI Codex image generation returned a response larger than the supported limit.",
      reason: "response_body_limit",
      retryable: false,
    },
    body_parse: {
      message: "OpenAI Codex image generation returned a malformed response.",
      reason: "response_body_malformed",
      retryable: true,
    },
    body_missing: {
      message: "OpenAI Codex image generation returned an empty response.",
      reason: "response_body_missing",
      retryable: true,
    },
    body_incomplete: {
      message: "OpenAI Codex image generation returned an incomplete response.",
      reason: "response_body_incomplete",
      retryable: true,
    },
    body_no_payload: {
      message: "OpenAI Codex image generation returned no image payload.",
      reason: "response_body_no_payload",
      retryable: true,
    },
    body_event_limit: {
      message: "OpenAI Codex image generation returned too many response events.",
      reason: "response_body_event_limit",
      retryable: false,
    },
  };
  const failure = failureByCode[code];
  return new ExternalServiceError(failure.message, {
    service: "openai-codex",
    operation: "image_generation",
    reason: failure.reason,
    retryable: failure.retryable,
  });
}

function toOpenAICodexImageResult(item: Record<string, unknown>): ImageGenerationResponse["data"][number] | undefined {
  const result = typeof item.result === "string" ? item.result : undefined;
  if (!result) {
    return undefined;
  }
  if (result.length > MAX_CODEX_IMAGE_BASE64_CHARS) {
    throw new Error("OpenAI Codex image generation result exceeded size limit.");
  }
  assertStrictBase64(result, "OpenAI Codex image generation result");
  return {
    b64Json: result,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
  };
}

function supportsImageGenerationProvider(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex" || normalized === "google";
}

function defaultImageModelForProvider(providerId: string): string {
  return providerId.trim().toLowerCase() === "google" ? "gemini-3.1-flash-image-preview" : "gpt-image-2";
}

function supportsImageResponseFormat(model: string): boolean {
  return !model.toLowerCase().startsWith("gpt-image-2");
}

function adaptImageGenerationResponse(
  payload: Record<string, unknown>,
  context: {
    providerId: string;
    model: string;
    operation: "generate" | "edit";
  },
): ImageGenerationResponse {
  const items = Array.isArray(payload.data)
    ? payload.data.filter(isRecord).map((item) => ({
        b64Json: normalizeProviderImageBase64(item.b64_json, "image generation result"),
        url: normalizeProviderImageUrl(item.url),
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      }))
    : [];
  return {
    providerId: context.providerId,
    model: typeof payload.model === "string" ? payload.model : context.model,
    created: typeof payload.created === "number" ? payload.created : undefined,
    operation: context.operation,
    data: items,
  };
}

function attachImageGenerationEvidence(
  response: ImageGenerationResponse,
  request: ImageGenerationRequest,
  context: {
    providerId: string;
    model: string;
    operation: "generate" | "edit";
    prompt: string;
  },
): ImageGenerationResponse {
  const referenceImageHashes = (request.referenceImages ?? []).map(hashImageAssetInput);
  const maskImageHash = request.maskImage ? hashImageAssetInput(request.maskImage) : undefined;
  const promptHash = hashUtf8(context.prompt);
  const requestHash = hashStableJson({
    providerId: context.providerId,
    model: context.model,
    operation: context.operation,
    promptHash,
    referenceImageHashes,
    maskImageHash,
    n: request.n,
    size: request.size,
    quality: request.quality,
    background: request.background,
    outputFormat: request.outputFormat,
    responseFormat: request.responseFormat,
    moderation: request.moderation,
  });
  const evidenceId = `image-proof:${requestHash.slice(0, 24)}`;
  const results = response.data.map((item, index) => buildImageResultEvidence(evidenceId, item, index));
  const providerBacked = results.some((item) => item.status === "provider_backed" || item.status === "provider_url");

  return {
    ...response,
    evidence: {
      evidenceId,
      owner: "gateway",
      source: "provider_response",
      timestamp: new Date().toISOString(),
      providerId: response.providerId ?? context.providerId,
      model: response.model ?? context.model,
      operation: response.operation,
      requestHash,
      promptHash,
      referenceImageHashes: referenceImageHashes.length > 0 ? referenceImageHashes : undefined,
      maskImageHash,
      resultCount: response.data.length,
      status: providerBacked ? "provider_backed" : "no_results",
      actionNeeded: providerBacked
        ? "Persist the selected image artifact before claiming local artifact durability."
        : "Provider returned no usable image result; retry or choose another provider.",
      results,
    },
  };
}

function buildImageResultEvidence(
  evidenceId: string,
  item: ImageGenerationResponse["data"][number],
  index: number,
): NonNullable<ImageGenerationResponse["evidence"]>["results"][number] {
  const revisedPromptHash = item.revisedPrompt ? hashUtf8(item.revisedPrompt) : undefined;
  if (item.b64Json) {
    const bytes = decodeStrictBase64(item.b64Json, "image generation result");
    return {
      evidenceId: `${evidenceId}:result:${index}`,
      index,
      source: "b64_json",
      status: "provider_backed",
      sha256: hashBuffer(bytes),
      sizeBytes: bytes.length,
      revisedPromptHash,
      persistedArtifact: {
        status: "inline_result",
        actionNeeded: "Persist this inline image response as an artifact before durable local claims.",
      },
    };
  }
  if (item.url?.toLowerCase().startsWith("data:")) {
    const parsed = parseImageDataUrl(item.url);
    return {
      evidenceId: `${evidenceId}:result:${index}`,
      index,
      source: "data_url",
      status: "provider_backed",
      sha256: hashBuffer(parsed.bytes),
      sizeBytes: parsed.bytes.length,
      mimeType: parsed.mimeType,
      revisedPromptHash,
      persistedArtifact: {
        status: "inline_result",
        actionNeeded: "Persist this inline image response as an artifact before durable local claims.",
      },
    };
  }
  if (item.url) {
    const parsed = new URL(item.url);
    return {
      evidenceId: `${evidenceId}:result:${index}`,
      index,
      source: "url",
      status: "provider_url",
      urlHost: parsed.host,
      urlHash: hashUtf8(item.url),
      revisedPromptHash,
      persistedArtifact: {
        status: "external_url",
        actionNeeded: "Download and hash through the artifact pipeline before durable local claims.",
      },
    };
  }
  return {
    evidenceId: `${evidenceId}:result:${index}`,
    index,
    source: "b64_json",
    status: "empty_result",
    revisedPromptHash,
    persistedArtifact: {
      status: "not_persisted",
      actionNeeded: "Provider result did not include image bytes or an image URL.",
    },
  };
}

function hashImageAssetInput(input: ImageAssetInput): string {
  return hashBuffer(decodeStrictBase64(input.bytesBase64, "image asset"));
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } {
  const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new Error("image generation data URL must be a valid base64 data URL.");
  }
  return {
    mimeType: match[1] ?? "application/octet-stream",
    bytes: decodeStrictBase64(match[2] ?? "", "image generation data URL"),
  };
}

function hashBuffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashStableJson(value: unknown): string {
  return hashUtf8(JSON.stringify(sortStableJson(value)));
}

function sortStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortStableJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortStableJson(item)]),
  );
}

function normalizeProviderImageBase64(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > MAX_CODEX_IMAGE_BASE64_CHARS) {
    throw new Error(`${label} exceeded size limit.`);
  }
  assertStrictBase64(normalized, label);
  return normalized;
}

function normalizeProviderImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.toLowerCase().startsWith("data:")) {
    assertValidImageDataUrl(normalized, "image generation data URL");
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return normalized;
    }
  } catch {
    // Intentionally fall through to report a stable validation error below.
  }
  throw new Error("Image generation result URL must be http(s) or a valid base64 data URL.");
}

function assertValidImageDataUrl(dataUrl: string, label: string): void {
  if (dataUrl.length > MAX_IMAGE_DATA_URL_BASE64_CHARS + 64) {
    throw new Error(`${label} exceeded size limit.`);
  }
  const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new Error(`${label} must be a valid base64 data URL.`);
  }
  assertStrictBase64(match[2] ?? "", label);
}

function assertStrictBase64(value: string, label: string): void {
  void decodeStrictBase64(value, label);
}

function decodeStrictBase64(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} base64 payload is empty.`);
  }
  const unpadded = normalized.replace(/=+$/, "");
  const firstPaddingIndex = normalized.indexOf("=");
  const paddingLength = normalized.match(/=+$/)?.[0].length ?? 0;
  if (
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    (firstPaddingIndex !== -1 && firstPaddingIndex < normalized.length - paddingLength)
  ) {
    throw new Error(`${label} must be valid base64.`);
  }
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new Error(`${label} must be valid base64.`);
  }
  return decoded;
}

function normalizeProviderMessages(
  messages: ChatCompletionRequest["messages"],
  model: string,
): ChatCompletionRequest["messages"] {
  if (!modelRequiresReasoningContentForToolCalls(model)) {
    return messages;
  }
  return messages.map((message) => {
    const value = toPlainRecord(message);
    if (message.role !== "assistant" || !value || !Array.isArray(value.tool_calls)) {
      return message;
    }
    const existingReasoning = typeof value.reasoning_content === "string" ? value.reasoning_content.trim() : "";
    if (existingReasoning.length > 0) {
      return message;
    }
    const content = typeof value.content === "string" ? value.content.trim() : "";
    return {
      ...message,
      reasoning_content: content || "Using tools to gather and verify information.",
    } as ChatCompletionRequest["messages"][number];
  });
}

function modelRequiresReasoningContentForToolCalls(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("kimi") || normalized.includes("moonshot");
}

function inferProviderCapabilities(provider: LlmProviderConfig): LlmProviderCapabilities {
  const model = provider.defaultModel.toLowerCase();
  const base = provider.baseUrl.toLowerCase();
  const hasVision =
    model.includes("vision") ||
    model.includes("gpt-5") ||
    model.includes("gpt-4o") ||
    model.includes("gpt-4.1") ||
    model.includes("gemini") ||
    model.includes("claude-3") ||
    model.includes("claude-sonnet-4") ||
    model.includes("claude-opus-4") ||
    model.includes("kimi") ||
    model.includes("glm");
  const hasAudio = model.includes("audio") || model.includes("whisper");
  const hasVideo = model.includes("video");
  const hasToolCalling = true;
  const hasJsonMode =
    model.includes("gpt") || model.includes("glm") || model.includes("gemini") || base.includes("openai");
  const hasWebSearch =
    model.includes("search") ||
    model.includes("sonar") ||
    model.includes("kimi") ||
    model.includes("gpt-4.1") ||
    model.includes("gpt-5");
  const hasReasoning =
    model.includes("gpt-5") ||
    model.includes("reason") ||
    model.includes("thinking") ||
    model.includes("o1") ||
    model.includes("o3") ||
    model.includes("claude-sonnet-4") ||
    model.includes("claude-opus-4");
  return {
    vision: hasVision,
    audio: hasAudio,
    video: hasVideo,
    toolCalling: hasToolCalling,
    jsonMode: hasJsonMode,
    webSearch: hasWebSearch,
    reasoning: hasReasoning,
    reasoningEfforts: provider.providerId.trim().toLowerCase() === "vertex" ? ["low", "medium", "high"] : undefined,
    imageGenerate: supportsImageGenerationProvider(provider.providerId),
    imageEdit: supportsImageGenerationProvider(provider.providerId),
    ...(provider.capabilities ?? {}),
  };
}

function defaultModelForProvider(providerId: string): string {
  return findProviderTemplate(providerId.trim().toLowerCase())?.defaultModel ?? "gpt-5.4-mini";
}

function defaultAuthModeForProvider(providerId: string): LlmProviderConfig["authMode"] {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "openai-codex") {
    return "codex-oauth";
  }
  if (normalized === "claude-code") {
    return "claude-code-oauth";
  }
  if (normalized === "vertex") {
    return "google-adc";
  }
  return undefined;
}

function resolveProviderAuthMode(provider: LlmProviderConfig): LlmProviderConfig["authMode"] {
  return provider.authMode ?? defaultAuthModeForProvider(provider.providerId);
}

function isOpenAICodexProvider(provider: Pick<LlmProviderConfig, "providerId">): boolean {
  return provider.providerId.trim().toLowerCase() === "openai-codex";
}

function isClaudeCodeOAuthProvider(provider: Pick<LlmProviderConfig, "providerId" | "authMode">): boolean {
  return provider.providerId.trim().toLowerCase() === "claude-code" || provider.authMode === "claude-code-oauth";
}

function isAnthropicApiKeyProvider(provider: Pick<LlmProviderConfig, "providerId" | "authMode">): boolean {
  return provider.providerId.trim().toLowerCase() === "anthropic" && !isClaudeCodeOAuthProvider(provider);
}

function applyProviderSpecificChatOptions(input: {
  payload: Record<string, unknown>;
  providerId: string;
  model: string;
  request: ChatCompletionRequest;
}): void {
  const providerId = input.providerId.trim().toLowerCase();
  if (providerId !== "openai" && providerId !== "vertex" && providerId !== "fireworks") {
    return;
  }
  if (providerId === "openai") {
    validateOpenAiRequestCompatibility(input.request, input.model);
  }
  if (input.request.reasoning?.effort && (providerId === "openai" || input.request.reasoning.effort !== "none")) {
    input.payload.reasoning_effort = input.request.reasoning.effort;
  }
  if (providerId === "fireworks") {
    input.payload.context_length_exceeded_behavior = "error";
  }
  if (providerId !== "openai") {
    return;
  }
  if (input.request.verbosity) {
    input.payload.verbosity = input.request.verbosity;
  }
  if (input.request.service_tier) {
    input.payload.service_tier = input.request.service_tier;
  }
  if (input.request.prompt_cache_retention) {
    input.payload.prompt_cache_retention = input.request.prompt_cache_retention;
  }
}

function validateOpenAiRequestCompatibility(request: ChatCompletionRequest, model: string): void {
  const hasSamplingControls = request.temperature !== undefined || request.top_p !== undefined;
  if (!hasSamplingControls) {
    return;
  }
  if (isOpenAiGpt54Or52Model(model)) {
    if (request.reasoning?.effort && request.reasoning.effort !== "none") {
      throw new Error("OpenAI GPT-5.4/GPT-5.2 only support temperature/top_p when reasoning effort is set to none.");
    }
    return;
  }
  if (isOlderOpenAiGpt5Model(model)) {
    throw new Error("Older OpenAI GPT-5 family models do not support temperature/top_p in chat/completions.");
  }
}

function isOpenAiGpt54Or52Model(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^gpt-5\.(?:4|2)(?:$|[.-])/.test(normalized);
}

function isOlderOpenAiGpt5Model(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^gpt-5(?:$|-)/.test(normalized) && !isOpenAiGpt54Or52Model(normalized);
}
