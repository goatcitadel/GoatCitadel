import { isIP } from "node:net";
import { assertHostAllowed } from "@goatcitadel/policy-engine";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmConfigFile,
  LlmModelRecord,
  LlmModelPreviewRequest,
  LlmModelPreviewResponse,
  LlmProviderConfig,
  LlmProviderSummary,
  LlmRuntimeConfig,
} from "@goatcitadel/contracts";
import { findProviderTemplate } from "@goatcitadel/contracts";
import { SecretStoreService, SecretStoreUnavailableError } from "./secret-store-service.js";

export interface LlmRuntimeUpdateInput {
  activeProviderId?: string;
  activeModel?: string;
  upsertProvider?: {
    providerId: string;
    label?: string;
    baseUrl?: string;
    defaultModel?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    headers?: Record<string, string>;
  };
}

interface ResolvedProvider {
  provider: LlmProviderConfig;
  apiKey?: string;
}

export interface LlmServiceOptions {
  networkAllowlist?: string[];
  secretStore?: SecretStoreService;
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

const DISALLOWED_BASE_HOSTS = new Set([
  "0.0.0.0",
  "169.254.169.254",
  "metadata.google.internal",
  "100.100.100.200",
]);
const SECRET_STATUS_CACHE_TTL_MS = 60_000;

export class LlmService {
  private readonly providers = new Map<string, LlmProviderConfig>();
  private readonly secretStore: SecretStoreService;
  private readonly secretStatusCache = new Map<string, SecretStatusCacheEntry>();
  private networkAllowlist: string[];
  private activeProviderId: string;
  private activeModel: string;

  public constructor(
    config: LlmConfigFile,
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: LlmServiceOptions = {},
  ) {
    this.secretStore = options.secretStore ?? new SecretStoreService();
    this.networkAllowlist = [...(options.networkAllowlist ?? [])];

    for (const provider of config.providers) {
      this.providers.set(provider.providerId, normalizeProvider(provider));
    }

    const active = this.providers.get(config.activeProviderId) ?? this.providers.values().next().value;
    if (!active) {
      throw new Error("LLM configuration must include at least one provider");
    }

    this.activeProviderId = active.providerId;
    this.activeModel = active.defaultModel;
  }

  public updateNetworkAllowlist(allowlist: string[]): void {
    this.networkAllowlist = [...allowlist];
  }

  public listProviders(options: LlmListProvidersOptions = {}): LlmProviderSummary[] {
    const includeKeychainDefault = options.includeKeychain ?? false;
    return Array.from(this.providers.values()).map((provider) => {
      const includeKeychain = options.includeKeychainForProviderId === provider.providerId
        ? true
        : includeKeychainDefault;
      const status = this.getProviderSecretStatus(provider.providerId, {
        includeKeychain,
        useCache: options.useCache,
      });
      return {
        providerId: provider.providerId,
        label: provider.label,
        baseUrl: provider.baseUrl,
        apiStyle: provider.apiStyle,
        defaultModel: provider.defaultModel,
        hasApiKey: status.hasApiKey,
        apiKeySource: status.apiKeySource,
        hasKeychainSecret: status.hasKeychainSecret,
        apiKeyRef: status.apiKeyRef,
        capabilities: inferProviderCapabilities(provider),
      };
    });
  }

  public getRuntimeConfig(options: { includeKeychainForActiveProvider?: boolean; useCache?: boolean } = {}): LlmRuntimeConfig {
    return {
      activeProviderId: this.activeProviderId,
      activeModel: this.activeModel,
      providers: this.listProviders({
        includeKeychain: false,
        includeKeychainForProviderId: options.includeKeychainForActiveProvider
          ? this.activeProviderId
          : undefined,
        useCache: options.useCache,
      }),
    };
  }

