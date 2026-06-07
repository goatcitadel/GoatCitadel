import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { arch, cpus, freemem, homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  LocalAiBackendKind,
  LocalAiDownloadJob,
  LocalAiDownloadRequest,
  LocalAiEndpointRegistration,
  LocalAiEndpointRegistrationRequest,
  LocalAiFitRecommendation,
  LocalAiHardwareSnapshot,
  LocalAiModelCatalogItem,
  LocalAiPlatformSupport,
  LocalAiReadinessResponse,
  LocalAiServeJob,
  LocalAiServeRequest,
} from "@goatcitadel/contracts";

const execFileAsync = promisify(execFile);
const GIB = 1024 * 1024 * 1024;

const SERVER_BACKENDS = new Set<LocalAiBackendKind>(["vllm", "sglang"]);

export const LOCAL_AI_BUILTIN_CATALOG: LocalAiModelCatalogItem[] = [
  {
    modelId: "llama3.2:3b-instruct-q4_K_M",
    label: "Llama 3.2 3B Instruct Q4",
    family: "llama",
    parameterCountBillions: 3.2,
    quantization: "Q4_K_M",
    downloadBytes: gib(2.4),
    contextTokens: 8192,
    preferredBackends: ["ollama", "llama_cpp"],
    tags: ["starter", "chat", "cpu-friendly"],
    source: "builtin",
  },
  {
    modelId: "qwen2.5-coder:7b-instruct-q4_K_M",
    label: "Qwen2.5 Coder 7B Instruct Q4",
    family: "qwen-coder",
    parameterCountBillions: 7.6,
    quantization: "Q4_K_M",
    downloadBytes: gib(5.2),
    contextTokens: 32768,
    preferredBackends: ["ollama", "llama_cpp"],
    tags: ["coding", "tool-use", "balanced"],
    source: "builtin",
  },
  {
    modelId: "mistral-nemo:12b-instruct-q4_K_M",
    label: "Mistral Nemo 12B Instruct Q4",
    family: "mistral",
    parameterCountBillions: 12.2,
    quantization: "Q4_K_M",
    downloadBytes: gib(8),
    contextTokens: 128000,
    preferredBackends: ["ollama", "llama_cpp", "vllm"],
    tags: ["reasoning", "long-context"],
    source: "builtin",
  },
  {
    modelId: "llama3.1:8b-instruct-fp16",
    label: "Llama 3.1 8B Instruct FP16",
    family: "llama",
    parameterCountBillions: 8,
    quantization: "FP16",
    downloadBytes: gib(16),
    contextTokens: 131072,
    preferredBackends: ["vllm", "sglang", "ollama"],
    tags: ["gpu", "server", "long-context"],
    source: "builtin",
  },
  {
    modelId: "mixtral:8x7b-instruct-q4_K_M",
    label: "Mixtral 8x7B Instruct Q4",
    family: "mixtral",
    parameterCountBillions: 46.7,
    quantization: "Q4_K_M",
    downloadBytes: gib(26),
    contextTokens: 32768,
    preferredBackends: ["vllm", "sglang", "ollama"],
    tags: ["large", "router", "gpu-preferred"],
    source: "builtin",
  },
];

export interface LocalAiRuntimeProbe {
  findCommand(command: string): Promise<string | undefined>;
  readVersion(commandPath: string, args: string[]): Promise<string | undefined>;
}

export interface LocalAiHardwareSnapshotOptions {
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
  modelsRootPath?: string;
  probe?: LocalAiRuntimeProbe;
}

export interface LocalAiRouteServiceOptions {
  catalog?: LocalAiModelCatalogItem[];
  clock?: () => Date;
  createApproval?: (input: ApprovalCreateInput) => Promise<ApprovalRequest>;
  hardwareSnapshot?: () => Promise<LocalAiHardwareSnapshot>;
  idFactory?: () => string;
}

export interface LocalAiRouteService {
  getReadiness(): Promise<LocalAiReadinessResponse>;
  registerEndpoint(input: LocalAiEndpointRegistrationRequest): LocalAiEndpointRegistration;
  requestServeStop(jobId: string): Promise<LocalAiServeJob>;
  startDownload(input: LocalAiDownloadRequest): Promise<LocalAiDownloadJob>;
  startServe(input: LocalAiServeRequest): Promise<LocalAiServeJob>;
}

interface RuntimeProfile {
  backend: Exclude<LocalAiBackendKind, "openai_compatible">;
  commands: string[];
  defaultBaseUrl: string;
  envBaseUrl?: string;
  versionArgs: string[];
}

