export type LocalAiBackendKind = "ollama" | "llama_cpp" | "vllm" | "sglang" | "openai_compatible";

export type LocalAiPlatformSupport = "native" | "wsl" | "remote" | "unsupported";

export type LocalAiJobStatus = "queued" | "requires_approval" | "running" | "ready" | "failed" | "stopped";

export interface LocalAiHardwareSnapshot {
  checkedAt: string;
  os: {
    platform: string;
    arch: string;
    release?: string;
  };
  cpu: {
    model?: string;
    logicalCores: number;
  };
  memory: {
    totalBytes: number;
    freeBytes?: number;
  };
  gpu: Array<{
    name: string;
    vendor?: string;
    vramBytes?: number;
    driverVersion?: string;
    source: "wmic" | "nvidia-smi" | "dxdiag" | "system_profiler" | "lspci" | "unknown";
  }>;
  disk: {
    modelsRootPath?: string;
    freeBytes?: number;
  };
  runtimes: Array<{
    backend: LocalAiBackendKind;
    detected: boolean;
    version?: string;
    command?: string;
    baseUrl?: string;
    platformSupport: LocalAiPlatformSupport;
    notes?: string[];
  }>;
}

export interface LocalAiModelCatalogItem {
  modelId: string;
  label: string;
  family: string;
  parameterCountBillions?: number;
  quantization?: string;
  downloadBytes?: number;
  contextTokens?: number;
  preferredBackends: LocalAiBackendKind[];
  tags: string[];
  source: "builtin" | "operator" | "remote_catalog";
}

export interface LocalAiFitRecommendation {
  modelId: string;
  backend: LocalAiBackendKind;
  fit: "excellent" | "good" | "borderline" | "not_recommended";
  confidence: "high" | "medium" | "low";
  reasons: string[];
  limitations: string[];
  estimatedMemoryBytes?: number;
  estimatedDiskBytes?: number;
}

export interface LocalAiDownloadJob {
  jobId: string;
  modelId: string;
  backend: LocalAiBackendKind;
  status: LocalAiJobStatus;
  approvalId?: string;
  progressPercent?: number;
  artifactPath?: string;
  artifactHash?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAiServeJob {
  jobId: string;
  modelId: string;
  backend: LocalAiBackendKind;
  status: LocalAiJobStatus;
  approvalId?: string;
  endpointUrl?: string;
  processId?: number;
  health?: "unknown" | "starting" | "healthy" | "unhealthy";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAiEndpointRegistration {
  endpointId: string;
  providerId: string;
  label: string;
  backend: LocalAiBackendKind;
  baseUrl: string;
  model: string;
  smokeStatus: "pending" | "passed" | "failed";
  evidenceRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAiReadinessResponse {
  hardware: LocalAiHardwareSnapshot;
  catalog: LocalAiModelCatalogItem[];
  recommendations: LocalAiFitRecommendation[];
  downloads: LocalAiDownloadJob[];
  serveJobs: LocalAiServeJob[];
  endpoints: LocalAiEndpointRegistration[];
}

export interface LocalAiDownloadRequest {
  modelId: string;
  backend: LocalAiBackendKind;
  approvalMode?: "request" | "dry_run";
}

export interface LocalAiServeRequest {
  modelId: string;
  backend: LocalAiBackendKind;
  approvalMode?: "request" | "dry_run";
  port?: number;
}

export interface LocalAiEndpointRegistrationRequest {
  label: string;
  backend: LocalAiBackendKind;
  baseUrl: string;
  model: string;
  providerId?: string;
}
