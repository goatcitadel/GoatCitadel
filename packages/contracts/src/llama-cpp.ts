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

export interface LlamaCppRuntimeLeaseRequest {
  /** Stable diagnostic label such as `chat_completion` or `embedding`. */
  purpose: string;
}

export interface LlamaCppRuntimeLease {
  leaseId: string;
  purpose: string;
  acquiredAt: string;
}

export type LlamaCppRuntimeOwnership = "none" | "owned" | "external";

export type LlamaCppRuntimeLeaseState = "idle" | "starting" | "active" | "idle_pending" | "persistent" | "closed";

export interface LlamaCppRuntimeLeasePurposeSummary {
  purpose: string;
  count: number;
}

export interface LlamaCppRuntimeLeaseEvidence {
  lastLease?: {
    at: string;
    action: "acquired" | "released" | "settled";
    purpose: string;
  };
  lastStart?: {
    at: string;
    reason: "manual" | "api" | "autostart" | "lease" | "restart" | "other";
    outcome: "requested" | "ready" | "failed";
  };
  lastProbe?: {
    at: string;
    healthy: boolean;
  };
  lastExit?: {
    at: string;
    unexpected: boolean;
    code?: number;
    signal?: string;
  };
  lastRestart?: {
    at: string;
    outcome: "scheduled" | "attempting" | "ready" | "failed" | "exhausted";
  };
}

export interface LlamaCppRuntimeLeaseDiagnostics {
  state: LlamaCppRuntimeLeaseState;
  activeLeaseCount: number;
  ownership: LlamaCppRuntimeOwnership;
  idleDeadline?: string;
  purposes: LlamaCppRuntimeLeasePurposeSummary[];
  persistentDemand: {
    manual: boolean;
    api: boolean;
    autostart: boolean;
  };
  evidence: LlamaCppRuntimeLeaseEvidence;
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
  /** Additive service-lifetime diagnostics; absent on older Gateway versions. */
  leaseDiagnostics?: LlamaCppRuntimeLeaseDiagnostics;
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
