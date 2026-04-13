import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import type {
  LlamaCppAdvisorRecommendation,
  LlamaCppAdvisorRequest,
  LlamaCppConfig as ContractLlamaCppConfig,
  LlamaCppGpuInfo,
  LlamaCppHardwareProfile,
  LlamaCppModelManifest,
  LlamaCppRuntimeStatus,
} from "@goatcitadel/contracts";
import type { LlamaCppConfig } from "../config.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LLAMACPP_ALIAS = "gemma-4-local";
const DEFAULT_LLAMACPP_REASONING_ARGS = ["--reasoning", "off"] as const;

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

export interface LlamaCppHuggingFaceDownloadJobStatus {
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

export interface LlamaCppRuntimeServiceOptions {
  rootDir: string;
  config: LlamaCppConfig;
  onEvent?: (eventType: string, payload: Record<string, unknown>) => void;
}

interface CommandResolution {
  command?: string;
  source: NonNullable<LlamaCppRuntimeStatus["commandSource"]>;
}

export class LlamaCppRuntimeService {
  private process: ChildProcess | null = null;
  private desiredState: "stopped" | "running" = "stopped";
  private processState: "stopped" | "starting" | "running" | "error" = "stopped";
  private healthy = false;
  private activeModelId?: string;
  private lastError?: string;
  private updatedAt = new Date().toISOString();
  private closed = false;
  private restartTimestamps: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  private lastCommand?: string;
  private lastCommandSource: LlamaCppRuntimeStatus["commandSource"] = "missing";
  private hfDownloadJobs = new Map<string, LlamaCppHuggingFaceDownloadJobStatus>();
  private hfDownloadControllers = new Map<string, AbortController>();

  private readonly stateCachePath: string;

  public constructor(private options: LlamaCppRuntimeServiceOptions) {
    this.stateCachePath = path.resolve(options.rootDir, "data", "llamacpp-runtime-state.json");
  }

  public async init(): Promise<void> {
    await this.loadCachedState();
    if (this.options.config.enabled && this.options.config.autoStart) {
      await this.start("auto_start");
      return;
    }
    await this.refresh();
  }

  public updateConfig(config: LlamaCppConfig): void {
    this.options = {
      ...this.options,
      config,
    };
  }

  public getStatus(): LlamaCppRuntimeStatus {
    const commandPreview = buildLaunchCommandPreview({
      config: this.options.config,
      rootDir: this.options.rootDir,
      command: this.lastCommand,
    });
    return {
      enabled: this.options.config.enabled,
      desiredState: this.desiredState,
      processState: this.processState,
      baseUrl: normalizeLlamaCppProviderBaseUrl(this.options.config.server.baseUrl),
      pid: this.process?.pid,
      healthy: this.healthy,
      activeModelId: this.activeModelId ?? normalizeOptionalText(this.options.config.launch.alias),
      command: this.lastCommand,
      commandSource: this.lastCommandSource,
      modelPath: resolveConfiguredPath(this.options.rootDir, this.options.config.launch.modelPath),
      lastError: this.lastError,
      updatedAt: this.updatedAt,
      launchCommandPreview: commandPreview,
    };
  }

