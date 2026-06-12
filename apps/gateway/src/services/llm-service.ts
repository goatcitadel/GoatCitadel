/* eslint-disable max-lines -- LLM transport and provider normalization are intentionally centralized until provider seams are split further. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { logger } from "@goatcitadel/gateway-core";
import { assertHostAllowed } from "@goatcitadel/policy-engine";
import { parseProviderJsonResponse } from "./llm-response-parsing.js";
import { Agent, ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
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
  LlmModelRecord,
  LlmModelPreviewRequest,
  LlmModelPreviewResponse,
  LlmProviderConfig,
  LlmProviderSummary,
  LlmRuntimeConfig,
} from "@goatcitadel/contracts";
import { findProviderTemplate, inferProviderForModelId, providerAllowsForeignModelIds } from "@goatcitadel/contracts";
import { clampSummaryReserveTokens, type ClampSummaryReserveResult } from "./chat-compaction.js";
import { loadLlmModelMetadataManifest, lookupModelMetadata } from "./llm-model-metadata.js";
import { anthropicProviderAdapter } from "./llm-provider-anthropic.js";
import {
  createLlmProviderAdapterRegistry,
  type LlmProviderAdapterHost,
  type LlmProviderAdapterRegistry,
  type LlmProviderResolution,
} from "./llm-provider-adapter.js";
import { applyEstimatedCostToChatResponse, applyEstimatedCostToStreamChunk } from "./llm-pricing.js";
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
const MODEL_DISCOVERY_AUTH_CACHE_TOKENS = new Map<string, string>();

export interface LlmRuntimeUpdateInput {
  activeProviderId?: string;
  activeModel?: string;
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
  };
}

type ResolvedProvider = LlmProviderResolution;

interface ProviderRequestTarget {
  url: string;
  headers: Record<string, string>;
  dispatcher?: Dispatcher;
}

function getModelDiscoveryAuthCacheToken(apiKey: string): string {
  const existing = MODEL_DISCOVERY_AUTH_CACHE_TOKENS.get(apiKey);
  if (existing) {
    return existing;
  }
  const token = randomUUID();
  MODEL_DISCOVERY_AUTH_CACHE_TOKENS.set(apiKey, token);
  return token;
}

interface ModelDiscoveryResult {
  items: LlmModelRecord[];
  source: LlmModelDiscoverySource;
  warning?: string;
}

export interface LlmServiceOptions {
  networkAllowlist?: string[];
  enforceNetworkAllowlist?: boolean;
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
}

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

const DISALLOWED_BASE_HOSTS = new Set(["0.0.0.0", "169.254.169.254", "metadata.google.internal", "100.100.100.200"]);
const SECRET_STATUS_CACHE_TTL_MS = 60_000;
type UndiciAgentConnectOptions = Exclude<
  NonNullable<NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"]>,
  (...args: unknown[]) => unknown
>;
type UndiciProxyTlsOptions = Extract<ConstructorParameters<typeof ProxyAgent>[0], object>["requestTls"];
type UndiciConnectOptions = UndiciAgentConnectOptions & UndiciProxyTlsOptions;
type FetchRequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

export class LlmService {
  private static readonly MODEL_DISCOVERY_TTL_MS = 60_000;
  private readonly providers = new Map<string, LlmProviderConfig>();
  private readonly secretStore: SecretStoreService;
  private readonly openAICodexOAuth: OpenAICodexOAuthService;
  private readonly secretStatusCache = new Map<string, SecretStatusCacheEntry>();
  private readonly modelDiscoveryCache = new Map<string, { cachedAt: number; result: ModelDiscoveryResult }>();
  private readonly modelDiscoveryInFlight = new Map<string, Promise<ModelDiscoveryResult>>();
  private readonly requestDispatcherCache = new Map<string, Dispatcher>();
  private readonly providerAdapters: LlmProviderAdapterRegistry = createLlmProviderAdapterRegistry([
    anthropicProviderAdapter,
  ]);
  private readonly providerAdapterHost: LlmProviderAdapterHost = {
    buildRequestTarget: (resolved, purpose, endpointUrl) => this.buildRequestTarget(resolved, purpose, endpointUrl),
  };
  private networkAllowlist: string[];
  private enforceNetworkAllowlist: boolean;
  private activeProviderId: string;
  private activeModel: string;
  private readonly modelMetadata: LlmModelMetadataManifest;

  public constructor(
    config: LlmConfigFile,
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: LlmServiceOptions = {},
  ) {
    this.secretStore = options.secretStore ?? new SecretStoreService();
    this.openAICodexOAuth = new OpenAICodexOAuthService(this.secretStore, options.openAICodexOAuthFetch ?? fetch);
    this.networkAllowlist = [...(options.networkAllowlist ?? [])];
    this.enforceNetworkAllowlist = options.enforceNetworkAllowlist ?? true;
    this.activeProviderId = "";
    this.activeModel = "";

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
  }

  public listProviders(options: LlmListProvidersOptions = {}): LlmProviderSummary[] {
    const includeKeychainDefault = options.includeKeychain ?? false;
    return Array.from(this.providers.values()).map((provider) => {
      const includeKeychain =
        options.includeKeychainForProviderId === provider.providerId ? true : includeKeychainDefault;
      const oauthStatus = isOpenAICodexProvider(provider) ? this.openAICodexOAuth.getStatus() : undefined;
      const status = oauthStatus
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
        authMode: resolveProviderAuthMode(provider),
        oauthStatus,
        hasApiKey: status.hasApiKey,
        apiKeySource: status.apiKeySource,
        hasKeychainSecret: status.hasKeychainSecret,
        apiKeyRef: status.apiKeyRef,
        capabilities: inferProviderCapabilities(provider),
      };
    });
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
      activeModelContextWindow: activeMeta?.contextWindow,
      activeModelOutputTokenLimit: activeMeta?.outputTokenLimit,
      providers,
    };
  }

  public updateRuntimeConfig(input: LlmRuntimeUpdateInput): LlmRuntimeConfig {
    this.modelDiscoveryCache.clear();
    this.modelDiscoveryInFlight.clear();
    if (input.upsertProvider) {
      const existing = this.providers.get(input.upsertProvider.providerId);
      const isCodexOAuthProvider = input.upsertProvider.providerId.trim().toLowerCase() === "openai-codex";
      const submittedApiKey = isCodexOAuthProvider ? undefined : input.upsertProvider.apiKey?.trim();
      if (submittedApiKey) {
        this.setProviderApiKey(input.upsertProvider.providerId, submittedApiKey);
      }

      const merged: LlmProviderConfig = normalizeProvider({
        providerId: input.upsertProvider.providerId,
        label: input.upsertProvider.label ?? existing?.label ?? input.upsertProvider.providerId,
        baseUrl: input.upsertProvider.baseUrl ?? existing?.baseUrl ?? "http://127.0.0.1:1234/v1",
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
            : (input.upsertProvider.apiKey ?? existing?.apiKey),
        apiKeyEnv: isCodexOAuthProvider ? undefined : (input.upsertProvider.apiKeyEnv ?? existing?.apiKeyEnv),
        request: input.upsertProvider.request ?? existing?.request,
        headers: input.upsertProvider.headers ?? existing?.headers,
      });
      this.providers.set(merged.providerId, merged);
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

    return this.getRuntimeConfig({
      includeKeychainForActiveProvider: true,
      useCache: true,
    });
  }

  public getProviderSecretStatus(
    providerId: string,
    options: LlmProviderSecretStatusOptions = {},
  ): LlmProviderSecretStatus {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
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
  }

  public getOpenAICodexOAuthStatus(): OpenAICodexOAuthStatus {
    return this.openAICodexOAuth.getStatus();
  }

  public async startOpenAICodexOAuthDeviceFlow(): Promise<OpenAICodexDeviceStartResponse> {
    this.assertKnownOpenAICodexProvider();
    return this.openAICodexOAuth.startDeviceFlow();
  }

  public async pollOpenAICodexOAuthDeviceFlow(flowId: string): Promise<OpenAICodexDevicePollResponse> {
    this.assertKnownOpenAICodexProvider();
    return this.openAICodexOAuth.pollDeviceFlow(flowId);
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
    // baseUrl is on a different host than the existing provider's
    // configured baseUrl. The caller may still preview an arbitrary baseUrl
    // — they just have to supply the key themselves.
    const hostsMatch = previewHostsMatch(existing?.baseUrl, input.baseUrl);
    const inheritFromExisting = !existing || hostsMatch;
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

  public async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new Error("images requires a non-empty prompt");
    }

    const resolved = await this.resolveProvider(request.providerId, { requireAuth: true });
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    if (!supportsImageGenerationProvider(resolved.provider.providerId)) {
      throw new Error("Image generation currently requires an OpenAI, OpenAI Codex, or Google-compatible provider.");
    }

    const model = request.model?.trim() || defaultImageModelForProvider(resolved.provider.providerId);
    const operation =
      Array.isArray(request.referenceImages) && request.referenceImages.length > 0 ? "edit" : "generate";

    if (isOpenAICodexProvider(resolved.provider)) {
      return this.generateOpenAICodexImage(request, resolved, model, operation);
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
      const response = await postMultipartRequest(target, formData, timeoutMs);
      if (isRedirect(response.status)) {
        throw new Error(`image edit blocked redirect (${response.status})`);
      }
      if (!response.ok) {
        throw new Error(await buildHttpError("image edit", response));
      }
      return adaptImageGenerationResponse(await parseProviderJsonResponse("image edit", response), {
        providerId: resolved.provider.providerId,
        model,
        operation,
      });
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
    const response = await postJsonRequest(target, payload, timeoutMs);
    if (isRedirect(response.status)) {
      throw new Error(`image generation blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("image generation", response));
    }
    return adaptImageGenerationResponse(await parseProviderJsonResponse("image generation", response), {
      providerId: resolved.provider.providerId,
      model,
      operation,
    });
  }

  private async generateOpenAICodexImage(
    request: ImageGenerationRequest,
    resolved: ResolvedProvider,
    model: string,
    operation: "generate" | "edit",
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
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: request.prompt.trim() },
      ...referenceImages.map((image) => ({
        type: "input_image",
        image_url: toImageDataUrl(image),
        detail: "auto",
      })),
    ];

    for (let index = 0; index < count; index += 1) {
      const response = await postJsonRequest(target, buildOpenAICodexImagePayload(request, model, content), timeoutMs);
      if (isRedirect(response.status)) {
        throw new Error(`OpenAI Codex image generation blocked redirect (${response.status})`);
      }
      if (!response.ok) {
        throw new Error(await buildHttpError("OpenAI Codex image generation", response));
      }
      data.push(...(await adaptOpenAICodexImageResponse(response, model)));
    }

    return {
      providerId: resolved.provider.providerId,
      model,
      operation,
      data: data.slice(0, 4),
    };
  }

  private assertKnownOpenAICodexProvider(): void {
    if (!this.providers.has("openai-codex")) {
      throw new Error("Unknown LLM provider: openai-codex");
    }
  }

  public async chatCompletions(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!request.messages || request.messages.length === 0) {
      throw new Error("chat/completions requires at least one message");
    }

    const resolved = await this.resolveProvider(request.providerId, { requireAuth: true });
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const model = this.resolveRequestModel(resolved.provider, request.model);
    const apiStyle = resolveProviderExecutionApiStyle(resolved.provider, model);
    const providerAdapter = this.providerAdapters.get(apiStyle);
    if (providerAdapter) {
      return providerAdapter.chatCompletions(request, resolved, model, this.providerAdapterHost);
    }

    switch (apiStyle) {
      case "openai-codex-responses":
      case "openai-responses":
        return this.executeOpenAiResponses(request, resolved, model);
      case "bedrock-messages":
        throw new Error("AWS Bedrock messages API style is not yet supported in this version");
      default:
        return this.executeChatCompletions(request, resolved, model);
    }
  }

  public async *chatCompletionsStream(request: ChatCompletionRequest): AsyncGenerator<Record<string, unknown>> {
    if (!request.messages || request.messages.length === 0) {
      throw new Error("chat/completions requires at least one message");
    }

    const resolved = await this.resolveProvider(request.providerId, { requireAuth: true });
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const model = this.resolveRequestModel(resolved.provider, request.model);
    const apiStyle = resolveProviderExecutionApiStyle(resolved.provider, model);
    const providerAdapter = this.providerAdapters.get(apiStyle);
    if (providerAdapter) {
      yield* providerAdapter.chatCompletionsStream(request, resolved, model, this.providerAdapterHost);
      return;
    }

    switch (apiStyle) {
      case "openai-codex-responses":
      case "openai-responses":
        yield* this.executeOpenAiResponsesStream(request, resolved, model);
        return;
      case "bedrock-messages":
        throw new Error("AWS Bedrock messages API style is not yet supported in this version");
      default:
        yield* this.executeChatCompletionsStream(request, resolved, model);
        return;
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
    let response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`chat completion blocked redirect (${response.status})`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.metadata;
        response = await postJsonRequest(target, fallbackPayload, timeoutMs, request.signal);
        if (isRedirect(response.status)) {
          throw new Error(`chat completion blocked redirect (${response.status})`);
        }
        if (!response.ok) {
          throw new Error(await buildHttpError("chat completion", response));
        }
      } else {
        throw new Error(buildHttpErrorFromText("chat completion", response.status, response.statusText, errorText));
      }
    }

    return applyEstimatedCostToChatResponseWithSource(
      await parseProviderJsonResponse<ChatCompletionResponse>("chat completion", response),
      {
        providerId: resolved.provider.providerId,
        model,
      },
    );
  }

  private async *executeChatCompletionsStream(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
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
    let response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`chat completion blocked redirect (${response.status})`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.metadata;
        response = await postJsonRequest(target, fallbackPayload, timeoutMs, request.signal);
        if (isRedirect(response.status)) {
          throw new Error(`chat completion blocked redirect (${response.status})`);
        }
        if (!response.ok) {
          throw new Error(await buildHttpError("chat completion", response));
        }
      } else {
        throw new Error(buildHttpErrorFromText("chat completion", response.status, response.statusText, errorText));
      }
    }

    for await (const event of streamJsonSseResponse(response)) {
      yield applyEstimatedCostToStreamChunkWithSource(event, {
        providerId: resolved.provider.providerId,
        model,
      });
    }
  }

  private async executeOpenAiResponses(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
  ): Promise<ChatCompletionResponse> {
    const payload = buildOpenAiResponsesPayload(request, model, resolved.provider);
    const codexResponsesProvider = isOpenAICodexResponsesProvider(resolved.provider);
    if (codexResponsesProvider) {
      payload.stream = true;
    }
    const target = this.buildRequestTarget(resolved, "responses", `${resolved.provider.baseUrl}/responses`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    const response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`responses request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("responses request", response));
    }

    if (codexResponsesProvider && response.body) {
      return applyEstimatedCostToChatResponseWithSource(await collectOpenAiResponsesStreamCompletion(response, model), {
        providerId: resolved.provider.providerId,
        model,
      });
    }

    const json = await parseProviderJsonResponse("responses request", response);
    return applyEstimatedCostToChatResponseWithSource(adaptOpenAiResponsesResponse(json), {
      providerId: resolved.provider.providerId,
      model,
    });
  }

  private async *executeOpenAiResponsesStream(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const payload = buildOpenAiResponsesPayload(request, model, resolved.provider);
    payload.stream = true;

    const target = this.buildRequestTarget(resolved, "responses", `${resolved.provider.baseUrl}/responses`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    const response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`responses request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("responses request", response));
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const shouldParseAsSse =
      isOpenAICodexResponsesProvider(resolved.provider) || contentType.includes("text/event-stream");
    if (!shouldParseAsSse || !response.body) {
      const json = await parseProviderJsonResponse("responses stream", response);
      yield applyEstimatedCostToChatResponseWithSource(adaptOpenAiResponsesResponse(json), {
        providerId: resolved.provider.providerId,
        model,
      });
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

    for await (const event of streamJsonSseResponse(response, { forceSse: shouldParseAsSse })) {
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "response.output_text.delta") {
        yield {
          id: String(event.item_id ?? event.response_id ?? event.id ?? "response"),
          choices: [
            {
              index: 0,
              delta: {
                content: String(event.delta ?? ""),
              },
            },
          ],
        };
        continue;
      }

      if (eventType === "response.output_item.done") {
        const item = isRecord(event.item) ? event.item : undefined;
        if (item?.type === "function_call") {
          const toolCallIndex = resolveStreamedFunctionCallIndex(event, item);
          yield {
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
          };
        }
        continue;
      }

      if (eventType === "response.completed" && isRecord(event.response)) {
        const adapted = adaptOpenAiResponsesResponse(event.response);
        yield applyEstimatedCostToStreamChunkWithSource(
          {
            id: adapted.id,
            model: adapted.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: adapted.choices?.[0]?.finish_reason ?? "stop",
              },
            ],
            usage: adapted.usage,
          },
          {
            providerId: resolved.provider.providerId,
            model,
          },
        );
        continue;
      }

      if (eventType === "response.failed") {
        throw buildResponsesStreamFailureError(event);
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

    const apiKey = isOpenAICodexProvider(provider)
      ? options.requireAuth
        ? await this.openAICodexOAuth.resolveAccessToken()
        : undefined
      : this.resolveApiKey(provider);
    return { provider, apiKey };
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
    // When no explicit runtime allowlist is configured, permit validated provider base URLs.
    // Provider URLs still pass strict baseUrl validation (protocol/host/private-range checks).
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
    if (!requestConfig?.proxy && !requestConfig?.tls) {
      return undefined;
    }

    const targetUrl = new URL(endpoint);
    const cacheKey = buildRequestDispatcherCacheKey(targetUrl, requestConfig);
    const cached = this.requestDispatcherCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const dispatcher = createRequestDispatcher(targetUrl, requestConfig, this.env);
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

  private async fetchModelsForResolvedProvider(resolved: ResolvedProvider): Promise<ModelDiscoveryResult> {
    let key = `${resolved.provider.providerId}::${resolved.provider.baseUrl}`;
    if (resolved.apiKey) {
      key += `::auth_${getModelDiscoveryAuthCacheToken(resolved.apiKey)}`;
    }
    const now = Date.now();
    const cached = this.modelDiscoveryCache.get(key);
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
      // and trigger a background refresh.
      if (ageMs < 3600_000) {
        log.debug("model catalog cache hit (stale, revalidating in background)", {
          providerId: resolved.provider.providerId,
          ageMs,
          itemCount: cached.result.items.length,
        });

        const inFlight = this.modelDiscoveryInFlight.get(key);
        if (!inFlight) {
          const pending = this.fetchModelsForResolvedProviderUncached(resolved)
            .then((result) => {
              if (result.source !== "error_fallback") {
                this.modelDiscoveryCache.set(key, { cachedAt: Date.now(), result });
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
              this.modelDiscoveryInFlight.delete(key);
            });
          this.modelDiscoveryInFlight.set(key, pending);
        }
        return cached.result;
      }
    }
    // Stampede protection: coalesce concurrent cold-cache callers onto a single fetch.
    const inFlight = this.modelDiscoveryInFlight.get(key);
    if (inFlight) {
      return inFlight;
    }
    const pending = this.fetchModelsForResolvedProviderUncached(resolved)
      .then((result) => {
        // Cache live + template_fallback (successful fetches with known catalog), but
        // skip error_fallback so transient network errors retry on the next call.
        if (result.source !== "error_fallback") {
          this.modelDiscoveryCache.set(key, { cachedAt: now, result });
        }
        return result;
      })
      .finally(() => {
        this.modelDiscoveryInFlight.delete(key);
      });
    this.modelDiscoveryInFlight.set(key, pending);
    return pending;
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

    try {
      const requestInit: FetchRequestInitWithDispatcher = {
        method: "GET",
        headers: target.headers,
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
        dispatcher: target.dispatcher,
      };
      const response = await fetch(target.url, requestInit);

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
      if (fallback.length > 0) {
        return { items: fallback, source: "error_fallback", warning: (error as Error).message };
      }
      throw error;
    }
  }
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

// SECURITY (codex finding #25a, #30): Compare the host portion of two
// provider base URLs. Used by `previewModels` to decide whether the
// caller-supplied baseUrl is the same provider host as the configured one;
// if not, inheriting stored secrets is unsafe.
export function previewHostsMatch(configuredBaseUrl: string | undefined, requestedBaseUrl: string): boolean {
  if (!configuredBaseUrl?.trim()) {
    return true;
  }
  try {
    const configured = new URL(configuredBaseUrl).host.toLowerCase();
    const requested = new URL(requestedBaseUrl).host.toLowerCase();
    return configured === requested;
  } catch {
    return false;
  }
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
    });
  }
  return normalized;
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
  if (providerId === "perplexity" || providerId === "openai-codex") {
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
  const text = await response.text();
  const snippet = text.slice(0, 400);
  return `${action} failed (${response.status} ${response.statusText}): ${snippet}`;
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

function resolveChatCompletionTimeoutMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }
  return Math.max(1, Math.floor(value));
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

function shouldUseMaxCompletionTokens(providerId: string, model: string): boolean {
  if (providerId !== "openai") {
    return false;
  }
  const normalized = model.trim().toLowerCase();
  return /^gpt-5(?:$|[.-])/.test(normalized);
}

async function postJsonRequest(
  target: ProviderRequestTarget,
  payload: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  const requestInit: FetchRequestInitWithDispatcher = {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify(payload),
    signal,
    redirect: "manual",
    dispatcher: target.dispatcher,
  };
  return fetch(target.url, requestInit);
}

async function postMultipartRequest(
  target: ProviderRequestTarget,
  formData: FormData,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  const requestInit: FetchRequestInitWithDispatcher = {
    method: "POST",
    headers: target.headers,
    body: formData,
    signal,
    redirect: "manual",
    dispatcher: target.dispatcher,
  };
  return fetch(target.url, requestInit);
}

function createRequestDispatcher(
  targetUrl: URL,
  requestConfig: LlmProviderRequestConfig,
  env: NodeJS.ProcessEnv,
): Dispatcher | undefined {
  const tlsOptions = targetUrl.protocol === "https:" ? buildRequestTlsOptions(requestConfig.tls) : undefined;
  const proxy = requestConfig.proxy;
  if (proxy && !shouldBypassProxy(targetUrl.hostname, proxy.bypassHosts)) {
    const proxyHeaders = buildProxyRequestHeaders(proxy.auth, env);
    return new ProxyAgent({
      uri: proxy.url,
      headers: proxyHeaders,
      proxyTls: buildRequestTlsOptions(proxy.tls),
      requestTls: tlsOptions,
    });
  }
  if (!tlsOptions) {
    return undefined;
  }
  return new Agent({
    connect: tlsOptions,
  });
}

function buildRequestDispatcherCacheKey(targetUrl: URL, requestConfig: LlmProviderRequestConfig): string {
  const useProxy = Boolean(
    requestConfig.proxy && !shouldBypassProxy(targetUrl.hostname, requestConfig.proxy.bypassHosts),
  );
  return JSON.stringify({
    origin: targetUrl.origin,
    useProxy,
    proxyUrl: useProxy ? requestConfig.proxy?.url : undefined,
    proxyAuth: useProxy ? (requestConfig.proxy?.auth ?? undefined) : undefined,
    proxyTls: useProxy ? (requestConfig.proxy?.tls ?? undefined) : undefined,
    tls: requestConfig.tls ?? undefined,
  });
}

function buildRequestTlsOptions(tlsConfig: LlmProviderRequestTlsConfig | undefined): UndiciConnectOptions | undefined {
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
    connectOptions.ca = readFileSync(tlsConfig.caCertPath);
    hasTlsOverride = true;
  }
  if (tlsConfig.clientCertPath) {
    connectOptions.cert = readFileSync(tlsConfig.clientCertPath);
    hasTlsOverride = true;
  }
  if (tlsConfig.clientKeyPath) {
    connectOptions.key = readFileSync(tlsConfig.clientKeyPath);
    hasTlsOverride = true;
  }

  return hasTlsOverride ? connectOptions : undefined;
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
  options?: { forceSse?: boolean },
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
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
            return;
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
          return;
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

function buildOpenAiResponsesPayload(
  request: ChatCompletionRequest,
  model: string,
  provider: Pick<LlmProviderConfig, "providerId" | "apiStyle">,
): Record<string, unknown> {
  const { instructions, input } = buildOpenAiResponsesInput(request.messages);
  const payload: Record<string, unknown> = {
    model,
    input,
  };

  if (instructions) {
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
  if (request.tools !== undefined) payload.tools = mapOpenAiResponsesTools(request.tools);
  if (request.tool_choice !== undefined) payload.tool_choice = mapOpenAiResponsesToolChoice(request.tool_choice);
  if (request.parallel_tool_calls !== undefined) payload.parallel_tool_calls = request.parallel_tool_calls;
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

async function collectOpenAiResponsesStreamCompletion(
  response: Response,
  model: string,
): Promise<ChatCompletionResponse> {
  let outputText = "";
  for await (const event of streamJsonSseResponse(response, { forceSse: true })) {
    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType === "response.output_text.delta") {
      outputText += String(event.delta ?? "");
      continue;
    }
    if (eventType === "response.completed" && isRecord(event.response)) {
      const completion = adaptOpenAiResponsesResponse(event.response);
      const message = completion.choices?.[0]?.message as Record<string, unknown> | undefined;
      if (outputText && (typeof message?.content !== "string" || message.content.length === 0)) {
        return {
          ...completion,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: outputText },
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

  return {
    id: "response",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: outputText },
        finish_reason: "stop",
      },
    ],
  };
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
  if (!isRecord(response.usage) || !hasUsageCost(response.usage) || hasUsageCostSource(response.usage)) {
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
  if (!isRecord(chunk.usage) || !hasUsageCost(chunk.usage) || hasUsageCostSource(chunk.usage)) {
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

function hasUsageCostSource(usage: Record<string, unknown>): boolean {
  return Boolean(firstNonEmptyString(usage.cost_source, usage.costSource));
}

function buildResponsesStreamFailureError(event: Record<string, unknown>): Error {
  const provider = readResponsesProviderFailure(event);
  const details = [provider?.code, provider?.message].filter((value): value is string => Boolean(value));
  const message = details.length > 0 ? `responses stream failed: ${details.join(" - ")}` : "responses stream failed";
  const error = provider ? new Error(message, { cause: provider }) : new Error(message);
  if (provider) {
    (error as Error & { providerFailure?: ChatProviderFailureRecord }).providerFailure = provider;
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
  return new Blob([Buffer.from(input.bytesBase64, "base64")], {
    type: input.mimeType?.trim() || "image/png",
  });
}

const OPENAI_CODEX_IMAGE_RESPONSES_MODEL = "gpt-5.4";
const OPENAI_CODEX_IMAGE_INSTRUCTIONS = "You are an image generation assistant.";
const MAX_CODEX_IMAGE_SSE_BYTES = 64 * 1024 * 1024;
const MAX_CODEX_IMAGE_SSE_EVENTS = 512;
const MAX_CODEX_IMAGE_BASE64_CHARS = 64 * 1024 * 1024;

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
  return `data:${mimeType};base64,${image.bytesBase64}`;
}

async function adaptOpenAICodexImageResponse(
  response: Response,
  model: string,
): Promise<ImageGenerationResponse["data"]> {
  const body = await readLimitedResponseBodyText(response, MAX_CODEX_IMAGE_SSE_BYTES);
  const events = parseOpenAICodexImageEvents(body);
  const failure = events.find((event) => event.type === "response.failed" || event.type === "error");
  if (failure) {
    const error = isRecord(failure.error) ? failure.error : undefined;
    const message =
      (typeof error?.message === "string" ? error.message : undefined) ??
      (typeof failure.message === "string" ? failure.message : undefined) ??
      "OpenAI Codex image generation failed";
    throw new Error(message);
  }

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
    throw new Error(`OpenAI Codex image generation returned no images for ${model}.`);
  }
  return results.slice(0, 4);
}

async function readLimitedResponseBodyText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("OpenAI Codex image generation response exceeded size limit.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
          throw new Error("OpenAI Codex image generation response exceeded size limit.");
        }
        chunks.push(decoder.decode(value, { stream: !done }));
      }
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        return chunks.join("");
      }
    }
  } finally {
    reader.releaseLock();
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
      continue;
    }
    if (events.length > MAX_CODEX_IMAGE_SSE_EVENTS) {
      throw new Error("OpenAI Codex image generation response exceeded event limit.");
    }
  }
  return events;
}

function toOpenAICodexImageResult(item: Record<string, unknown>): ImageGenerationResponse["data"][number] | undefined {
  const result = typeof item.result === "string" ? item.result : undefined;
  if (!result) {
    return undefined;
  }
  if (result.length > MAX_CODEX_IMAGE_BASE64_CHARS) {
    throw new Error("OpenAI Codex image generation result exceeded size limit.");
  }
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
        b64Json: typeof item.b64_json === "string" ? item.b64_json : undefined,
        url: typeof item.url === "string" ? item.url : undefined,
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

function inferProviderCapabilities(provider: LlmProviderConfig): {
  vision: boolean;
  audio: boolean;
  video: boolean;
  toolCalling: boolean;
  jsonMode: boolean;
  webSearch?: boolean;
  reasoning?: boolean;
  imageGenerate?: boolean;
  imageEdit?: boolean;
} {
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
  if (input.providerId !== "openai") {
    return;
  }
  validateOpenAiChatRequestCompatibility(input.request, input.model);
  if (input.request.reasoning?.effort) {
    input.payload.reasoning_effort = input.request.reasoning.effort;
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

function validateOpenAiChatRequestCompatibility(request: ChatCompletionRequest, model: string): void {
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
