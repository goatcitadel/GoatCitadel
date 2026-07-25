import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationRun } from "@goatcitadel/contracts";
import { createDatabase, OrchestrationWorktreeLeaseRepository } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";

const worktreeManagerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  prune: vi.fn(),
  constructor: vi.fn(),
}));

vi.mock("@goatcitadel/orchestration", () => ({
  WorktreeManager: vi.fn().mockImplementation(function (input) {
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
const leaseNow = "2026-04-12T00:00:00.000Z";

function buildLeaseDeps(
  input: {
    repository?: OrchestrationWorktreeLeaseRepository;
    ownerId?: string;
    now?: string | (() => string);
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number | false;
  } = {},
) {
  return {
    worktreeLeases:
      input.repository ?? new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" })),
    ownerId: input.ownerId ?? "test-worktree-owner",
    leaseDurationMs: input.leaseDurationMs ?? 60_000,
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? (false as const),
    now: typeof input.now === "function" ? input.now : () => input.now ?? leaseNow,
  };
}

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
      ...buildLeaseDeps(),
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
      worktreeLeaseOwnerId: "test-worktree-owner",
      worktreeLeaseGeneration: 1,
      worktreeLeaseExpiresAt: "2026-04-12T00:01:00.000Z",
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
      ...buildLeaseDeps(),
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
      ...buildLeaseDeps(),
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

  it("holds the cleanup generation through git metadata pruning before releasing it", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-race");
    await fs.mkdir(worktreePath, { recursive: true });
    const leases = new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" }));
    const order: string[] = [];
    const releaseLease = leases.release.bind(leases);
    vi.spyOn(leases, "release").mockImplementation((input) => {
      order.push("lease-release");
      return releaseLease(input);
    });
    worktreeManagerMocks.remove.mockImplementationOnce(async () => {
      order.push("worktree-remove");
    });
    worktreeManagerMocks.prune.mockImplementationOnce(async () => {
      order.push("metadata-prune");
      expect(leases.get(worktreePath)?.releasedAt).toBeUndefined();
      expect(
        leases.claim({
          worktreePath,
          runId: "run-race",
          ownerId: "racing-owner",
          leaseDurationMs: 60_000,
          now: "2026-04-12T00:00:30.000Z",
        }).outcome,
      ).toBe("blocked");
    });
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: { listRuns: vi.fn(() => []) },
      ...buildLeaseDeps({ repository: leases, ownerId: "cleanup-owner" }),
    });

    await service.release({
      run: buildRun({ runId: "run-race", worktreePath }),
      reason: "completed",
    });

    expect(order).toEqual(["worktree-remove", "metadata-prune", "lease-release"]);
    expect(leases.get(worktreePath)).toMatchObject({
      ownerId: "cleanup-owner",
      generation: 1,
      releasedAt: leaseNow,
    });
  });

  it("leaves the cleanup generation leased when git metadata pruning fails", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-prune-failed");
    await fs.mkdir(worktreePath, { recursive: true });
    const leases = new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" }));
    worktreeManagerMocks.prune.mockRejectedValueOnce(new Error("prune failed"));
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: { listRuns: vi.fn(() => []) },
      ...buildLeaseDeps({ repository: leases, ownerId: "cleanup-owner" }),
    });

    await expect(
      service.release({
        run: buildRun({ runId: "run-prune-failed", worktreePath }),
        reason: "failed",
      }),
    ).resolves.toBeUndefined();

    expect(leases.get(worktreePath)).toMatchObject({
      ownerId: "cleanup-owner",
      generation: 1,
      leaseExpiresAt: "2026-04-12T00:01:00.000Z",
      releasedAt: undefined,
    });
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
      ...buildLeaseDeps(),
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
      ...buildLeaseDeps(),
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
