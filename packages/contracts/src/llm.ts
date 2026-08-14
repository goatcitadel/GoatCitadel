import type { MemoryCitationProvenance } from "./memory.js";

export type LlmApiStyle =
  | "openai-chat-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-messages";

export type LlmProviderAuthMode =
  | "api-key"
  | "codex-oauth"
  | "claude-code-oauth"
  | "google-service-account"
  | "google-adc";

export type ChatCompletionReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface LlmProviderOAuthStatus {
  connected: boolean;
  accountLabel?: string;
  expiresAt?: string;
  requiresReauth?: boolean;
}

export interface LlmProviderAuthReadiness {
  status: "configured" | "ready" | "missing" | "invalid" | "unknown" | "unavailable";
  source: "keychain" | "env" | "adc_file" | "metadata" | "none";
  /** True only after the Gateway auth owner has successfully resolved a live credential. */
  liveVerified: boolean;
  /** Bounded, secret-free machine-readable explanation. */
  reasonCode: string;
}

export interface LlmProviderCapabilities {
  vision: boolean;
  audio: boolean;
  video: boolean;
  toolCalling: boolean;
  jsonMode: boolean;
  webSearch?: boolean;
  reasoning?: boolean;
  /** Explicit provider-level reasoning contract. Models may narrow or remap it. */
  reasoningEfforts?: ChatCompletionReasoningEffort[];
  voiceInput?: boolean;
  voiceOutput?: boolean;
  imageGenerate?: boolean;
  imageEdit?: boolean;
  artifacts?: boolean;
}

export interface LlmProviderGoogleCloudConfig {
  /** Secret-free Google Cloud project selector. Credential/env project ids remain valid fallbacks. */
  projectId?: string;
  /** Optional environment variable containing the project id. */
  projectIdEnv?: string;
  /** Vertex region, for example `us-central1`. */
  location?: string;
  /** Optional environment variable containing the Vertex region. */
  locationEnv?: string;
  /** Vertex endpoint id. OpenAI-compatible Google models use `openapi`. */
  endpointId?: string;
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
  authMode?: LlmProviderAuthMode;
  apiKey?: string;
  apiKeyEnv?: string;
  googleCloud?: LlmProviderGoogleCloudConfig;
  request?: LlmProviderRequestConfig;
  /** @deprecated Use request.headers instead. */
  headers?: Record<string, string>;
  capabilities?: Partial<LlmProviderCapabilities>;
}

export type ProviderProfileSource = "builtin" | "plugin" | "remote_manifest";
export type ProviderProfileStatus = "builtin" | "pending_owner_approval" | "approved" | "rejected" | "disabled";

export interface ProviderProfileModelDiscovery {
  type: "none" | "openai-compatible" | "openrouter" | "nous-portal";
  url?: string;
  refreshIntervalHours?: number;
}

export interface ProviderProfileErrorMapping {
  retryableStatusCodes?: number[];
  authStatusCodes?: number[];
  rateLimitStatusCodes?: number[];
}

