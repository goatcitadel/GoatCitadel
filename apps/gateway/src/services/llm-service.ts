import { isIP } from "node:net";
import { assertHostAllowed } from "@goatcitadel/policy-engine";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmApiStyle,
  LlmConfigFile,
  LlmModelRecord,
  LlmModelPreviewRequest,
  LlmModelPreviewResponse,
  LlmProviderConfig,
  LlmProviderSummary,
  LlmRuntimeConfig,
} from "@goatcitadel/contracts";
import { findProviderTemplate } from "@goatcitadel/contracts";
import { applyEstimatedCostToChatResponse, applyEstimatedCostToStreamChunk } from "./llm-pricing.js";
import { SecretStoreService, SecretStoreUnavailableError } from "./secret-store-service.js";

export interface LlmRuntimeUpdateInput {
  activeProviderId?: string;
  activeModel?: string;
  upsertProvider?: {
    providerId: string;
    label?: string;
    baseUrl?: string;
    apiStyle?: LlmApiStyle;
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

interface ModelDiscoveryResult {
  items: LlmModelRecord[];
  source: "remote" | "fallback";
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
        resolvedApiStyle: resolveProviderExecutionApiStyle(provider, provider.defaultModel),
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
        apiStyle: normalizeProviderApiStyle(
          input.upsertProvider.providerId,
          input.upsertProvider.apiStyle ?? existing?.apiStyle,
        ),
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
    const result = await this.fetchModelsForResolvedProvider(resolved);
    return result.items;
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
      headers: input.headers ?? existing?.headers,
    });
    const explicitPreviewApiKey = input.apiKey?.trim()
      || (input.apiKeyEnv ? this.env[input.apiKeyEnv]?.trim() : undefined);
    const resolved: ResolvedProvider = {
      provider,
      apiKey: explicitPreviewApiKey || this.resolveApiKey(provider),
    };