  public updateRuntimeConfig(input: LlmRuntimeUpdateInput): LlmRuntimeConfig {
    if (input.upsertProvider) {
      const existing = this.providers.get(input.upsertProvider.providerId);
      const submittedApiKey = input.upsertProvider.apiKey?.trim();
      if (submittedApiKey) {
        this.setProviderApiKey(input.upsertProvider.providerId, submittedApiKey);
      }

      const merged: LlmProviderConfig = normalizeProvider({
        providerId: input.upsertProvider.providerId,
        label: input.upsertProvider.label ?? existing?.label ?? input.upsertProvider.providerId,
        baseUrl: input.upsertProvider.baseUrl ?? existing?.baseUrl ?? "http://127.0.0.1:1234/v1",
        apiStyle: "openai-chat-completions",
        defaultModel: input.upsertProvider.defaultModel ?? existing?.defaultModel ?? defaultModelForProvider(input.upsertProvider.providerId),
        apiKey: submittedApiKey ? undefined : (input.upsertProvider.apiKey ?? existing?.apiKey),
        apiKeyEnv: input.upsertProvider.apiKeyEnv ?? existing?.apiKeyEnv,
        headers: input.upsertProvider.headers ?? existing?.headers,
      });
      this.providers.set(merged.providerId, merged);
      this.secretStatusCache.delete(merged.providerId);
    }

    if (input.activeProviderId) {
      const provider = this.providers.get(input.activeProviderId);
      if (!provider) {
        throw new Error(`Unknown LLM provider: ${input.activeProviderId}`);
      }
      this.activeProviderId = provider.providerId;
      if (!input.activeModel) {
        this.activeModel = provider.defaultModel;
      }
    }

    if (input.activeModel) {
      this.activeModel = input.activeModel;
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
    if (!this.providers.has(providerId)) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    try {
      this.secretStore.setProviderApiKey(providerId, apiKey);
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        throw new Error("Secure keychain is unavailable on this host. Use apiKeyEnv for env-backed secrets.");
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
    if (!this.providers.has(providerId)) {
      throw new Error(`Unknown LLM provider: ${providerId}`);
    }
    try {
      this.secretStore.deleteProviderApiKey(providerId);
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        throw new Error("Secure keychain is unavailable on this host.");
      }
      throw error;
    }
    const provider = this.providers.get(providerId);
    if (provider) {
      this.setCachedSecretStatus(this.buildQuickSecretStatus(provider));
    } else {
      this.secretStatusCache.delete(providerId);
    }
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
      providers: Array.from(this.providers.values()).map((provider) => ({
        ...provider,
        apiKey: undefined,
      })),
    };
  }

  public async listModels(providerId?: string): Promise<LlmModelRecord[]> {
    const resolved = this.resolveProvider(providerId);
    return this.fetchModelsForResolvedProvider(resolved);
  }

  public async previewModels(input: LlmModelPreviewRequest): Promise<LlmModelPreviewResponse> {
    const existing = this.providers.get(input.providerId);
    const provider = normalizeProvider({
      providerId: input.providerId,
      label: existing?.label ?? input.providerId,
      baseUrl: input.baseUrl,
      apiStyle: "openai-chat-completions",
      defaultModel: existing?.defaultModel ?? defaultModelForProvider(input.providerId),
      apiKey: input.apiKey ?? existing?.apiKey,
      apiKeyEnv: input.apiKeyEnv ?? existing?.apiKeyEnv,
      headers: input.headers ?? existing?.headers,
    });
    const explicitPreviewApiKey = input.apiKey?.trim()
      || (input.apiKeyEnv ? this.env[input.apiKeyEnv]?.trim() : undefined);
    const resolved: ResolvedProvider = {
      provider,
      apiKey: explicitPreviewApiKey || this.resolveApiKey(provider),
    };

    try {
      const items = await this.fetchModelsForResolvedProvider(resolved);
      if (items.length > 0) {
        return {
          items,
          source: "remote",
        };
      }
    } catch (error) {
      const fallbackItems = provider.defaultModel
        ? [{ id: provider.defaultModel }]
        : [];
      if (fallbackItems.length > 0) {
        return {
          items: fallbackItems,
          source: "fallback",
          warning: (error as Error).message,
        };
      }
      throw error;
    }

    return {
      items: provider.defaultModel ? [{ id: provider.defaultModel }] : [],
      source: "fallback",
      warning: "Provider returned no models. Falling back to the recommended default model.",
    };
  }

