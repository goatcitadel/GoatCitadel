export interface NpuCapabilityReport {
  platform: string;
  arch: string;
  isWindowsArm64: boolean;
  pythonVersion?: string;
  onnxRuntimeAvailable: boolean;
  onnxRuntimeGenAiAvailable: boolean;
  qnnExecutionProviderAvailable: boolean;
  supported: boolean;
  localInferenceReady?: boolean;
  streamingChatCompletions?: boolean;
  fallbackProxyConfigured?: boolean;
  details: string[];
}

export interface NpuModelManifest {
  modelId: string;
  label: string;
  family: "llama" | "phi" | "qwen" | "mistral" | "gemma" | "other";
  source: "local" | "huggingface" | "custom";
  path?: string;
  sha256?: string;
  readiness?: "ready" | "missing_path" | "hash_mismatch" | "unchecked";
  backend?: "qnn" | "cpu" | "unknown";
  fallbackReason?: string;
  default: boolean;
  requiresQnn: boolean;
  contextWindow?: number;
  enabled: boolean;
}

export interface NpuRuntimeStatus {
  enabled: boolean;
  desiredState: "stopped" | "running";
  processState: "stopped" | "starting" | "running" | "error";
  sidecarUrl: string;
  sidecarPid?: number;
  healthy: boolean;
  activeModelId?: string;
  backend: "qnn" | "cpu" | "unknown";
  capability: NpuCapabilityReport;
  lastError?: string;
  updatedAt: string;
}

export interface NpuSidecarConfig {
  enabled: boolean;
  autoStart: boolean;
  sidecarUrl: string;
  command: string;
  args: string[];
  healthPath: string;
  modelsPath: string;
  startTimeoutMs: number;
  requestTimeoutMs: number;
  restartBudget: {
    windowMs: number;
    maxRestarts: number;
    backoffMs: number;
  };
}