const RUNTIME_PROFILES: RuntimeProfile[] = [
  {
    backend: "ollama",
    commands: ["ollama"],
    defaultBaseUrl: "http://127.0.0.1:11434",
    envBaseUrl: "OLLAMA_HOST",
    versionArgs: ["--version"],
  },
  {
    backend: "llama_cpp",
    commands: ["llama-server", "llama-cli", "llama.cpp"],
    defaultBaseUrl: "http://127.0.0.1:8080",
    versionArgs: ["--version"],
  },
  {
    backend: "vllm",
    commands: ["vllm"],
    defaultBaseUrl: "http://127.0.0.1:8000",
    versionArgs: ["--version"],
  },
  {
    backend: "sglang",
    commands: ["sglang"],
    defaultBaseUrl: "http://127.0.0.1:30000",
    versionArgs: ["--version"],
  },
];

export function createDefaultLocalAiRuntimeProbe(): LocalAiRuntimeProbe {
  return {
    async findCommand(command) {
      const lookupCommand = platform() === "win32" ? "where.exe" : "which";
      try {
        const result = await execFileAsync(lookupCommand, [command], { timeout: 1_000, windowsHide: true });
        return firstOutputLine(result.stdout);
      } catch {
        return undefined;
      }
    },
    async readVersion(commandPath, args) {
      try {
        const result = await execFileAsync(commandPath, args, { timeout: 1_500, windowsHide: true });
        return firstOutputLine(result.stdout) ?? firstOutputLine(result.stderr);
      } catch {
        return undefined;
      }
    },
  };
}

export async function createLocalAiHardwareSnapshot(
  options: LocalAiHardwareSnapshotOptions = {},
): Promise<LocalAiHardwareSnapshot> {
  const processors = cpus();
  const firstProcessor = processors[0];
  const clock = options.clock ?? (() => new Date());

  return {
    checkedAt: clock().toISOString(),
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
    },
    cpu: {
      model: firstProcessor?.model,
      logicalCores: processors.length,
    },
    memory: {
      totalBytes: totalmem(),
      freeBytes: freemem(),
    },
    gpu: [],
    disk: {
      modelsRootPath: options.modelsRootPath ?? join(homedir(), ".goatcitadel", "local-ai", "models"),
    },
    runtimes: await detectLocalAiRuntimes({
      env: options.env,
      probe: options.probe,
    }),
  };
}

export async function detectLocalAiRuntimes(
  options: Pick<LocalAiHardwareSnapshotOptions, "env" | "probe"> = {},
): Promise<LocalAiHardwareSnapshot["runtimes"]> {
  const env = options.env ?? process.env;
  const probe = options.probe ?? createDefaultLocalAiRuntimeProbe();

  return Promise.all(
    RUNTIME_PROFILES.map(async (profile) => {
      const commandPath = await findFirstCommand(profile.commands, probe);
      const version = commandPath ? await probe.readVersion(commandPath, profile.versionArgs) : undefined;
      const platformSupport = platformSupportForBackend(profile.backend, platform());
      const notes = buildRuntimeNotes(profile, commandPath, platformSupport);

      return {
        backend: profile.backend,
        detected: Boolean(commandPath),
        version,
        command: commandPath,
        baseUrl: resolveRuntimeBaseUrl(profile, env),
        platformSupport,
        notes,
      };
    }),
  );
}

export function buildLocalAiFitRecommendations(
  hardware: LocalAiHardwareSnapshot,
  catalog: LocalAiModelCatalogItem[] = LOCAL_AI_BUILTIN_CATALOG,
): LocalAiFitRecommendation[] {
  const runtimeByBackend = new Map(hardware.runtimes.map((runtime) => [runtime.backend, runtime]));
  const recommendations: LocalAiFitRecommendation[] = [];

  for (const item of catalog) {
    for (const backend of item.preferredBackends) {
      recommendations.push(scoreCatalogItemForBackend(item, backend, hardware, runtimeByBackend.get(backend)));
    }
  }

  return recommendations.sort((left, right) => {
    const fitDelta = fitRank(right.fit) - fitRank(left.fit);
    if (fitDelta !== 0) {
      return fitDelta;
    }
    return left.modelId.localeCompare(right.modelId) || left.backend.localeCompare(right.backend);
  });
}

