export type LlmApiStyle = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

export interface LlmProviderCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  toolCalling: boolean;
  jsonMode: boolean;
  webSearch?: boolean;
  reasoning?: boolean;
  voiceInput?: boolean;
  voiceOutput?: boolean;
  imageGenerate?: boolean;
  imageEdit?: boolean;
  artifacts?: boolean;
}

export type LlmProviderRequestAuthConfig =
  | {
      type: "bearer";
      token?: string;
      tokenEnv?: string;
      headerName?: string;
    }
  | {
      type: "header";
      headerName: string;
      value?: string;
      valueEnv?: string;
      scheme?: string;
    }
  | {
      type: "query";
      queryParam: string;
      value?: string;
      valueEnv?: string;
      prefix?: string;
    };

export type LlmProviderRequestProxyAuthConfig = Extract<
  LlmProviderRequestAuthConfig,
  { type: "bearer" } | { type: "header" }
>;

export interface LlmProviderRequestProxyConfig {
  url: string;
  bypassHosts?: string[];
  auth?: LlmProviderRequestProxyAuthConfig;
  tls?: LlmProviderRequestTlsConfig;
}

export interface LlmProviderRequestTlsConfig {
  insecureSkipVerify?: boolean;
  caCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  serverName?: string;
}

export interface LlmProviderRequestConfig {
  headers?: Record<string, string>;
  auth?: LlmProviderRequestAuthConfig;
  proxy?: LlmProviderRequestProxyConfig;
  tls?: LlmProviderRequestTlsConfig;
}

export interface LlmProviderConfig {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle: LlmApiStyle;
  defaultModel: string;
  apiKey?: string;
  apiKeyEnv?: string;
  request?: LlmProviderRequestConfig;
  /** @deprecated Use request.headers instead. */
  headers?: Record<string, string>;
  capabilities?: Partial<LlmProviderCapabilities>;
}

export interface LlmConfigFile {
  activeProviderId: string;
  activeModel?: string;
  providers: LlmProviderConfig[];
}

export interface LlmProviderSummary {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle: LlmApiStyle;
  resolvedApiStyle?: LlmApiStyle;
  defaultModel: string;
  hasApiKey: boolean;
  apiKeySource: "inline" | "env" | "keychain" | "none";
  hasKeychainSecret?: boolean;
  apiKeyRef?: string;
  capabilities?: LlmProviderCapabilities;
}

export interface LlmRuntimeConfig {
  activeProviderId: string;
  activeModel: string;
  providers: LlmProviderSummary[];
}

export interface LlmModelRecord {
  id: string;
  ownedBy?: string;
  created?: number;
}

export interface LlmModelPreviewRequest {
  providerId: string;
  baseUrl: string;
  apiStyle?: LlmApiStyle;
  apiKey?: string;
  apiKeyEnv?: string;
  request?: LlmProviderRequestConfig;
  /** @deprecated Use request.headers instead. */
  headers?: Record<string, string>;
}

export interface ImageAssetInput {
  bytesBase64: string;
  mimeType?: string;
  fileName?: string;
}

export interface ImageGenerationRequest {
  providerId?: string;
  model?: string;
  prompt: string;
  referenceImages?: ImageAssetInput[];
  maskImage?: ImageAssetInput;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  responseFormat?: "b64_json" | "url";
  moderation?: "auto" | "low";
  timeoutMs?: number;
}

export interface ImageGenerationResultItem {
  b64Json?: string;
  url?: string;
  revisedPrompt?: string;
}

export interface ImageGenerationResponse {
  providerId?: string;
  model?: string;
  created?: number;
  operation: "generate" | "edit";
  data: ImageGenerationResultItem[];
}

export interface LlmModelPreviewResponse {
  items: LlmModelRecord[];
  source: "remote" | "fallback";
  warning?: string;
}

export type ChatCompletionRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ChatCompletionReasoningConfig {
  effort: "none" | "low" | "medium" | "high" | "xhigh";
}

export interface ChatCompletionMessage {
  role: ChatCompletionRole;
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  providerId?: string;
  model?: string;
  messages: ChatCompletionMessage[];
  signal?: AbortSignal;
  memory?: {
    enabled?: boolean;
    mode?: "qmd" | "off";
    turnId?: string;
    sessionId?: string;
    taskId?: string;
    workspace?: string;
    relationScope?: import("./memory.js").MemoryRelationScope;
    maxContextTokens?: number;
    forceRefresh?: boolean;
  };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning?: ChatCompletionReasoningConfig;
  verbosity?: "low" | "medium" | "high";
  timeoutMs?: number;
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  stop?: string | string[];
  response_format?: Record<string, unknown>;
  service_tier?: string;
  prompt_cache_retention?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatCompletionResponseChoice {
  index: number;
  message?: Record<string, unknown>;
  finish_reason?: string | null;
}

export interface ChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: ChatCompletionResponseChoice[];
  usage?: Record<string, unknown>;
  memoryContext?: {
    contextId: string;
    cacheHit: boolean;
    originalTokenEstimate: number;
    distilledTokenEstimate: number;
    savingsPercent: number;
    citationsCount: number;
  };
  routing?: {
    primaryProviderId?: string;
    primaryModel?: string;
    primaryApiStyle?: LlmApiStyle;
    effectiveProviderId?: string;
    effectiveModel?: string;
    effectiveApiStyle?: LlmApiStyle;
    fallbackProviderId?: string;
    fallbackModel?: string;
    fallbackApiStyle?: LlmApiStyle;
    fallbackReason?: string;
    fallbackUsed?: boolean;
  };
  citations?: Array<{
    citationId: string;
    title?: string;
    url: string;
    snippet?: string;
    sourceType?: "web" | "file" | "tool";
  }>;
  [key: string]: unknown;
}