    try {
      const result = await this.fetchModelsForResolvedProvider(resolved);
      if (result.items.length > 0) {
        return {
          items: result.items,
          source: result.source,
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
    const apiStyle = resolveProviderExecutionApiStyle(resolved.provider, model);

    switch (apiStyle) {
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

    const resolved = this.resolveProvider(request.providerId);
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const model = normalizeRequestedModel(
      resolved.provider.providerId,
      request.model ?? (resolved.provider.providerId === this.activeProviderId ? this.activeModel : resolved.provider.defaultModel),
    );
    const apiStyle = resolveProviderExecutionApiStyle(resolved.provider, model);

    switch (apiStyle) {
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
    const resolved = this.resolveProvider(providerId);
    const resolvedModel = normalizeRequestedModel(
      resolved.provider.providerId,
      model ?? (resolved.provider.providerId === this.activeProviderId ? this.activeModel : resolved.provider.defaultModel),
    );
    return resolveProviderExecutionApiStyle(resolved.provider, resolvedModel);
  }

  private async executeChatCompletions(
    request: ChatCompletionRequest,
    resolved: ResolvedProvider,
    model: string,
  ): Promise<ChatCompletionResponse> {
    const normalizedMessages = normalizeProviderMessages(
      request.messages,
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
    let response = await postJsonRequest(endpoint, headers, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`chat completion blocked redirect (${response.status})`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.metadata;
        response = await postJsonRequest(endpoint, headers, fallbackPayload, timeoutMs, request.signal);
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

    return applyEstimatedCostToChatResponse(
      (await response.json()) as ChatCompletionResponse,
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
    const normalizedMessages = normalizeProviderMessages(
      request.messages,
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
    let response = await postJsonRequest(endpoint, headers, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`chat completion blocked redirect (${response.status})`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (request.metadata !== undefined && isMetadataStoreCompatibilityError(errorText)) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.metadata;
        response = await postJsonRequest(endpoint, headers, fallbackPayload, timeoutMs, request.signal);
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
    const payload = buildOpenAiResponsesPayload(request, model);
    const endpoint = `${resolved.provider.baseUrl}/responses`;
    const headers = this.buildHeaders(resolved, "responses");
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    const response = await postJsonRequest(endpoint, headers, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`responses request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("responses request", response));
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
    const payload = buildOpenAiResponsesPayload(request, model);
    payload.stream = true;

    const endpoint = `${resolved.provider.baseUrl}/responses`;
    const headers = this.buildHeaders(resolved, "responses");
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    const response = await postJsonRequest(endpoint, headers, payload, timeoutMs, request.signal);

    if (isRedirect(response.status)) {
      throw new Error(`responses request blocked redirect (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(await buildHttpError("responses request", response));
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      const json = (await response.json()) as Record<string, unknown>;
      yield applyEstimatedCostToChatResponse(adaptOpenAiResponsesResponse(json), {
        providerId: resolved.provider.providerId,
        model,
      });
      return;
    }

    for await (const event of streamJsonSseResponse(response)) {
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
        yield applyEstimatedCostToStreamChunk({
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
        }, {
          providerId: resolved.provider.providerId,
          model,
        });
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
    const endpoint = `${resolved.provider.baseUrl}/messages`;
    const headers = this.buildHeaders(resolved, "messages");
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 60000);
    const response = await postJsonRequest(endpoint, headers, payload, timeoutMs, request.signal);

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

    const endpoint = `${resolved.provider.baseUrl}/messages`;
    const headers = this.buildHeaders(resolved, "messages");
    const timeoutMs = resolveChatCompletionTimeoutMs(request.timeoutMs, 120000);
    const response = await postJsonRequest(endpoint, headers, payload, timeoutMs, request.signal);

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

    const toolUseBuffers = new Map<number, {
      id: string;
      name: string;
      partialJson: string;
    }>();
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
        yield applyEstimatedCostToStreamChunk({
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
        }, {
          providerId: resolved.provider.providerId,
          model,
        });
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
    purpose: "chat" | "models" | "responses" | "messages" = "chat",
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(resolved.provider.headers ?? {}),
    };

    const useAnthropicNativeHeaders = resolved.provider.providerId === "anthropic"
      && (purpose === "models" || purpose === "messages");

    if (useAnthropicNativeHeaders) {
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

  private async fetchModelsForResolvedProvider(resolved: ResolvedProvider): Promise<ModelDiscoveryResult> {
    this.assertProviderHostAllowed(resolved.provider.baseUrl);
    const fallback = buildFallbackModelCatalog(
      resolved.provider.providerId,
      resolved.provider.defaultModel,
    );

    try {
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
        if (fallback.length > 0) {
          return { items: fallback, source: "fallback" };
        }
        throw new Error(await buildHttpError("model listing", response));
      }

      const json = (await response.json()) as unknown;
      const items = normalizeModelRecords(json);
      if (items.length > 0) {
        return { items, source: "remote" };
      }
      return { items: fallback, source: "fallback" };
    } catch (error) {
      if (fallback.length > 0) {
        return { items: fallback, source: "fallback" };
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
  };
}

function normalizeProviderApiStyle(providerId: string, apiStyle: LlmApiStyle | undefined): LlmApiStyle {
  if (apiStyle === "openai-chat-completions" || apiStyle === "openai-responses" || apiStyle === "anthropic-messages") {
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
  if (provider.providerId === "openai") {
    if (provider.apiStyle === "openai-chat-completions") {
      return "openai-chat-completions";
    }
    return isOpenAiResponsesPreferredModel(model)
      ? "openai-responses"
      : "openai-chat-completions";
  }

  if (provider.providerId === "anthropic") {
    return provider.apiStyle === "openai-chat-completions"
      ? "openai-chat-completions"
      : "anthropic-messages";
  }

  return provider.apiStyle;
}

function isOpenAiResponsesPreferredModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return /^gpt-5(?:$|[.-])/.test(normalized);
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

/**
 * Data-driven provider URL canonicalization rules.
 * Adding a new provider URL quirk is a config change, not a code change.
 */
const PROVIDER_URL_CANONICALIZATION: Record<string, { match: RegExp; replace: string }[]> = {
  google: [
    { match: /\/v1beta\/openai\/v1$/i, replace: "/v1beta/openai" },
  ],
  moonshot: [
    { match: /api\.moonshot\.cn/i, replace: "api.moonshot.ai" },
  ],
  minimax: [
    { match: /api\.minimax\.chat/i, replace: "api.minimax.io" },
  ],
};

function canonicalizeProviderUrl(providerId: string, baseUrl: string): string {
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

function buildFallbackModelCatalog(
  providerId: string,
  defaultModel: string | undefined,
): LlmModelRecord[] {
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
  return records
    .map((record) => {
      const id = extractModelId(record);
      if (!id) {
        return undefined;
      }
      return {
        id,
        ownedBy: typeof record.owned_by === "string"
          ? record.owned_by
          : typeof record.ownedBy === "string"
            ? record.ownedBy
            : undefined,
        created: typeof record.created === "number"
          ? record.created
          : typeof record.created_at === "number"
            ? record.created_at
            : typeof record.createdAt === "number"
              ? record.createdAt
              : undefined,
      } satisfies LlmModelRecord;
    })
    .filter((record): record is LlmModelRecord => Boolean(record));
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

async function postJsonRequest(
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

async function *streamJsonSseResponse(response: Response): AsyncGenerator<Record<string, unknown>> {
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

function buildOpenAiResponsesPayload(
  request: ChatCompletionRequest,
  model: string,
): Record<string, unknown> {
  const { instructions, input } = buildOpenAiResponsesInput(request.messages);
  const payload: Record<string, unknown> = {
    model,
    input,
  };

  if (instructions) {
    payload.instructions = instructions;
  }
  if (request.temperature !== undefined) payload.temperature = request.temperature;
  if (request.top_p !== undefined) payload.top_p = request.top_p;
  if (request.max_tokens !== undefined) payload.max_output_tokens = request.max_tokens;
  if (request.reasoning?.effort) payload.reasoning = { effort: request.reasoning.effort };
  if (request.verbosity) payload.text = { ...(isRecord(payload.text) ? payload.text : {}), verbosity: request.verbosity };
  if (request.response_format !== undefined) {
    payload.text = {
      ...(isRecord(payload.text) ? payload.text : {}),
      format: request.response_format,
    };
  }
  if (request.tools !== undefined) payload.tools = request.tools;
  if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
  if (request.stop !== undefined) payload.stop = request.stop;
  if (request.metadata !== undefined) payload.metadata = request.metadata;
  if (request.service_tier) payload.service_tier = request.service_tier;
  if (request.prompt_cache_retention) payload.prompt_cache_retention = request.prompt_cache_retention;

  return payload;
}

function buildOpenAiResponsesInput(
  messages: ChatCompletionRequest["messages"],
): { instructions?: string; input: Array<Record<string, unknown>> } {
  const instructionParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
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
    const content = mapOpenAiResponsesContent(message.content);
    if (content.length > 0) {
      input.push({ role, content });
    }

    if (message.role === "assistant" && Array.isArray(record.tool_calls)) {
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

function mapOpenAiResponsesContent(content: ChatCompletionRequest["messages"][number]["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => {
    if (!isRecord(block)) {
      return undefined;
    }
    if (block.type === "input_text" || block.type === "input_image" || block.type === "input_file") {
      return block;
    }
    if (block.type === "text" || block.type === "output_text") {
      const text = String(block.text ?? "");
      return text.trim() ? { type: "input_text", text } : undefined;
    }
    return block;
  }).filter((block): block is Record<string, unknown> => Boolean(block));
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
  const finishReason = toolCalls.length > 0
    ? "tool_calls"
    : mapOpenAiResponsesFinishReason(json);

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

function buildAnthropicMessagesPayload(
  request: ChatCompletionRequest,
  model: string,
): Record<string, unknown> {
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
  if (request.tools !== undefined) payload.tools = request.tools;
  if (request.tool_choice !== undefined) payload.tool_choice = request.tool_choice;
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

function buildAnthropicMessagesInput(
  messages: ChatCompletionRequest["messages"],
): { system?: string | Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } {
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
      const assistantRecord = message as unknown as Record<string, unknown>;
      const assistantContent = mapAnthropicMessageContent(message.content);
      if (Array.isArray(assistantRecord.tool_calls)) {
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

  const system = systemBlocks.length > 0
    ? [...systemBlocks, ...systemStrings.filter(Boolean).map((text) => ({ type: "text", text }))]
    : (systemStrings.filter(Boolean).length > 0 ? systemStrings.filter(Boolean).join("\n\n") : undefined);

  return { system, messages: normalizedMessages };
}

function mapAnthropicMessageContent(content: ChatCompletionRequest["messages"][number]["content"]): Array<Record<string, unknown>> {
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

function normalizeAnthropicToolResultContent(content: ChatCompletionRequest["messages"][number]["content"]): string | Array<Record<string, unknown>> {
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

function normalizeToolOutputContent(content: ChatCompletionRequest["messages"][number]["content"]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }
  return mapOpenAiResponsesContent(content);
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

function randomToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeProviderMessages(
  messages: ChatCompletionRequest["messages"],
  model: string,
): ChatCompletionRequest["messages"] {
  if (!modelRequiresReasoningContentForToolCalls(model)) {
    return messages;
  }
  return messages.map((message) => {
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
    || model.includes("gpt-5")
    || model.includes("gpt-4o")
    || model.includes("gpt-4.1")
    || model.includes("gemini")
    || model.includes("claude-3")
    || model.includes("claude-sonnet-4")
    || model.includes("claude-opus-4")
    || model.includes("kimi")
    || model.includes("glm")
  );
  const hasAudio = model.includes("audio") || model.includes("whisper");
  const hasVideo = model.includes("video");
  const hasToolCalling = true;
  const hasJsonMode = model.includes("gpt") || model.includes("glm") || model.includes("gemini") || base.includes("openai");
  const hasWebSearch = model.includes("search") || model.includes("sonar") || model.includes("kimi") || model.includes("gpt-4.1") || model.includes("gpt-5");
  const hasReasoning = model.includes("gpt-5") || model.includes("reason") || model.includes("thinking") || model.includes("o1") || model.includes("o3") || model.includes("claude-sonnet-4") || model.includes("claude-opus-4");
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