export function createLocalAiRouteService(options: LocalAiRouteServiceOptions = {}): LocalAiRouteService {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const catalog = cloneCatalog(options.catalog ?? LOCAL_AI_BUILTIN_CATALOG);
  const hardwareSnapshot =
    options.hardwareSnapshot ??
    (() =>
      createLocalAiHardwareSnapshot({
        clock,
      }));
  const downloads = new Map<string, LocalAiDownloadJob>();
  const serveJobs = new Map<string, LocalAiServeJob>();
  const endpoints = new Map<string, LocalAiEndpointRegistration>();

  const service: LocalAiRouteService = {
    async getReadiness() {
      const hardware = await hardwareSnapshot();
      return {
        hardware,
        catalog: cloneCatalog(catalog),
        recommendations: buildLocalAiFitRecommendations(hardware, catalog),
        downloads: Array.from(downloads.values()).map(cloneDownloadJob),
        serveJobs: Array.from(serveJobs.values()).map(cloneServeJob),
        endpoints: Array.from(endpoints.values()).map(cloneEndpoint),
      };
    },

    registerEndpoint(input) {
      const now = clock().toISOString();
      const id = idFactory();
      const endpoint: LocalAiEndpointRegistration = {
        endpointId: `local-ai-endpoint-${id}`,
        providerId: normalizeProviderId(input.providerId, input.backend, input.model),
        label: input.label.trim(),
        backend: input.backend,
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        smokeStatus: "pending",
        evidenceRef: `local-ai:endpoint:${id}:smoke-pending-no-network-probe`,
        createdAt: now,
        updatedAt: now,
      };
      endpoints.set(endpoint.endpointId, endpoint);
      return cloneEndpoint(endpoint);
    },

    async requestServeStop(jobId) {
      const existing = serveJobs.get(jobId);
      if (!existing) {
        throw new Error(`Local AI serve job ${jobId} was not found.`);
      }
      const approvalSeed = idFactory();
      const fallbackApprovalId = createApprovalId("serve-stop", approvalSeed, "request");
      const approvalId = await createLocalAiApproval(options.createApproval, fallbackApprovalId, {
        kind: "local_ai.serve_stop",
        riskLevel: "caution",
        payload: {
          action: "serve_stop",
          jobId,
          modelId: existing.modelId,
          backend: existing.backend,
        },
        preview: {
          title: "Stop local AI serve job",
          jobId,
          modelId: existing.modelId,
          backend: existing.backend,
          execution: "Approval records operator intent; no process is stopped by this route.",
        },
        linkage: {
          actionType: "local_ai.serve_stop",
        },
      });
      const updated: LocalAiServeJob = {
        ...existing,
        status: "requires_approval",
        approvalId,
        health: "unknown",
        updatedAt: clock().toISOString(),
      };
      serveJobs.set(jobId, updated);
      return cloneServeJob(updated);
    },

    async startDownload(input) {
      assertCatalogBackend(catalog, input.modelId, input.backend);
      const now = clock().toISOString();
      const id = idFactory();
      const fallbackApprovalId = createApprovalId("download", id, input.approvalMode ?? "request");
      const approvalId = await createLocalAiApproval(options.createApproval, fallbackApprovalId, {
        kind: "local_ai.download",
        riskLevel: "caution",
        payload: {
          action: "download",
          jobId: `local-ai-download-${id}`,
          modelId: input.modelId,
          backend: input.backend,
          approvalMode: input.approvalMode ?? "request",
        },
        preview: {
          title: "Download local AI model",
          modelId: input.modelId,
          backend: input.backend,
          execution: "Approval records operator intent; no model download is started by this route.",
        },
        linkage: {
          actionType: "local_ai.download",
        },
      });
      const job: LocalAiDownloadJob = {
        jobId: `local-ai-download-${id}`,
        modelId: input.modelId,
        backend: input.backend,
        status: "requires_approval",
        approvalId,
        progressPercent: 0,
        createdAt: now,
        updatedAt: now,
      };
      downloads.set(job.jobId, job);
      return cloneDownloadJob(job);
    },

    async startServe(input) {
      assertCatalogBackend(catalog, input.modelId, input.backend);
      const now = clock().toISOString();
      const id = idFactory();
      const fallbackApprovalId = createApprovalId("serve", id, input.approvalMode ?? "request");
      const approvalId = await createLocalAiApproval(options.createApproval, fallbackApprovalId, {
        kind: "local_ai.serve",
        riskLevel: "danger",
        payload: {
          action: "serve",
          jobId: `local-ai-serve-${id}`,
          modelId: input.modelId,
          backend: input.backend,
          approvalMode: input.approvalMode ?? "request",
          port: input.port,
        },
        preview: {
          title: "Serve local AI model",
          modelId: input.modelId,
          backend: input.backend,
          port: input.port,
          execution: "Approval records operator intent; no server process or network binding is started by this route.",
        },
        linkage: {
          actionType: "local_ai.serve",
        },
      });
      const job: LocalAiServeJob = {
        jobId: `local-ai-serve-${id}`,
        modelId: input.modelId,
        backend: input.backend,
        status: "requires_approval",
        approvalId,
        endpointUrl: input.port ? `http://127.0.0.1:${input.port}` : undefined,
        health: "unknown",
        createdAt: now,
        updatedAt: now,
      };
      serveJobs.set(job.jobId, job);
      return cloneServeJob(job);
    },
  };

  return Object.freeze(service);
}

