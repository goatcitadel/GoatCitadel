export interface LlamaCppRestartBudget {
  windowMs: number;
  maxRestarts: number;
  backoffMs: number;
}

export interface LlamaCppServerConfig {
  baseUrl: string;
  command: string;
  extraArgs: string[];
  healthPath: string;
  modelsPath: string;
  startTimeoutMs: number;
  requestTimeoutMs: number;
  restartBudget: LlamaCppRestartBudget;
}

export interface LlamaCppLaunchConfig {
  modelsRootPath?: string;
  modelPath?: string;
  alias: string;
  ctxSize?: number;
  threads?: number;
  gpuLayers?: number;
  parallel?: number;
  batchSize?: number;
  ubatchSize?: number;
  flashAttention?: boolean;
}

export interface LlamaCppConfig {
  enabled: boolean;
  autoStart: boolean;
  server: LlamaCppServerConfig;
  launch: LlamaCppLaunchConfig;
}

export interface LlamaCppModelManifest {
  modelId: string;
  object?: string;
  created?: number;
  ownedBy?: string;
  filePath?: string;
  relativePath?: string;
  source?: "runtime" | "filesystem";
}

export interface LlamaCppModelsResponse {
  items: LlamaCppModelManifest[];
  degraded?: boolean;
  warning?: string;
}

export interface LlamaCppRuntimeStatus {
  enabled: boolean;
  desiredState: "stopped" | "running";
  processState: "stopped" | "starting" | "running" | "error";
  baseUrl: string;
  pid?: number;
  healthy: boolean;
  activeModelId?: string;
  command?: string;
  commandSource?: "explicit" | "path" | "path-with-exe" | "missing";
  modelPath?: string;
  lastError?: string;
  updatedAt: string;
  launchCommandPreview?: string;
}

export interface LlamaCppGpuInfo {
  vendor: "nvidia" | "amd" | "apple" | "intel" | "unknown";
  name: string;
  driver?: string;
  vramBytes?: number;
  source: string;
  confidence: "high" | "medium" | "low";
}

export interface LlamaCppHardwareProfile {
  platform: string;
  arch: string;
  cpuModel?: string;
  cpuCoresPhysical?: number;
  cpuCoresLogical: number;
  systemRamBytes: number;
  systemRamFreeBytes: number;
  gpus: LlamaCppGpuInfo[];
  notes: string[];
}

export interface LlamaCppAdvisorRequest {
  modelPath?: string;
  modelId?: string;
}

export interface LlamaCppAdvisorRecommendation {
  profile: LlamaCppHardwareProfile;
  recommended: {
    ctxSize?: number;
    threads?: number;
    gpuLayers?: number;
    parallel?: number;
    batchSize?: number;
    ubatchSize?: number;
    flashAttention?: boolean;
  };
  observedModelBytes?: number;
  warnings: string[];
}
