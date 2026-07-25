import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals, createDatabase } from "./sqlite.js";
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
      operatorId: "operator-1",
      authActorId: "auth-operator-1",
      authActorSource: "loopback",
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
      executionState: "worktree_ready",
      worktreePath: "F:/code/personal-ai/.worktrees/run-1",
      worktreeStatus: "ready",
      worktreeBaseRef: "HEAD",
      worktreeLeaseOwnerId: "gateway-owner-1",
      worktreeLeaseGeneration: 3,
      worktreeLeaseExpiresAt: "2026-02-27T00:05:00.000Z",
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
    assert.equal(persistedRun.operatorId, "operator-1");
    assert.equal(persistedRun.authActorId, "auth-operator-1");
    assert.equal(persistedRun.authActorSource, "loopback");
    assert.equal(persistedRun.permissionProfileId, "trusted-local-power");
    assert.equal(persistedRun.localOperatorOverrideId, "override-1");
    assert.equal(persistedRun.executionState, "paused_for_approval");
    assert.equal(persistedRun.worktreeStatus, "ready");
    assert.equal(persistedRun.worktreeLeaseOwnerId, "gateway-owner-1");
    assert.equal(persistedRun.worktreeLeaseGeneration, 3);
    assert.equal(persistedRun.worktreeLeaseExpiresAt, "2026-02-27T00:05:00.000Z");
    assert.equal(persistedRun.pendingApprovalPhaseId, "phase-1");
    assert.equal(persistedRun.pendingApprovedBy, "operator");
    assert.equal(persistedRun.pendingCostIncrementUsd, 0.25);

    const afterStaleLeaseUpdate = repo.updateRun({
      ...persistedRun,
      worktreeLeaseOwnerId: "stale-owner",
      worktreeLeaseGeneration: 2,
      worktreeLeaseExpiresAt: "2026-02-27T00:04:00.000Z",
    });
    assert.equal(afterStaleLeaseUpdate.worktreeLeaseOwnerId, "gateway-owner-1");
    assert.equal(afterStaleLeaseUpdate.worktreeLeaseGeneration, 3);
    assert.equal(afterStaleLeaseUpdate.worktreeLeaseExpiresAt, "2026-02-27T00:05:00.000Z");

    const afterSameGenerationDifferentOwner = repo.updateRun({
      ...afterStaleLeaseUpdate,
      worktreeLeaseOwnerId: "same-generation-stale-owner",
      worktreeLeaseGeneration: 3,
      worktreeLeaseExpiresAt: "2026-02-27T00:06:00.000Z",
    });
    assert.equal(afterSameGenerationDifferentOwner.worktreeLeaseOwnerId, "gateway-owner-1");
    assert.equal(afterSameGenerationDifferentOwner.worktreeLeaseGeneration, 3);
    assert.equal(afterSameGenerationDifferentOwner.worktreeLeaseExpiresAt, "2026-02-27T00:05:00.000Z");

    const afterSameOwnerRenewal = repo.updateRun({
      ...afterSameGenerationDifferentOwner,
      worktreeLeaseExpiresAt: "2026-02-27T00:07:00.000Z",
    });
    assert.equal(afterSameOwnerRenewal.worktreeLeaseOwnerId, "gateway-owner-1");
    assert.equal(afterSameOwnerRenewal.worktreeLeaseGeneration, 3);
    assert.equal(afterSameOwnerRenewal.worktreeLeaseExpiresAt, "2026-02-27T00:07:00.000Z");
    assert.equal(
      repo.renewWorktreeLease({
        runId: run.runId,
        worktreeLeaseOwnerId: "wrong-owner",
        worktreeLeaseGeneration: 3,
        worktreeLeaseExpiresAt: "2026-02-27T00:08:00.000Z",
      }),
      undefined,
    );
    assert.equal(
      repo.renewWorktreeLease({
        runId: run.runId,
        worktreeLeaseOwnerId: "gateway-owner-1",
        worktreeLeaseGeneration: 3,
        worktreeLeaseExpiresAt: "2026-02-27T00:09:00.000Z",
      })?.worktreeLeaseExpiresAt,
      "2026-02-27T00:09:00.000Z",
    );
    const adopted = repo.adoptWorktreeLease({
      runId: run.runId,
      worktreePath: run.worktreePath!,
      expectedWorktreeLeaseOwnerId: "gateway-owner-1",
      expectedWorktreeLeaseGeneration: 3,
      worktreeLeaseOwnerId: "gateway-owner-2",
      worktreeLeaseGeneration: 4,
      worktreeLeaseExpiresAt: "2026-02-27T00:11:00.000Z",
    });
    assert.equal(adopted?.worktreeLeaseOwnerId, "gateway-owner-2");
    assert.equal(adopted?.worktreeLeaseGeneration, 4);

    const afterStaleMixedGenerationUpdate = repo.updateRun({
      ...afterSameOwnerRenewal,
      worktreePath: "F:/stale-path",
      worktreeStatus: "blocked",
      worktreeBaseRef: "stale-ref",
      worktreeLeaseOwnerId: "gateway-owner-1",
      worktreeLeaseGeneration: 3,
      worktreeLeaseExpiresAt: "2026-02-27T00:12:00.000Z",
    });
    assert.equal(afterStaleMixedGenerationUpdate.worktreePath, run.worktreePath);
    assert.equal(afterStaleMixedGenerationUpdate.worktreeStatus, "ready");
    assert.equal(afterStaleMixedGenerationUpdate.worktreeBaseRef, "HEAD");
    assert.equal(afterStaleMixedGenerationUpdate.worktreeLeaseOwnerId, "gateway-owner-2");
    assert.equal(afterStaleMixedGenerationUpdate.worktreeLeaseGeneration, 4);
    assert.equal(afterStaleMixedGenerationUpdate.worktreeLeaseExpiresAt, "2026-02-27T00:11:00.000Z");

    const afterStaleMixedGenerationCas = repo.updateRunIfCurrentState(
      {
        ...afterSameOwnerRenewal,
        worktreePath: "F:/stale-cas-path",
        worktreeStatus: "blocked",
        worktreeBaseRef: "stale-cas-ref",
        worktreeLeaseOwnerId: "gateway-owner-1",
        worktreeLeaseGeneration: 3,
        worktreeLeaseExpiresAt: "2026-02-27T00:13:00.000Z",
      },
      {
        status: afterStaleMixedGenerationUpdate.status,
        executionState: afterStaleMixedGenerationUpdate.executionState,
      },
    );
    assert.equal(afterStaleMixedGenerationCas?.worktreePath, run.worktreePath);
    assert.equal(afterStaleMixedGenerationCas?.worktreeStatus, "ready");
    assert.equal(afterStaleMixedGenerationCas?.worktreeBaseRef, "HEAD");
    assert.equal(afterStaleMixedGenerationCas?.worktreeLeaseOwnerId, "gateway-owner-2");
    assert.equal(afterStaleMixedGenerationCas?.worktreeLeaseGeneration, 4);

    assert.equal(
      repo.fenceWorktreeLease({
        runId: run.runId,
        worktreePath: run.worktreePath!,
        worktreeLeaseOwnerId: "stale-owner",
        worktreeLeaseGeneration: 4,
        endedAt: "2026-02-27T00:10:00.000Z",
        lastError: "stale owner must not fence",
      }),
      undefined,
    );
    const fenced = repo.fenceWorktreeLease({
      runId: run.runId,
      worktreePath: run.worktreePath!,
      worktreeLeaseOwnerId: "gateway-owner-2",
      worktreeLeaseGeneration: 4,
      endedAt: "2026-02-27T00:10:00.000Z",
      lastError: "worktree lease lost",
    });
    assert.equal(fenced?.status, "failed");
    assert.equal(fenced?.executionState, "failed");
    assert.equal(fenced?.worktreeStatus, "blocked");
    assert.equal(fenced?.lastError, "worktree lease lost");

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

  it("persists and restores the per-wave cost accumulator and stop reason across reload", () => {
    const repo = createRepo();
    repo.upsertPlan(plan);

    const run: OrchestrationRun = {
      runId: "run-wave-budget",
      planId: "plan-1",
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      currentWaveId: "wave-1",
      currentPhaseId: "phase-1",
      totalCostUsd: 0.8,
      totalIterations: 2,
      waveCostUsdByWaveId: { "wave-1": 0.5, "wave-2": 0.3 },
      workspaceId: "default",
    };
    repo.createRun(run);

    const afterCreate = repo.getRun("run-wave-budget");
    assert.deepEqual(afterCreate.waveCostUsdByWaveId, { "wave-1": 0.5, "wave-2": 0.3 });
    assert.equal(afterCreate.stopReason, undefined);

    repo.updateRun({
      ...afterCreate,
      status: "stopped_by_limit",
      stopReason: "wave_budget_exceeded",
      waveCostUsdByWaveId: { "wave-1": 1.1, "wave-2": 0.3 },
      endedAt: "2026-02-27T00:10:00.000Z",
    });

    const afterUpdate = repo.getRun("run-wave-budget");
    assert.equal(afterUpdate.status, "stopped_by_limit");
    assert.equal(afterUpdate.stopReason, "wave_budget_exceeded");
    assert.deepEqual(afterUpdate.waveCostUsdByWaveId, { "wave-1": 1.1, "wave-2": 0.3 });
  });

  it("treats an absent per-wave accumulator and stop reason as undefined", () => {
    const repo = createRepo();
    repo.upsertPlan(plan);
    const run: OrchestrationRun = {
      runId: "run-no-wave-cost",
      planId: "plan-1",
      status: "running",
      startedAt: "2026-02-27T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 0,
      workspaceId: "default",
    };
    repo.createRun(run);

    const persisted = repo.getRun("run-no-wave-cost");
    assert.equal(persisted.waveCostUsdByWaveId, undefined);
    assert.equal(persisted.stopReason, undefined);
  });

  it("scopes plan payloads by workspace", () => {
    const repo = createRepo();

    repo.upsertPlan({ ...plan, goal: "workspace a" }, "workspace-a");
    repo.upsertPlan({ ...plan, goal: "workspace b" }, "workspace-b");

    assert.equal(repo.getPlan("plan-1", "workspace-a").goal, "workspace a");
    assert.equal(repo.getPlan("plan-1", "workspace-b").goal, "workspace b");
    assert.throws(() => repo.getPlan("plan-1"), /Orchestration plan plan-1 not found/);
  });

  it("backfills legacy global plans into non-default run workspaces during migration", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-orch-legacy-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Migrations 172+ fail closed on databases that claim applied history without the real
    // predecessor tables, so build the genuine v92 schema before installing the legacy
    // orchestration shapes that predate workspace scoping.
    for (let version = 1; version < 93; version += 1) {
      __sqliteInternals.applySchemaMigrationForTest(version, legacy);
    }
    legacy.exec(`
      DROP TABLE IF EXISTS orchestration_events;
      DROP TABLE IF EXISTS orchestration_checkpoints;
      DROP TABLE IF EXISTS orchestration_runs;
      DROP TABLE IF EXISTS orchestration_plans;
      CREATE TABLE orchestration_plans (
        plan_id TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE orchestration_runs (
        run_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        current_wave_id TEXT,
        current_phase_id TEXT,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        total_iterations INTEGER NOT NULL DEFAULT 0,
        workspace_id TEXT,
        durable_run_id TEXT,
        operator_id TEXT,
        auth_actor_id TEXT,
        auth_actor_source TEXT,
        permission_profile_id TEXT,
        local_operator_override_id TEXT,
        execution_state TEXT,
        worktree_path TEXT,
        worktree_status TEXT,
        worktree_base_ref TEXT,
        pending_approval_phase_id TEXT,
        pending_approved_by TEXT,
        pending_cost_increment_usd REAL,
        last_error TEXT
      );
      CREATE TABLE orchestration_checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        wave_id TEXT,
        phase_id TEXT,
        checkpoint_kind TEXT NOT NULL,
        git_ref TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE orchestration_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const markApplied = legacy.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (let version = 1; version < 93; version += 1) {
      markApplied.run(version, __sqliteInternals.getSchemaMigrationNameForTest(version), "2026-02-27T00:00:00.000Z");
    }
    legacy
      .prepare("INSERT INTO orchestration_plans (plan_id, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(
        "plan-legacy",
        JSON.stringify({ ...plan, planId: "plan-legacy", goal: "legacy" }),
        "2026-02-27",
        "2026-02-27",
      );
    legacy
      .prepare(
        "INSERT INTO orchestration_runs (run_id, plan_id, status, started_at, workspace_id, durable_run_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("run-legacy", "plan-legacy", "paused", "2026-02-27T00:00:00.000Z", "workspace-a", "durable-run");
    legacy.close();

    const db = createDatabase({ dbPath });
    const repo = new OrchestrationRepository(db);

    assert.equal(repo.getPlan("plan-legacy", "default").goal, "legacy");
    assert.equal(repo.getPlan("plan-legacy", "workspace-a").goal, "legacy");
    db.close();
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
        status: "running",
        executionState: "resume_requested",
        pendingApprovalPhaseId: "phase-1",
      },
      { status: "paused", executionState: "paused_for_approval" },
    );
    const stale = repo.updateRunIfCurrentState(
      {
        ...run,
        status: "running",
        executionState: "resume_requested",
        pendingApprovedBy: "duplicate",
      },
      { status: "paused", executionState: "paused_for_approval" },
    );

    assert.equal(updated?.status, "running");
    assert.equal(updated?.executionState, "resume_requested");
    assert.equal(stale, undefined);
    assert.equal(repo.getRun("run-cas").pendingApprovedBy, undefined);
  });

  it("handles missing lookups, corrupted JSON fallbacks, cursors, and run events", () => {
    const { db, repo } = createRepoWithDb();

    assert.throws(() => repo.getPlan("missing-plan"), /Orchestration plan missing-plan not found/);
    assert.throws(() => repo.getRun("missing-run"), /Orchestration run missing-run not found/);
    assert.equal(repo.findLatestRunByPlan("missing-plan"), undefined);
    assert.equal(repo.findActiveRunByPlan("missing-plan"), undefined);

    repo.upsertPlan(plan);
    db.prepare("UPDATE orchestration_plans SET plan_json = ? WHERE plan_id = ? AND workspace_id = ?").run(
      "{bad",
      plan.planId,
      "default",
    );
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
    assert.equal(repo.findActiveRunByPlan("plan-1")?.runId, "run-cursor");
    repo.createRun({
      ...run,
      runId: "run-workspace-2",
      workspaceId: "workspace-2",
      startedAt: "2026-02-27T00:01:00.000Z",
    });
    assert.equal(repo.findActiveRunByPlan("plan-1")?.runId, "run-cursor");
    assert.equal(repo.findActiveRunByPlan("plan-1", "workspace-2")?.runId, "run-workspace-2");

    repo.updateRun({
      ...run,
      status: "cancelled",
      executionState: "cancelled",
      endedAt: "2026-02-27T00:11:00.000Z",
    });
    assert.equal(repo.findActiveRunByPlan("plan-1"), undefined);
    assert.equal(repo.findActiveRunByPlan("plan-1", "workspace-2")?.runId, "run-workspace-2");

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
      checkpointKind: "run_cancelled",
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

    repo.appendRunEvent(run.runId, "phase.completed", {
      phaseId: "phase-2",
      outputSummary: "finished",
    });
    repo.appendRunEvent(run.runId, "run.completed", { totalCostUsd: 1.25 });
    const events = repo.listRunEvents(run.runId);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventType, "phase.completed");
    assert.deepEqual(events[0]?.payload, {
      phaseId: "phase-2",
      outputSummary: "finished",
    });
    assert.deepEqual(
      repo.listRunEvents(run.runId, { limit: 1 }).map((event) => event.eventType),
      ["phase.completed"],
    );

    db.prepare("UPDATE orchestration_events SET payload_json = ? WHERE event_id = ?").run("{bad", events[0]?.eventId);
    assert.deepEqual(repo.listRunEvents(run.runId)[0]?.payload, {});

    assert.deepEqual(
      repo.listRuns(0).map((item) => item.runId),
      ["run-workspace-2"],
    );

    const internal = repo as unknown as {
      listRunsStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.listRunsStmt = { all: () => [null] };
    assert.throws(() => repo.listRuns(), /Unexpected orchestration_runs row shape/);
  });
});
