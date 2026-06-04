import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { NpuCapabilityReport, NpuModelManifest, NpuRuntimeStatus } from "@goatcitadel/contracts";
import type { NpuConfig } from "../config.js";

export interface NpuSidecarServiceOptions {
  rootDir: string;
  config: NpuConfig;
  onEvent?: (eventType: string, payload: Record<string, unknown>) => void;
}

interface SidecarHealthPayload {
  activeModelId?: string;
  backend?: "qnn" | "cpu" | "unknown";
  capability?: Partial<NpuCapabilityReport>;
  localInferenceReady?: boolean;
  streamingChatCompletions?: boolean;
  fallbackProxyConfigured?: boolean;
  lastError?: string;
}

export class NpuSidecarService {
  private process: ChildProcess | null = null;
  private desiredState: "stopped" | "running" = "stopped";
  private processState: "stopped" | "starting" | "running" | "error" = "stopped";
  private healthy = false;
  private activeModelId?: string;
  private backend: "qnn" | "cpu" | "unknown" = "unknown";
  private capability: NpuCapabilityReport = defaultCapability();
  private lastError?: string;
  private updatedAt = new Date().toISOString();
  private closed = false;
  private restartTimestamps: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;

  private readonly stateCachePath: string;

  public constructor(private options: NpuSidecarServiceOptions) {
    this.stateCachePath = path.resolve(options.rootDir, "data", "npu-runtime-state.json");
  }

  public async init(): Promise<void> {
    await this.loadCachedState();
    if (this.options.config.enabled && this.options.config.autoStart) {
      await this.start("auto_start");
      return;
    }
    await this.refresh();
  }

  public updateConfig(config: NpuConfig): void {
    this.options = {
      ...this.options,
      config,
    };
  }