export interface ProviderProfile {
  profileId: string;
  providerId: string;
  label: string;
  source: ProviderProfileSource;
  status: ProviderProfileStatus;
  baseUrl: string;
  apiStyle: LlmApiStyle;
  defaultModel: string;
  authMode?: LlmProviderAuthMode;
  googleCloud?: LlmProviderGoogleCloudConfig;
  request?: LlmProviderRequestConfig;
  capabilities?: Partial<LlmProviderCapabilities>;
  knownModels?: string[];
  modelDiscovery?: ProviderProfileModelDiscovery;
  errorMapping?: ProviderProfileErrorMapping;
  pluginId?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface LlmDiscoveredModelRecord {
  providerId: string;
  modelId: string;
  label?: string;
  source: "openrouter" | "nous-portal" | "provider-profile";
  status: "available_not_configured" | "approved" | "rejected";
  discoveredAt: string;
  contextWindow?: number;
  outputTokenLimit?: number;
}

export interface LlmConfigFile {
  activeProviderId: string;
  activeModel?: string;
  /** Default effort captured only by Chat sessions created after a change. */
  defaultThinkingLevel?: import("./chat.js").ChatThinkingLevel;
  /**
   * Optional cheap utility-model slot for background tasks (improvement scans,
   * judges, classifiers, prompt packs). Only honored when the
   * `utilityModelRoutingV1Enabled` feature flag is on and the provider has a key.
   */
  utilityProviderId?: string;
  utilityModel?: string;
  providers: LlmProviderConfig[];
}

export interface LlmProviderSummary {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle: LlmApiStyle;
  resolvedApiStyle?: LlmApiStyle;
  defaultModel: string;
  authMode?: LlmProviderAuthMode;
  googleCloud?: LlmProviderGoogleCloudConfig;
  oauthStatus?: LlmProviderOAuthStatus;
  authReadiness?: LlmProviderAuthReadiness;
  hasApiKey: boolean;
  apiKeySource: "inline" | "env" | "keychain" | "none";
  hasKeychainSecret?: boolean;
  apiKeyRef?: string;
  capabilities?: LlmProviderCapabilities;
  activeModelContextWindow?: number;
  activeModelOutputTokenLimit?: number;
}

export interface LlmRuntimeConfig {
  activeProviderId: string;
  activeModel: string;
  defaultThinkingLevel?: import("./chat.js").ChatThinkingLevel;
  utilityProviderId?: string;
  utilityModel?: string;
  providers: LlmProviderSummary[];
  activeModelContextWindow?: number;
  activeModelOutputTokenLimit?: number;
}

export interface LlmModelRecord {
  id: string;
  label?: string;
  ownedBy?: string;
  created?: number;
  contextWindow?: number;
  outputTokenLimit?: number;
}

export type LlmModelDiscoverySource = "live" | "template_fallback" | "error_fallback";

export type ProviderModelCatalogSnapshotStatus = "fresh" | "stale" | "refreshing" | "fallback";

export interface ProviderModelCatalogSnapshot {
  snapshotId: string;
  providerId: string;
  baseUrl: string;
  createdAt: string;
  cachedAt: string;
  source: Exclude<LlmModelDiscoverySource, "error_fallback">;
  status: ProviderModelCatalogSnapshotStatus;
  items: LlmModelRecord[];
  itemCount: number;
  catalogHash: string;
  warning?: string;
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

export type ImageGenerationEvidenceSource = "b64_json" | "data_url" | "url";

export interface ImageGenerationResultEvidence {
  evidenceId: string;
  index: number;
  source: ImageGenerationEvidenceSource;
  status: "provider_backed" | "provider_url" | "empty_result";
  sha256?: string;
  sizeBytes?: number;
  mimeType?: string;
  urlHost?: string;
  urlHash?: string;
  revisedPromptHash?: string;
  persistedArtifact?: {
    status: "inline_result" | "external_url" | "not_persisted";
    actionNeeded?: string;
  };
}

export interface ImageGenerationEvidence {
  evidenceId: string;
  owner: "gateway";
  source: "provider_response";
  timestamp: string;
  providerId?: string;
  model?: string;
  operation: "generate" | "edit";
  requestHash: string;
  promptHash: string;
  referenceImageHashes?: string[];
  maskImageHash?: string;
  resultCount: number;
  status: "provider_backed" | "no_results";
  actionNeeded?: string;
  results: ImageGenerationResultEvidence[];
}

export interface ImageGenerationResponse {
  providerId?: string;
  model?: string;
  created?: number;
  operation: "generate" | "edit";
  data: ImageGenerationResultItem[];
  evidence?: ImageGenerationEvidence;
  modelUsageEventIds?: string[];
}

export interface LlmModelPreviewResponse {
  items: LlmModelRecord[];
  source: LlmModelDiscoverySource;
  warning?: string;
}

export interface LlmProviderAdviceRequest {
  preference?: "low_cost" | "balanced" | "capability_fit" | "runtime_fit";
  taskHint?: string;
  requireConfiguredKey?: boolean;
  maxCandidates?: number;
}

export type LlmRuntimeMeasurementSource = "live" | "cached" | "estimated" | "unavailable";
export type LlmRuntimeEngineKind =
  | "remote_api"
  | "openai_compatible"
  | "ollama"
  | "lmstudio"
  | "llama_cpp"
  | "vllm"
  | "sglang"
  | "mlx"
  | "lemonade"
  | "apple_foundation_models"
  | "litellm"
  | "npu_sidecar"
  | "unknown";
export type LlmRuntimeMeasurementStatus = "completed" | "failed" | "partial";

export interface LlmRuntimeMeasurementMetrics {
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  outputTokensPerSecond?: number;
  estimatedCostUsd?: number;
  powerWatts?: number;
  energyJoules?: number;
  cpuPercent?: number;
  gpuPercent?: number;
  npuPercent?: number;
  memoryBytes?: number;
}

export interface LlmRuntimeMeasurementRecord {
  measurementId: string;
  providerId: string;
  model: string;
  engineKind: LlmRuntimeEngineKind;
  source: LlmRuntimeMeasurementSource;
  status: LlmRuntimeMeasurementStatus;
  stream: boolean;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  collectedAt: string;
  metrics: LlmRuntimeMeasurementMetrics;
  provenance: {
    collector: "gateway" | "eval_runner" | "operator_import";
    path: "chat_completion" | "chat_completion_stream" | "runtime_probe" | "eval_proof";
    notes?: string[];
  };
  error?: string;
}

export interface LlmRuntimeMeasurementsQuery {
  providerId?: string;
  model?: string;
  source?: LlmRuntimeMeasurementSource;
  status?: LlmRuntimeMeasurementStatus;
  limit?: number;
}

export interface LlmRuntimeMeasurementsResponse {
  generatedAt: string;
  items: LlmRuntimeMeasurementRecord[];
  warnings: string[];
}

export interface LlmLocalEngineRecord {
  engineKind: LlmRuntimeEngineKind;
  label: string;
  configured: boolean;
  invocation: "native" | "openai_compatible" | "advisory_only" | "unavailable";
  providerIds: string[];
  measurementSource: LlmRuntimeMeasurementSource;
  latestMeasurement?: LlmRuntimeMeasurementRecord;
  fit: "strong" | "ok" | "weak" | "unknown";
  notes: string[];
}

export interface LlmLocalEngineCatalogResponse {
  generatedAt: string;
  items: LlmLocalEngineRecord[];
  warnings: string[];
}

export interface LlmProviderRuntimeFit {
  engineKind: LlmRuntimeEngineKind;
  fit: "strong" | "ok" | "weak" | "unknown";
  measurementSource: LlmRuntimeMeasurementSource;
  latestMeasurementId?: string;
  latencyMs?: number;
  outputTokensPerSecond?: number;
  estimatedCostUsd?: number;
  notes: string[];
}

export interface LlmEvalProofCandidate {
  providerId: string;
  model: string;
  qualityScore?: number;
}

export interface LlmEvalProofRunRequest {
  prompt: string;
  sessionId?: string;
  taskId?: string;
  candidates?: LlmEvalProofCandidate[];
}

export interface LlmEvalProofCandidateResult extends LlmEvalProofCandidate {
  measurementSource: LlmRuntimeMeasurementSource;
  latestMeasurement?: LlmRuntimeMeasurementRecord;
  qualityScoreSource: "operator" | "unavailable";
  latencyMs?: number;
  estimatedCostUsd?: number;
  energyJoules?: number;
  paretoOptimal: boolean;
  notes: string[];
}

export interface LlmEvalProofRunRecord {
  runId: string;
  promptHash: string;
  sessionId?: string;
  taskId?: string;
  status: "completed" | "completed_with_warnings";
  createdAt: string;
  candidates: LlmEvalProofCandidate[];
  results: LlmEvalProofCandidateResult[];
  warnings: string[];
}

export interface LlmEvalProofRunResponse {
  generatedAt: string;
  run: LlmEvalProofRunRecord;
}

export interface LlmEvalProofRunsResponse {
  generatedAt: string;
  items: LlmEvalProofRunRecord[];
}

export interface LlmEvalProofExportResponse {
  version: "llm.eval_proof_export.v1";
  generatedAt: string;
  format: "json";
  contentType: "application/json";
  filename: string;
  sourceEndpoint: string;
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    note: string;
  };
  runs: LlmEvalProofRunRecord[];
  content: string;
}

export interface LlmProviderAdviceCandidate {
  providerId: string;
  providerLabel: string;
  model: string;
  configured: boolean;
  estimatedCostUsd?: number;
  costSource: "estimated" | "unknown";
  fitScore: number;
  riskNotes: string[];
  requiredKeys: string[];
  measurementSource?: LlmRuntimeMeasurementSource;
  hardwareFit?: "strong" | "ok" | "weak" | "unknown";
  localRuntimeFit?: LlmProviderRuntimeFit;
}

export interface LlmProviderAdviceResponse {
  generatedAt: string;
  preference: NonNullable<LlmProviderAdviceRequest["preference"]>;
  candidates: LlmProviderAdviceCandidate[];
  advisoryOnly: true;
  mutationPerformed: false;
  warnings: string[];
}

export type ChatCompletionRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ChatCompletionReasoningConfig {
  effort: ChatCompletionReasoningEffort;
}

export interface ChatCompletionReasoningReceipt {
  requested: ChatCompletionReasoningEffort;
  actual: ChatCompletionReasoningEffort;
  /** Exact effort value sent across the provider boundary after an explicit metadata mapping. */
  providerEffort: ChatCompletionReasoningEffort;
  disposition: "honored" | "downgraded" | "provider_default";
  reasonCode: string;
  capabilitySource: "model_metadata" | "provider_config" | "legacy_compatibility";
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
    runId?: string;
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
  parallel_tool_calls?: boolean;
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
  /** Canonical per-network-attempt usage events contributing to this response. */
  modelUsageEventIds?: string[];
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
    reasoning?: ChatCompletionReasoningReceipt;
  };
  citations?: Array<{
    citationId: string;
    title?: string;
    url: string;
    snippet?: string;
    sourceType?: "web" | "file" | "tool" | "memory";
    provenance?: MemoryCitationProvenance;
  }>;
  [key: string]: unknown;
}