  public async start(reason = "manual"): Promise<LlamaCppRuntimeStatus> {
    this.desiredState = "running";
    this.closed = false;

    if (!this.options.config.enabled) {
      throw new Error("llama.cpp runtime is disabled in assistant config");
    }

    const modelPath = resolveConfiguredPath(this.options.rootDir, this.options.config.launch.modelPath);
    if (!modelPath) {
      throw new Error("llama.cpp launch.modelPath must be configured before starting the runtime");
    }
    if (!fsSync.existsSync(modelPath)) {
      throw new Error(`llama.cpp model path does not exist: ${modelPath}`);
    }

    if (this.process?.pid && this.processState === "running") {
      await this.refresh();
      return this.getStatus();
    }

    const observed = await this.readRemoteHealth().catch(() => undefined);
    if (observed?.healthy) {
      this.processState = "running";
      this.healthy = true;
      this.activeModelId = observed.activeModelId ?? this.options.config.launch.alias;
      this.lastError = undefined;
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      return this.getStatus();
    }

    const commandResolution = await resolveLlamaCppCommand(this.options.config.server.command);
    this.lastCommand = commandResolution.command;
    this.lastCommandSource = commandResolution.source;
    if (!commandResolution.command) {
      throw new Error(
        "Unable to find llama-server. Set assistant.llamaCpp.server.command or add llama-server to PATH.",
      );
    }

    this.assertRestartBudget();
    this.bumpRestartCounter();

    this.processState = "starting";
    this.healthy = false;
    this.lastError = undefined;
    this.updatedAt = new Date().toISOString();
    this.emit("llamacpp_starting", { reason, command: commandResolution.command });
    await this.persistState();

    const child = spawn(commandResolution.command, buildLlamaCppLaunchArgs(this.options.rootDir, this.options.config), {
      cwd: this.options.rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    child.stdout?.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.emit("llamacpp_stdout", { message });
      }
    });
    child.stderr?.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.lastError = message.slice(0, 500);
        this.emit("llamacpp_stderr", { message });
      }
    });
    child.on("error", (error) => {
      this.lastError = error.message;
      this.emit("llamacpp_spawn_error", { message: error.message });
    });
    child.on("exit", (code, signal) => {
      this.process = null;
      const unexpected = !this.closed && this.desiredState === "running";
      this.processState = unexpected ? "error" : "stopped";
      this.healthy = false;
      this.updatedAt = new Date().toISOString();
      if (unexpected) {
        this.lastError = `llama.cpp server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.emit("llamacpp_exited", {
          unexpected: true,
          code,
          signal,
          message: this.lastError,
        });
        void this.persistState();
        this.scheduleRestart();
      } else {
        this.emit("llamacpp_exited", { unexpected: false, code, signal });
        void this.persistState();
      }
    });

    const healthy = await this.waitForHealthy(this.options.config.server.startTimeoutMs);
    if (!healthy) {
      this.processState = "error";
      this.healthy = false;
      this.lastError = "llama.cpp server did not become healthy within timeout";
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      await this.stop("startup_timeout");
      throw new Error(this.lastError);
    }

    this.processState = "running";
    this.healthy = true;
    this.updatedAt = new Date().toISOString();
    await this.persistState();
    this.emit("llamacpp_started", {
      pid: this.process?.pid,
      baseUrl: normalizeLlamaCppProviderBaseUrl(this.options.config.server.baseUrl),
    });
    return this.getStatus();
  }

  public async stop(reason = "manual"): Promise<LlamaCppRuntimeStatus> {
    this.desiredState = "stopped";
    this.closed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    const running = this.process;
    if (!running?.pid) {
      const health = await this.readRemoteHealth().catch(() => undefined);
      this.processState = health?.healthy ? "running" : "stopped";
      this.healthy = health?.healthy ?? false;
      this.activeModelId = health?.activeModelId ?? this.activeModelId;
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      return this.getStatus();
    }

    this.emit("llamacpp_stopping", { reason, pid: running.pid });
    if (process.platform === "win32") {
      await killWindowsProcessTree(running.pid);
    } else {
      try {
        process.kill(running.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }

    this.process = null;
    this.processState = "stopped";
    this.healthy = false;
    this.updatedAt = new Date().toISOString();
    await this.persistState();
    return this.getStatus();
  }

  public async refresh(): Promise<LlamaCppRuntimeStatus> {
    const health = await this.readRemoteHealth().catch(() => undefined);
    if (!health?.healthy) {
      if (!this.process?.pid && this.desiredState === "stopped") {
        this.processState = "stopped";
      } else if (this.process?.pid) {
        this.processState = "error";
      }
      this.healthy = false;
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      return this.getStatus();
    }

    this.healthy = true;
    this.processState = "running";
    this.activeModelId = health.activeModelId ?? this.options.config.launch.alias;
    this.lastError = undefined;
    this.updatedAt = new Date().toISOString();
    await this.persistState();
    return this.getStatus();
  }

  public async listModels(): Promise<LlamaCppModelManifest[]> {
    const url = joinUrl(
      normalizeLlamaCppServerRoot(this.options.config.server.baseUrl),
      this.options.config.server.modelsPath,
    );
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(this.options.config.server.requestTimeoutMs),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`llama.cpp model listing failed (${response.status})`);
    }
    const payload = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
      models?: Array<Record<string, unknown>>;
    };
    const items = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    return items
      .map((item) => ({
        modelId: String(item.id ?? item.model ?? ""),
        object: typeof item.object === "string" ? item.object : undefined,
        created: typeof item.created === "number" ? item.created : undefined,
        ownedBy:
          typeof item.owned_by === "string"
            ? item.owned_by
            : typeof item.ownedBy === "string"
              ? item.ownedBy
              : undefined,
      }))
      .filter((item) => item.modelId.length > 0);
  }

  public async detectLocalInstall(): Promise<LlamaCppInstallDetection> {
    const configured = normalizeOptionalText(this.options.config.server.command);
    if (configured) {
      const resolvedConfigured = await resolveExecutable(configured);
      if (resolvedConfigured) {
        return {
          found: true,
          command: resolvedConfigured,
          source: "configured",
          version: await inspectLlamaCppVersion(resolvedConfigured),
          recommendedBaseUrl: normalizeLlamaCppProviderBaseUrl(this.options.config.server.baseUrl),
        };
      }
    }

    if (process.platform === "win32") {
      const standardWindowsPath = "C:\\llama\\llama-server.exe";
      if (fsSync.existsSync(standardWindowsPath)) {
        return {
          found: true,
          command: standardWindowsPath,
          source: "standard-windows",
          version: await inspectLlamaCppVersion(standardWindowsPath),
          recommendedBaseUrl: normalizeLlamaCppProviderBaseUrl(this.options.config.server.baseUrl),
        };
      }
    }

    const resolved = await resolveLlamaCppCommand(this.options.config.server.command);
    if (resolved.command && resolved.source !== "missing") {
      return {
        found: true,
        command: resolved.command,
        source: resolved.source === "explicit" ? "configured" : resolved.source,
        version: await inspectLlamaCppVersion(resolved.command),
        recommendedBaseUrl: normalizeLlamaCppProviderBaseUrl(this.options.config.server.baseUrl),
      };
    }

    return {
      found: false,
      source: "missing",
      recommendedBaseUrl: normalizeLlamaCppProviderBaseUrl(this.options.config.server.baseUrl),
    };
  }

  public async startHuggingFaceDownload(
    input: LlamaCppHuggingFaceDownloadRequest,
  ): Promise<LlamaCppHuggingFaceDownloadJobStatus> {
    const running = [...this.hfDownloadJobs.values()].find((job) => job.status === "queued" || job.status === "running");
    if (running) {
      throw new Error(`A llama.cpp Hugging Face download is already in progress (${running.jobId}).`);
    }

    const repo = normalizeHuggingFaceRepo(input.repo);
    const filename = normalizeHuggingFacePath(input.filename);
    const mmprojFilenameInput = normalizeOptionalText(input.mmprojFilename);
    const mmprojFilename = mmprojFilenameInput ? normalizeHuggingFacePath(mmprojFilenameInput) : undefined;
    const alias =
      normalizeOptionalText(input.alias) ??
      normalizeOptionalText(this.options.config.launch.alias) ??
      DEFAULT_LLAMACPP_ALIAS;
    const expectedSha256 = normalizeSha256(input.sha256);
    const expectedMmprojSha256 = normalizeSha256(input.mmprojSha256);

    const sourceUrl = buildHuggingFaceResolveUrl(repo, filename);
    const mmprojSourceUrl = mmprojFilename ? buildHuggingFaceResolveUrl(repo, mmprojFilename) : undefined;
    const startedAt = new Date().toISOString();
    const jobId = randomUUID();
    const job: LlamaCppHuggingFaceDownloadJobStatus = {
      jobId,
      status: "queued",
      stage: "model",
      repo,
      alias,
      filename,
      mmprojFilename,
      sourceUrl,
      mmprojSourceUrl,
      expectedSha256,
      expectedMmprojSha256,
      bytesDownloaded: 0,
      startedAt,
      updatedAt: startedAt,
    };

    this.hfDownloadJobs.set(jobId, job);
    this.hfDownloadControllers.set(jobId, new AbortController());
    void this.runHuggingFaceDownload(jobId, input);
    return { ...job };
  }

  public getHuggingFaceDownloadStatus(jobId: string): LlamaCppHuggingFaceDownloadJobStatus {
    const job = this.hfDownloadJobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown llama.cpp download job: ${jobId}`);
    }
    return { ...job };
  }

  public cancelHuggingFaceDownload(jobId: string): LlamaCppHuggingFaceDownloadJobStatus {
    const job = this.hfDownloadJobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown llama.cpp download job: ${jobId}`);
    }
    if (job.status !== "queued" && job.status !== "running") {
      return { ...job };
    }
    this.hfDownloadControllers.get(jobId)?.abort();
    const cancelledAt = new Date().toISOString();
    this.updateHuggingFaceDownloadJob(jobId, {
      status: "cancelled",
      stage: "done",
      error: "Cancelled by user.",
      updatedAt: cancelledAt,
      completedAt: cancelledAt,
    });
    return { ...this.hfDownloadJobs.get(jobId)! };
  }

  private async runHuggingFaceDownload(jobId: string, input: LlamaCppHuggingFaceDownloadRequest): Promise<void> {
    const current = this.hfDownloadJobs.get(jobId);
    if (!current) {
      return;
    }

    try {
      const repo = normalizeHuggingFaceRepo(input.repo);
      const filename = normalizeHuggingFacePath(input.filename);
      const mmprojFilenameInput = normalizeOptionalText(input.mmprojFilename);
      const mmprojFilename = mmprojFilenameInput ? normalizeHuggingFacePath(mmprojFilenameInput) : undefined;
      const expectedSha256 = normalizeSha256(input.sha256);
      const expectedMmprojSha256 = normalizeSha256(input.mmprojSha256);
      const targetDir = path.resolve(this.options.rootDir, "models", "llamacpp", sanitizeHuggingFaceRepo(repo));
      const modelPath = path.join(targetDir, ...filename.split("/"));
      const sourceUrl = buildHuggingFaceResolveUrl(repo, filename);
      const controller = this.hfDownloadControllers.get(jobId);

      this.updateHuggingFaceDownloadJob(jobId, {
        status: "running",
        stage: "model",
        updatedAt: new Date().toISOString(),
      });

      const modelResult = await downloadUrlToFile({
        url: sourceUrl,
        destinationPath: modelPath,
        expectedSha256,
        signal: controller?.signal,
        onProgress: ({ bytesDownloaded, totalBytes }) => {
          this.updateHuggingFaceDownloadJob(jobId, {
            bytesDownloaded,
            totalBytes,
            updatedAt: new Date().toISOString(),
          });
        },
      });

      this.updateHuggingFaceDownloadJob(jobId, {
        modelPath,
        modelBytes: modelResult.sizeBytes,
        actualSha256: modelResult.sha256,
        bytesDownloaded: modelResult.sizeBytes,
        totalBytes: modelResult.sizeBytes,
        updatedAt: new Date().toISOString(),
      });

      if (mmprojFilename) {
        const mmprojPath = path.join(targetDir, ...mmprojFilename.split("/"));
        const mmprojSourceUrl = buildHuggingFaceResolveUrl(repo, mmprojFilename);
        this.updateHuggingFaceDownloadJob(jobId, {
          stage: "mmproj",
          mmprojPath,
          mmprojSourceUrl,
          mmprojBytesDownloaded: 0,
          updatedAt: new Date().toISOString(),
        });

        const mmprojResult = await downloadUrlToFile({
          url: mmprojSourceUrl,
          destinationPath: mmprojPath,
          expectedSha256: expectedMmprojSha256,
          signal: controller?.signal,
          onProgress: ({ bytesDownloaded, totalBytes }) => {
            this.updateHuggingFaceDownloadJob(jobId, {
              mmprojBytesDownloaded: bytesDownloaded,
              mmprojTotalBytes: totalBytes,
              updatedAt: new Date().toISOString(),
            });
          },
        });

        this.updateHuggingFaceDownloadJob(jobId, {
          mmprojPath,
          mmprojBytes: mmprojResult.sizeBytes,
          actualMmprojSha256: mmprojResult.sha256,
          mmprojBytesDownloaded: mmprojResult.sizeBytes,
          mmprojTotalBytes: mmprojResult.sizeBytes,
          updatedAt: new Date().toISOString(),
        });
      }

      const completedAt = new Date().toISOString();
      this.updateHuggingFaceDownloadJob(jobId, {
        status: "completed",
        stage: "done",
        updatedAt: completedAt,
        completedAt,
      });
    } catch (error) {
      const currentJob = this.hfDownloadJobs.get(jobId);
      if (currentJob?.status === "cancelled") {
        return;
      }
      const failedAt = new Date().toISOString();
      this.updateHuggingFaceDownloadJob(jobId, {
        status: "failed",
        error: (error as Error).message,
        updatedAt: failedAt,
        completedAt: failedAt,
      });
    } finally {
      this.hfDownloadControllers.delete(jobId);
    }
  }

  private updateHuggingFaceDownloadJob(
    jobId: string,
    patch: Partial<LlamaCppHuggingFaceDownloadJobStatus>,
  ): void {
    const current = this.hfDownloadJobs.get(jobId);
    if (!current) {
      return;
    }
    this.hfDownloadJobs.set(jobId, {
      ...current,
      ...patch,
    });
  }

  public async advise(input: LlamaCppAdvisorRequest = {}): Promise<LlamaCppAdvisorRecommendation> {
    return adviseLlamaCppRuntime({
      rootDir: this.options.rootDir,
      config: this.options.config,
      input,
    });
  }

  public async close(): Promise<void> {
    await this.stop("shutdown");
  }

  private async readRemoteHealth(): Promise<{ healthy: boolean; activeModelId?: string }> {
    const healthUrl = joinUrl(
      normalizeLlamaCppServerRoot(this.options.config.server.baseUrl),
      this.options.config.server.healthPath,
    );
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(this.options.config.server.requestTimeoutMs),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`llama.cpp health check failed (${response.status})`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    let activeModelId = normalizeOptionalText(this.options.config.launch.alias);
    if (contentType.includes("json")) {
      const payload = (await response.json()) as Record<string, unknown>;
      const modelAlias = typeof payload["model_alias"] === "string" ? payload["model_alias"] : undefined;
      const modelName = typeof payload["model"] === "string" ? payload["model"] : undefined;
      activeModelId = normalizeOptionalText(modelAlias) ?? normalizeOptionalText(modelName) ?? activeModelId;
    } else {
      await response.text();
    }

    try {
      const models = await this.listModels();
      activeModelId = models[0]?.modelId ?? activeModelId;
    } catch {
      // keep alias fallback
    }

    return {
      healthy: true,
      activeModelId,
    };
  }

  private async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.closed) {
        return false;
      }
      const status = await this.refresh().catch(() => undefined);
      if (status?.healthy) {
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  private async loadCachedState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateCachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LlamaCppRuntimeStatus>;
      this.processState = parsed.processState ?? this.processState;
      this.desiredState = parsed.desiredState ?? this.desiredState;
      this.healthy = parsed.healthy ?? false;
      this.activeModelId = parsed.activeModelId;
      this.lastError = parsed.lastError;
      this.updatedAt = parsed.updatedAt ?? this.updatedAt;
      this.lastCommand = parsed.command;
      this.lastCommandSource = parsed.commandSource ?? this.lastCommandSource;
    } catch {
      // ignore cache miss
    }
  }

  private async persistState(): Promise<void> {
    const payload = this.getStatus();
    await fs.mkdir(path.dirname(this.stateCachePath), { recursive: true });
    await fs.writeFile(this.stateCachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private emit(eventType: string, payload: Record<string, unknown>): void {
    this.options.onEvent?.(eventType, payload);
  }

  private assertRestartBudget(): void {
    const now = Date.now();
    const windowMs = this.options.config.server.restartBudget.windowMs;
    this.restartTimestamps = this.restartTimestamps.filter((timestamp) => now - timestamp <= windowMs);
    if (this.restartTimestamps.length >= this.options.config.server.restartBudget.maxRestarts) {
      throw new Error("llama.cpp restart budget exhausted");
    }
  }

  private bumpRestartCounter(): void {
    this.restartTimestamps.push(Date.now());
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.closed || this.desiredState !== "running") {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start("restart").catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.updatedAt = new Date().toISOString();
        void this.persistState();
      });
    }, this.options.config.server.restartBudget.backoffMs);
  }
}

export async function adviseLlamaCppRuntime(input: {
  rootDir: string;
  config: LlamaCppConfig | ContractLlamaCppConfig;
  input?: LlamaCppAdvisorRequest;
}): Promise<LlamaCppAdvisorRecommendation> {
  const profile = await probeLlamaCppHardware();
  const requestedModelPath = input.input?.modelPath ?? input.config.launch.modelPath;
  const modelPath = resolveConfiguredPath(input.rootDir, requestedModelPath);
  let observedModelBytes: number | undefined;

  if (modelPath) {
    try {
      const stats = await fs.stat(modelPath);
      observedModelBytes = stats.size;
    } catch {
      profile.notes = [...profile.notes, `Model path could not be read: ${modelPath}`];
    }
  }

  const { recommended, warnings } = recommendLlamaCppLaunchSettings({
    profile,
    observedModelBytes,
  });

  const recommendation: LlamaCppAdvisorRecommendation = {
    profile,
    recommended,
    observedModelBytes,
    warnings,
  };

  return recommendation;
}

export async function probeLlamaCppHardware(): Promise<LlamaCppHardwareProfile> {
  const cpus = os.cpus();
  const notes: string[] = [];
  const gpus: LlamaCppGpuInfo[] = [];

  const nvidia = await detectNvidiaGpus();
  if (nvidia.length > 0) {
    gpus.push(...nvidia);
  } else {
    const amd = await detectAmdGpus();
    if (amd.length > 0) {
      gpus.push(...amd);
    } else if (process.platform === "darwin") {
      gpus.push(...(await detectAppleGpus()));
    } else if (process.platform === "win32") {
      gpus.push(...(await detectWindowsVideoControllers()));
    }
  }

  if (gpus.length === 0) {
    notes.push("No GPU telemetry command responded. Recommendations will stay CPU-safe.");
  }

  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model,
    cpuCoresLogical: cpus.length,
    systemRamBytes: os.totalmem(),
    systemRamFreeBytes: os.freemem(),
    gpus,
    notes,
  };
}

export function parseNvidiaSmiCsv(raw: string): LlamaCppGpuInfo[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, memoryMiB, driver] = line.split(",").map((part) => part.trim());
      const parsedMemoryMiB = Number.parseInt(memoryMiB ?? "", 10);
      return {
        vendor: "nvidia",
        name: name || "NVIDIA GPU",
        driver: driver || undefined,
        vramBytes: Number.isFinite(parsedMemoryMiB) ? parsedMemoryMiB * 1024 * 1024 : undefined,
        source: "nvidia-smi",
        confidence: "high",
      } satisfies LlamaCppGpuInfo;
    });
}

export function parseWindowsVideoControllerJson(raw: string): LlamaCppGpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records
    .filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === "object")
    .map<LlamaCppGpuInfo>((record) => ({
      vendor: guessGpuVendor(typeof record.Name === "string" ? record.Name : undefined),
      name: typeof record.Name === "string" ? record.Name : "GPU",
      driver: typeof record.DriverVersion === "string" ? record.DriverVersion : undefined,
      vramBytes: typeof record.AdapterRAM === "number" ? record.AdapterRAM : undefined,
      source: "windows-cim",
      confidence: "low",
    }))
    .filter((record) => record.name.trim().length > 0);
}

export function parseSystemProfilerDisplaysJson(raw: string): LlamaCppGpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const sections = isRecord(parsed) ? parsed.SPDisplaysDataType : undefined;
  if (!Array.isArray(sections)) {
    return [];
  }
  return sections.filter(isRecord).map((entry) => {
    const name =
      typeof entry.sppci_model === "string" ? entry.sppci_model : typeof entry._name === "string" ? entry._name : "GPU";
    const vramText =
      typeof entry.spdisplays_vram === "string"
        ? entry.spdisplays_vram
        : typeof entry.spdisplays_vram_shared === "string"
          ? entry.spdisplays_vram_shared
          : undefined;
    return {
      vendor: guessGpuVendor(name),
      name,
      vramBytes: parseHumanMemoryString(vramText),
      source: "system_profiler",
      confidence: "medium",
    } satisfies LlamaCppGpuInfo;
  });
}

export function parseAmdGpuTelemetryJson(raw: string, source: "amd-smi" | "rocm-smi" = "amd-smi"): LlamaCppGpuInfo[] {
  return parseFlexibleJsonGpuTelemetry(raw, source, "amd");
}

async function detectNvidiaGpus(): Promise<LlamaCppGpuInfo[]> {
  const raw = await runOptionalCommand("nvidia-smi", [
    "--query-gpu=name,memory.total,driver_version",
    "--format=csv,noheader,nounits",
  ]);
  return raw ? parseNvidiaSmiCsv(raw) : [];
}

async function detectAmdGpus(): Promise<LlamaCppGpuInfo[]> {
  const amdSmiRaw = await runOptionalCommand("amd-smi", ["list", "--json"]);
  if (amdSmiRaw) {
    const parsed = parseAmdGpuTelemetryJson(amdSmiRaw, "amd-smi");
    if (parsed.length > 0) {
      return parsed;
    }
  }

  const rocmRaw = await runOptionalCommand("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"]);
  if (rocmRaw) {
    return parseAmdGpuTelemetryJson(rocmRaw, "rocm-smi");
  }
  return [];
}

async function detectAppleGpus(): Promise<LlamaCppGpuInfo[]> {
  const raw = await runOptionalCommand("system_profiler", ["SPDisplaysDataType", "-json"]);
  return raw ? parseSystemProfilerDisplaysJson(raw) : [];
}

async function detectWindowsVideoControllers(): Promise<LlamaCppGpuInfo[]> {
  const raw = await runOptionalCommand("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress",
  ]);
  return raw ? parseWindowsVideoControllerJson(raw) : [];
}

function parseFlexibleJsonGpuTelemetry(
  raw: string,
  source: string,
  vendor: LlamaCppGpuInfo["vendor"],
): LlamaCppGpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const objects = flattenJsonObjects(parsed);
  return objects
    .map((record) => {
      const name = firstString(record, ["product_name", "name", "Card series", "card_name", "model", "asic"]);
      const vram = firstNumber(record, ["vram_size_mb", "vram_total_mb", "VRAM Total Memory (B)", "vram_total_bytes"]);
      const vramBytes =
        record["VRAM Total Memory (B)"] && typeof record["VRAM Total Memory (B)"] === "number"
          ? Number(record["VRAM Total Memory (B)"])
          : typeof vram === "number"
            ? vram > 1024 * 1024
              ? vram
              : vram * 1024 * 1024
            : undefined;
      return {
        vendor,
        name: name ?? "AMD GPU",
        driver: firstString(record, ["driver_version", "driver"]),
        vramBytes,
        source,
        confidence: vramBytes ? "medium" : "low",
      } satisfies LlamaCppGpuInfo;
    })
    .filter((gpu) => gpu.name.trim().length > 0);
}

function flattenJsonObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenJsonObjects(item));
  }
  if (!isRecord(value)) {
    return [];
  }
  const nested = Object.values(value).flatMap((item) => flattenJsonObjects(item));
  return [value, ...nested];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.replace(/[^\d.]/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

async function runOptionalCommand(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function inspectLlamaCppVersion(command: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, ["--version"], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return combined?.slice(0, 200);
  } catch {
    return undefined;
  }
}

async function resolveLlamaCppCommand(configuredCommand: string): Promise<CommandResolution> {
  const explicit = normalizeOptionalText(configuredCommand);
  if (explicit) {
    const explicitResolved = await resolveExecutable(explicit);
    if (explicitResolved) {
      return {
        command: explicitResolved,
        source: "explicit",
      };
    }
  }

  const fallbackCandidates = process.platform === "win32" ? ["llama-server.exe", "llama-server"] : ["llama-server"];
  for (const candidate of fallbackCandidates) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      return {
        command: resolved,
        source: candidate.endsWith(".exe") ? "path-with-exe" : "path",
      };
    }
  }

  return {
    command: explicit,
    source: "missing",
  };
}

export function recommendLlamaCppLaunchSettings(input: {
  profile: LlamaCppHardwareProfile;
  observedModelBytes?: number;
}): Pick<LlamaCppAdvisorRecommendation, "recommended" | "warnings"> {
  const warnings = [...input.profile.notes];
  const bestGpu = selectBestGpu(input.profile.gpus);
  const systemRamGiB = input.profile.systemRamBytes / 1024 ** 3;
  const confidentGpu = Boolean(bestGpu?.vramBytes && bestGpu.confidence !== "low");
  const highHeadroomGpu = Boolean(bestGpu?.vramBytes && bestGpu.vramBytes >= 10 * 1024 ** 3);

  let ctxSize = 4096;
  if (systemRamGiB >= 64) {
    ctxSize = 16384;
  } else if (systemRamGiB >= 32) {
    ctxSize = 8192;
  }

  const physicalThreads =
    input.profile.cpuCoresPhysical ?? Math.max(1, Math.floor(input.profile.cpuCoresLogical * 0.75));
  const threads = Math.max(1, Math.min(physicalThreads, input.profile.cpuCoresLogical));

  let gpuLayers: number | undefined;
  if (!bestGpu) {
    gpuLayers = 0;
    warnings.push("No discrete GPU was detected. The safest default is CPU-first inference.");
  } else if (!confidentGpu) {
    gpuLayers = 0;
    warnings.push(`GPU "${bestGpu.name}" was detected, but VRAM confidence is low. Keeping GPU layers at 0 is safer.`);
  }

  if (input.observedModelBytes && input.observedModelBytes > input.profile.systemRamBytes * 0.8) {
    warnings.push(
      "The selected GGUF is close to total system RAM. Expect slow loads or failure without a smaller quant.",
    );
    ctxSize = Math.min(ctxSize, 4096);
  }

  if (bestGpu?.vramBytes && input.observedModelBytes && bestGpu.vramBytes < input.observedModelBytes * 0.4) {
    gpuLayers = 0;
    warnings.push("Available VRAM is modest relative to the model size. Avoid aggressive GPU offload first.");
  }

  return {
    recommended: {
      ctxSize,
      threads,
      gpuLayers,
      parallel: systemRamGiB >= 96 && highHeadroomGpu ? 2 : 1,
      batchSize: confidentGpu ? 1024 : 512,
      ubatchSize: confidentGpu ? 512 : 256,
      flashAttention: confidentGpu && highHeadroomGpu ? true : undefined,
    },
    warnings,
  };
}

async function resolveExecutable(command: string): Promise<string | undefined> {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  if (path.isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return fsSync.existsSync(trimmed) ? trimmed : undefined;
  }

  const locator = process.platform === "win32" ? "where.exe" : "which";
  const found = await runOptionalCommand(locator, [trimmed]);
  if (!found) {
    return undefined;
  }
  return found
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function normalizeHuggingFaceRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error("Hugging Face repo must look like owner/name.");
  }
  return trimmed;
}

function normalizeHuggingFacePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized) {
    throw new Error("Hugging Face filename is required.");
  }
  if (normalized.startsWith("/") || normalized.includes("://")) {
    throw new Error("Hugging Face filename must be a repo-relative path.");
  }
  const parts = normalized.split("/");
  if (
    parts.some((part) => {
      return !part || part === "." || part === "..";
    })
  ) {
    throw new Error("Hugging Face filename contains an invalid path segment.");
  }
  if (!normalized.toLowerCase().endsWith(".gguf")) {
    throw new Error("Only GGUF artifacts are supported in this workflow.");
  }
  return normalized;
}

function sanitizeHuggingFaceRepo(repo: string): string {
  return repo.replace(/[^\w.-]+/g, "_");
}

function buildHuggingFaceResolveUrl(repo: string, filename: string): string {
  const encodedPath = filename
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://huggingface.co/${repo}/resolve/main/${encodedPath}`;
}

