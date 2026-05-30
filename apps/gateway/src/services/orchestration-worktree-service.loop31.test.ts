import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationRun } from "@goatcitadel/contracts";
import type { GatewayRuntimeConfig } from "../config.js";

const worktreeManagerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  prune: vi.fn(),
  constructor: vi.fn(),
}));

vi.mock("@goatcitadel/orchestration", () => ({
  WorktreeManager: vi.fn().mockImplementation((input) => {
    worktreeManagerMocks.constructor(input);
    return {
      create: worktreeManagerMocks.create,
      remove: worktreeManagerMocks.remove,
      prune: worktreeManagerMocks.prune,
    };
  }),
}));

import { OrchestrationWorktreeService } from "./orchestration-worktree-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  worktreeManagerMocks.create.mockReset();
  worktreeManagerMocks.remove.mockReset();
  worktreeManagerMocks.prune.mockReset();
  worktreeManagerMocks.constructor.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-worktrees-loop31-"));
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

describe("OrchestrationWorktreeService loop31 tails", () => {
  it("creates a missing git worktree through the orchestration manager", async () => {
    const rootDir = await makeTempDir();
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
    ).resolves.toEqual({
      worktreePath: path.join(rootDir, ".worktrees", "orchestration", "run-1"),
      worktreeStatus: "ready",
      worktreeBaseRef: "HEAD",
    });
    expect(worktreeManagerMocks.constructor).toHaveBeenCalledWith({
      repoRoot: rootDir,
      worktreesRoot: path.join(rootDir, ".worktrees", "orchestration"),
    });
    expect(worktreeManagerMocks.create).toHaveBeenCalledWith("run-1", "HEAD");
  });

  it("falls back to filesystem cleanup when git worktree removal fails", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-1");
    await fs.mkdir(worktreePath, { recursive: true });
    worktreeManagerMocks.remove.mockRejectedValueOnce("git remove failed");
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
    });

    await expect(
      service.release({
        run: buildRun({ worktreePath }),
        reason: "failed",
      }),
    ).resolves.toBeUndefined();

    expect(worktreeManagerMocks.remove).toHaveBeenCalledWith(worktreePath);
    // ORCH-004: even when git removal fails and we fall back to fs.rm, the
    // stale .git/worktrees/<id> metadata must be pruned.
    expect(worktreeManagerMocks.prune).toHaveBeenCalledTimes(1);
    await expect(fs.stat(worktreePath)).rejects.toThrow();
  });

  it("uses git worktree removal when it succeeds and prunes stale metadata", async () => {
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
      service.release({
        run: buildRun({ worktreePath }),
        reason: "completed",
      }),
    ).resolves.toBeUndefined();

    expect(worktreeManagerMocks.remove).toHaveBeenCalledWith(worktreePath);
    // ORCH-004: prune after a successful removal keeps git's worktree registry clean.
    expect(worktreeManagerMocks.prune).toHaveBeenCalledTimes(1);
    await expect(fs.stat(worktreePath)).resolves.toBeTruthy();
  });

  it("skips non-directory and young worktree candidates during orphan scans", async () => {
    const rootDir = await makeTempDir();
    const worktreesRoot = path.join(rootDir, ".worktrees", "orchestration");
    const youngPath = path.join(worktreesRoot, "young-run");
    const dryRunPath = path.join(worktreesRoot, "dry-run");
    await fs.mkdir(youngPath, { recursive: true });
    await fs.mkdir(dryRunPath, { recursive: true });
    await fs.writeFile(path.join(worktreesRoot, "README.txt"), "not a worktree", "utf8");
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => [buildRun({ runId: "missing-path", status: "running" })]),
      },
    });

    const youngResult = await service.reapOrphaned({ dryRun: true, minAgeMs: 60 * 60 * 1000 });
    expect(youngResult.removed).toEqual([]);

    const dryRunResult = await service.reapOrphaned({ dryRun: true, minAgeMs: 0 });
    expect(dryRunResult.removed.sort()).toEqual([dryRunPath, youngPath].sort());
    await expect(fs.stat(dryRunPath)).resolves.toBeTruthy();
  });

  it("records Error messages when git worktree cleanup falls back", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-error");
    await fs.mkdir(worktreePath, { recursive: true });
    worktreeManagerMocks.remove.mockRejectedValueOnce(new Error("git remove threw"));
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
    });

    await expect(
      service.release({
        run: buildRun({ runId: "run-error", worktreePath }),
        reason: "failed",
      }),
    ).resolves.toBeUndefined();

    await expect(fs.stat(worktreePath)).rejects.toThrow();
  });
});
