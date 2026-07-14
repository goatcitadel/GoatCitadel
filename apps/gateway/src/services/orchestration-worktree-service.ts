import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@goatcitadel/gateway-core";
import { WorktreeManager } from "@goatcitadel/orchestration";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import { type OrchestrationRun, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { OrchestrationWorktreeLeaseRecord, OrchestrationWorktreeLeaseToken } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
import { DurableWorkerInterruptionError } from "./durable-run-service.js";

const log = logger.child("orchestration-worktree-service");
const DEFAULT_WORKTREE_LEASE_DURATION_MS = 5 * 60 * 1000;

export type OrchestrationWorktreeReleaseReason = "completed" | "failed" | "stopped_by_limit" | "cancelled";

export interface OrchestrationWorktreeServiceDeps {
  readonly config: Pick<GatewayRuntimeConfig, "rootDir" | "assistant" | "toolPolicy">;
  readonly orchestrationRuns: Pick<
    Storage["orchestration"],
    "adoptWorktreeLease" | "fenceWorktreeLease" | "listRuns" | "renewWorktreeLease"
  >;
  readonly worktreeLeases: Pick<Storage["orchestrationWorktreeLeases"], "get" | "claim" | "renew" | "release">;
  readonly ownerId?: string;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number | false;
  readonly now?: () => string;
  readonly onLeaseLost?: (event: OrchestrationWorktreeLeaseLossEvent) => void;
}

export interface OrchestrationWorktreeAllocation {
  worktreePath: string;
  worktreeStatus: NonNullable<OrchestrationRun["worktreeStatus"]>;
  worktreeBaseRef: string;
  worktreeLeaseOwnerId: string;
  worktreeLeaseGeneration: number;
  worktreeLeaseExpiresAt: string;
}

export interface OrchestrationWorktreeLeaseLossEvent {
  token: OrchestrationWorktreeLeaseToken;
  reason: "lease_renewal_rejected" | "run_lease_fence_rejected" | "lease_renewal_error";
  error?: string;
  fencedRun?: OrchestrationRun;
}

export class OrchestrationWorktreeService {
  private readonly ownerId: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs?: number;
  private readonly leaseHeartbeats = new Map<
    string,
    { token: OrchestrationWorktreeLeaseToken; timer: ReturnType<typeof setInterval> }
  >();

  public constructor(private readonly deps: OrchestrationWorktreeServiceDeps) {
    this.ownerId = deps.ownerId?.trim() || `orchestration-worktree:${process.pid}:${randomUUID()}`;
    this.leaseDurationMs = normalizeLeaseDurationMs(deps.leaseDurationMs ?? DEFAULT_WORKTREE_LEASE_DURATION_MS);
    this.heartbeatIntervalMs =
      deps.heartbeatIntervalMs === false
        ? undefined
        : normalizeLeaseDurationMs(deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 3)));
  }

  public async allocate(input: {
    runId: string;
    workspaceId: string;
    baseRef?: string;
  }): Promise<OrchestrationWorktreeAllocation> {
    const baseRef = input.baseRef?.trim() || "HEAD";
    const worktreesRoot = this.resolveWorktreesRoot();
    const targetPath = path.resolve(worktreesRoot, input.runId);
    await fs.mkdir(worktreesRoot, { recursive: true });
    assertWritePathInJail(targetPath, this.deps.config.toolPolicy.sandbox.writeJailRoots);
    const gitDirPath = path.join(targetPath, ".git");
    if (fsSync.existsSync(targetPath) && !fsSync.existsSync(gitDirPath)) {
      throw new ValidationError({
        message:
          "Orchestration worktree path already exists but is not a valid git worktree. Clean it up before retrying.",
      });
    }
    const claimed = this.deps.worktreeLeases.claim({
      worktreePath: targetPath,
      runId: input.runId,
      ownerId: this.ownerId,
      leaseDurationMs: this.leaseDurationMs,
      now: this.now(),
    });
    if (claimed.outcome === "blocked") {
      throw this.buildLeaseConflictError(targetPath, claimed.lease);
    }
    const token = toLeaseToken(claimed.lease);
    try {
      if (fsSync.existsSync(targetPath) && !fsSync.existsSync(gitDirPath)) {
        throw new ValidationError({
          message: "Orchestration worktree path became invalid during allocation. Clean it up before retrying.",
        });
      }
      if (!fsSync.existsSync(targetPath)) {
        await this.createManager(worktreesRoot).create(input.runId, baseRef);
      }
    } catch (error) {
      this.deps.worktreeLeases.release({ ...token, releasedAt: this.now() });
      throw error;
    }
    this.startLeaseHeartbeat(claimed.lease);
    return {
      worktreePath: targetPath,
      worktreeStatus: "ready",
      worktreeBaseRef: baseRef,
      worktreeLeaseOwnerId: claimed.lease.ownerId,
      worktreeLeaseGeneration: claimed.lease.generation,
      worktreeLeaseExpiresAt: claimed.lease.leaseExpiresAt,
    };
  }

  public ensureLeaseForExecution(run: OrchestrationRun): OrchestrationRun {
    const worktreePath = run.worktreePath?.trim();
    if (!worktreePath) {
      return run;
    }
    const worktreesRoot = this.resolveWorktreesRoot();
    const resolvedPath = path.resolve(worktreePath);
    this.assertWithinWorktreesRoot(worktreesRoot, resolvedPath, worktreePath);
    assertWritePathInJail(resolvedPath, this.deps.config.toolPolicy.sandbox.writeJailRoots);
    if (!fsSync.existsSync(resolvedPath) || !fsSync.existsSync(path.join(resolvedPath, ".git"))) {
      throw new ValidationError({
        message: `Orchestration worktree is missing or invalid before durable execution: ${resolvedPath}`,
      });
    }

    const claimed = this.deps.worktreeLeases.claim({
      worktreePath: resolvedPath,
      runId: run.runId,
      ownerId: this.ownerId,
      leaseDurationMs: this.leaseDurationMs,
      now: this.now(),
    });
    if (claimed.outcome === "blocked") {
      throw new DurableWorkerInterruptionError(
        "lease_lost",
        `Orchestration worktree remains owned by ${claimed.lease.ownerId} generation ` +
          `${claimed.lease.generation} until ${claimed.lease.leaseExpiresAt}: ${resolvedPath}`,
      );
    }

    const token = toLeaseToken(claimed.lease);
    const adopted = this.deps.orchestrationRuns.adoptWorktreeLease({
      runId: run.runId,
      worktreePath: resolvedPath,
      expectedWorktreeLeaseOwnerId: run.worktreeLeaseOwnerId,
      expectedWorktreeLeaseGeneration: run.worktreeLeaseGeneration,
      worktreeLeaseOwnerId: claimed.lease.ownerId,
      worktreeLeaseGeneration: claimed.lease.generation,
      worktreeLeaseExpiresAt: claimed.lease.leaseExpiresAt,
    });
    if (!adopted) {
      this.deps.worktreeLeases.release({ ...token, releasedAt: this.now() });
      throw new DurableWorkerInterruptionError(
        "lease_lost",
        `Orchestration run ${run.runId} changed before worktree generation ${claimed.lease.generation} could attach.`,
      );
    }
    this.startLeaseHeartbeat(claimed.lease);
    return adopted;
  }

  public async release(input: { run: OrchestrationRun; reason: OrchestrationWorktreeReleaseReason }): Promise<void> {
    const worktreePath = input.run.worktreePath?.trim();
    if (!worktreePath) {
      return;
    }
    const worktreesRoot = this.resolveWorktreesRoot();
    const resolvedPath = path.resolve(worktreePath);
    this.assertWithinWorktreesRoot(worktreesRoot, resolvedPath, worktreePath);
    assertWritePathInJail(resolvedPath, this.deps.config.toolPolicy.sandbox.writeJailRoots);
    if (!fsSync.existsSync(resolvedPath)) {
      this.releaseMissingPathLease(input.run, resolvedPath);
      return;
    }
    const cleanupLease = this.acquireCleanupLease(input.run, resolvedPath);
    this.stopLeaseHeartbeat(resolvedPath, cleanupLease);
    const manager = this.createManager(worktreesRoot);
    try {
      await manager.remove(resolvedPath);
    } catch (error) {
      log.warn("git worktree remove failed; falling back to filesystem cleanup", {
        runId: input.run.runId,
        reason: input.reason,
        worktreePath: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
      await fs.rm(resolvedPath, { recursive: true, force: true });
    }
    // ORCH-004: prune stale `.git/worktrees/<id>` metadata after every removal
    // path (including the filesystem fallback), so git's worktree registry does
    // not accumulate orphaned entries for reclaimed run worktrees.
    const pruned = await this.pruneWorktreeMetadata(manager, input.run.runId, input.reason, resolvedPath);
    if (
      pruned &&
      !this.deps.worktreeLeases.release({
        ...cleanupLease,
        releasedAt: this.now(),
      })
    ) {
      throw new Error(`Orchestration worktree lease changed before cleanup completed: ${resolvedPath}`);
    }
  }

  private acquireCleanupLease(run: OrchestrationRun, resolvedPath: string): OrchestrationWorktreeLeaseToken {
    const current = this.deps.worktreeLeases.get(resolvedPath);
    if (current && current.runId !== run.runId) {
      throw new ValidationError({
        message: `Orchestration worktree lease belongs to another run and cannot be released: ${resolvedPath}`,
      });
    }

    const expectedGeneration = run.worktreeLeaseGeneration;
    const expectedOwnerId = run.worktreeLeaseOwnerId?.trim();
    if (
      current &&
      expectedOwnerId === this.ownerId &&
      typeof expectedGeneration === "number" &&
      Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration === current.generation &&
      current.ownerId === expectedOwnerId
    ) {
      const renewed = this.deps.worktreeLeases.renew({
        ...toLeaseToken(current),
        leaseDurationMs: this.leaseDurationMs,
        now: this.now(),
      });
      if (renewed) {
        return toLeaseToken(renewed);
      }
    }

    if (current && isLeaseActive(current, Date.parse(this.now()))) {
      throw this.buildLeaseConflictError(resolvedPath, current);
    }
    const claimed = this.deps.worktreeLeases.claim({
      worktreePath: resolvedPath,
      runId: run.runId,
      ownerId: this.ownerId,
      leaseDurationMs: this.leaseDurationMs,
      now: this.now(),
    });
    if (claimed.outcome === "blocked") {
      throw this.buildLeaseConflictError(resolvedPath, claimed.lease);
    }
    return toLeaseToken(claimed.lease);
  }

  private releaseMissingPathLease(run: OrchestrationRun, resolvedPath: string): void {
    const ownerId = run.worktreeLeaseOwnerId?.trim();
    const generation = run.worktreeLeaseGeneration;
    if (ownerId !== this.ownerId || typeof generation !== "number" || !Number.isSafeInteger(generation)) {
      return;
    }
    this.stopLeaseHeartbeat(resolvedPath, {
      worktreePath: resolvedPath,
      runId: run.runId,
      ownerId,
      generation,
    });
    this.deps.worktreeLeases.release({
      worktreePath: resolvedPath,
      runId: run.runId,
      ownerId,
      generation,
      releasedAt: this.now(),
    });
  }

  public close(): void {
    for (const heartbeat of this.leaseHeartbeats.values()) {
      clearInterval(heartbeat.timer);
    }
    this.leaseHeartbeats.clear();
  }

  private startLeaseHeartbeat(lease: OrchestrationWorktreeLeaseRecord): void {
    if (this.heartbeatIntervalMs === undefined) {
      return;
    }
    const token = toLeaseToken(lease);
    this.stopLeaseHeartbeat(token.worktreePath);
    const timer = setInterval(() => this.renewOwnedLease(token.worktreePath), this.heartbeatIntervalMs);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this.leaseHeartbeats.set(token.worktreePath, { token, timer });
  }

  private renewOwnedLease(worktreePath: string): void {
    const heartbeat = this.leaseHeartbeats.get(worktreePath);
    if (!heartbeat) {
      return;
    }
    try {
      const renewed = this.deps.worktreeLeases.renew({
        ...heartbeat.token,
        leaseDurationMs: this.leaseDurationMs,
        now: this.now(),
      });
      if (!renewed) {
        this.handleLeaseLoss(heartbeat.token, "lease_renewal_rejected");
        return;
      }
      const renewedRun = this.deps.orchestrationRuns.renewWorktreeLease({
        runId: renewed.runId,
        worktreeLeaseOwnerId: renewed.ownerId,
        worktreeLeaseGeneration: renewed.generation,
        worktreeLeaseExpiresAt: renewed.leaseExpiresAt,
      });
      if (!renewedRun) {
        this.handleLeaseLoss(heartbeat.token, "run_lease_fence_rejected");
      }
    } catch (error) {
      this.handleLeaseLoss(
        heartbeat.token,
        "lease_renewal_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private handleLeaseLoss(
    token: OrchestrationWorktreeLeaseToken,
    reason: OrchestrationWorktreeLeaseLossEvent["reason"],
    error?: string,
  ): void {
    this.stopLeaseHeartbeat(token.worktreePath, token);
    const lastError =
      `Orchestration worktree lease lost (${reason}) for owner ${token.ownerId} ` + `generation ${token.generation}.`;
    let fencedRun: OrchestrationRun | undefined;
    let fenceError: string | undefined;
    try {
      fencedRun = this.deps.orchestrationRuns.fenceWorktreeLease({
        runId: token.runId,
        worktreePath: token.worktreePath,
        worktreeLeaseOwnerId: token.ownerId,
        worktreeLeaseGeneration: token.generation,
        endedAt: this.now(),
        lastError: error ? `${lastError} ${error}` : lastError,
      });
    } catch (fencingFailure) {
      fenceError = fencingFailure instanceof Error ? fencingFailure.message : String(fencingFailure);
    }

    try {
      this.deps.onLeaseLost?.({
        token,
        reason,
        ...(error ? { error } : {}),
        ...(fencedRun ? { fencedRun } : {}),
      });
    } catch (callbackFailure) {
      log.error("orchestration worktree lease loss callback failed", {
        runId: token.runId,
        worktreePath: token.worktreePath,
        ownerId: token.ownerId,
        generation: token.generation,
        error: callbackFailure instanceof Error ? callbackFailure.message : String(callbackFailure),
      });
    }

    log.warn("orchestration worktree lease heartbeat fenced its owner", {
      runId: token.runId,
      worktreePath: token.worktreePath,
      ownerId: token.ownerId,
      generation: token.generation,
      reason,
      canonicalRunFenced: Boolean(fencedRun),
      ...(error ? { error } : {}),
      ...(fenceError ? { fenceError } : {}),
    });
  }

  private stopLeaseHeartbeat(worktreePath: string, expected?: OrchestrationWorktreeLeaseToken): void {
    const heartbeat = this.leaseHeartbeats.get(worktreePath);
    if (
      !heartbeat ||
      (expected &&
        (heartbeat.token.runId !== expected.runId ||
          heartbeat.token.ownerId !== expected.ownerId ||
          heartbeat.token.generation !== expected.generation))
    ) {
      return;
    }
    clearInterval(heartbeat.timer);
    this.leaseHeartbeats.delete(worktreePath);
  }

  private async pruneWorktreeMetadata(
    manager: WorktreeManager,
    runId: string,
    reason: OrchestrationWorktreeReleaseReason,
    resolvedPath: string,
  ): Promise<boolean> {
    try {
      await manager.prune();
      return true;
    } catch (error) {
      log.warn("git worktree prune failed after worktree release", {
        runId,
        reason,
        worktreePath: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep the cleanup generation leased until expiry. Releasing it here
      // would let another owner recreate the path while stale git metadata
      // from this generation is still present.
      return false;
    }
  }

  public async reapOrphaned(
    input: {
      dryRun?: boolean;
      minAgeMs?: number;
    } = {},
  ): Promise<{ dryRun: boolean; scanned: number; removed: string[]; skippedActive: string[] }> {
    const dryRun = input.dryRun ?? true;
    const minAgeMs = Math.max(0, input.minAgeMs ?? 60 * 60 * 1000);
    const worktreesRoot = this.resolveWorktreesRoot();
    if (!fsSync.existsSync(worktreesRoot)) {
      return { dryRun, scanned: 0, removed: [], skippedActive: [] };
    }

    const activeStatuses = new Set<OrchestrationRun["status"]>(["queued", "running", "paused"]);
    const activeWorktreePaths = new Set(
      this.deps.orchestrationRuns
        .listRuns(5000)
        .filter((run) => activeStatuses.has(run.status))
        .map((run) => (run.worktreePath ? path.resolve(run.worktreePath).toLowerCase() : undefined))
        .filter((value): value is string => Boolean(value)),
    );
    const entries = await fs.readdir(worktreesRoot, { withFileTypes: true });
    const removed: string[] = [];
    const skippedActive: string[] = [];
    const scanNow = this.now();
    const now = Date.parse(scanNow);

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidatePath = path.resolve(worktreesRoot, entry.name);
      const relative = path.relative(worktreesRoot, candidatePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      if (activeWorktreePaths.has(candidatePath.toLowerCase())) {
        skippedActive.push(candidatePath);
        continue;
      }
      const stat = await fs.stat(candidatePath);
      if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) {
        continue;
      }
      assertWritePathInJail(candidatePath, this.deps.config.toolPolicy.sandbox.writeJailRoots);
      const currentLease = this.deps.worktreeLeases.get(candidatePath);
      if (currentLease && isLeaseActive(currentLease, now)) {
        skippedActive.push(candidatePath);
        continue;
      }
      if (dryRun) {
        removed.push(candidatePath);
        continue;
      }
      const claimed = this.deps.worktreeLeases.claim({
        worktreePath: candidatePath,
        runId: currentLease?.runId ?? entry.name,
        ownerId: this.ownerId,
        leaseDurationMs: this.leaseDurationMs,
        now: scanNow,
      });
      if (claimed.outcome === "blocked") {
        skippedActive.push(candidatePath);
        continue;
      }
      await fs.rm(candidatePath, { recursive: true, force: true });
      if (!this.deps.worktreeLeases.release({ ...toLeaseToken(claimed.lease), releasedAt: this.now() })) {
        throw new Error(`Orchestration worktree lease changed before orphan cleanup completed: ${candidatePath}`);
      }
      removed.push(candidatePath);
    }

    return { dryRun, scanned: entries.length, removed, skippedActive };
  }

  private resolveWorktreesRoot(): string {
    return path.resolve(this.deps.config.rootDir, this.deps.config.assistant.worktreesDir, "orchestration");
  }

  private createManager(worktreesRoot: string): WorktreeManager {
    return new WorktreeManager({
      repoRoot: this.deps.config.rootDir,
      worktreesRoot,
    });
  }

  private assertWithinWorktreesRoot(worktreesRoot: string, resolvedPath: string, originalPath: string): void {
    const relative = path.relative(worktreesRoot, resolvedPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to clean orchestration worktree outside worktrees root: ${originalPath}`);
    }
  }

  private buildLeaseConflictError(worktreePath: string, lease: OrchestrationWorktreeLeaseRecord): ValidationError {
    return new ValidationError({
      message:
        `Orchestration worktree is owned by ${lease.ownerId} generation ${lease.generation} ` +
        `until ${lease.leaseExpiresAt}: ${worktreePath}`,
    });
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }
}

function toLeaseToken(lease: OrchestrationWorktreeLeaseRecord): OrchestrationWorktreeLeaseToken {
  return {
    worktreePath: lease.worktreePath,
    runId: lease.runId,
    ownerId: lease.ownerId,
    generation: lease.generation,
  };
}

function isLeaseActive(lease: OrchestrationWorktreeLeaseRecord, nowMs: number): boolean {
  if (lease.releasedAt) {
    return false;
  }
  const expiresAtMs = Date.parse(lease.leaseExpiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
}

function normalizeLeaseDurationMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Orchestration worktree lease duration must be a positive number of milliseconds.");
  }
  return Math.floor(value);
}