  public async chatCompletions(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (!request.messages || request.messages.length === 0) {
      throw new Error("chat/completions requires at least one message");
    }

    const resolved = this.resolveProvider(request.providerId);
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
      const model = normalizeRequestedModel(
        resolved.provider.providerId,
        request.model ?? (resolved.provider.providerId === this.activeProviderId ? this.activeModel : resolved.provider.defaultModel),
      );
      const normalizedMessages = normalizeProviderMessages(
        request.messages,
        resolved.provider.providerId,
        model,
      );

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

    const endpoint = `${resolved.provider.baseUrl}/chat/completions`;
    const headers = this.buildHeaders(resolved, "chat");
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    let response = await postChatCompletionsRequest(endpoint, headers, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`chat completion blocked redirect (${response.status})`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.metadata;
        response = await postChatCompletionsRequest(endpoint, headers, fallbackPayload, timeoutMs, request.signal);
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

    return (await response.json()) as ChatCompletionResponse;
  }

  public async *chatCompletionsStream(request: ChatCompletionRequest): AsyncGenerator<Record<string, unknown>> {
    if (!request.messages || request.messages.length === 0) {
      throw new Error("chat/completions requires at least one message");
    }

    const resolved = this.resolveProvider(request.providerId);
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
      const model = normalizeRequestedModel(
        resolved.provider.providerId,
        request.model ?? (resolved.provider.providerId === this.activeProviderId ? this.activeModel : resolved.provider.defaultModel),
      );
      const normalizedMessages = normalizeProviderMessages(
        request.messages,
        resolved.provider.providerId,
        model,
      );

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

    const endpoint = `${resolved.provider.baseUrl}/chat/completions`;
    const headers = this.buildHeaders(resolved, "chat");
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    let response = await postChatCompletionsRequest(endpoint, headers, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`chat completion blocked redirect (${response.status})`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.metadata;
        response = await postChatCompletionsRequest(endpoint, headers, fallbackPayload, timeoutMs, request.signal);
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

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
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
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private resolveProvider(providerId?: string): ResolvedProvider {
    const selectedId = providerId ?? this.activeProviderId;
    const provider = this.providers.get(selectedId);
    if (!provider) {
      throw new Error(`Unknown LLM provider: ${selectedId}`);
    }

    const apiKey = this.resolveApiKey(provider);
    return { provider, apiKey };
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
    // When no explicit runtime allowlist is configured, permit validated provider base URLs.
    // Provider URLs still pass strict baseUrl validation (protocol/host/private-range checks).
    if (this.networkAllowlist.length === 0) {
      return;
    }
    assertHostAllowed(baseUrl, this.networkAllowlist);
  }

  private buildHeaders(
    resolved: ResolvedProvider,
    purpose: "chat" | "models" = "chat",
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(resolved.provider.headers ?? {}),
    };

    if (purpose === "models" && resolved.provider.providerId === "anthropic") {
      delete headers.Authorization;
      if (resolved.apiKey) {
        headers["x-api-key"] = resolved.apiKey;
      }
      headers["anthropic-version"] = "2023-06-01";
      return headers;
    }

    if (resolved.apiKey) {
      headers.Authorization = `Bearer ${resolved.apiKey}`;
    }
    return headers;
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

  private async fetchModelsForResolvedProvider(resolved: ResolvedProvider): Promise<LlmModelRecord[]> {
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const response = await fetch(`${resolved.provider.baseUrl}/models`, {
      method: "GET",
      headers: this.buildHeaders(resolved, "models"),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });

    if (isRedirect(response.status)) {
      throw new Error(`model listing blocked redirect (${response.status})`);
    }

    if (!response.ok) {
      const fallback = fallbackModelCatalog(
        resolved.provider.providerId,
        resolved.provider.defaultModel,
        response.status,
      );
      if (fallback) {
        return fallback;
      }
      throw new Error(await buildHttpError("model listing", response));
    }

    const json = (await response.json()) as { data?: Array<Record<string, unknown>> };
    return (json.data ?? []).map((record) => ({
      id: String(record.id ?? ""),
      ownedBy: record.owned_by ? String(record.owned_by) : undefined,
      created: typeof record.created === "number" ? record.created : undefined,
    })).filter((record) => Boolean(record.id));
  }
}

function normalizeProvider(provider: LlmProviderConfig): LlmProviderConfig {
  const base = provider.baseUrl.trim().replace(/\/+$/, "");
  validateProviderBaseUrl(base);
  const canonicalBase = canonicalizeProviderBaseUrl(provider.providerId, base);
  const withV1 = shouldAppendV1(provider.providerId, canonicalBase) ? `${canonicalBase}/v1` : canonicalBase;
  return {
    ...provider,
    baseUrl: withV1,
    apiStyle: "openai-chat-completions",
  };
}

function normalizeRequestedModel(providerId: string, model: string): string {
  const trimmed = model.trim();
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

function canonicalizeProviderBaseUrl(providerId: string, baseUrl: string): string {
  if (providerId === "google" && /\/v1beta\/openai\/v1$/i.test(baseUrl)) {
    return baseUrl.replace(/\/v1$/i, "");
  }

  if (providerId === "moonshot" && /api\.moonshot\.cn/i.test(baseUrl)) {
    return baseUrl.replace(/api\.moonshot\.cn/i, "api.moonshot.ai");
  }

  if (providerId === "minimax" && /api\.minimax\.chat/i.test(baseUrl)) {
    return baseUrl.replace(/api\.minimax\.chat/i, "api.minimax.io");
  }

  if (providerId !== "perplexity") {
    return baseUrl;
  }
  const parsed = new URL(baseUrl);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "/v1" || path === "/api/v1") {
    parsed.pathname = "/";
    return parsed.toString().replace(/\/+$/, "");
  }
  return baseUrl;
}

function fallbackModelCatalog(
  providerId: string,
  defaultModel: string,
  status: number,
): LlmModelRecord[] | undefined {
  if (status !== 404 && status !== 405) {
    return undefined;
  }

  if (providerId === "perplexity") {
    return [
      { id: "sonar" },
      { id: "sonar-pro" },
      { id: "sonar-reasoning-pro" },
      { id: "sonar-deep-research" },
    ];
  }

  if (providerId === "minimax" && defaultModel) {
    return [{ id: defaultModel }];
  }

  return undefined;
}

function shouldAppendV1(providerId: string, baseUrl: string): boolean {
  if (providerId === "perplexity") {
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

function isMetadataStoreCompatibilityError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("metadata")
    && normalized.includes("store")
    && (normalized.includes("only allowed") || normalized.includes("enabled"))
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

async function postChatCompletionsRequest(
  endpoint: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;
  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
    redirect: "manual",
  });
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

function normalizeProviderMessages(
  messages: ChatCompletionRequest["messages"],
  providerId: string,
  model: string,
): ChatCompletionRequest["messages"] {
  let normalizedMessages = providerId === "openai"
    ? messages.map((message) => normalizeOpenAiMessageRole(message))
    : messages;
  if (!modelRequiresReasoningContentForToolCalls(model)) {
    return normalizedMessages;
  }
  return normalizedMessages.map((message) => {
    const value = message as unknown as Record<string, unknown>;
    if (value.role !== "assistant" || !Array.isArray(value.tool_calls)) {
      return message;
    }
    const existingReasoning = typeof value.reasoning_content === "string" ? value.reasoning_content.trim() : "";
    if (existingReasoning.length > 0) {
      return message;
    }
    const content = typeof value.content === "string" ? value.content.trim() : "";
    return {
      ...value,
      reasoning_content: content || "Using tools to gather and verify information.",
    } as unknown as ChatCompletionRequest["messages"][number];
  });
}

function normalizeOpenAiMessageRole(
  message: ChatCompletionRequest["messages"][number],
): ChatCompletionRequest["messages"][number] {
  if (message.role !== "system") {
    return message;
  }
  return {
    ...message,
    role: "developer",
  };
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
} {
  const model = provider.defaultModel.toLowerCase();
  const base = provider.baseUrl.toLowerCase();
  const hasVision = (
    model.includes("vision")
    || model.includes("gpt-4o")
    || model.includes("gpt-4.1")
    || model.includes("gemini")
    || model.includes("claude-3")
    || model.includes("kimi")
    || model.includes("glm")
  );
  const hasAudio = model.includes("audio") || model.includes("whisper");
  const hasVideo = model.includes("video");
  const hasToolCalling = true;
  const hasJsonMode = model.includes("gpt") || model.includes("glm") || model.includes("gemini") || base.includes("openai");
  const hasWebSearch = model.includes("search") || model.includes("kimi") || model.includes("gpt-4.1");
  const hasReasoning = model.includes("reason") || model.includes("thinking") || model.includes("o1") || model.includes("o3");
  return {
    vision: hasVision,
    audio: hasAudio,
    video: hasVideo,
    toolCalling: hasToolCalling,
    jsonMode: hasJsonMode,
    webSearch: hasWebSearch,
    reasoning: hasReasoning,
  };
}

function defaultModelForProvider(providerId: string): string {
  return findProviderTemplate(providerId.trim().toLowerCase())?.defaultModel ?? "gpt-5.4-mini";
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

function validateOpenAiChatRequestCompatibility(
  request: ChatCompletionRequest,
  model: string,
): void {
  const hasSamplingControls = request.temperature !== undefined || request.top_p !== undefined;
  if (!hasSamplingControls) {
    return;
  }
  if (isOpenAiGpt54Or52Model(model)) {
    if (request.reasoning?.effort && request.reasoning.effort !== "none") {
      throw new Error(
        "OpenAI GPT-5.4/GPT-5.2 only support temperature/top_p when reasoning effort is set to none.",
      );
    }
    return;
  }
  if (isOlderOpenAiGpt5Model(model)) {
    throw new Error(
      "Older OpenAI GPT-5 family models do not support temperature/top_p in chat/completions.",
    );
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
