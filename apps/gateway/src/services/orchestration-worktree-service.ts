import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@goatcitadel/gateway-core";
import { WorktreeManager } from "@goatcitadel/orchestration";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import { type OrchestrationRun, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";

const log = logger.child("orchestration-worktree-service");

export type OrchestrationWorktreeReleaseReason = "completed" | "failed" | "stopped_by_limit" | "cancelled";

export interface OrchestrationWorktreeServiceDeps {
  readonly config: Pick<GatewayRuntimeConfig, "rootDir" | "assistant" | "toolPolicy">;
  readonly orchestrationRuns: Pick<Storage["orchestration"], "listRuns">;
}

export interface OrchestrationWorktreeAllocation {
  worktreePath: string;
  worktreeStatus: NonNullable<OrchestrationRun["worktreeStatus"]>;
  worktreeBaseRef: string;
}

export class OrchestrationWorktreeService {
  public constructor(private readonly deps: OrchestrationWorktreeServiceDeps) {}

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
    if (!fsSync.existsSync(targetPath)) {
      await this.createManager(worktreesRoot).create(input.runId, baseRef);
    }
    return {
      worktreePath: targetPath,
      worktreeStatus: "ready",
      worktreeBaseRef: baseRef,
    };
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
      return;
    }
    try {
      await this.createManager(worktreesRoot).remove(resolvedPath);
    } catch (error) {
      log.warn("git worktree remove failed; falling back to filesystem cleanup", {
        runId: input.run.runId,
        reason: input.reason,
        worktreePath: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
      await fs.rm(resolvedPath, { recursive: true, force: true });
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
    const now = Date.now();

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
      removed.push(candidatePath);
      if (!dryRun) {
        await fs.rm(candidatePath, { recursive: true, force: true });
      }
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
}
