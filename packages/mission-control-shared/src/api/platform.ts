import type {
  AddonActionResponse,
  AddonCatalogEntry,
  AddonDashboardSlot,
  AddonDashboardSlotDeclaration,
  AddonInstalledRecord,
  AddonInstallRequest,
  AddonStatusRecord,
  AddonUninstallResponse,
  AssemblyRunDetailResponse,
  AssemblyRunRecord,
  CapabilityPackInstallResult,
  CapabilityPackManifest,
  CapabilityPackPreview,
  ChangeRiskEvaluationResponse,
  CreateAssemblyRunInput,
  CuratorArchiveRequest,
  CuratorArchiveResponse,
  CuratorListArchivedResponse,
  CuratorPruneRequest,
  CuratorPruneResponse,
  CuratorRunRequest,
  CuratorRunResponse,
  CuratorStatusResponse,
  EvidenceEnvelope,
  EvidenceEnvelopeListQuery,
  LlmModelDiscoverySource,
  LlmEvalProofRunRequest,
  LlmEvalProofRunResponse,
  LlmEvalProofRunsResponse,
  LlmEvalProofExportResponse,
  LlmLocalEngineCatalogResponse,
  LlmProviderAdviceRequest,
  LlmProviderAdviceResponse,
  LlmProviderConfig,
  LlmProviderRequestConfig,
  LlmRuntimeMeasurementsQuery,
  LlmRuntimeMeasurementsResponse,
  LlamaCppAdvisorRecommendation,
  LlamaCppAdvisorRequest,
  LlamaCppModelsResponse,
  LlamaCppRuntimeStatus,
  ImageGenerationRequest,
  ImageGenerationResponse,
  MemoryContextPack,
  ModelReputation,
  NpuModelManifest,
  NpuRuntimeStatus,
  OrchestrationRun,
} from "@goatcitadel/contracts";
import type {
  LlmChatCompletionResponse,
  DaemonControlHandoff,
  MeshLeaseRecord,
  MeshNodeRecord,
  MeshReplicationOffsetRecord,
  MeshSessionOwnerRecord,
  MeshStatusResponse,
  OrchestrationCheckpointRecord,
  RuntimeSettingsResponse,
} from "./types.js";
import { request } from "./client-core.js";

export interface AddonSlotRegistration extends AddonDashboardSlotDeclaration {
  addonId: string;
}

export interface FetchAddonSlotsParams {
  route?: string;
  slot?: AddonDashboardSlot;
}

export type LlmRuntimeConfigResponse = RuntimeSettingsResponse["llm"] & {
  providerConfigs?: LlmProviderConfig[];
};