async function createLocalAiApproval(
  createApproval: LocalAiRouteServiceOptions["createApproval"],
  fallbackApprovalId: string,
  input: ApprovalCreateInput,
): Promise<string> {
  if (!createApproval) {
    return fallbackApprovalId;
  }
  const approval = await createApproval(input);
  return approval.approvalId;
}

function scoreCatalogItemForBackend(
  item: LocalAiModelCatalogItem,
  backend: LocalAiBackendKind,
  hardware: LocalAiHardwareSnapshot,
  runtime: LocalAiHardwareSnapshot["runtimes"][number] | undefined,
): LocalAiFitRecommendation {
  const estimatedMemoryBytes = estimateMemoryBytes(item, backend);
  const estimatedDiskBytes = item.downloadBytes ?? estimatedMemoryBytes;
  const platformSupport = runtime?.platformSupport ?? platformSupportForBackend(backend, String(hardware.os.platform));
  const limitations: string[] = [];
  const reasons: string[] = [];
  let fit: LocalAiFitRecommendation["fit"] = "borderline";

  if (platformSupport === "unsupported") {
    fit = "not_recommended";
    limitations.push(`${backend} is not a supported native backend on ${hardware.os.platform}.`);
  } else if (hardware.memory.totalBytes <= 0 || estimatedMemoryBytes <= 0) {
    limitations.push("Memory fit is approximate because the hardware or model estimate is incomplete.");
  } else {
    const ratio = hardware.memory.totalBytes / estimatedMemoryBytes;
    if (ratio >= 2.5 && hardware.cpu.logicalCores >= 8) {
      fit = "excellent";
    } else if (ratio >= 1.5 && hardware.cpu.logicalCores >= 4) {
      fit = "good";
    } else if (ratio >= 1.1) {
      fit = "borderline";
    } else {
      fit = "not_recommended";
      limitations.push(
        `Estimated runtime memory ${formatGiB(estimatedMemoryBytes)} exceeds the conservative system-memory budget.`,
      );
    }
    reasons.push(
      `${formatGiB(hardware.memory.totalBytes)} system memory vs ${formatGiB(estimatedMemoryBytes)} estimated runtime memory.`,
    );
  }

  if (runtime?.detected) {
    reasons.push(`Detected ${backend} command on PATH.`);
  } else {
    limitations.push(`${backend} command was not detected on PATH; v1 did not install or start it.`);
  }

  if (platformSupport === "wsl") {
    limitations.push(`${backend} is treated as WSL-only on Windows until native proof is added.`);
  }

  if (SERVER_BACKENDS.has(backend) && hardware.gpu.length === 0 && fit !== "not_recommended") {
    fit = "borderline";
    limitations.push("GPU inventory is unavailable from Node os APIs; server backend fit is advisory only.");
  }

  return {
    modelId: item.modelId,
    backend,
    fit,
    confidence: confidenceFor(runtime, backend, platformSupport, hardware.gpu.length),
    reasons,
    limitations,
    estimatedMemoryBytes,
    estimatedDiskBytes,
  };
}

function assertCatalogBackend(
  catalog: LocalAiModelCatalogItem[],
  modelId: string,
  backend: LocalAiBackendKind,
): LocalAiModelCatalogItem {
  const item = catalog.find((candidate) => candidate.modelId === modelId);
  if (!item) {
    throw new Error(`Unknown local AI catalog model: ${modelId}`);
  }
  if (!item.preferredBackends.includes(backend)) {
    throw new Error(`Backend ${backend} is not available for ${modelId} in the v1 local AI catalog.`);
  }
  return item;
}

function buildRuntimeNotes(
  profile: RuntimeProfile,
  commandPath: string | undefined,
  platformSupport: LocalAiPlatformSupport,
): string[] {
  const notes = ["No install, model download, or server launch was attempted."];
  if (commandPath) {
    notes.push(`Detected ${profile.backend} command on PATH.`);
  } else {
    notes.push(`No ${profile.commands.join(" or ")} command was found on PATH.`);
  }
  if (platformSupport === "wsl") {
    notes.push("Windows support is recorded as WSL-oriented for this backend in v1.");
  }
  if (platformSupport === "unsupported") {
    notes.push("This backend is advisory only on the current platform.");
  }
  return notes;
}