  public getStatus(): NpuRuntimeStatus {
    return {
      enabled: this.options.config.enabled,
      desiredState: this.desiredState,
      processState: this.processState,
      sidecarUrl: normalizeBaseUrl(this.options.config.sidecar.baseUrl),
      sidecarPid: this.process?.pid,
      healthy: this.healthy,
      activeModelId: this.activeModelId,
      backend: this.backend,
      capability: this.capability,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  public async start(reason = "manual"): Promise<NpuRuntimeStatus> {
    this.desiredState = "running";
    this.closed = false;

    if (!this.options.config.enabled) {
      throw new Error("NPU runtime is disabled in assistant config");
    }

    if (this.process?.pid && this.processState === "running") {
      await this.refresh();
      return this.getStatus();
    }

    this.assertRestartBudget();
    this.bumpRestartCounter();

    this.processState = "starting";
    this.healthy = false;
    this.lastError = undefined;
    this.updatedAt = new Date().toISOString();
    this.emit("npu_starting", { reason });
    await this.persistState();

    const { command, args, env } = this.resolveProcessCommand();
    const child = spawn(command, args, {
      cwd: this.options.rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    child.stdout?.on("data", (chunk) => {
      this.emit("npu_stdout", {
        message: chunk.toString("utf8").trim(),
      });
    });
    child.stderr?.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.lastError = message.slice(0, 500);
      }
      this.emit("npu_stderr", { message });
    });
    child.on("exit", (code, signal) => {
      this.process = null;
      const unexpected = !this.closed && this.desiredState === "running";
      this.processState = unexpected ? "error" : "stopped";
      this.healthy = false;
      this.updatedAt = new Date().toISOString();
      if (unexpected) {
        this.lastError = `NPU sidecar exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.emit("npu_exited", {
          unexpected: true,
          code,
          signal,
          message: this.lastError,
        });
        void this.persistState();
        this.scheduleRestart();
      } else {
        this.emit("npu_exited", { unexpected: false, code, signal });
        void this.persistState();
      }
    });

    const healthy = await this.waitForHealthy(this.options.config.sidecar.startTimeoutMs);
    if (!healthy) {
      this.processState = "error";
      this.healthy = false;
      this.lastError = "NPU sidecar did not become healthy within timeout";
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      await this.stop("startup_timeout");
      throw new Error(this.lastError);
    }

    this.processState = "running";
    this.healthy = true;
    this.updatedAt = new Date().toISOString();
    await this.persistState();
    this.emit("npu_started", {
      pid: this.process?.pid,
      sidecarUrl: normalizeBaseUrl(this.options.config.sidecar.baseUrl),
    });
    return this.getStatus();
  }

  public async stop(reason = "manual"): Promise<NpuRuntimeStatus> {
    this.desiredState = "stopped";
    this.closed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }

    const running = this.process;
    if (!running?.pid) {
      this.processState = "stopped";
      this.healthy = false;
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      return this.getStatus();
    }

    this.emit("npu_stopping", { reason, pid: running.pid });
    if (process.platform === "win32") {
      await this.killWindows(running.pid);
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

  public async refresh(): Promise<NpuRuntimeStatus> {
    const payload = await this.fetchHealth().catch(() => undefined);
    if (!payload) {
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
    this.processState = this.process?.pid ? "running" : "running";
    this.activeModelId = payload.activeModelId ?? this.activeModelId;
    this.backend = payload.backend ?? this.backend;
    if (payload.capability) {
      this.capability = { ...defaultCapability(), ...payload.capability };
    }
    if (payload.lastError) {
      this.lastError = payload.lastError;
    }
    this.updatedAt = new Date().toISOString();
    await this.persistState();
    return this.getStatus();
  }

  public async listModels(): Promise<NpuModelManifest[]> {
    const url = joinUrl(normalizeBaseUrl(this.options.config.sidecar.baseUrl), this.options.config.sidecar.modelsPath);
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(this.options.config.sidecar.requestTimeoutMs),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`NPU model listing failed (${response.status})`);
    }
    const json = (await response.json()) as { data?: Array<Record<string, unknown>> };
    return (json.data ?? [])
      .map((record) => {
        const metadata = (record.metadata ?? {}) as Record<string, unknown>;
        return {
          modelId: String(record.id ?? metadata.modelId ?? ""),
          label: String(metadata.label ?? record.id ?? "NPU model"),
          family: normalizeModelFamily(metadata.family),
          source: normalizeModelSource(metadata.source),
          path: typeof metadata.path === "string" ? metadata.path : undefined,
          sha256: typeof metadata.sha256 === "string" ? metadata.sha256 : undefined,
          readiness: normalizeModelReadiness(metadata.readiness),
          backend: normalizeNpuBackend(metadata.backend),
          fallbackReason: typeof metadata.fallbackReason === "string" ? metadata.fallbackReason : undefined,
          default: Boolean(metadata.default),
          requiresQnn: Boolean(metadata.requiresQnn),
          contextWindow: typeof metadata.contextWindow === "number" ? metadata.contextWindow : undefined,
          enabled: metadata.enabled === undefined ? true : Boolean(metadata.enabled),
        };
      })
      .filter((model) => model.modelId.length > 0);
  }

  public async close(): Promise<void> {
    await this.stop("shutdown");
  }

  private async fetchHealth(): Promise<SidecarHealthPayload> {
    const url = joinUrl(normalizeBaseUrl(this.options.config.sidecar.baseUrl), this.options.config.sidecar.healthPath);
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(this.options.config.sidecar.requestTimeoutMs),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`NPU health failed (${response.status})`);
    }
    return (await response.json()) as SidecarHealthPayload;
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.desiredState !== "running" || !this.options.config.enabled) {
      return;
    }

    const backoffMs = Math.max(100, this.options.config.sidecar.restartBudget.backoffMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start("auto_restart").catch((error) => {
        this.lastError = (error as Error).message;
        this.processState = "error";
        this.healthy = false;
        this.updatedAt = new Date().toISOString();
        this.emit("npu_restart_failed", {
          message: this.lastError,
        });
        void this.persistState();
      });
    }, backoffMs);
    this.restartTimer.unref();
  }

  private assertRestartBudget(): void {
    const now = Date.now();
    const windowMs = Math.max(1_000, this.options.config.sidecar.restartBudget.windowMs);
    const maxRestarts = Math.max(1, this.options.config.sidecar.restartBudget.maxRestarts);
    this.restartTimestamps = this.restartTimestamps.filter((value) => now - value <= windowMs);
    if (this.restartTimestamps.length >= maxRestarts) {
      throw new Error("NPU restart budget exceeded");
    }
  }

  private bumpRestartCounter(): void {
    this.restartTimestamps.push(Date.now());
  }

  private resolveProcessCommand(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    const sidecar = this.options.config.sidecar;
    const baseUrl = new URL(normalizeBaseUrl(sidecar.baseUrl));
    const args = sidecar.args.map((arg) => resolveArgPath(this.options.rootDir, arg));

    return {
      command: sidecar.command,
      args,
      env: {
        ...process.env,
        GOATCITADEL_NPU_HOST: baseUrl.hostname,
        GOATCITADEL_NPU_PORT: baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80"),
      },
    };
  }

  private async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(2_000, timeoutMs);
    while (Date.now() < deadline) {
      if (
        await this.fetchHealth()
          .then(() => true)
          .catch(() => false)
      ) {
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  private async killWindows(pid: number): Promise<void> {
    const command = process.env.ComSpec ?? "cmd.exe";
    await new Promise<void>((resolve) => {
      const child = spawn(command, ["/c", "taskkill", "/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  }

  private emit(eventType: string, payload: Record<string, unknown>): void {
    if (!this.options.onEvent) {
      return;
    }
    this.options.onEvent(eventType, payload);
  }

  private async loadCachedState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateCachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<NpuRuntimeStatus>;
      this.processState = parsed.processState ?? this.processState;
      this.desiredState = parsed.desiredState ?? this.desiredState;
      this.healthy = Boolean(parsed.healthy);
      this.activeModelId = parsed.activeModelId;
      this.backend = parsed.backend ?? this.backend;
      if (parsed.capability) {
        this.capability = parsed.capability;
      }
      this.lastError = parsed.lastError;
      this.updatedAt = parsed.updatedAt ?? this.updatedAt;
    } catch {
      // no cached state yet
    }
  }

  private async persistState(): Promise<void> {
    const snapshot = this.getStatus();
    const dir = path.dirname(this.stateCachePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.stateCachePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

function defaultCapability(): NpuCapabilityReport {
  return {
    platform: process.platform,
    arch: process.arch,
    isWindowsArm64: process.platform === "win32" && process.arch === "arm64",
    onnxRuntimeAvailable: false,
    onnxRuntimeGenAiAvailable: false,
    qnnExecutionProviderAvailable: false,
    supported: false,
    localInferenceReady: false,
    streamingChatCompletions: false,
    fallbackProxyConfigured: false,
    details: ["No sidecar capability report received yet."],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, suffix: string): string {
  if (!suffix.startsWith("/")) {
    return `${baseUrl}/${suffix}`;
  }
  return `${baseUrl}${suffix}`;
}

function normalizeModelFamily(value: unknown): NpuModelManifest["family"] {
  const family = String(value ?? "other").toLowerCase();
  if (family === "llama" || family === "phi" || family === "qwen" || family === "mistral" || family === "gemma") {
    return family;
  }
  return "other";
}

function normalizeModelSource(value: unknown): NpuModelManifest["source"] {
  const source = String(value ?? "custom").toLowerCase();
  if (source === "local" || source === "huggingface" || source === "custom") {
    return source;
  }
  return "custom";
}

function normalizeModelReadiness(value: unknown): NpuModelManifest["readiness"] {
  const readiness = String(value ?? "unchecked").toLowerCase();
  if (readiness === "ready" || readiness === "missing_path" || readiness === "hash_mismatch") {
    return readiness;
  }
  return "unchecked";
}

function normalizeNpuBackend(value: unknown): NpuModelManifest["backend"] {
  const backend = String(value ?? "unknown").toLowerCase();
  if (backend === "qnn" || backend === "cpu") {
    return backend;
  }
  return "unknown";
}

function resolveArgPath(rootDir: string, arg: string): string {
  if (!arg || arg.startsWith("-")) {
    return arg;
  }
  if (path.isAbsolute(arg)) {
    return arg;
  }
  const normalized = arg.replaceAll("/", path.sep).replaceAll("\\", path.sep);
  const candidate = path.resolve(rootDir, normalized);
  if (fsSync.existsSync(candidate)) {
    return candidate;
  }
  return arg;
}
