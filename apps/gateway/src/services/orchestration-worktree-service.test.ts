import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationRun } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";
import { OrchestrationWorktreeService } from "./orchestration-worktree-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-worktrees-"));
  tempDirs.push(dir);
  return dir;
}

function buildConfig(rootDir: string): Pick<GatewayRuntimeConfig, "rootDir" | "assistant" | "toolPolicy"> {
  return {
    rootDir,
    assistant: {
      worktreesDir: ".worktrees",
    },
    toolPolicy: {
      sandbox: {
        writeJailRoots: [rootDir],
      },
    },
  } as Pick<GatewayRuntimeConfig, "rootDir" | "assistant" | "toolPolicy">;
}

function buildRun(input: Partial<OrchestrationRun>): OrchestrationRun {
  return {
    runId: "run-1",
    planId: "plan-1",
    status: "queued",
    startedAt: "2026-04-12T00:00:00.000Z",
    totalIterations: 0,
    totalCostUsd: 0,
    workspaceId: "default",
    executionState: "queued",
    ...input,
  };
}

describe("OrchestrationWorktreeService", () => {
  it("returns an empty orphan scan when the orchestration worktree root does not exist", async () => {
    const rootDir = await makeTempDir();
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
    });

    await expect(service.reapOrphaned()).resolves.toEqual({
      dryRun: true,
      scanned: 0,
      removed: [],
      skippedActive: [],
    });
  });

  it("reuses an existing valid worktree directory without invoking git worktree creation", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-1");
    await fs.mkdir(path.join(worktreePath, ".git"), { recursive: true });
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
    });

    await expect(
      service.allocate({
        runId: "run-1",
        workspaceId: "default",
        baseRef: " main ",
      }),
    ).resolves.toEqual({
      worktreePath,
      worktreeStatus: "ready",
      worktreeBaseRef: "main",
    });
  });

  it("rejects stale non-git directories at the requested worktree path", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-1");
    await fs.mkdir(worktreePath, { recursive: true });
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
    });

    await expect(
      service.allocate({
        runId: "run-1",
        workspaceId: "default",
      }),
    ).rejects.toThrow("not a valid git worktree");
  });

  it("reaps inactive orphan worktrees while preserving active runs", async () => {
    const rootDir = await makeTempDir();
    const worktreesRoot = path.join(rootDir, ".worktrees", "orchestration");
    const activePath = path.join(worktreesRoot, "active-run");
    const orphanPath = path.join(worktreesRoot, "orphan-run");
    await fs.mkdir(activePath, { recursive: true });
    await fs.mkdir(orphanPath, { recursive: true });
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => [buildRun({ runId: "active-run", status: "running", worktreePath: activePath })]),
      },
    });

    const result = await service.reapOrphaned({ dryRun: false, minAgeMs: 0 });

    expect(result.removed).toEqual([orphanPath]);
    expect(result.skippedActive).toEqual([activePath]);
    await expect(fs.stat(activePath)).resolves.toBeTruthy();
    await expect(fs.stat(orphanPath)).rejects.toThrow();
  });

  it("refuses to release worktrees outside the orchestration worktree root", async () => {
    const rootDir = await makeTempDir();
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
    });

    await expect(
      service.release({
        run: buildRun({ worktreePath: path.join(os.tmpdir(), "outside-worktree") }),
        reason: "failed",
      }),
    ).rejects.toThrow("outside worktrees root");
  });

  it("treats missing or absent release paths as no-op cleanup", async () => {
    const rootDir = await makeTempDir();
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
    });
    const missingWorktreePath = path.join(rootDir, ".worktrees", "orchestration", "missing-run");

    await expect(
      service.release({ run: buildRun({ worktreePath: undefined }), reason: "cancelled" }),
    ).resolves.toBeUndefined();
    await expect(
      service.release({
        run: buildRun({ worktreePath: missingWorktreePath }),
        reason: "completed",
      }),
    ).resolves.toBeUndefined();
  });
});
