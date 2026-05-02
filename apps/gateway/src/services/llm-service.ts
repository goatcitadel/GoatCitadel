/* eslint-disable max-lines -- LLM transport and provider normalization are intentionally centralized until provider seams are split further. */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { assertHostAllowed } from "@goatcitadel/policy-engine";
import { Agent, ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
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
  LlmModelRecord,
  LlmModelPreviewRequest,
  LlmModelPreviewResponse,
  LlmProviderConfig,
  LlmProviderSummary,
  LlmRuntimeConfig,
} from "@goatcitadel/contracts";
import { findProviderTemplate, inferProviderForModelId, providerAllowsForeignModelIds } from "@goatcitadel/contracts";
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

interface ResolvedProvider {
  provider: LlmProviderConfig;
  apiKey?: string;
}

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

export interface LlmServiceOptions {
  networkAllowlist?: string[];
  enforceNetworkAllowlist?: boolean;
  secretStore?: SecretStoreService;
  openAICodexOAuthFetch?: typeof fetch;
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
  private readonly providers = new Map<string, LlmProviderConfig>();
  private readonly secretStore: SecretStoreService;
  private readonly openAICodexOAuth: OpenAICodexOAuthService;
  private readonly secretStatusCache = new Map<string, SecretStatusCacheEntry>();
  private readonly requestDispatcherCache = new Map<string, Dispatcher>();
  private networkAllowlist: string[];
  private enforceNetworkAllowlist: boolean;
  private activeProviderId: string;
  private activeModel: string;

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
    return {
      activeProviderId: this.activeProviderId,
      activeModel: this.activeModel,
      providers: this.listProviders({
        includeKeychain: false,
        includeKeychainForProviderId: options.includeKeychainForActiveProvider ? this.activeProviderId : undefined,
        useCache: options.useCache,
      }),
    };
  }

  public updateRuntimeConfig(input: LlmRuntimeUpdateInput): LlmRuntimeConfig {
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
        apiKey: undefined,
        headers: undefined,
      })),
    };
  }

  public async listModels(providerId?: string): Promise<LlmModelRecord[]> {
    const resolved = await this.resolveProvider(providerId);
    const result = await this.fetchModelsForResolvedProvider(resolved);
    return result.items;
  }

  public async listModelsWithSource(providerId?: string): Promise<ModelDiscoveryResult> {
    const resolved = await this.resolveProvider(providerId);
    return this.fetchModelsForResolvedProvider(resolved);
  }

  public async previewModels(input: LlmModelPreviewRequest): Promise<LlmModelPreviewResponse> {
    const existing = this.providers.get(input.providerId);
    const provider = normalizeProvider({
      providerId: input.providerId,
      label: existing?.label ?? input.providerId,
      baseUrl: input.baseUrl,
      apiStyle: normalizeProviderApiStyle(input.providerId, input.apiStyle ?? existing?.apiStyle),
      defaultModel: existing?.defaultModel ?? defaultModelForProvider(input.providerId),
      apiKey: input.apiKey ?? existing?.apiKey,
      apiKeyEnv: input.apiKeyEnv ?? existing?.apiKeyEnv,
      request: input.request ?? existing?.request,
      headers: input.headers ?? existing?.headers,
    });
    const explicitPreviewApiKey =
      input.apiKey?.trim() || (input.apiKeyEnv ? this.env[input.apiKeyEnv]?.trim() : undefined);
    const resolved: ResolvedProvider = {
      provider,
      apiKey: explicitPreviewApiKey || this.resolveApiKey(provider),
    };
    const fallbackCatalog = buildFallbackModelCatalog(provider.providerId, provider.defaultModel);

    try {
      const result = await this.fetchModelsForResolvedProvider(resolved);
      if (result.items.length > 0) {
        return {
          items: mergeModelCatalogs(result.items, fallbackCatalog),
          source: result.source,
          warning: result.warning,
        };
      }
    } catch (error) {
      if (fallbackCatalog.length > 0) {
        return {
          items: fallbackCatalog,
          source: "error_fallback",
          warning: (error as Error).message,
        };
      }
      throw error;
    }

    return {
      items: fallbackCatalog,
      source: "template_fallback",
      warning: "Provider returned no models. Falling back to the recommended default model.",
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
      return adaptImageGenerationResponse((await response.json()) as Record<string, unknown>, {
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
    return adaptImageGenerationResponse((await response.json()) as Record<string, unknown>, {
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

    switch (apiStyle) {
      case "openai-codex-responses":
      case "openai-responses":
        return this.executeOpenAiResponses(request, resolved, model);
      case "anthropic-messages":
        return this.executeAnthropicMessages(request, resolved, model);
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

    switch (apiStyle) {
      case "openai-codex-responses":
      case "openai-responses":
        yield* this.executeOpenAiResponsesStream(request, resolved, model);
        return;
      case "anthropic-messages":
        yield* this.executeAnthropicMessagesStream(request, resolved, model);
        return;
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

    return applyEstimatedCostToChatResponse((await response.json()) as ChatCompletionResponse, {
      providerId: resolved.provider.providerId,
      model,
    });
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
      yield applyEstimatedCostToStreamChunk(event, {
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
      return applyEstimatedCostToChatResponse(await collectOpenAiResponsesStreamCompletion(response, model), {
        providerId: resolved.provider.providerId,
        model,
      });
    }

    const json = (await response.json()) as Record<string, unknown>;
    return applyEstimatedCostToChatResponse(adaptOpenAiResponsesResponse(json), {
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
      const json = (await response.json()) as Record<string, unknown>;
      yield applyEstimatedCostToChatResponse(adaptOpenAiResponsesResponse(json), {
        providerId: resolved.provider.providerId,
        model,
      });
      return;
    }

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
          yield {
            id: String(item.id ?? event.item_id ?? "response"),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
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
        yield applyEstimatedCostToStreamChunk(
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
        throw new Error("responses stream failed");
      }
    }
  }

  private async executeAnthropicMessages(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
  ): Promise<ChatCompletionResponse> {
    const payload = buildAnthropicMessagesPayload(request, model);
    const target = this.buildRequestTarget(resolved, "messages", `${resolved.provider.baseUrl}/messages`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    const response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`messages request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("messages request", response));
    }

    const json = (await response.json()) as Record<string, unknown>;
    return applyEstimatedCostToChatResponse(adaptAnthropicMessageResponse(json), {
      providerId: resolved.provider.providerId,
      model,
    });
  }

  private async *executeAnthropicMessagesStream(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const payload = buildAnthropicMessagesPayload(request, model);
    payload.stream = true;

    const target = this.buildRequestTarget(resolved, "messages", `${resolved.provider.baseUrl}/messages`);
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    const response = await postJsonRequest(target, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`messages request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("messages request", response));
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      const json = (await response.json()) as Record<string, unknown>;
      yield applyEstimatedCostToChatResponse(adaptAnthropicMessageResponse(json), {
        providerId: resolved.provider.providerId,
        model,
      });
      return;
    }

    const toolUseBuffers = new Map<
      number,
      {
        id: string;
        name: string;
        partialJson: string;
      }
    >();
    let messageId: string | undefined;
    let messageModel: string | undefined;
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;

    for await (const event of streamJsonSseResponse(response)) {
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "message_start" && isRecord(event.message)) {
        messageId = typeof event.message.id === "string" ? event.message.id : messageId;
        messageModel = typeof event.message.model === "string" ? event.message.model : messageModel;
        continue;
      }

      if (eventType === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
        const block = event.content_block;
        if (block.type === "tool_use") {
          toolUseBuffers.set(event.index, {
            id: String(block.id ?? `tool_${event.index}`),
            name: String(block.name ?? ""),
            partialJson: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          });
        }
        continue;
      }

      if (eventType === "content_block_delta" && isRecord(event.delta)) {
        if (event.delta.type === "text_delta") {
          yield {
            id: messageId ?? "message",
            model: messageModel,
            choices: [
              {
                index: 0,
                delta: {
                  content: String(event.delta.text ?? ""),
                },
              },
            ],
          };
          continue;
        }

        if (event.delta.type === "input_json_delta" && typeof event.index === "number") {
          const existing = toolUseBuffers.get(event.index);
          if (existing) {
            existing.partialJson += String(event.delta.partial_json ?? "");
          }
        }
        continue;
      }

      if (eventType === "content_block_stop" && typeof event.index === "number") {
        const toolUse = toolUseBuffers.get(event.index);
        if (toolUse) {
          toolUseBuffers.delete(event.index);
          yield {
            id: messageId ?? toolUse.id,
            model: messageModel,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: toolUse.id,
                      type: "function",
                      function: {
                        name: toolUse.name,
                        arguments: normalizeJsonString(toolUse.partialJson),
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

      if (eventType === "message_delta") {
        finishReason = typeof event.stop_reason === "string" ? event.stop_reason : finishReason;
        usage = isRecord(event.usage) ? event.usage : usage;
        continue;
      }

      if (eventType === "message_stop") {
        yield applyEstimatedCostToStreamChunk(
          {
            id: messageId,
            model: messageModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: mapAnthropicStopReason(finishReason),
              },
            ],
            usage: normalizeAnthropicUsage(usage),
          },
          {
            providerId: resolved.provider.providerId,
            model,
          },
        );
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
      resolved.provider.providerId === "anthropic" && (purpose === "models" || purpose === "messages");

    delete headers.Authorization;
    delete headers["x-api-key"];
    applyRequestAuthHeaders(headers, explicitAuth, this.env, resolved.apiKey);
    if (useAnthropicNativeHeaders && !explicitAuth && resolved.apiKey) {
      headers["x-api-key"] = resolved.apiKey;
      delete headers.Authorization;
    } else if (!explicitAuth && resolved.apiKey) {
      headers.Authorization = `Bearer ${resolved.apiKey}`;
    }
    if (useAnthropicNativeHeaders) {
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
        void close.call(dispatcher).catch(() => {});
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
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const fallback = buildFallbackModelCatalog(resolved.provider.providerId, resolved.provider.defaultModel);
    if (isOpenAICodexProvider(resolved.provider)) {
      return {
        items: fallback,
        source: "template_fallback",
        warning:
          "OpenAI Codex model catalog is sourced from GoatCitadel's template because ChatGPT OAuth does not expose a stable /models endpoint.",
      };
    }
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

      const json = (await response.json()) as unknown;
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

function normalizeProviderApiStyle(providerId: string, apiStyle: LlmApiStyle | undefined): LlmApiStyle {
  if (providerId === "openai-codex") {
    return "openai-codex-responses";
  }
  if (
    apiStyle === "openai-chat-completions" ||
    apiStyle === "openai-responses" ||
    apiStyle === "openai-codex-responses" ||
    apiStyle === "anthropic-messages"
  ) {
    return apiStyle;
  }
  if (providerId === "openai") {
    return "openai-responses";
  }
  if (providerId === "anthropic") {
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

  if (provider.providerId === "anthropic") {
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
  return ownerProviderId;
}

function normalizeRequestedModel(providerId: string, model: string): string {
  const trimmed = model.trim();
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
    const json = (await response.json()) as Record<string, unknown>;
    yield json;
    return;
  }
  if (!options?.forceSse && !contentType.includes("text/event-stream")) {
    const json = (await response.json()) as Record<string, unknown>;
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
  if (request.stop !== undefined) payload.stop = request.stop;
  if (request.metadata !== undefined) payload.metadata = request.metadata;
  if (request.service_tier) payload.service_tier = request.service_tier;
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
      throw new Error("responses stream failed");
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

function buildAnthropicMessagesPayload(request: ChatCompletionRequest, model: string): Record<string, unknown> {
  const { system, messages } = buildAnthropicMessagesInput(request.messages);
  const payload: Record<string, unknown> = {
    model,
    messages,
  };
  if (system !== undefined) {
    payload.system = system;
  }
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.top_p !== undefined) payload.top_p = request.top_p;
  if (request.max_tokens !== undefined) payload.max_tokens = request.max_tokens;
  else payload.max_tokens = 1024;
  if (request.stop !== undefined) payload.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  const anthropicTools = mapAnthropicTools(request.tools);
  if (anthropicTools !== undefined) payload.tools = anthropicTools;
  const anthropicToolChoice = mapAnthropicToolChoice(request.tool_choice);
  if (anthropicToolChoice !== undefined) payload.tool_choice = anthropicToolChoice;
  if (request.response_format !== undefined) payload.output_config = { format: request.response_format };
  if (request.metadata !== undefined) payload.metadata = request.metadata;
  if (request.reasoning?.effort && request.reasoning.effort !== "none") {
    payload.thinking = {
      type: "enabled",
      budget_tokens: anthropicThinkingBudgetForEffort(request.reasoning.effort),
    };
  }
  return payload;
}

function mapAnthropicTools(tools: ChatCompletionRequest["tools"]): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  return tools
    .map((tool) => {
      if (!isRecord(tool)) {
        return undefined;
      }
      if (typeof tool.name === "string" && isRecord(tool.input_schema)) {
        return tool;
      }
      if (tool.type !== "function" || !isRecord(tool.function)) {
        return tool;
      }
      const fn = tool.function;
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) {
        return undefined;
      }
      return {
        name,
        description: typeof fn.description === "string" ? fn.description : undefined,
        input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      };
    })
    .filter((tool): tool is Record<string, unknown> => Boolean(tool));
}

function mapAnthropicToolChoice(toolChoice: ChatCompletionRequest["tool_choice"]): Record<string, unknown> | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    if (toolChoice === "none") {
      return undefined;
    }
    if (toolChoice === "required") {
      return { type: "any" };
    }
    return { type: toolChoice };
  }
  if (isRecord(toolChoice) && toolChoice.type === "function") {
    const fn = isRecord(toolChoice.function) ? toolChoice.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name : typeof toolChoice.name === "string" ? toolChoice.name : "";
    return name ? { type: "tool", name } : { type: "auto" };
  }
  return toolChoice;
}

function buildAnthropicMessagesInput(messages: ChatCompletionRequest["messages"]): {
  system?: string | Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
} {
  const systemStrings: string[] = [];
  const systemBlocks: Array<Record<string, unknown>> = [];
  const normalizedMessages: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content === "string") {
        systemStrings.push(message.content);
      } else if (Array.isArray(message.content)) {
        systemBlocks.push(...message.content.map((block) => mapAnthropicContentBlock(block)).filter(isRecord));
      }
      continue;
    }

    if (message.role === "tool") {
      normalizedMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: normalizeAnthropicToolResultContent(message.content),
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const assistantRecord = toPlainRecord(message);
      const assistantContent = mapAnthropicMessageContent(message.content);
      if (assistantRecord && Array.isArray(assistantRecord.tool_calls)) {
        for (const toolCall of assistantRecord.tool_calls) {
          if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
            continue;
          }
          assistantContent.push({
            type: "tool_use",
            id: String(toolCall.id ?? randomToolCallId()),
            name: String(toolCall.function.name ?? ""),
            input: parseJsonObject(toolCall.function.arguments),
          });
        }
      }
      normalizedMessages.push({
        role: "assistant",
        content: anthropicContentValue(assistantContent),
      });
      continue;
    }

    normalizedMessages.push({
      role: "user",
      content: anthropicContentValue(mapAnthropicMessageContent(message.content)),
    });
  }

  const system =
    systemBlocks.length > 0
      ? [...systemBlocks, ...systemStrings.filter(Boolean).map((text) => ({ type: "text", text }))]
      : systemStrings.filter(Boolean).length > 0
        ? systemStrings.filter(Boolean).join("\n\n")
        : undefined;

  return { system, messages: normalizedMessages };
}

function mapAnthropicMessageContent(
  content: ChatCompletionRequest["messages"][number]["content"],
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => mapAnthropicContentBlock(block)).filter(isRecord);
}

function mapAnthropicContentBlock(block: unknown): Record<string, unknown> | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  if (block.type === "input_text" || block.type === "output_text") {
    const text = String(block.text ?? "");
    return text.trim() ? { type: "text", text } : undefined;
  }
  if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) {
    return undefined;
  }
  return block;
}

function anthropicContentValue(content: Array<Record<string, unknown>>): string | Array<Record<string, unknown>> {
  if (content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string") {
    return String(content[0].text);
  }
  return content;
}

function normalizeAnthropicToolResultContent(
  content: ChatCompletionRequest["messages"][number]["content"],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }
  const mapped = mapAnthropicMessageContent(content);
  return anthropicContentValue(mapped);
}

function adaptAnthropicMessageResponse(json: Record<string, unknown>): ChatCompletionResponse {
  const content = Array.isArray(json.content) ? json.content.filter(isRecord) : [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  const toolCalls = dedupeToolCalls(
    content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: String(block.id ?? randomToolCallId()),
        type: "function",
        function: {
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        },
      })),
  );

  return {
    id: typeof json.id === "string" ? json.id : undefined,
    object: "chat.completion",
    model: typeof json.model === "string" ? json.model : undefined,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapAnthropicStopReason(typeof json.stop_reason === "string" ? json.stop_reason : undefined),
      },
    ],
    usage: normalizeAnthropicUsage(isRecord(json.usage) ? json.usage : undefined),
  };
}

function normalizeAnthropicUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

function mapAnthropicStopReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

function anthropicThinkingBudgetForEffort(effort: NonNullable<ChatCompletionRequest["reasoning"]>["effort"]): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 8192;
    case "xhigh":
      return 16384;
    default:
      return 1024;
  }
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeJsonString(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value || "{}";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  return providerId.trim().toLowerCase() === "openai-codex" ? "codex-oauth" : undefined;
}

function resolveProviderAuthMode(provider: LlmProviderConfig): LlmProviderConfig["authMode"] {
  return provider.authMode ?? defaultAuthModeForProvider(provider.providerId);
}

function isOpenAICodexProvider(provider: Pick<LlmProviderConfig, "providerId">): boolean {
  return provider.providerId.trim().toLowerCase() === "openai-codex";
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
