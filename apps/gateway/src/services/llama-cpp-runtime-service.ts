/* eslint-disable max-lines -- Runtime service intentionally centralizes platform-specific llama.cpp detection and launch logic. */
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
  LlamaCppRuntimeLease,
  LlamaCppRuntimeLeaseDiagnostics,
  LlamaCppRuntimeLeaseEvidence,
  LlamaCppRuntimeLeaseRequest,
  LlamaCppRuntimeOwnership,
  LlamaCppRuntimeStatus,
} from "@goatcitadel/contracts";
import { coerceHttpContentLength } from "@goatcitadel/contracts";
import type { LlamaCppConfig } from "../config.js";
import { readBoundedResponseJson, readBoundedResponseText } from "./bounded-response-reader.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LLAMACPP_ALIAS = "gemma-4-local";
const DEFAULT_LLAMACPP_REASONING_ARGS = ["--reasoning", "off"] as const;
const MAX_DISCOVERED_LLAMACPP_MODELS = 512;
const DEFAULT_LLAMACPP_LEASE_IDLE_TIMEOUT_MS = 30_000;
const MAX_LLAMACPP_LEASE_PURPOSES = 8;

type LlamaCppPersistentDemand = "manual" | "api" | "autostart";
type LlamaCppStartEvidenceReason = NonNullable<LlamaCppRuntimeLeaseEvidence["lastStart"]>["reason"];

interface LlamaCppHealthObservation {
  healthy: boolean;
  activeModelId?: string;
}

interface LlamaCppLifecycleObservationToken {
  generation: number;
  identityFingerprint: string;
  process: ChildProcess | null;
  ownedProcessTree: LlamaCppOwnedProcessTree | null;
}

interface LlamaCppRuntimeStateCache extends LlamaCppRuntimeStatus {
  runtimeIdentityFingerprint?: string;
}

interface LlamaCppOwnedProcessTree {
  child: ChildProcess;
  pid: number;
}

export interface LlamaCppRuntimeServiceHooks {
  spawnProcess?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
  probeHealth?: () => Promise<LlamaCppHealthObservation>;
  terminateOwnedProcess?: (process: ChildProcess) => Promise<void> | void;
  persistState?: (path: string, status: LlamaCppRuntimeStatus) => Promise<void>;
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
  onEvent?: (eventType: string, payload: Record<string, unknown>) => void | Promise<unknown>;
  leaseIdleTimeoutMs?: number;
  runtimeHooks?: LlamaCppRuntimeServiceHooks;
}

export interface LlamaCppRuntimeLeaseHandle extends LlamaCppRuntimeLease {
  release(): Promise<void>;
}

export interface LlamaCppRuntimeLifecycleSnapshot {
  persistentDemand: {
    manual: boolean;
    api: boolean;
    autostart: boolean;
  };
  idleShutdownRemainingMs?: number;
}

export interface LlamaCppRuntimeConfigTransitionAssessment {
  allowed: boolean;
  identityChanged: boolean;
  activeLeaseCount: number;
  reason?: "active_leases";
}

interface CommandResolution {
  command?: string;
  source: NonNullable<LlamaCppRuntimeStatus["commandSource"]>;
}

export class LlamaCppRuntimeService {
  private process: ChildProcess | null = null;
  private ownedProcessTree: LlamaCppOwnedProcessTree | null = null;
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
  private readonly leases = new Map<string, LlamaCppRuntimeLease>();
  private readonly persistentDemand = new Set<LlamaCppPersistentDemand>();
  private readonly intentionalExits = new WeakSet<ChildProcess>();
  private startupPromise: Promise<LlamaCppRuntimeStatus> | undefined;
  private startupAbortController: AbortController | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private idleDeadline?: string;
  private ownership: LlamaCppRuntimeOwnership = "none";
  private leaseEvidence: LlamaCppRuntimeLeaseEvidence = {};
  private lifecycleGeneration = 0;
  private disposed = false;
  private stateLoaded = false;
  private stateLoadPromise: Promise<void> | undefined;
  private initPromise: Promise<void> | undefined;
  private idleShutdownPromise: Promise<void> | undefined;
  private stopPromise: Promise<LlamaCppRuntimeStatus> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly queuedStartupPromises = new Set<Promise<LlamaCppRuntimeStatus>>();
  private readonly refreshPromises = new Set<Promise<LlamaCppRuntimeStatus>>();
  private persistTail: Promise<void> = Promise.resolve();

  private readonly stateCachePath: string;

  public constructor(private options: LlamaCppRuntimeServiceOptions) {
    this.stateCachePath = path.resolve(options.rootDir, "data", "llamacpp-runtime-state.json");
  }