function normalizeSha256(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(trimmed)) {
    throw new Error("SHA256 must be a 64-character hex string.");
  }
  return trimmed;
}

async function downloadUrlToFile(input: {
  url: string;
  destinationPath: string;
  expectedSha256?: string;
  signal?: AbortSignal;
  onProgress?: (progress: { bytesDownloaded: number; totalBytes?: number }) => void;
}): Promise<{ sizeBytes: number; sha256: string }> {
  const { url, destinationPath, expectedSha256, signal, onProgress } = input;
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.part`;
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  try {
    const totalBytesHeader = response.headers.get("content-length");
    const totalBytes = totalBytesHeader ? Number.parseInt(totalBytesHeader, 10) : undefined;
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    const writer = fsSync.createWriteStream(tempPath);
    let bytesDownloaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = Buffer.from(value);
        bytesDownloaded += chunk.length;
        hash.update(chunk);
        if (!writer.write(chunk)) {
          await once(writer, "drain");
        }
        onProgress?.({ bytesDownloaded, totalBytes });
      }
      writer.end();
      await once(writer, "finish");
    } catch (error) {
      writer.destroy();
      throw error;
    }

    const sha256 = hash.digest("hex");
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(`SHA256 mismatch for ${path.basename(destinationPath)}.`);
    }
    await fs.rename(tempPath, destinationPath);
    return {
      sizeBytes: bytesDownloaded,
      sha256,
    };
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    await fs.rm(destinationPath, { force: true });
    throw error;
  }
}

export function buildLlamaCppLaunchArgs(rootDir: string, config: LlamaCppConfig): string[] {
  const modelPath = resolveConfiguredPath(rootDir, config.launch.modelPath);
  const rootUrl = new URL(normalizeLlamaCppServerRoot(config.server.baseUrl));
  const args = ["-m", modelPath ?? "", "--host", rootUrl.hostname];

  if (rootUrl.port) {
    args.push("--port", rootUrl.port);
  }
  if (normalizeOptionalText(config.launch.alias)) {
    args.push("--alias", config.launch.alias.trim());
  }
  if (config.launch.ctxSize !== undefined) {
    args.push("-c", String(config.launch.ctxSize));
  }
  if (config.launch.threads !== undefined) {
    args.push("-t", String(config.launch.threads));
  }
  if (config.launch.gpuLayers !== undefined) {
    args.push("-ngl", String(config.launch.gpuLayers));
  }
  if (config.launch.parallel !== undefined) {
    args.push("-np", String(config.launch.parallel));
  }
  if (config.launch.batchSize !== undefined) {
    args.push("-b", String(config.launch.batchSize));
  }
  if (config.launch.ubatchSize !== undefined) {
    args.push("-ub", String(config.launch.ubatchSize));
  }
  if (config.launch.flashAttention !== undefined) {
    args.push("--flash-attn", config.launch.flashAttention ? "on" : "off");
  }

  if (!hasReasoningOverride(config.server.extraArgs)) {
    args.push(...DEFAULT_LLAMACPP_REASONING_ARGS);
  }
  args.push(...config.server.extraArgs);
  return args;
}

function buildLaunchCommandPreview(input: {
  rootDir: string;
  config: LlamaCppConfig | ContractLlamaCppConfig;
  command?: string;
}): string | undefined {
  const command = normalizeOptionalText(input.command);
  if (!command) {
    return undefined;
  }
  const args = buildLlamaCppLaunchArgs(input.rootDir, input.config as LlamaCppConfig);
  return renderCommand(command, args);
}

export function normalizeLlamaCppProviderBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "http://127.0.0.1:8080/v1";
  }
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function normalizeLlamaCppServerRoot(baseUrl: string): string {
  return normalizeLlamaCppProviderBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

function resolveConfiguredPath(rootDir: string, configuredPath: string | undefined): string | undefined {
  const trimmed = normalizeOptionalText(configuredPath);
  if (!trimmed) {
    return undefined;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(rootDir, trimmed);
}

function joinUrl(baseUrl: string, routePath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${normalizedBase}${normalizedPath}`;
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args].map((segment) => quoteSegment(segment)).join(" ");
}

