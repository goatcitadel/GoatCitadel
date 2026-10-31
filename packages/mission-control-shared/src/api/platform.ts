import type {
  LlmModelDiscoverySource,
  LlmModelPreviewResponse,
  LlmModelRecord,
  LlmProviderConfig,
  LlmProviderRequestConfig,
  LlmProviderTransportReceipt,
  LlamaCppRuntimeStatus,
  ImageGenerationRequest,
  ImageGenerationResponse,
  NpuRuntimeStatus,
} from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "./types.js";
import { request } from "./client-core.js";

export type LlmRuntimeConfigResponse = RuntimeSettingsResponse["llm"] & {
  revision: number;
  providerConfigs?: LlmProviderConfig[];
  providerTransportReceipt?: LlmProviderTransportReceipt;
};

export interface ProviderSecretStatus {
  providerId: string;
  hasSecret: boolean;
  source: "none" | "keychain" | "env" | "inline";
}

export interface ProviderSecretMutationResponse extends ProviderSecretStatus {
  revision: number;
  /** Additive compatibility receipt when the save/delete entered the Evolution Control Plane. */
  changePlanReceipt?: NonNullable<RuntimeSettingsResponse["changePlanReceipt"]>;
}

export interface OpenAICodexOAuthStatus {
  providerId: "openai-codex";
  available: boolean;
  connected: boolean;
  accountLabel?: string;
  expiresAt?: string;
  requiresReauth?: boolean;
}

export interface OpenAICodexDeviceStartResponse {
  flowId: string;
  providerId: "openai-codex";
  verificationUrl: string;
  userCode?: string;
  expiresAt: string;
  pollAfterMs: number;
}

export interface OpenAICodexDevicePollResponse {
  flowId: string;
  providerId: "openai-codex";
  status: "pending" | "connected" | "expired" | "failed";
  retryAfterMs?: number;
  accountLabel?: string;
  expiresAt?: string;
  requiresReauth?: boolean;
  error?: string;
}

export interface LlamaCppInstallDetection {
  found: boolean;
  command?: string;
  source: "configured" | "standard-windows" | "path" | "path-with-exe" | "missing";
  version?: string;
  recommendedBaseUrl: string;
}

export interface LlamaCppHuggingFaceDownloadRequest {
  repo: string;
  filename: string;
  alias?: string;
  mmprojFilename?: string;
  sha256?: string;
  mmprojSha256?: string;
}

export interface LlamaCppHuggingFaceDownloadStatus {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: "model" | "mmproj" | "done";
  repo: string;
  alias: string;
  filename: string;
  mmprojFilename?: string;
  sourceUrl: string;
  mmprojSourceUrl?: string;
  expectedSha256?: string;
  expectedMmprojSha256?: string;
  bytesDownloaded: number;
  totalBytes?: number;
  mmprojBytesDownloaded?: number;
  mmprojTotalBytes?: number;
  modelBytes?: number;
  mmprojBytes?: number;
  actualSha256?: string;
  actualMmprojSha256?: string;
  modelPath?: string;
  mmprojPath?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export async function fetchLlmConfig(): Promise<LlmRuntimeConfigResponse> {
  return request<LlmRuntimeConfigResponse>("/api/v1/llm/config");
}

export async function fetchLlmModels(providerId?: string): Promise<{
  items: LlmModelRecord[];
  source: LlmModelDiscoverySource;
  catalogStatus?: "fresh" | "stale";
  warning?: string;
}> {
  const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
  return request(`/api/v1/llm/models${query}`);
}

export async function previewLlmModels(
  input: {
    providerId: string;
    baseUrl: string;
    apiStyle?:
      | "openai-chat-completions"
      | "openai-responses"
      | "openai-codex-responses"
      | "anthropic-messages"
      | "bedrock-messages"
      | "claude-code-cli";
    apiKey?: string;
    apiKeyEnv?: string;
    request?: LlmProviderRequestConfig;
    headers?: Record<string, string>;
  },
  options?: { signal?: AbortSignal },
): Promise<LlmModelPreviewResponse> {
  return request("/api/v1/llm/models/preview", {
    method: "POST",
    body: JSON.stringify(input),
    signal: options?.signal,
  });
}

export async function generateLlmImage(input: ImageGenerationRequest): Promise<ImageGenerationResponse> {
  return request<ImageGenerationResponse>("/api/v1/llm/images", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchNpuStatus(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/status");
}

export async function fetchLlamaCppStatus(): Promise<LlamaCppRuntimeStatus> {
  return request<LlamaCppRuntimeStatus>("/api/v1/llamacpp/status");
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  fetchCapabilityPacks,
  fetchStagedCapabilityPacks,
  fetchCapabilityPackPreview,
  exportCapabilityPack,
  fetchLocalCapabilityPackPreview,
  installCapabilityPack,
  installLocalCapabilityPack,
  materializeStagedCapabilityPack,
  fetchEvidenceEnvelopes,
  fetchCuratorStatus,
  archiveCuratorSkill,
  pruneCuratorSkill,
  listCuratorArchived,
  runCurator,
  fetchOrchestrationRunContext,
  fetchOrchestrationRun,
  fetchOrchestrationRunTrace,
  fetchOrchestrationRunCheckpoints,
  cancelOrchestrationRun,
  fetchLlmProviderAdvice,
  fetchLlmRuntimeMeasurements,
  fetchLlmLocalEngines,
  fetchLlmEvalProofRuns,
  exportLlmEvalProofRuns,
  runLlmEvalProof,
  fetchAssemblyRuns,
  createAssemblyRun,
  fetchAssemblyRunDetail,
  fetchAssemblyReputations,
  createLlmChatCompletion,
  fetchProviderSecretStatus,
  saveProviderSecret,
  deleteProviderSecret,
  fetchOpenAICodexOAuthStatus,
  startOpenAICodexOAuthDeviceFlow,
  pollOpenAICodexOAuthDeviceFlow,
  deleteOpenAICodexOAuthCredential,
  fetchMeshStatus,
  fetchMeshReadiness,
  fetchMeshNodes,
  fetchMeshLeases,
  fetchMeshSessionOwners,
  fetchMeshReplicationOffsets,
  fetchNpuModels,
  startNpuRuntime,
  stopNpuRuntime,
  refreshNpuRuntime,
  fetchLlamaCppSetup,
  stageLlamaCppManagedSelection,
  testLlamaCppChat,
  fetchLlamaCppModels,
  detectLlamaCppInstall,
  startLlamaCppHuggingFaceDownload,
  fetchLlamaCppHuggingFaceDownload,
  cancelLlamaCppHuggingFaceDownload,
  startLlamaCppRuntime,
  stopLlamaCppRuntime,
  refreshLlamaCppRuntime,
  fetchLlamaCppAdvisor,
  fetchDaemonStatus,
  startDaemon,
  stopDaemon,
  restartDaemon,
  fetchDaemonLogs,
  evaluateUiChangeRisk,
} from "./platform-operations.js";