  public init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    const initialization = this.initCore();
    this.initPromise = initialization;
    void initialization.catch(() => {
      if (this.initPromise === initialization) {
        this.initPromise = undefined;
      }
    });
    return initialization;
  }

  private async initCore(): Promise<void> {
    await this.ensureStateLoaded();
    if (this.disposed) {
      return;
    }
    if (this.options.config.enabled && this.options.config.autoStart) {
      await this.start("auto_start");
      return;
    }
    this.syncDesiredState();
    await this.refreshCore();
  }

  public updateConfig(config: LlamaCppConfig): void {
    this.assertCanApplyConfig(config);
    const identityChanged = hasLlamaCppRuntimeIdentityChanged(this.options.config, config);
    if (identityChanged) {
      this.lifecycleGeneration += 1;
      this.startupAbortController?.abort();
      this.cancelIdleShutdown();
      this.cancelRestart();
      this.restartTimestamps = [];
      this.leaseEvidence = {};
      this.lastError = undefined;
      this.activeModelId = undefined;
      this.lastCommand = undefined;
      this.lastCommandSource = "missing";
      this.healthy = false;
      if (!this.ownedProcessTree) {
        this.processState = "stopped";
        this.ownership = "none";
      }
      this.updatedAt = new Date().toISOString();
    }
    this.options = {
      ...this.options,
      config,
    };
    if (!config.autoStart) {
      this.persistentDemand.delete("autostart");
    }
    if (!config.enabled) {
      this.lifecycleGeneration += 1;
      this.startupAbortController?.abort();
      this.closed = true;
      this.persistentDemand.clear();
      this.cancelIdleShutdown();
      this.cancelRestart();
    } else if (!this.hasRuntimeDemand()) {
      this.scheduleIdleShutdown();
    }
    this.syncDesiredState();
  }

  public getConfigSnapshot(): LlamaCppConfig {
    return structuredClone(this.options.config);
  }

  public getLifecycleSnapshot(): LlamaCppRuntimeLifecycleSnapshot {
    const idleShutdownRemainingMs = this.idleDeadline
      ? Math.max(0, new Date(this.idleDeadline).getTime() - Date.now())
      : undefined;
    return {
      persistentDemand: {
        manual: this.persistentDemand.has("manual"),
        api: this.persistentDemand.has("api"),
        autostart: this.persistentDemand.has("autostart"),
      },
      ...(idleShutdownRemainingMs === undefined ? {} : { idleShutdownRemainingMs }),
    };
  }

  public assessConfigTransition(config: LlamaCppConfig): LlamaCppRuntimeConfigTransitionAssessment {
    const identityChanged = hasLlamaCppRuntimeIdentityChanged(this.options.config, config);
    const activeLeaseCount = this.leases.size;
    const allowed = !identityChanged || activeLeaseCount === 0;
    return {
      allowed,
      identityChanged,
      activeLeaseCount,
      ...(allowed ? {} : { reason: "active_leases" as const }),
    };
  }

  public assertCanApplyConfig(config: LlamaCppConfig): void {
    const assessment = this.assessConfigTransition(config);
    if (!assessment.allowed) {
      throw new Error(
        `Cannot change llama.cpp runtime identity while ${assessment.activeLeaseCount} active lease(s) are in use`,
      );
    }
  }

  public async restoreLifecycleSnapshot(snapshot: LlamaCppRuntimeLifecycleSnapshot): Promise<LlamaCppRuntimeStatus> {
    if (this.disposed) {
      throw new Error("llama.cpp runtime service is closed");
    }
    await this.awaitStableLifecycle();
    if (this.disposed) {
      throw new Error("llama.cpp runtime service is closed");
    }
    this.cancelIdleShutdown();
    this.persistentDemand.clear();
    if (this.options.config.enabled) {
      for (const demand of persistentDemandFromSnapshot(snapshot)) {
        this.persistentDemand.add(demand);
      }
    }
    this.closed = !this.options.config.enabled;
    this.syncDesiredState();

    if (this.options.config.enabled && this.hasRuntimeDemand()) {
      const generation = this.lifecycleGeneration;
      await this.awaitIdleShutdown();
      this.assertLifecycleGeneration(generation);
      return this.ensureStarted("lifecycle_restore", "other");
    }
    if (this.options.config.enabled && snapshot.idleShutdownRemainingMs !== undefined) {
      this.scheduleIdleShutdown(snapshot.idleShutdownRemainingMs);
    }
    // A config transition can move from an externally owned endpoint to a new
    // identity without persistent demand. Re-probe the new endpoint so the
    // returned settings/runtime snapshot never carries health or ownership
    // observed against the previous base URL.
    return this.refreshCore();
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
      pid: this.process?.pid ?? this.ownedProcessTree?.pid,
      healthy: this.healthy,
      activeModelId: this.healthy
        ? (this.activeModelId ?? normalizeOptionalText(this.options.config.launch.alias))
        : undefined,
      command: this.lastCommand,
      commandSource: this.lastCommandSource,
      modelPath: resolveConfiguredPath(this.options.rootDir, this.options.config.launch.modelPath),
      lastError: this.lastError,
      updatedAt: this.updatedAt,
      launchCommandPreview: commandPreview,
      leaseDiagnostics: this.buildLeaseDiagnostics(),
    };
  }

  public async acquireLease(
    input: LlamaCppRuntimeLeaseRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<LlamaCppRuntimeLeaseHandle> {
    if (this.disposed) {
      throw new Error("llama.cpp runtime service is closed");
    }
    throwIfAborted(options.signal);
    await this.awaitStableLifecycle(options.signal);
    if (this.disposed) {
      throw new Error("llama.cpp runtime service is closed");
    }
    const purpose = normalizeLeasePurpose(input.purpose);
    const acquiredAt = new Date().toISOString();
    const lease: LlamaCppRuntimeLease = {
      leaseId: randomUUID(),
      purpose,
      acquiredAt,
    };
    this.cancelIdleShutdown();
    this.leases.set(lease.leaseId, lease);
    this.leaseEvidence.lastLease = { at: acquiredAt, action: "acquired", purpose };
    this.syncDesiredState();
    const generation = this.lifecycleGeneration;

    try {
      await waitForPromiseWithSignal(this.awaitIdleShutdown(), options.signal);
      this.assertLifecycleGeneration(generation);
      if (!this.leases.has(lease.leaseId)) {
        throw new Error("llama.cpp lease was settled during a forced runtime transition");
      }
      await waitForPromiseWithSignal(this.ensureStarted("lease", "lease"), options.signal);
      if (!this.leases.has(lease.leaseId) || this.disposed || !this.options.config.enabled) {
        throw new Error("llama.cpp lease was settled during a forced runtime transition");
      }
    } catch (error) {
      await this.releaseLease(lease.leaseId);
      throw error;
    }

    let released = false;
    return {
      ...lease,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await this.releaseLease(lease.leaseId);
      },
    };
  }

  public async releaseLease(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return;
    }
    this.leases.delete(leaseId);
    this.leaseEvidence.lastLease = {
      at: new Date().toISOString(),
      action: "released",
      purpose: lease.purpose,
    };
    if (!this.hasRuntimeDemand()) {
      this.cancelRestart();
      if (this.startupPromise) {
        await this.cancelUndemandedStartup();
      } else {
        this.scheduleIdleShutdown();
      }
    }
    this.syncDesiredState();
  }

  public async start(reason = "manual"): Promise<LlamaCppRuntimeStatus> {
    if (this.disposed) {
      throw new Error("llama.cpp runtime service is closed");
    }
    await this.awaitStableLifecycle();
    if (this.disposed) {
      throw new Error("llama.cpp runtime service is closed");
    }
    const demand = classifyPersistentDemand(reason, this.options.config.autoStart);
    if (demand) {
      this.persistentDemand.add(demand);
    }
    this.cancelIdleShutdown();
    this.syncDesiredState();
    const generation = this.lifecycleGeneration;
    await this.awaitIdleShutdown();
    this.assertLifecycleGeneration(generation);
    return this.ensureStarted(reason, classifyStartEvidenceReason(reason));
  }

  private ensureStarted(reason: string, evidenceReason: LlamaCppStartEvidenceReason): Promise<LlamaCppRuntimeStatus> {
    const activeStartup = this.startupPromise;
    if (activeStartup) {
      if (!this.startupAbortController?.signal.aborted) {
        return activeStartup;
      }
      const requestGeneration = this.lifecycleGeneration;
      const replacement = activeStartup
        .catch(() => undefined)
        .then(() => {
          if (this.disposed || this.closed || requestGeneration !== this.lifecycleGeneration) {
            throw createRuntimeStartSupersededError();
          }
          if (reason === "lease" && !this.hasRuntimeDemand()) {
            throw createLeaseAbortError();
          }
          if (reason === "restart" && !this.hasRuntimeDemand()) {
            throw createRuntimeStartSupersededError();
          }
          if (this.startupPromise && this.startupPromise !== activeStartup) {
            return this.ensureStarted(reason, evidenceReason);
          }
          return this.beginStartup(reason, evidenceReason);
        });
      this.trackQueuedStartup(replacement);
      return replacement;
    }
    return this.beginStartup(reason, evidenceReason);
  }

  private beginStartup(reason: string, evidenceReason: LlamaCppStartEvidenceReason): Promise<LlamaCppRuntimeStatus> {
    const generation = this.lifecycleGeneration;
    const abortController = new AbortController();
    this.startupAbortController = abortController;
    const requestedAt = new Date().toISOString();
    this.leaseEvidence.lastStart = { at: requestedAt, reason: evidenceReason, outcome: "requested" };
    const startup = this.startCore(reason, generation, abortController.signal);
    this.startupPromise = startup;
    void startup.then(
      () => {
        if (this.startupPromise === startup) {
          this.startupPromise = undefined;
          this.startupAbortController = undefined;
        }
        if (generation !== this.lifecycleGeneration) {
          return;
        }
        this.leaseEvidence.lastStart = {
          at: new Date().toISOString(),
          reason: evidenceReason,
          outcome: "ready",
        };
        if (!this.hasRuntimeDemand()) {
          this.scheduleIdleShutdown();
        }
      },
      () => {
        if (this.startupPromise === startup) {
          this.startupPromise = undefined;
          this.startupAbortController = undefined;
        }
        if (generation !== this.lifecycleGeneration) {
          return;
        }
        this.leaseEvidence.lastStart = {
          at: new Date().toISOString(),
          reason: evidenceReason,
          outcome: "failed",
        };
      },
    );
    return startup;
  }

  private async startCore(reason: string, generation: number, signal: AbortSignal): Promise<LlamaCppRuntimeStatus> {
    this.assertLifecycleGeneration(generation);
    this.closed = false;

    if (!this.options.config.enabled) {
      throw new Error("llama.cpp runtime is disabled in assistant config");
    }

    let ownedStartAttemptPrepared = false;
    if (this.process?.pid) {
      this.ownedProcessTree ??= { child: this.process, pid: this.process.pid };
      const status = await waitForPromiseWithSignal(this.refresh(), signal);
      this.assertLifecycleGeneration(generation);
      if (status.healthy) {
        return status;
      }
      await this.prepareOwnedStartAttempt("unhealthy_restart");
      ownedStartAttemptPrepared = true;
      this.assertLifecycleGeneration(generation);
    }

    const observed = await waitForPromiseWithSignal(
      this.readRemoteHealth().catch(() => undefined),
      signal,
    );
    this.assertLifecycleGeneration(generation);
    if (observed?.healthy) {
      this.ownership = this.ownedProcessTree || this.process?.pid ? "owned" : "external";
      this.processState = "running";
      this.healthy = true;
      this.activeModelId = observed.activeModelId ?? this.options.config.launch.alias;
      this.lastError = undefined;
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      return this.getStatus();
    }

    // Count every owned-start attempt before validating launch inputs. A model or
    // executable can disappear after a healthy process crashes; if those failures
    // do not consume budget, the crash-restart loop can reschedule forever.
    if (!ownedStartAttemptPrepared) {
      await this.prepareOwnedStartAttempt(this.ownedProcessTree ? "orphaned_process_tree" : undefined);
      this.assertLifecycleGeneration(generation);
    }

    const modelPath = resolveConfiguredPath(this.options.rootDir, this.options.config.launch.modelPath);
    if (!modelPath) {
      throw new Error("llama.cpp launch.modelPath must be configured before starting the runtime");
    }
    if (!fsSync.existsSync(modelPath)) {
      throw new Error(`llama.cpp model path does not exist: ${modelPath}`);
    }

    const commandResolution = await waitForPromiseWithSignal(
      resolveLlamaCppCommand(this.options.config.server.command),
      signal,
    );
    this.assertLifecycleGeneration(generation);
    this.lastCommand = commandResolution.command;
    this.lastCommandSource = commandResolution.source;
    if (!commandResolution.command) {
      throw new Error(
        "Unable to find llama-server. Set assistant.llamaCpp.server.command or add llama-server to PATH.",
      );
    }

    this.processState = "starting";
    this.healthy = false;
    this.lastError = undefined;
    this.updatedAt = new Date().toISOString();
    this.emit("llamacpp_starting", { reason, command: commandResolution.command });
    await this.persistState();
    throwIfAborted(signal);
    this.assertLifecycleGeneration(generation);

    const spawnProcess = this.options.runtimeHooks?.spawnProcess ?? spawn;
    const child = spawnProcess(
      commandResolution.command,
      buildLlamaCppLaunchArgs(this.options.rootDir, this.options.config),
      {
        cwd: this.options.rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    child.on("error", (error) => {
      const belongsToCurrentLifecycle =
        generation === this.lifecycleGeneration &&
        (this.process === child || (!child.pid && !this.process && !this.ownedProcessTree));
      if (belongsToCurrentLifecycle) {
        this.lastError = error.message;
        this.processState = "error";
        this.healthy = false;
        this.activeModelId = undefined;
        this.updatedAt = new Date().toISOString();
        this.persistStateBestEffort("spawn_error");
      }
      this.emit("llamacpp_spawn_error", { message: error.message });
    });
    this.process = child;
    if (!child.pid) {
      this.process = null;
      this.processState = "error";
      this.healthy = false;
      this.lastError = "llama.cpp server spawn did not return a process identifier";
      this.updatedAt = new Date().toISOString();
      try {
        child.kill("SIGKILL");
      } catch (error) {
        this.emit("llamacpp_spawn_cleanup_error", { message: normalizeErrorMessage(error) });
      }
      await this.persistState();
      throw new Error(this.lastError);
    }
    this.ownedProcessTree = { child, pid: child.pid };
    this.ownership = "owned";

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
    child.on("exit", (code, signal) => {
      const isCurrentProcess = this.process === child;
      if (isCurrentProcess) {
        this.process = null;
        this.ownership = this.ownedProcessTree?.child === child ? "owned" : "none";
      }
      const unexpected =
        isCurrentProcess && !this.intentionalExits.has(child) && !this.closed && this.hasRuntimeDemand();
      if (!isCurrentProcess) {
        return;
      }
      this.leaseEvidence.lastExit = {
        at: new Date().toISOString(),
        unexpected,
        ...(typeof code === "number" ? { code } : {}),
        ...(signal ? { signal } : {}),
      };
      this.processState = unexpected ? "error" : "stopped";
      this.healthy = false;
      this.activeModelId = undefined;
      this.updatedAt = new Date().toISOString();
      if (unexpected) {
        this.lastError = `llama.cpp server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.emit("llamacpp_exited", {
          unexpected: true,
          code,
          signal,
          message: this.lastError,
        });
        this.persistStateBestEffort("unexpected_exit");
        this.scheduleRestart();
      } else {
        this.emit("llamacpp_exited", { unexpected: false, code, signal });
        this.persistStateBestEffort("expected_exit");
      }
    });

    try {
      const healthy = await this.waitForHealthy(this.options.config.server.startTimeoutMs, signal);
      this.assertLifecycleGeneration(generation);
      if (!healthy) {
        this.processState = "error";
        this.healthy = false;
        this.lastError = "llama.cpp server did not become healthy within timeout";
        this.updatedAt = new Date().toISOString();
        await this.persistState();
        await this.stopOwnedProcess("startup_timeout");
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
    } catch (error) {
      if (this.process === child) {
        await this.stopOwnedProcess("startup_failed").catch(() => undefined);
      }
      throw error;
    }
  }

  public stop(reason = "manual", options: { force?: boolean } = {}): Promise<LlamaCppRuntimeStatus> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const stopping = this.stopCore(reason, options);
    const tracked = stopping.finally(() => {
      if (this.stopPromise === tracked) {
        this.stopPromise = undefined;
      }
    });
    this.stopPromise = tracked;
    return tracked;
  }

  private async stopCore(reason: string, options: { force?: boolean }): Promise<LlamaCppRuntimeStatus> {
    const force = options.force === true || this.disposed;
    if (this.leases.size > 0 && !force) {
      throw new Error(`Cannot stop llama.cpp runtime while ${this.leases.size} active lease(s) are in use`);
    }
    this.lifecycleGeneration += 1;
    this.startupAbortController?.abort();
    this.closed = true;
    this.persistentDemand.clear();
    if (force) {
      this.settleLeases();
    }
    this.cancelIdleShutdown();
    this.cancelRestart();
    this.syncDesiredState();

    const pendingStateLoad = this.stateLoadPromise;
    if (pendingStateLoad) {
      await pendingStateLoad.catch(() => undefined);
    } else {
      // A stop is authoritative and must not be overwritten later by a cold,
      // stale cache read that had not started yet.
      this.stateLoaded = true;
    }
    await this.awaitStartupQuiescence();
    await this.awaitIdleShutdown();
    await this.stopOwnedProcess(reason);
    return this.getStatus();
  }

  private async stopOwnedProcess(reason: string): Promise<void> {
    const ownedTree = this.ownedProcessTree;
    if (!ownedTree) {
      if (this.disposed) {
        this.processState = "stopped";
        this.healthy = false;
        this.activeModelId = undefined;
        this.ownership = "none";
        this.updatedAt = new Date().toISOString();
        await this.persistState();
        return;
      }
      const token = this.captureLifecycleObservationToken();
      const health = await this.readRemoteHealth(token).catch(() => undefined);
      if (!this.isLifecycleObservationCurrent(token)) {
        return;
      }
      this.processState = health?.healthy ? "running" : "stopped";
      this.healthy = health?.healthy ?? false;
      this.activeModelId = health?.healthy ? health.activeModelId : undefined;
      this.ownership = health?.healthy ? "external" : "none";
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      return;
    }

    const running = ownedTree.child;
    this.intentionalExits.add(running);
    this.emit("llamacpp_stopping", { reason, pid: ownedTree.pid });
    try {
      if (this.options.runtimeHooks?.terminateOwnedProcess) {
        await this.options.runtimeHooks.terminateOwnedProcess(running);
      } else if (process.platform === "win32") {
        await killWindowsProcessTree(ownedTree.pid);
      } else {
        await terminatePosixProcess(running, ownedTree.pid);
      }
    } catch (error) {
      this.lastError = `Failed to terminate owned llama.cpp process tree: ${normalizeErrorMessage(error)}`;
      this.processState = "error";
      this.healthy = false;
      this.activeModelId = undefined;
      this.ownership = "owned";
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      throw error;
    }

    if (this.process === running) {
      this.process = null;
    }
    if (this.ownedProcessTree === ownedTree) {
      this.ownedProcessTree = null;
    }
    this.ownership = "none";
    this.processState = "stopped";
    this.healthy = false;
    this.activeModelId = undefined;
    this.updatedAt = new Date().toISOString();
    await this.persistState();
  }

  public async refresh(): Promise<LlamaCppRuntimeStatus> {
    if (this.disposed) {
      return this.getStatus();
    }
    await this.awaitStableLifecycle();
    if (this.disposed) {
      return this.getStatus();
    }
    return this.refreshCore();
  }

  private refreshCore(): Promise<LlamaCppRuntimeStatus> {
    const refreshing = this.refreshCoreTracked();
    this.refreshPromises.add(refreshing);
    void refreshing.finally(() => this.refreshPromises.delete(refreshing)).catch(() => undefined);
    return refreshing;
  }

  private async refreshCoreTracked(): Promise<LlamaCppRuntimeStatus> {
    const token = this.captureLifecycleObservationToken();
    const health = await this.readRemoteHealth(token).catch(() => undefined);
    if (!this.isLifecycleObservationCurrent(token)) {
      return this.getStatus();
    }
    if (!health?.healthy) {
      if (!this.process?.pid && this.desiredState === "stopped") {
        this.processState = "stopped";
      } else if (this.ownedProcessTree || this.process?.pid) {
        this.processState = "error";
      }
      this.ownership = this.ownedProcessTree || this.process?.pid ? "owned" : "none";
      this.healthy = false;
      this.activeModelId = undefined;
      this.updatedAt = new Date().toISOString();
      await this.persistState();
      return this.getStatus();
    }

    this.healthy = true;
    this.processState = "running";
    this.ownership = this.ownedProcessTree || this.process?.pid ? "owned" : "external";
    this.activeModelId = health.activeModelId ?? this.options.config.launch.alias;
    this.lastError = undefined;
    this.updatedAt = new Date().toISOString();
    await this.persistState();
    return this.getStatus();
  }

  public async listModels(): Promise<LlamaCppModelManifest[]> {
    const localModels = await this.listLocalModels();
    if (localModels.length > 0) {
      return localModels;
    }
    return this.listRemoteModels();
  }

  private async listRemoteModels(config: LlamaCppConfig = this.options.config): Promise<LlamaCppModelManifest[]> {
    const url = joinUrl(normalizeLlamaCppServerRoot(config.server.baseUrl), config.server.modelsPath);
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(config.server.requestTimeoutMs),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`llama.cpp model listing failed (${response.status})`);
    }
    const payload = await readBoundedResponseJson<{
      data?: Array<Record<string, unknown>>;
      models?: Array<Record<string, unknown>>;
    }>(response, {
      maxBytes: 512 * 1024,
      timeoutMs: config.server.requestTimeoutMs,
      label: "llama.cpp models",
    });
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

  private async listLocalModels(): Promise<LlamaCppModelManifest[]> {
    const modelsRoot = resolveLlamaCppModelsRoot(this.options.rootDir, this.options.config);
    if (!fsSync.existsSync(modelsRoot)) {
      return [];
    }
    const files = await discoverLlamaCppModelFiles(modelsRoot, MAX_DISCOVERED_LLAMACPP_MODELS);
    return files.map((file) => ({
      modelId: file.relativeId,
      filePath: file.filePath,
      relativePath: file.relativePath,
      source: "filesystem",
    }));
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
    const running = [...this.hfDownloadJobs.values()].find(
      (job) => job.status === "queued" || job.status === "running",
    );
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
    void this.runHuggingFaceDownload(jobId, input).catch((error: unknown) => {
      const failedAt = new Date().toISOString();
      this.updateHuggingFaceDownloadJob(jobId, {
        status: "failed",
        stage: "done",
        error: normalizeErrorMessage(error),
        updatedAt: failedAt,
        completedAt: failedAt,
      });
      this.hfDownloadControllers.delete(jobId);
    });
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
      const targetDir = path.join(
        resolveLlamaCppModelsRoot(this.options.rootDir, this.options.config),
        sanitizeHuggingFaceRepo(repo),
      );
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

  private updateHuggingFaceDownloadJob(jobId: string, patch: Partial<LlamaCppHuggingFaceDownloadJobStatus>): void {
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

  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const closing = this.closeCore();
    const tracked = closing.catch((error) => {
      if (this.closePromise === tracked) {
        this.closePromise = undefined;
      }
      throw error;
    });
    this.closePromise = tracked;
    return tracked;
  }

  private async closeCore(): Promise<void> {
    this.disposed = true;
    const inProgressStop = this.stopPromise;
    if (inProgressStop) {
      await inProgressStop.catch(() => undefined);
    }
    await this.stop("shutdown", { force: true });
    await this.initPromise?.catch(() => undefined);
    await this.awaitRefreshQuiescence();
    await this.awaitStartupQuiescence();
  }

  private async readRemoteHealth(
    token: LlamaCppLifecycleObservationToken = this.captureLifecycleObservationToken(),
  ): Promise<LlamaCppHealthObservation> {
    const config = structuredClone(this.options.config);
    try {
      const observation = this.options.runtimeHooks?.probeHealth
        ? await this.options.runtimeHooks.probeHealth()
        : await this.readRemoteHealthFromNetwork(config);
      if (this.isLifecycleObservationCurrent(token)) {
        this.leaseEvidence.lastProbe = { at: new Date().toISOString(), healthy: observation.healthy };
      }
      return observation;
    } catch (error) {
      if (this.isLifecycleObservationCurrent(token)) {
        this.leaseEvidence.lastProbe = { at: new Date().toISOString(), healthy: false };
      }
      throw error;
    }
  }

  private async readRemoteHealthFromNetwork(config: LlamaCppConfig): Promise<LlamaCppHealthObservation> {
    const healthUrl = joinUrl(normalizeLlamaCppServerRoot(config.server.baseUrl), config.server.healthPath);
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(config.server.requestTimeoutMs),
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`llama.cpp health check failed (${response.status})`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    let activeModelId = normalizeOptionalText(config.launch.alias);
    if (contentType.includes("json")) {
      const payload = await readBoundedResponseJson<Record<string, unknown>>(response, {
        maxBytes: 128 * 1024,
        timeoutMs: config.server.requestTimeoutMs,
        label: "llama.cpp health",
      });
      const modelAlias = typeof payload["model_alias"] === "string" ? payload["model_alias"] : undefined;
      const modelName = typeof payload["model"] === "string" ? payload["model"] : undefined;
      activeModelId = normalizeOptionalText(modelAlias) ?? normalizeOptionalText(modelName) ?? activeModelId;
    } else {
      await readBoundedResponseText(response, {
        maxBytes: 128 * 1024,
        timeoutMs: config.server.requestTimeoutMs,
        label: "llama.cpp health",
      });
    }

    try {
      const models = await this.listRemoteModels(config);
      activeModelId = models[0]?.modelId ?? activeModelId;
    } catch {
      // keep alias fallback
    }

    return {
      healthy: true,
      activeModelId,
    };
  }

  private async waitForHealthy(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      if (this.closed) {
        return false;
      }
      const status = await waitForPromiseWithSignal(
        this.refresh().catch(() => undefined),
        signal,
      );
      if (status?.healthy) {
        return true;
      }
      await waitForPromiseWithSignal(sleep(500), signal);
    }
    return false;
  }

  private ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) {
      return Promise.resolve();
    }
    if (this.stateLoadPromise) {
      return this.stateLoadPromise;
    }
    const loading = this.loadCachedState();
    this.stateLoadPromise = loading;
    void loading.then(
      () => {
        this.stateLoaded = true;
      },
      () => {
        if (this.stateLoadPromise === loading) {
          this.stateLoadPromise = undefined;
        }
      },
    );
    return loading;
  }

  private async loadCachedState(): Promise<void> {
    const token = this.captureLifecycleObservationToken();
    try {
      const raw = await fs.readFile(this.stateCachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LlamaCppRuntimeStateCache>;
      if (
        !this.isLifecycleObservationCurrent(token) ||
        parsed.runtimeIdentityFingerprint !== token.identityFingerprint
      ) {
        return;
      }
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

  private persistState(): Promise<void> {
    const payload = this.getStatus();
    const cachePayload: LlamaCppRuntimeStateCache = {
      ...payload,
      runtimeIdentityFingerprint: llamaCppRuntimeIdentityFingerprint(this.options.config),
    };
    const write = this.persistTail
      .catch(() => undefined)
      .then(async () => {
        if (this.options.runtimeHooks?.persistState) {
          await this.options.runtimeHooks.persistState(this.stateCachePath, payload);
          return;
        }
        await fs.mkdir(path.dirname(this.stateCachePath), { recursive: true });
        await fs.writeFile(this.stateCachePath, `${JSON.stringify(cachePayload, null, 2)}\n`, "utf8");
      });
    this.persistTail = write;
    return write;
  }

  private persistStateBestEffort(context: string): void {
    void this.persistState().catch((error) => {
      try {
        this.emit("llamacpp_state_persist_failed", {
          context,
          message: normalizeErrorMessage(error).slice(0, 500),
        });
      } catch {
        // Persistence is best-effort on event callbacks; never create a second
        // unhandled failure while reporting the first one.
      }
    });
  }

  private emit(eventType: string, payload: Record<string, unknown>): void {
    if (!this.options.onEvent) return;
    const reportFailure = (error: unknown) => {
      // Process callbacks cannot await retained-event persistence. Surface a
      // failed delivery without recursively publishing another realtime event.
      // eslint-disable-next-line no-console -- Last-resort sink when the configured lifecycle event reporter itself fails.
      console.warn("[goatcitadel] llama.cpp lifecycle event persistence failed", {
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    try {
      const pending = this.options.onEvent(eventType, payload);
      void Promise.resolve(pending).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  }

  private buildLeaseDiagnostics(): LlamaCppRuntimeLeaseDiagnostics {
    const purposeCounts = new Map<string, number>();
    for (const lease of this.leases.values()) {
      purposeCounts.set(lease.purpose, (purposeCounts.get(lease.purpose) ?? 0) + 1);
    }
    const purposes = [...purposeCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_LLAMACPP_LEASE_PURPOSES)
      .map(([purpose, count]) => ({ purpose, count }));
    return {
      state:
        this.disposed || this.closed
          ? "closed"
          : this.startupPromise || this.processState === "starting"
            ? "starting"
            : this.leases.size > 0
              ? "active"
              : this.idleTimer
                ? "idle_pending"
                : this.persistentDemand.size > 0
                  ? "persistent"
                  : "idle",
      activeLeaseCount: this.leases.size,
      ownership: this.ownership,
      idleDeadline: this.idleDeadline,
      purposes,
      persistentDemand: {
        manual: this.persistentDemand.has("manual"),
        api: this.persistentDemand.has("api"),
        autostart: this.persistentDemand.has("autostart"),
      },
      evidence: structuredClone(this.leaseEvidence),
    };
  }

  private hasRuntimeDemand(): boolean {
    return this.leases.size > 0 || this.persistentDemand.size > 0;
  }

  private async awaitStableLifecycle(signal?: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const stopping = this.stopPromise;
      if (stopping) {
        await waitForPromiseWithSignal(
          stopping.then(() => undefined),
          signal,
        );
        continue;
      }
      const generation = this.lifecycleGeneration;
      await waitForPromiseWithSignal(this.ensureStateLoaded(), signal);
      if (!this.stopPromise && generation === this.lifecycleGeneration) {
        return;
      }
    }
  }

  private trackQueuedStartup(startup: Promise<LlamaCppRuntimeStatus>): void {
    this.queuedStartupPromises.add(startup);
    void startup.finally(() => this.queuedStartupPromises.delete(startup)).catch(() => undefined);
  }

  private async awaitStartupQuiescence(): Promise<void> {
    while (true) {
      const pending = [...(this.startupPromise ? [this.startupPromise] : []), ...this.queuedStartupPromises];
      if (pending.length === 0) {
        return;
      }
      await Promise.allSettled(pending);
    }
  }

  private async awaitRefreshQuiescence(): Promise<void> {
    while (this.refreshPromises.size > 0) {
      await Promise.allSettled([...this.refreshPromises]);
    }
  }

  private captureLifecycleObservationToken(): LlamaCppLifecycleObservationToken {
    return {
      generation: this.lifecycleGeneration,
      identityFingerprint: llamaCppRuntimeIdentityFingerprint(this.options.config),
      process: this.process,
      ownedProcessTree: this.ownedProcessTree,
    };
  }

  private isLifecycleObservationCurrent(token: LlamaCppLifecycleObservationToken): boolean {
    return (
      !this.disposed &&
      token.generation === this.lifecycleGeneration &&
      token.identityFingerprint === llamaCppRuntimeIdentityFingerprint(this.options.config) &&
      token.process === this.process &&
      token.ownedProcessTree === this.ownedProcessTree
    );
  }

  private syncDesiredState(): void {
    this.desiredState =
      !this.options.config.enabled || this.closed
        ? "stopped"
        : this.hasRuntimeDemand() || Boolean(this.idleTimer)
          ? "running"
          : "stopped";
  }

  private settleLeases(): void {
    const lastLease = [...this.leases.values()].at(-1);
    if (lastLease) {
      this.leaseEvidence.lastLease = {
        at: new Date().toISOString(),
        action: "settled",
        purpose: lastLease.purpose,
      };
    }
    this.leases.clear();
  }

  private scheduleIdleShutdown(delayMs?: number): void {
    if (this.disposed || this.closed || this.hasRuntimeDemand() || this.idleTimer) {
      return;
    }
    if (this.ownership !== "owned" && !this.startupPromise) {
      this.syncDesiredState();
      return;
    }
    const timeoutMs =
      delayMs === undefined
        ? normalizeLeaseIdleTimeoutMs(this.options.leaseIdleTimeoutMs)
        : Math.max(0, Math.floor(delayMs));
    this.idleDeadline = new Date(Date.now() + timeoutMs).toISOString();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.idleDeadline = undefined;
      const shutdown = this.handleIdleShutdown();
      this.idleShutdownPromise = shutdown;
      void shutdown.then(
        () => {
          if (this.idleShutdownPromise === shutdown) {
            this.idleShutdownPromise = undefined;
          }
        },
        (error) => {
          if (this.idleShutdownPromise === shutdown) {
            this.idleShutdownPromise = undefined;
          }
          this.lastError = error instanceof Error ? error.message : String(error);
          this.processState = this.ownedProcessTree || this.process?.pid ? "error" : "stopped";
          this.healthy = false;
          this.activeModelId = undefined;
          this.updatedAt = new Date().toISOString();
          this.emit("llamacpp_idle_shutdown_failed", { message: this.lastError });
          this.persistStateBestEffort("idle_shutdown_failure");
        },
      );
    }, timeoutMs);
    this.idleTimer.unref();
    this.syncDesiredState();
  }

  private cancelIdleShutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.idleDeadline = undefined;
  }

  private async awaitIdleShutdown(): Promise<void> {
    const shutdown = this.idleShutdownPromise;
    if (shutdown) {
      await shutdown.catch(() => undefined);
    }
  }

  private async handleIdleShutdown(): Promise<void> {
    const pendingStartup = this.startupPromise;
    if (pendingStartup) {
      await pendingStartup.catch(() => undefined);
    }
    if (this.disposed || this.closed || this.hasRuntimeDemand()) {
      this.syncDesiredState();
      return;
    }
    if (this.ownership === "owned") {
      await this.stopOwnedProcess("lease_idle_timeout");
    }
    this.syncDesiredState();
    await this.persistState();
  }

  private async cancelUndemandedStartup(): Promise<void> {
    if (!this.startupPromise || this.hasRuntimeDemand()) {
      return;
    }
    if (this.processState === "running" && this.healthy) {
      this.scheduleIdleShutdown();
      return;
    }
    const pendingStartup = this.startupPromise;
    this.lifecycleGeneration += 1;
    this.startupAbortController?.abort();
    this.cancelIdleShutdown();
    this.cancelRestart();
    this.syncDesiredState();
    await pendingStartup.catch(() => undefined);
    if (this.ownedProcessTree) {
      await this.stopOwnedProcess("lease_start_cancelled");
    } else {
      this.processState = "stopped";
      this.healthy = false;
      this.ownership = "none";
      this.updatedAt = new Date().toISOString();
      await this.persistState();
    }
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private assertLifecycleGeneration(generation: number): void {
    if (this.disposed || generation !== this.lifecycleGeneration) {
      throw new Error("llama.cpp runtime start was superseded by a forced transition");
    }
  }

  private assertRestartBudget(): void {
    const now = Date.now();
    const windowMs = this.options.config.server.restartBudget.windowMs;
    this.restartTimestamps = this.restartTimestamps.filter((timestamp) => now - timestamp <= windowMs);
    if (this.restartTimestamps.length >= this.options.config.server.restartBudget.maxRestarts) {
      throw new LlamaCppRestartBudgetExhaustedError();
    }
  }

  private bumpRestartCounter(): void {
    this.restartTimestamps.push(Date.now());
  }

  private async prepareOwnedStartAttempt(cleanupReason?: string): Promise<void> {
    let exhausted = false;
    try {
      this.assertRestartBudget();
    } catch (error) {
      if (!(error instanceof LlamaCppRestartBudgetExhaustedError)) {
        throw error;
      }
      exhausted = true;
    }
    if (!exhausted) {
      this.bumpRestartCounter();
    }

    if (cleanupReason && this.ownedProcessTree) {
      try {
        await this.stopOwnedProcess(cleanupReason);
      } catch (error) {
        if (exhausted) {
          throw new LlamaCppRestartBudgetExhaustedError();
        }
        throw error;
      }
    }
    if (exhausted) {
      throw new LlamaCppRestartBudgetExhaustedError();
    }
  }

  private scheduleRestart(): void {
    const restartDemand = this.hasRuntimeDemand() || (this.desiredState === "running" && !this.idleTimer);
    if (this.restartTimer || this.closed || !restartDemand) {
      return;
    }
    this.leaseEvidence.lastRestart = { at: new Date().toISOString(), outcome: "scheduled" };
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closed || this.disposed || !this.hasRuntimeDemand()) {
        this.syncDesiredState();
        this.persistStateBestEffort("restart_cancelled");
        return;
      }
      const generation = this.lifecycleGeneration;
      this.leaseEvidence.lastRestart = { at: new Date().toISOString(), outcome: "attempting" };
      void this.ensureStarted("restart", "restart").then(
        () => {
          if (generation !== this.lifecycleGeneration) {
            return;
          }
          this.leaseEvidence.lastRestart = { at: new Date().toISOString(), outcome: "ready" };
        },
        (error) => {
          if (generation !== this.lifecycleGeneration) {
            return;
          }
          const exhausted = error instanceof LlamaCppRestartBudgetExhaustedError;
          this.leaseEvidence.lastRestart = {
            at: new Date().toISOString(),
            outcome: exhausted ? "exhausted" : "failed",
          };
          this.lastError = error instanceof Error ? error.message : String(error);
          this.processState = "error";
          this.healthy = false;
          this.updatedAt = new Date().toISOString();
          this.persistStateBestEffort("restart_failure");
          if (!exhausted) {
            this.scheduleRestart();
          }
        },
      );
    }, this.options.config.server.restartBudget.backoffMs);
    this.restartTimer.unref();
  }
}

class LlamaCppRestartBudgetExhaustedError extends Error {
  public constructor() {
    super("llama.cpp restart budget exhausted");
    this.name = "LlamaCppRestartBudgetExhaustedError";
  }
}

function normalizeLeasePurpose(value: string): string {
  const purpose = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(purpose)) {
    throw new Error("llama.cpp lease purpose must be a 1-64 character diagnostic label");
  }
  return purpose;
}

function normalizeLeaseIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LLAMACPP_LEASE_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return DEFAULT_LLAMACPP_LEASE_IDLE_TIMEOUT_MS;
  }
  return Math.max(0, Math.min(Math.floor(value), 24 * 60 * 60 * 1000));
}

function persistentDemandFromSnapshot(snapshot: LlamaCppRuntimeLifecycleSnapshot): LlamaCppPersistentDemand[] {
  const demand: LlamaCppPersistentDemand[] = [];
  if (snapshot.persistentDemand.manual) {
    demand.push("manual");
  }
  if (snapshot.persistentDemand.api) {
    demand.push("api");
  }
  if (snapshot.persistentDemand.autostart) {
    demand.push("autostart");
  }
  return demand;
}

function hasLlamaCppRuntimeIdentityChanged(current: LlamaCppConfig, next: LlamaCppConfig): boolean {
  return JSON.stringify(llamaCppRuntimeIdentity(current)) !== JSON.stringify(llamaCppRuntimeIdentity(next));
}

function llamaCppRuntimeIdentity(config: LlamaCppConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    baseUrl: config.server.baseUrl,
    command: config.server.command,
    extraArgs: config.server.extraArgs,
    healthPath: config.server.healthPath,
    modelsPath: config.server.modelsPath,
    launch: config.launch,
  };
}

function llamaCppRuntimeIdentityFingerprint(config: LlamaCppConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(llamaCppRuntimeIdentity(config)))
    .digest("hex");
}

function classifyPersistentDemand(reason: string, autoStart: boolean): LlamaCppPersistentDemand | undefined {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "lease" || normalized === "restart" || normalized === "rollback") {
    return undefined;
  }
  if (normalized === "api") {
    return "api";
  }
  if (normalized === "auto_start" || normalized === "config_autostart") {
    return "autostart";
  }
  if (autoStart && normalized !== "manual") {
    return "autostart";
  }
  return "manual";
}

function classifyStartEvidenceReason(reason: string): LlamaCppStartEvidenceReason {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "manual" || normalized === "api" || normalized === "lease" || normalized === "restart") {
    return normalized;
  }
  if (normalized === "auto_start" || normalized === "config_autostart") {
    return "autostart";
  }
  return "other";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createLeaseAbortError();
}

function createLeaseAbortError(): Error {
  const error = new Error("llama.cpp lease acquisition was aborted");
  error.name = "AbortError";
  return error;
}

function createRuntimeStartSupersededError(): Error {
  return new Error("llama.cpp runtime start was superseded by a forced transition");
}

function waitForPromiseWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createLeaseAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
    const totalBytes = coerceHttpContentLength(response.headers.get("content-length"), {
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
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
    // Only clean up the partial temp file. The atomic rename mutates destinationPath solely
    // on full success, so a failed (re-)download must never delete a previously-good model.
    await fs.rm(tempPath, { force: true });
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

function resolveLlamaCppModelsRoot(rootDir: string, config: LlamaCppConfig | ContractLlamaCppConfig): string {
  return resolveConfiguredPath(rootDir, config.launch.modelsRootPath) ?? path.resolve(rootDir, "models", "llamacpp");
}

async function discoverLlamaCppModelFiles(
  modelsRoot: string,
  limit: number,
): Promise<Array<{ filePath: string; relativePath: string; relativeId: string }>> {
  const queue = [modelsRoot];
  const discovered: Array<{ filePath: string; relativePath: string; relativeId: string }> = [];

  while (queue.length > 0 && discovered.length < limit) {
    const currentDir = queue.shift();
    if (!currentDir) {
      break;
    }

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (discovered.length >= limit) {
        break;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) {
        continue;
      }
      const relativePath = path.relative(modelsRoot, fullPath).replaceAll("\\", "/");
      const relativeId = relativePath.replace(/\.gguf$/i, "");
      discovered.push({
        filePath: fullPath,
        relativePath,
        relativeId,
      });
    }
  }

  return discovered.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

type PosixSignalTarget = "group" | "process" | "gone";

export interface PosixTerminationHooks {
  signalTree?: (pid: number, signal: NodeJS.Signals) => PosixSignalTarget;
  waitForTreeExit?: (
    child: ChildProcess,
    pid: number,
    target: Exclude<PosixSignalTarget, "gone">,
    timeoutMs: number,
  ) => Promise<boolean>;
}

export async function terminatePosixProcess(
  child: ChildProcess,
  pid: number,
  hooks: PosixTerminationHooks = {},
): Promise<void> {
  const signalTree = hooks.signalTree ?? signalPosixProcessTree;
  const waitForTreeExit = hooks.waitForTreeExit ?? waitForPosixTreeExit;
  const termTarget = signalTree(pid, "SIGTERM");
  if (termTarget === "gone" || (await waitForTreeExit(child, pid, termTarget, 5_000))) {
    return;
  }

  const killTarget = signalTree(pid, "SIGKILL");
  if (killTarget === "gone" || (await waitForTreeExit(child, pid, killTarget, 1_000))) {
    return;
  }

  throw new Error(`llama.cpp process tree ${pid} remained alive after SIGKILL`);
}

function signalPosixProcessTree(pid: number, signal: NodeJS.Signals): PosixSignalTarget {
  try {
    process.kill(-pid, signal);
    return "group";
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
  }

  try {
    process.kill(pid, signal);
    return "process";
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return "gone";
    }
    throw error;
  }
}

function waitForPosixTreeExit(
  child: ChildProcess,
  pid: number,
  target: Exclude<PosixSignalTarget, "gone">,
  timeoutMs: number,
): Promise<boolean> {
  return target === "group" ? waitForProcessGroupExit(pid, timeoutMs) : waitForChildExit(child, timeoutMs);
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessGroupAlive(pid)) {
      return true;
    }
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    if (isNodeErrorWithCode(error, "EPERM")) {
      return true;
    }
    throw error;
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return isNodeErrorWithCode(error, "ESRCH");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
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
