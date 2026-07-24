import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationRun } from "@goatcitadel/contracts";
import { createDatabase, OrchestrationRepository, OrchestrationWorktreeLeaseRepository } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "../config.js";
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
      ...buildLeaseDeps(),
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
      ...buildLeaseDeps(),
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
      worktreeLeaseOwnerId: "test-worktree-owner",
      worktreeLeaseGeneration: 1,
      worktreeLeaseExpiresAt: "2026-04-12T00:01:00.000Z",
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
      ...buildLeaseDeps(),
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
    const leaseDeps = buildLeaseDeps();
    leaseDeps.worktreeLeases.claim({
      worktreePath: activePath,
      runId: "active-run",
      ownerId: "previous-active-owner",
      leaseDurationMs: 60_000,
      now: "2026-04-11T23:58:00.000Z",
    });
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => [buildRun({ runId: "active-run", status: "running", worktreePath: activePath })]),
      },
      ...leaseDeps,
    });

    const result = await service.reapOrphaned({ dryRun: false, minAgeMs: 0 });

    expect(result.removed).toEqual([orphanPath]);
    expect(result.skippedActive).toEqual([activePath]);
    await expect(fs.stat(activePath)).resolves.toBeTruthy();
    expect(leaseDeps.worktreeLeases.get(activePath)).toMatchObject({
      ownerId: "previous-active-owner",
      generation: 1,
      leaseExpiresAt: "2026-04-11T23:59:00.000Z",
      releasedAt: undefined,
    });
    await expect(fs.stat(orphanPath)).rejects.toThrow();
    expect(leaseDeps.worktreeLeases.get(orphanPath)).toMatchObject({
      runId: "orphan-run",
      ownerId: "test-worktree-owner",
      generation: 1,
      releasedAt: leaseNow,
    });
  });

  it("refuses a stale owner release after a newer worktree generation is claimed", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-1");
    await fs.mkdir(path.join(worktreePath, ".git"), { recursive: true });
    const leases = new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" }));
    const firstService = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: { listRuns: vi.fn(() => []) },
      ...buildLeaseDeps({ repository: leases, ownerId: "owner-a", now: "2026-04-12T00:00:00.000Z" }),
    });
    const first = await firstService.allocate({ runId: "run-1", workspaceId: "default" });
    const secondService = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: { listRuns: vi.fn(() => []) },
      ...buildLeaseDeps({ repository: leases, ownerId: "owner-b", now: "2026-04-12T00:02:00.000Z" }),
    });
    const second = await secondService.allocate({ runId: "run-1", workspaceId: "default" });

    expect(second.worktreeLeaseGeneration).toBe(2);
    await expect(
      firstService.release({
        run: buildRun({
          status: "completed",
          worktreePath,
          worktreeLeaseOwnerId: first.worktreeLeaseOwnerId,
          worktreeLeaseGeneration: first.worktreeLeaseGeneration,
          worktreeLeaseExpiresAt: first.worktreeLeaseExpiresAt,
        }),
        reason: "completed",
      }),
    ).rejects.toThrow("owned by owner-b generation 2");
    await expect(fs.stat(worktreePath)).resolves.toBeTruthy();
  });

  it("preserves an inactive-run directory while another unexpired owner lease is active", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "leased-run");
    await fs.mkdir(worktreePath, { recursive: true });
    const leases = new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" }));
    leases.claim({
      worktreePath,
      runId: "leased-run",
      ownerId: "active-owner",
      leaseDurationMs: 5 * 60_000,
      now: "2026-04-12T00:00:00.000Z",
    });
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: { listRuns: vi.fn(() => []) },
      ...buildLeaseDeps({ repository: leases, ownerId: "reaper", now: "2026-04-12T00:01:00.000Z" }),
    });

    const result = await service.reapOrphaned({ dryRun: false, minAgeMs: 0 });

    expect(result.removed).toEqual([]);
    expect(result.skippedActive).toEqual([worktreePath]);
    await expect(fs.stat(worktreePath)).resolves.toBeTruthy();
  });

  it("reclaims an expired lease after restart before deleting the orphan", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "expired-run");
    await fs.mkdir(worktreePath, { recursive: true });
    const leases = new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" }));
    leases.claim({
      worktreePath,
      runId: "expired-run",
      ownerId: "previous-process",
      leaseDurationMs: 60_000,
      now: "2026-04-12T00:00:00.000Z",
    });
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: { listRuns: vi.fn(() => []) },
      ...buildLeaseDeps({ repository: leases, ownerId: "restarted-process", now: "2026-04-12T00:02:00.000Z" }),
    });

    const result = await service.reapOrphaned({ dryRun: false, minAgeMs: 0 });

    expect(result.removed).toEqual([worktreePath]);
    expect(leases.get(worktreePath)).toMatchObject({
      ownerId: "restarted-process",
      generation: 2,
      releasedAt: "2026-04-12T00:02:00.000Z",
    });
    await expect(fs.stat(worktreePath)).rejects.toThrow();
  });

  it("blocks restart execution before expiry and adopts the next generation after expiry", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-restart");
    await fs.mkdir(path.join(worktreePath, ".git"), { recursive: true });
    const db = createDatabase({ dbPath: ":memory:" });
    const leases = new OrchestrationWorktreeLeaseRepository(db);
    const runs = new OrchestrationRepository(db);
    runs.upsertPlan({
      planId: "plan-restart",
      goal: "recover after restart",
      mode: "auto",
      maxIterations: 1,
      maxRuntimeMinutes: 5,
      maxCostUsd: 1,
      waves: [],
    });
    runs.createRun(
      buildRun({
        runId: "run-restart",
        planId: "plan-restart",
        status: "running",
        executionState: "running",
        worktreePath,
        worktreeStatus: "ready",
        worktreeBaseRef: "HEAD",
        worktreeLeaseOwnerId: "owner-before-restart",
        worktreeLeaseGeneration: 1,
        worktreeLeaseExpiresAt: "2026-04-12T00:00:00.100Z",
      }),
    );
    leases.claim({
      worktreePath,
      runId: "run-restart",
      ownerId: "owner-before-restart",
      leaseDurationMs: 100,
      now: "2026-04-12T00:00:00.000Z",
    });

    let nowMs = Date.parse("2026-04-12T00:00:00.050Z");
    const restarted = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: runs,
      ...buildLeaseDeps({
        repository: leases,
        ownerId: "owner-after-restart",
        now: () => new Date(nowMs).toISOString(),
        leaseDurationMs: 100,
        heartbeatIntervalMs: 30,
      }),
    });
    vi.useFakeTimers();
    try {
      expect(() => restarted.ensureLeaseForExecution(runs.getRun("run-restart"))).toThrow(
        "remains owned by owner-before-restart generation 1",
      );
      expect(runs.getRun("run-restart")).toMatchObject({
        worktreeLeaseOwnerId: "owner-before-restart",
        worktreeLeaseGeneration: 1,
      });

      nowMs = Date.parse("2026-04-12T00:00:00.200Z");
      const adopted = restarted.ensureLeaseForExecution(runs.getRun("run-restart"));
      expect(adopted).toMatchObject({
        worktreeLeaseOwnerId: "owner-after-restart",
        worktreeLeaseGeneration: 2,
        worktreeLeaseExpiresAt: "2026-04-12T00:00:00.300Z",
      });
      expect(runs.getRun("run-restart")).toMatchObject({
        worktreeLeaseOwnerId: "owner-after-restart",
        worktreeLeaseGeneration: 2,
      });

      nowMs = Date.parse("2026-04-12T00:00:00.230Z");
      vi.advanceTimersByTime(30);
      expect(leases.get(worktreePath)).toMatchObject({
        ownerId: "owner-after-restart",
        generation: 2,
        leaseExpiresAt: "2026-04-12T00:00:00.330Z",
      });
      expect(runs.getRun("run-restart").worktreeLeaseExpiresAt).toBe("2026-04-12T00:00:00.330Z");
    } finally {
      restarted.close();
      vi.useRealTimers();
      db.close();
    }
  });

  it("renews a long-running allocation so another owner stays blocked beyond the original expiry", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-heartbeat");
    await fs.mkdir(path.join(worktreePath, ".git"), { recursive: true });
    const leases = new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" }));
    const renewRunLease = vi.fn(
      (input: {
        runId: string;
        worktreeLeaseOwnerId: string;
        worktreeLeaseGeneration: number;
        worktreeLeaseExpiresAt: string;
      }) =>
        buildRun({
          runId: input.runId,
          status: "running",
          worktreePath,
          worktreeStatus: "ready",
          worktreeLeaseOwnerId: input.worktreeLeaseOwnerId,
          worktreeLeaseGeneration: input.worktreeLeaseGeneration,
          worktreeLeaseExpiresAt: input.worktreeLeaseExpiresAt,
        }),
    );
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    let service: OrchestrationWorktreeService | undefined;
    vi.useFakeTimers();
    try {
      service = new OrchestrationWorktreeService({
        config: buildConfig(rootDir),
        orchestrationRuns: {
          listRuns: vi.fn(() => []),
          renewWorktreeLease: renewRunLease,
          fenceWorktreeLease: vi.fn(),
        },
        ...buildLeaseDeps({
          repository: leases,
          ownerId: "heartbeat-owner",
          now: () => new Date(nowMs).toISOString(),
          leaseDurationMs: 100,
          heartbeatIntervalMs: 30,
        }),
      });
      const allocation = await service.allocate({ runId: "run-heartbeat", workspaceId: "default" });
      expect(allocation.worktreeLeaseGeneration).toBe(1);
      expect(allocation.worktreeLeaseExpiresAt).toBe("2026-04-12T00:00:00.100Z");

      for (let tick = 0; tick < 10; tick += 1) {
        nowMs += 30;
        vi.advanceTimersByTime(30);
      }

      const current = leases.get(worktreePath);
      expect(current).toMatchObject({
        ownerId: "heartbeat-owner",
        generation: 1,
        leaseExpiresAt: "2026-04-12T00:00:00.400Z",
      });
      expect(
        leases.claim({
          worktreePath,
          runId: "run-heartbeat",
          ownerId: "owner-b",
          leaseDurationMs: 100,
          now: new Date(nowMs).toISOString(),
        }).outcome,
      ).toBe("blocked");
      expect(renewRunLease).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-heartbeat",
          worktreeLeaseOwnerId: "heartbeat-owner",
          worktreeLeaseGeneration: 1,
        }),
      );

      const renewCountBeforeClose = renewRunLease.mock.calls.length;
      service.close();
      nowMs += 300;
      vi.advanceTimersByTime(300);
      expect(renewRunLease).toHaveBeenCalledTimes(renewCountBeforeClose);
    } finally {
      service?.close();
      vi.useRealTimers();
    }
  });

  it("stops heartbeating after ownership loss and fences the former owner from cleanup", async () => {
    const rootDir = await makeTempDir();
    const worktreePath = path.join(rootDir, ".worktrees", "orchestration", "run-heartbeat-loss");
    await fs.mkdir(path.join(worktreePath, ".git"), { recursive: true });
    const leases = new OrchestrationWorktreeLeaseRepository(createDatabase({ dbPath: ":memory:" }));
    const onLeaseLost = vi.fn();
    const fenceWorktreeLease = vi.fn(
      (input: {
        runId: string;
        worktreePath: string;
        worktreeLeaseOwnerId: string;
        worktreeLeaseGeneration: number;
        endedAt: string;
        lastError: string;
      }) =>
        buildRun({
          runId: input.runId,
          status: "failed",
          executionState: "failed",
          worktreePath: input.worktreePath,
          worktreeStatus: "blocked",
          worktreeLeaseOwnerId: input.worktreeLeaseOwnerId,
          worktreeLeaseGeneration: input.worktreeLeaseGeneration,
          endedAt: input.endedAt,
          lastError: input.lastError,
        }),
    );
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    let service: OrchestrationWorktreeService | undefined;
    vi.useFakeTimers();
    try {
      service = new OrchestrationWorktreeService({
        config: buildConfig(rootDir),
        orchestrationRuns: {
          listRuns: vi.fn(() => []),
          renewWorktreeLease: vi.fn(),
          fenceWorktreeLease,
        },
        onLeaseLost,
        ...buildLeaseDeps({
          repository: leases,
          ownerId: "owner-a",
          now: () => new Date(nowMs).toISOString(),
          leaseDurationMs: 100,
          heartbeatIntervalMs: 30,
        }),
      });
      const allocation = await service.allocate({ runId: "run-heartbeat-loss", workspaceId: "default" });
      const firstToken = {
        worktreePath,
        runId: "run-heartbeat-loss",
        ownerId: allocation.worktreeLeaseOwnerId,
        generation: allocation.worktreeLeaseGeneration,
      };
      nowMs += 10;
      expect(leases.release({ ...firstToken, releasedAt: new Date(nowMs).toISOString() })).toBe(true);
      const replacement = leases.claim({
        worktreePath,
        runId: "run-heartbeat-loss",
        ownerId: "owner-b",
        leaseDurationMs: 500,
        now: new Date(nowMs).toISOString(),
      });
      expect(replacement.outcome).toBe("claimed");
      if (replacement.outcome !== "claimed") {
        throw new Error("expected replacement worktree generation");
      }
      expect(replacement.lease.generation).toBe(2);

      const renewSpy = vi.spyOn(leases, "renew");
      nowMs += 20;
      vi.advanceTimersByTime(30);
      expect(renewSpy).toHaveBeenCalledTimes(1);
      expect(fenceWorktreeLease).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-heartbeat-loss",
          worktreePath,
          worktreeLeaseOwnerId: "owner-a",
          worktreeLeaseGeneration: 1,
        }),
      );
      expect(onLeaseLost).toHaveBeenCalledWith(
        expect.objectContaining({
          token: firstToken,
          reason: "lease_renewal_rejected",
          fencedRun: expect.objectContaining({ status: "failed", worktreeStatus: "blocked" }),
        }),
      );
      nowMs += 300;
      vi.advanceTimersByTime(300);
      expect(renewSpy).toHaveBeenCalledTimes(1);

      await expect(
        service.release({
          run: buildRun({
            runId: "run-heartbeat-loss",
            status: "completed",
            worktreePath,
            worktreeLeaseOwnerId: firstToken.ownerId,
            worktreeLeaseGeneration: firstToken.generation,
            worktreeLeaseExpiresAt: allocation.worktreeLeaseExpiresAt,
          }),
          reason: "completed",
        }),
      ).rejects.toThrow("owned by owner-b generation 2");
      await expect(fs.stat(worktreePath)).resolves.toBeTruthy();
    } finally {
      service?.close();
      vi.useRealTimers();
    }
  });

  it("refuses to release worktrees outside the orchestration worktree root", async () => {
    const rootDir = await makeTempDir();
    const service = new OrchestrationWorktreeService({
      config: buildConfig(rootDir),
      orchestrationRuns: {
        listRuns: vi.fn(() => []),
      },
      ...buildLeaseDeps(),
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
      ...buildLeaseDeps(),
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