function cloneCatalog(items: LocalAiModelCatalogItem[]): LocalAiModelCatalogItem[] {
  return items.map((item) => ({
    ...item,
    preferredBackends: [...item.preferredBackends],
    tags: [...item.tags],
  }));
}

function cloneDownloadJob(job: LocalAiDownloadJob): LocalAiDownloadJob {
  return { ...job };
}

function cloneEndpoint(endpoint: LocalAiEndpointRegistration): LocalAiEndpointRegistration {
  return { ...endpoint };
}

function cloneServeJob(job: LocalAiServeJob): LocalAiServeJob {
  return { ...job };
}

function confidenceFor(
  runtime: LocalAiHardwareSnapshot["runtimes"][number] | undefined,
  backend: LocalAiBackendKind,
  platformSupport: LocalAiPlatformSupport,
  gpuCount: number,
): LocalAiFitRecommendation["confidence"] {
  if (platformSupport === "unsupported") {
    return "high";
  }
  if (SERVER_BACKENDS.has(backend) && gpuCount === 0) {
    return "low";
  }
  return runtime?.detected ? "high" : "medium";
}

async function findFirstCommand(commands: string[], probe: LocalAiRuntimeProbe): Promise<string | undefined> {
  for (const command of commands) {
    const commandPath = await probe.findCommand(command);
    if (commandPath) {
      return commandPath;
    }
  }
  return undefined;
}

function estimateMemoryBytes(item: LocalAiModelCatalogItem, backend: LocalAiBackendKind): number {
  const downloadEstimate = item.downloadBytes ? item.downloadBytes * (SERVER_BACKENDS.has(backend) ? 1.35 : 1.2) : 0;
  const parameterEstimate = item.parameterCountBillions
    ? item.parameterCountBillions * GIB * bytesPerParameter(item.quantization)
    : 0;
  return Math.ceil(Math.max(downloadEstimate, parameterEstimate));
}

function bytesPerParameter(quantization: string | undefined): number {
  const normalized = quantization?.toLowerCase() ?? "";
  if (normalized.includes("fp16")) {
    return 2.2;
  }
  if (normalized.includes("q8")) {
    return 1.1;
  }
  if (normalized.includes("q5")) {
    return 0.75;
  }
  if (normalized.includes("q4")) {
    return 0.65;
  }
  return 1.25;
}

function firstOutputLine(value: unknown): string | undefined {
  const output = String(value ?? "");
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line;
}

function fitRank(fit: LocalAiFitRecommendation["fit"]): number {
  switch (fit) {
    case "excellent":
      return 3;
    case "good":
      return 2;
    case "borderline":
      return 1;
    case "not_recommended":
      return 0;
  }
}

function formatGiB(bytes: number): string {
  const value = bytes / GIB;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} GiB`;
}

function gib(value: number): number {
  return Math.round(value * GIB);
}

function normalizeProviderId(providerId: string | undefined, backend: LocalAiBackendKind, model: string): string {
  const trimmed = providerId?.trim();
  if (trimmed) {
    return trimmed;
  }
  return `local-ai-${backend}-${model
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .toLowerCase()}`;
}

function platformSupportForBackend(backend: LocalAiBackendKind, osPlatform: string): LocalAiPlatformSupport {
  if (backend === "openai_compatible") {
    return "remote";
  }
  if (backend === "vllm" || backend === "sglang") {
    if (osPlatform === "linux") {
      return "native";
    }
    if (osPlatform === "win32") {
      return "wsl";
    }
    return "unsupported";
  }
  if (osPlatform === "linux" || osPlatform === "win32" || osPlatform === "darwin") {
    return "native";
  }
  return "unsupported";
}

function resolveRuntimeBaseUrl(profile: RuntimeProfile, env: NodeJS.ProcessEnv): string {
  const rawValue = profile.envBaseUrl ? env[profile.envBaseUrl]?.trim() : undefined;
  if (!rawValue) {
    return profile.defaultBaseUrl;
  }
  if (/^https?:\/\//i.test(rawValue)) {
    return rawValue;
  }
  return `http://${rawValue}`;
}

function createApprovalId(action: string, seed: string, mode: "dry_run" | "request"): string {
  const prefix = mode === "dry_run" ? "local-ai-dry-run" : "local-ai-approval";
  return `${prefix}-${action}-${seed}`;
}
