import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { OrchestrationRepository } from "./orchestration-repo.js";
import type { OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): OrchestrationRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-orch-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new OrchestrationRepository(db);
}

function createRepoWithDb(): { db: ReturnType<typeof createDatabase>; repo: OrchestrationRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-orch-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new OrchestrationRepository(db) };
}

const plan: OrchestrationPlan = {
  planId: "plan-1",
  goal: "test",
  mode: "hitl",
  maxIterations: 10,
  maxRuntimeMinutes: 60,
  maxCostUsd: 5,
  waves: [
    {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 1,
      ownership: [{ agentId: "agent-a", paths: ["apps/**"] }],
      phases: [
        {
          phaseId: "phase-1",
          ownerAgentId: "agent-a",
          specPath: "phases/1.md",
          loopMode: "fresh-context",
          requiresApproval: true,
        },
      ],
    },
  ],
};

describe("OrchestrationRepository", () => {
  it("persists plans, runs, and checkpoints", () => {
    const repo = createRepo();
    repo.upsertPlan(plan);

    const loaded = repo.getPlan("plan-1");
    assert.equal(loaded.goal, "test");

    const run: OrchestrationRun = {
      runId: "run-1",
      planId: "plan-1",
      status: "queued",
      startedAt: "2026-02-27T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
      workspaceId: "default",
      durableRunId: "durable-run-1",
      executionState: "worktree_ready",
      worktreePath: "F:/code/personal-ai/.worktrees/run-1",
      worktreeStatus: "ready",
      worktreeBaseRef: "HEAD",
    };

    repo.createRun(run);
    repo.updateRun({
      ...run,
      status: "paused",
      executionState: "paused_for_approval",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      pendingApprovalPhaseId: "phase-1",
      pendingApprovedBy: "operator",
      pendingCostIncrementUsd: 0.25,
    });

    const persistedRun = repo.getRun("run-1");
    assert.equal(persistedRun.durableRunId, "durable-run-1");
    assert.equal(persistedRun.executionState, "paused_for_approval");
    assert.equal(persistedRun.worktreeStatus, "ready");
    assert.equal(persistedRun.pendingApprovalPhaseId, "phase-1");
    assert.equal(persistedRun.pendingApprovedBy, "operator");
    assert.equal(persistedRun.pendingCostIncrementUsd, 0.25);

    repo.createCheckpoint({
      runId: "run-1",
      planId: "plan-1",
      checkpointKind: "run_created",
      details: { status: "queued" },
    });

    const checkpoints = repo.listCheckpoints("run-1");
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.checkpointKind, "run_created");
  });

  it("updates runs only when the current status and execution state still match", () => {
    const repo = createRepo();
    repo.upsertPlan(plan);
    const run: OrchestrationRun = {
      runId: "run-cas",
      planId: "plan-1",
      status: "paused",
      startedAt: "2026-02-27T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
      workspaceId: "default",
      executionState: "paused_for_approval",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
    };
    repo.createRun(run);

    const updated = repo.updateRunIfCurrentState(
      {
        ...run,
        executionState: "resume_requested",
        pendingApprovalPhaseId: "phase-1",
      },
      { status: "paused", executionState: "paused_for_approval" },
    );
    const stale = repo.updateRunIfCurrentState(
      {
        ...run,
        executionState: "resume_requested",
        pendingApprovedBy: "duplicate",
      },
      { status: "paused", executionState: "paused_for_approval" },
    );

    assert.equal(updated?.executionState, "resume_requested");
    assert.equal(stale, undefined);
    assert.equal(repo.getRun("run-cas").pendingApprovedBy, undefined);
  });

  it("handles missing lookups, corrupted JSON fallbacks, cursors, and run events", () => {
    const { db, repo } = createRepoWithDb();

    assert.throws(() => repo.getPlan("missing-plan"), /Orchestration plan missing-plan not found/);
    assert.throws(() => repo.getRun("missing-run"), /Orchestration run missing-run not found/);
    assert.equal(repo.findLatestRunByPlan("missing-plan"), undefined);

    repo.upsertPlan(plan);
    db.prepare("UPDATE orchestration_plans SET plan_json = ? WHERE plan_id = ?").run("{bad", plan.planId);
    assert.equal(repo.getPlan(plan.planId).goal, "[corrupted orchestration plan payload]");

    const run: OrchestrationRun = {
      runId: "run-cursor",
      planId: "plan-1",
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      endedAt: "2026-02-27T00:10:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 1.25,
      totalIterations: 2,
      pendingCostIncrementUsd: undefined,
      lastError: "previous warning",
    };
    repo.createRun(run);
    assert.equal(repo.findLatestRunByPlan("plan-1")?.runId, "run-cursor");

    const firstCheckpoint = repo.createCheckpoint({
      runId: run.runId,
      planId: run.planId,
      waveId: "wave-1",
      phaseId: "phase-1",
      checkpointKind: "phase_executed",
      gitRef: "abc123",
      details: { ok: true },
    });
    const secondCheckpoint = repo.createCheckpoint({
      runId: run.runId,
      planId: run.planId,
      checkpointKind: "run_completed",
      details: { ok: true },
    });
    db.prepare("UPDATE orchestration_checkpoints SET created_at = ? WHERE checkpoint_id = ?").run(
      "2026-02-27T00:00:01.000Z",
      firstCheckpoint.checkpointId,
    );
    db.prepare("UPDATE orchestration_checkpoints SET created_at = ? WHERE checkpoint_id = ?").run(
      "2026-02-27T00:00:02.000Z",
      secondCheckpoint.checkpointId,
    );
    db.prepare("UPDATE orchestration_checkpoints SET details_json = ? WHERE checkpoint_id = ?").run(
      "{bad",
      secondCheckpoint.checkpointId,
    );

    assert.deepEqual(
      repo.listCheckpoints(run.runId, { limit: 0 }).map((item) => item.checkpointId),
      [firstCheckpoint.checkpointId],
    );
    const afterCursor = repo.listCheckpoints(run.runId, { cursor: "2026-02-27T00:00:01.000Z", limit: 10 });
    assert.deepEqual(afterCursor[0]?.details, {});

    repo.appendRunEvent(run.runId, "coverage.event", { ok: true });
    assert.equal(
      db
        .prepare("SELECT COUNT(1) AS count FROM orchestration_events WHERE run_id = ?")
        .get<{ count: number }>(run.runId)?.count,
      1,
    );
  });
});