export interface ProviderSecretStatus {
  providerId: string;
  hasSecret: boolean;
  source: "none" | "keychain" | "env" | "inline";
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

export async function fetchAddonsCatalog(): Promise<{ items: AddonCatalogEntry[] }> {
  return request<{ items: AddonCatalogEntry[] }>("/api/v1/addons/catalog");
}

export async function fetchInstalledAddons(): Promise<{ items: AddonInstalledRecord[] }> {
  return request<{ items: AddonInstalledRecord[] }>("/api/v1/addons/installed");
}

export async function fetchAddonStatus(addonId: string): Promise<AddonStatusRecord> {
  return request<AddonStatusRecord>(`/api/v1/addons/${encodeURIComponent(addonId)}/status`);
}

export async function fetchAddonSlots(params: FetchAddonSlotsParams = {}): Promise<{ items: AddonSlotRegistration[] }> {
  const query = new URLSearchParams();
  if (params.route) {
    query.set("route", params.route);
  }
  if (params.slot) {
    query.set("slot", params.slot);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request<{ items: AddonSlotRegistration[] }>(`/api/v1/addons/slots${suffix}`);
}

export async function installAddon(addonId: string, input: AddonInstallRequest): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/install`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/update`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function enableAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/enable`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function disableAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/disable`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function launchAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/launch`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopAddon(addonId: string): Promise<AddonActionResponse> {
  return request<AddonActionResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function uninstallAddon(addonId: string): Promise<AddonUninstallResponse> {
  return request<AddonUninstallResponse>(`/api/v1/addons/${encodeURIComponent(addonId)}/uninstall`, {
    method: "DELETE",
  });
}

export async function fetchCapabilityPacks(): Promise<{ items: CapabilityPackManifest[] }> {
  return request<{ items: CapabilityPackManifest[] }>("/api/v1/capability-packs");
}

export async function fetchCapabilityPackPreview(packId: string): Promise<CapabilityPackPreview> {
  return request<CapabilityPackPreview>(`/api/v1/capability-packs/${encodeURIComponent(packId)}/preview`);
}

export async function fetchLocalCapabilityPackPreview(
  manifest: CapabilityPackManifest,
): Promise<CapabilityPackPreview> {
  return request<CapabilityPackPreview>("/api/v1/capability-packs/local/preview", {
    method: "POST",
    body: JSON.stringify({ manifest }),
  });
}

export async function installCapabilityPack(
  packId: string,
  input: { actorId?: string } = {},
): Promise<CapabilityPackInstallResult> {
  return request<CapabilityPackInstallResult>(`/api/v1/capability-packs/${encodeURIComponent(packId)}/install`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function installLocalCapabilityPack(
  manifest: CapabilityPackManifest,
  input: { actorId?: string } = {},
): Promise<CapabilityPackInstallResult> {
  return request<CapabilityPackInstallResult>("/api/v1/capability-packs/local/install", {
    method: "POST",
    body: JSON.stringify({ ...input, manifest }),
  });
}

export async function fetchEvidenceEnvelopes(
  query: EvidenceEnvelopeListQuery = {},
): Promise<{ items: EvidenceEnvelope[] }> {
  const params = new URLSearchParams();
  if (query.sessionId) {
    params.set("sessionId", query.sessionId);
  }
  if (query.turnId) {
    params.set("turnId", query.turnId);
  }
  if (query.runId) {
    params.set("runId", query.runId);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request<{ items: EvidenceEnvelope[] }>(`/api/v1/evidence/envelopes${suffix}`);
}

export async function fetchCuratorStatus(): Promise<CuratorStatusResponse> {
  return request<CuratorStatusResponse>(`/api/v1/curator/status`);
}

export async function archiveCuratorSkill(input: CuratorArchiveRequest): Promise<CuratorArchiveResponse> {
  return request<CuratorArchiveResponse>(`/api/v1/curator/archive`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function pruneCuratorSkill(input: CuratorPruneRequest): Promise<CuratorPruneResponse> {
  return request<CuratorPruneResponse>(`/api/v1/curator/prune`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listCuratorArchived(): Promise<CuratorListArchivedResponse> {
  return request<CuratorListArchivedResponse>(`/api/v1/curator/archived`);
}

export async function runCurator(input: CuratorRunRequest = {}): Promise<CuratorRunResponse> {
  return request<CuratorRunResponse>(`/api/v1/curator/run`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchOrchestrationRunContext(runId: string): Promise<{ items: MemoryContextPack[] }> {
  return request<{ items: MemoryContextPack[] }>(`/api/v1/orchestration/runs/${encodeURIComponent(runId)}/context`);
}

export async function fetchOrchestrationRun(runId: string): Promise<OrchestrationRun> {
  return request<OrchestrationRun>(`/api/v1/orchestration/runs/${encodeURIComponent(runId)}`);
}

export async function fetchOrchestrationRunCheckpoints(
  runId: string,
): Promise<{ items: OrchestrationCheckpointRecord[] }> {
  return request<{ items: OrchestrationCheckpointRecord[] }>(
    `/api/v1/orchestration/runs/${encodeURIComponent(runId)}/checkpoints`,
  );
}

export async function cancelOrchestrationRun(
  runId: string,
  input: { actorId?: string; workspaceId?: string } = {},
): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpointRecord[] }> {
  return request<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpointRecord[] }>(
    `/api/v1/orchestration/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchLlmConfig(): Promise<LlmRuntimeConfigResponse> {
  return request<LlmRuntimeConfigResponse>("/api/v1/llm/config");
}

export async function fetchLlmModels(providerId?: string): Promise<{
  items: Array<{ id: string; ownedBy?: string; created?: number }>;
  source: LlmModelDiscoverySource;
  warning?: string;
}> {
  const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
  return request(`/api/v1/llm/models${query}`);
}

export async function fetchLlmProviderAdvice(input: LlmProviderAdviceRequest = {}): Promise<LlmProviderAdviceResponse> {
  return request<LlmProviderAdviceResponse>("/api/v1/llm/provider-advice", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchLlmRuntimeMeasurements(
  input: LlmRuntimeMeasurementsQuery = {},
): Promise<LlmRuntimeMeasurementsResponse> {
  const search = new URLSearchParams();
  if (input.providerId) search.set("providerId", input.providerId);
  if (input.model) search.set("model", input.model);
  if (input.source) search.set("source", input.source);
  if (input.status) search.set("status", input.status);
  if (input.limit) search.set("limit", String(input.limit));
  const query = search.toString();
  return request<LlmRuntimeMeasurementsResponse>(`/api/v1/llm/runtime-measurements${query ? `?${query}` : ""}`);
}

export async function fetchLlmLocalEngines(): Promise<LlmLocalEngineCatalogResponse> {
  return request<LlmLocalEngineCatalogResponse>("/api/v1/llm/local-engines");
}

export async function fetchLlmEvalProofRuns(limit = 20): Promise<LlmEvalProofRunsResponse> {
  return request<LlmEvalProofRunsResponse>(`/api/v1/llm/eval-proof?limit=${Math.max(1, Math.min(limit, 200))}`);
}

export async function exportLlmEvalProofRuns(limit = 20): Promise<LlmEvalProofExportResponse> {
  return request<LlmEvalProofExportResponse>(
    `/api/v1/llm/eval-proof/export?limit=${Math.max(1, Math.min(limit, 200))}`,
  );
}

export async function runLlmEvalProof(input: LlmEvalProofRunRequest): Promise<LlmEvalProofRunResponse> {
  return request<LlmEvalProofRunResponse>("/api/v1/llm/eval-proof", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchAssemblyRuns(limit = 50): Promise<{ items: AssemblyRunRecord[] }> {
  return request(`/api/v1/assembly/runs?limit=${limit}`);
}

export async function createAssemblyRun(input: CreateAssemblyRunInput): Promise<AssemblyRunRecord> {
  return request("/api/v1/assembly/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchAssemblyRunDetail(runId: string): Promise<AssemblyRunDetailResponse> {
  return request(`/api/v1/assembly/runs/${encodeURIComponent(runId)}`);
}

export async function fetchAssemblyReputations(limit = 50): Promise<{ items: ModelReputation[] }> {
  return request(`/api/v1/assembly/reputation?limit=${limit}`);
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
      | "bedrock-messages";
    apiKey?: string;
    apiKeyEnv?: string;
    request?: LlmProviderRequestConfig;
    headers?: Record<string, string>;
  },
  options?: { signal?: AbortSignal },
): Promise<{
  items: Array<{ id: string; ownedBy?: string; created?: number }>;
  source: LlmModelDiscoverySource;
  warning?: string;
}> {
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

export async function createLlmChatCompletion(input: {
  providerId?: string;
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  memory?: {
    enabled?: boolean;
    mode?: "qmd" | "off";
    sessionId?: string;
    taskId?: string;
    runId?: string;
    workspace?: string;
    maxContextTokens?: number;
    forceRefresh?: boolean;
  };
  temperature?: number;
  max_tokens?: number;
}): Promise<LlmChatCompletionResponse> {
  return request<LlmChatCompletionResponse>("/api/v1/llm/chat-completions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchProviderSecretStatus(
  providerId: string,
  options?: { signal?: AbortSignal },
): Promise<ProviderSecretStatus> {
  return request<ProviderSecretStatus>(`/api/v1/secrets/providers/${encodeURIComponent(providerId)}/status`, {
    signal: options?.signal,
  });
}

export async function saveProviderSecret(providerId: string, apiKey: string): Promise<ProviderSecretStatus> {
  return request<ProviderSecretStatus>(`/api/v1/secrets/providers/${encodeURIComponent(providerId)}`, {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });
}

export async function deleteProviderSecret(providerId: string): Promise<ProviderSecretStatus> {
  return request<ProviderSecretStatus>(`/api/v1/secrets/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function fetchOpenAICodexOAuthStatus(): Promise<OpenAICodexOAuthStatus> {
  return request<OpenAICodexOAuthStatus>("/api/v1/llm/providers/openai-codex/oauth/status");
}

export async function startOpenAICodexOAuthDeviceFlow(): Promise<OpenAICodexDeviceStartResponse> {
  return request<OpenAICodexDeviceStartResponse>("/api/v1/llm/providers/openai-codex/oauth/device/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function pollOpenAICodexOAuthDeviceFlow(flowId: string): Promise<OpenAICodexDevicePollResponse> {
  return request<OpenAICodexDevicePollResponse>("/api/v1/llm/providers/openai-codex/oauth/device/poll", {
    method: "POST",
    body: JSON.stringify({ flowId }),
  });
}

export async function deleteOpenAICodexOAuthCredential(): Promise<OpenAICodexOAuthStatus> {
  return request<OpenAICodexOAuthStatus>("/api/v1/llm/providers/openai-codex/oauth", {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export async function fetchMeshStatus(): Promise<MeshStatusResponse> {
  return request<MeshStatusResponse>("/api/v1/mesh/status");
}

export async function fetchMeshNodes(limit = 200): Promise<{ items: MeshNodeRecord[] }> {
  return request<{ items: MeshNodeRecord[] }>(`/api/v1/mesh/nodes?limit=${limit}`);
}

export async function fetchMeshLeases(limit = 200): Promise<{ items: MeshLeaseRecord[] }> {
  return request<{ items: MeshLeaseRecord[] }>(`/api/v1/mesh/leases?limit=${limit}`);
}

export async function fetchMeshSessionOwners(limit = 500): Promise<{ items: MeshSessionOwnerRecord[] }> {
  return request<{ items: MeshSessionOwnerRecord[] }>(`/api/v1/mesh/sessions/owners?limit=${limit}`);
}

export async function fetchMeshReplicationOffsets(limit = 500): Promise<{ items: MeshReplicationOffsetRecord[] }> {
  return request<{ items: MeshReplicationOffsetRecord[] }>(`/api/v1/mesh/replication/offsets?limit=${limit}`);
}

export async function fetchNpuStatus(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/status");
}

export async function fetchNpuModels(): Promise<{ items: NpuModelManifest[] }> {
  return request<{ items: NpuModelManifest[] }>("/api/v1/npu/models");
}

export async function startNpuRuntime(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopNpuRuntime(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function refreshNpuRuntime(): Promise<NpuRuntimeStatus> {
  return request<NpuRuntimeStatus>("/api/v1/npu/refresh", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchLlamaCppStatus(): Promise<LlamaCppRuntimeStatus> {
  return request<LlamaCppRuntimeStatus>("/api/v1/llamacpp/status");
}

export async function fetchLlamaCppModels(): Promise<LlamaCppModelsResponse> {
  return request<LlamaCppModelsResponse>("/api/v1/llamacpp/models");
}

export async function detectLlamaCppInstall(): Promise<LlamaCppInstallDetection> {
  return request<LlamaCppInstallDetection>("/api/v1/llamacpp/install");
}

export async function startLlamaCppHuggingFaceDownload(
  input: LlamaCppHuggingFaceDownloadRequest,
): Promise<LlamaCppHuggingFaceDownloadStatus> {
  return request<LlamaCppHuggingFaceDownloadStatus>("/api/v1/llamacpp/huggingface/download", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchLlamaCppHuggingFaceDownload(jobId: string): Promise<LlamaCppHuggingFaceDownloadStatus> {
  return request<LlamaCppHuggingFaceDownloadStatus>(
    `/api/v1/llamacpp/huggingface/downloads/${encodeURIComponent(jobId)}`,
  );
}

export async function cancelLlamaCppHuggingFaceDownload(jobId: string): Promise<LlamaCppHuggingFaceDownloadStatus> {
  return request<LlamaCppHuggingFaceDownloadStatus>(
    `/api/v1/llamacpp/huggingface/downloads/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function startLlamaCppRuntime(): Promise<LlamaCppRuntimeStatus> {
  return request<LlamaCppRuntimeStatus>("/api/v1/llamacpp/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopLlamaCppRuntime(): Promise<LlamaCppRuntimeStatus> {
  return request<LlamaCppRuntimeStatus>("/api/v1/llamacpp/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function refreshLlamaCppRuntime(): Promise<LlamaCppRuntimeStatus> {
  return request<LlamaCppRuntimeStatus>("/api/v1/llamacpp/refresh", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchLlamaCppAdvisor(input: LlamaCppAdvisorRequest): Promise<LlamaCppAdvisorRecommendation> {
  return request<LlamaCppAdvisorRecommendation>("/api/v1/llamacpp/advisor", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchDaemonStatus(): Promise<{
  running: boolean;
  pid: number;
  uptimeSeconds: number;
  host: string;
  state: "running" | "stopped";
  lastCommandAt?: string;
  requestedState?: "running" | "stopped";
  supported: boolean;
  controllable: boolean;
  controlMessage: string;
  controlHandoff?: DaemonControlHandoff;
}> {
  return request<{
    running: boolean;
    pid: number;
    uptimeSeconds: number;
    host: string;
    state: "running" | "stopped";
    lastCommandAt?: string;
    requestedState?: "running" | "stopped";
    supported: boolean;
    controllable: boolean;
    controlMessage: string;
    controlHandoff?: DaemonControlHandoff;
  }>("/api/v1/daemon/status");
}

export async function startDaemon(): Promise<{
  accepted: boolean;
  reason: string;
  status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
}> {
  return request<{
    accepted: boolean;
    reason: string;
    status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
  }>("/api/v1/daemon/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function stopDaemon(): Promise<{
  accepted: boolean;
  reason: string;
  status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
}> {
  return request<{
    accepted: boolean;
    reason: string;
    status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
  }>("/api/v1/daemon/stop", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function restartDaemon(): Promise<{
  accepted: boolean;
  reason: string;
  status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
}> {
  return request<{
    accepted: boolean;
    reason: string;
    status: Awaited<ReturnType<typeof fetchDaemonStatus>>;
  }>("/api/v1/daemon/restart", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchDaemonLogs(tail = 200): Promise<{
  items: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>;
}> {
  return request<{
    items: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string }>;
  }>(`/api/v1/daemon/logs?tail=${Math.max(1, Math.min(2000, tail))}`);
}

export async function evaluateUiChangeRisk(
  input: {
    pageId: string;
    changes: Array<{ field: string; from: unknown; to: unknown }>;
  },
  options?: { signal?: AbortSignal },
): Promise<ChangeRiskEvaluationResponse> {
  return request<ChangeRiskEvaluationResponse>("/api/v1/ui/change-risk/evaluate", {
    method: "POST",
    body: JSON.stringify(input),
    signal: options?.signal,
  });
}