function quoteSegment(segment: string): string {
  return /\s/.test(segment) ? `"${segment.replaceAll('"', '\\"')}"` : segment;
}

function normalizeOptionalText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hasReasoningOverride(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--reasoning" || arg === "-rea");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "taskkill", "/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function selectBestGpu(gpus: LlamaCppGpuInfo[]): LlamaCppGpuInfo | undefined {
  return [...gpus].sort((left, right) => {
    const vramDiff = (right.vramBytes ?? 0) - (left.vramBytes ?? 0);
    if (vramDiff !== 0) {
      return vramDiff;
    }
    return confidenceRank(right.confidence) - confidenceRank(left.confidence);
  })[0];
}

function confidenceRank(value: LlamaCppGpuInfo["confidence"]): number {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

export { DEFAULT_LLAMACPP_ALIAS };

function parseHumanMemoryString(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  const match = normalized.match(/([\d.]+)\s*(gb|gib|mb|mib)/i);
  if (!match) {
    return undefined;
  }
  const amount = Number.parseFloat(match[1] ?? "");
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  if (unit.startsWith("g")) {
    return Math.round(amount * 1024 ** 3);
  }
  return Math.round(amount * 1024 ** 2);
}

function guessGpuVendor(name: string | undefined): LlamaCppGpuInfo["vendor"] {
  const normalized = (name ?? "").toLowerCase();
  if (normalized.includes("nvidia") || normalized.includes("geforce") || normalized.includes("rtx")) {
    return "nvidia";
  }
  if (normalized.includes("amd") || normalized.includes("radeon")) {
    return "amd";
  }
  if (normalized.includes("apple")) {
    return "apple";
  }
  if (normalized.includes("intel")) {
    return "intel";
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
