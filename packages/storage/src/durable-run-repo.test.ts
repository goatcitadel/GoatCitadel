import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { DurableRunRepository } from "./durable-run-repo.js";

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

function createRepo(): DurableRunRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-durable-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new DurableRunRepository(db);
}

describe("DurableRunRepository", () => {
  it("persists payload updates when runs are patched", () => {
    const repo = createRepo();
    const run = repo.createRun({
      workflowKey: "chat.turn.execute",
      payload: { version: "chat.turn.execute.v1", step: "waiting" },
    });

    const updated = repo.updateRun({
      runId: run.runId,
      status: "waiting",
      payload: {
        version: "chat.turn.execute.v1",
        step: "queued",
        userInputResponses: [{ promptId: "prompt-1", kind: "text" }],
      },
      expectedVersion: run.version,
    });

    assert.deepEqual(updated.payload, {
      version: "chat.turn.execute.v1",
      step: "queued",
      userInputResponses: [{ promptId: "prompt-1", kind: "text" }],
    });
    assert.deepEqual(repo.getRun(run.runId).payload, updated.payload);
  });

  it("explicitly clears terminal and error fields without treating undefined as clear", () => {
    const repo = createRepo();
    const run = repo.createRun({
      workflowKey: "chat.turn.execute",
      status: "failed",
      finishedAt: "2026-03-03T12:00:00.000Z",
      lastError: "provider failed",
    });

    const preserved = repo.updateRun({
      runId: run.runId,
      status: "queued",
      finishedAt: undefined,
      lastError: undefined,
      expectedVersion: run.version,
    });

    assert.equal(preserved.finishedAt, "2026-03-03T12:00:00.000Z");
    assert.equal(preserved.lastError, "provider failed");

    const replaced = repo.updateRun({
      runId: run.runId,
      status: "failed",
      finishedAt: "2026-03-03T12:05:00.000Z",
      lastError: " provider failed again ",
      expectedVersion: preserved.version,
    });

    assert.equal(replaced.finishedAt, "2026-03-03T12:05:00.000Z");
    assert.equal(replaced.lastError, "provider failed again");

    const cleared = repo.updateRun({
      runId: run.runId,
      status: "queued",
      clearFinishedAt: true,
      clearLastError: true,
      expectedVersion: replaced.version,
    });

    assert.equal(cleared.finishedAt, undefined);
    assert.equal(cleared.lastError, undefined);
  });

  it("serializes checkpoint state payloads safely", () => {
    const repo = createRepo();
    const run = repo.createRun({
      workflowKey: "prompt_replay",
      payload: { testCode: "TEST-12" },
    });
    const expected = {
      status: "running",
      replay: {
        fromCheckpoint: "cp-01",
        withOverrides: { model: "glm/glm-5" },
      },
    };
    repo.createCheckpoint({
      runId: run.runId,
      checkpointKind: "manual_replay_requested",
      state: expected,
    });
    const checkpoints = repo.listCheckpoints(run.runId, 20);
    assert.equal(checkpoints.length, 1);
    assert.deepEqual(checkpoints[0]?.state, expected);
  });

  it("keeps retry attempts idempotent by run and attempt number", () => {
    const repo = createRepo();
    const run = repo.createRun({
      workflowKey: "daily_sync",
      payload: { scope: "workspace" },
    });

    repo.upsertRetry({
      runId: run.runId,
      attemptNo: 1,
      reason: "temporary timeout",
      nextRetryAt: "2026-03-03T12:00:00.000Z",
    });
    repo.upsertRetry({
      runId: run.runId,
      attemptNo: 1,
      reason: "temporary timeout (updated reason)",
      nextRetryAt: "2026-03-03T12:30:00.000Z",
    });

    const retries = repo.listRetries(run.runId, 20);
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.attemptNo, 1);
    assert.equal(retries[0]?.reason, "temporary timeout (updated reason)");
    assert.equal(retries[0]?.nextRetryAt, "2026-03-03T12:30:00.000Z");
  });

  it("does not truncate retry history when attempt numbers are sparse", () => {
    const repo = createRepo();
    const run = repo.createRun({
      workflowKey: "durable_sparse_attempts",
      payload: { testCode: "TEST-32" },
    });

    repo.upsertRetry({
      runId: run.runId,
      attemptNo: 1,
      reason: "first",
    });
    repo.upsertRetry({
      runId: run.runId,
      attemptNo: 3,
      reason: "third",
    });
    const updated = repo.upsertRetry({
      runId: run.runId,
      attemptNo: 7,
      reason: "seventh",
    });

    const retries = repo.listRetries(run.runId, 20);
    assert.equal(retries.length, 3);
    assert.deepEqual(
      retries.map((item) => item.attemptNo),
      [1, 3, 7],
    );
    assert.equal(updated.attemptNo, 7);
    assert.equal(updated.reason, "seventh");
  });

  it("looks up and resolves dead letters by id", () => {
    const repo = createRepo();
    const run = repo.createRun({
      workflowKey: "connector.delivery",
      payload: { task: "notify" },
    });

    const deadLetter = repo.upsertDeadLetter({
      deadLetterId: "dead-1",
      runId: run.runId,
      reason: "timeout",
      payload: { attempt: 3 },
    });

    assert.equal(repo.getDeadLetterById(deadLetter.deadLetterId).reason, "timeout");

    const resolved = repo.resolveDeadLetter(deadLetter.deadLetterId, {
      resolvedAt: "2026-04-10T00:00:00.000Z",
      resolutionNote: "recovered by operator",
    });

    assert.equal(resolved.resolvedAt, "2026-04-10T00:00:00.000Z");
    assert.equal(resolved.resolutionNote, "recovered by operator");
  });

  it("covers run validation, lease lifecycle, indexes, and dead-letter edge cases", () => {
    const repo = createRepo();

    assert.throws(() => repo.createRun({ workflowKey: "   " }), /workflowKey is required/);
    assert.throws(() => repo.getRun("missing-run"), /Durable run missing-run not found/);

    const queued = repo.createRun({
      runId: "run-queued",
      workflowKey: "workflow.queued",
      attemptCount: -3,
      maxAttempts: 0,
      payload: [] as unknown as Record<string, unknown>,
      metadata: [] as unknown as Record<string, unknown>,
      lastError: "   ",
      leaseOwnerId: "   ",
      now: "2026-04-21T00:00:00.000Z",
    });
    const completed = repo.createRun({
      runId: "run-completed",
      workflowKey: "workflow.completed",
      status: "completed",
      startedAt: "2026-04-21T00:01:00.000Z",
      finishedAt: "2026-04-21T00:02:00.000Z",
      now: "2026-04-21T00:01:00.000Z",
    });

    assert.equal(queued.attemptCount, 0);
    assert.equal(queued.maxAttempts, 1);
    assert.deepEqual(queued.payload, {});
    assert.equal(queued.metadata, undefined);
    assert.equal(queued.lastError, undefined);
    assert.equal(queued.leaseOwnerId, undefined);
    assert.equal(
      repo.tryClaimQueuedRun({ ...leaseInput("run-completed", "worker-a"), updatedAt: "2026-04-21T00:03:00.000Z" }),
      undefined,
    );

    assert.throws(
      () =>
        repo.updateRun({
          runId: queued.runId,
          status: "running",
          expectedVersion: queued.version + 99,
        }),
      /update conflict/,
    );

    const claimed = repo.tryClaimQueuedRun(leaseInput(queued.runId, "worker-a"));
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.startedAt, "2026-04-21T00:03:00.000Z");
    assert.equal(claimed?.leaseOwnerId, "worker-a");
    assert.equal(repo.renewLease(leaseInput(queued.runId, "worker-b")), undefined);
    const renewed = repo.renewLease({
      ...leaseInput(queued.runId, "worker-a"),
      leaseHeartbeatAt: "2026-04-21T00:04:00.000Z",
      leaseExpiresAt: "2026-04-21T00:09:00.000Z",
    });
    assert.equal(renewed?.leaseHeartbeatAt, "2026-04-21T00:04:00.000Z");
    assert.equal(repo.releaseLease(queued.runId, "worker-b"), undefined);
    const released = repo.releaseLease(queued.runId, "worker-a", "2026-04-21T00:05:00.000Z");
    assert.equal(released?.leaseOwnerId, undefined);
    assert.equal(released?.leaseExpiresAt, undefined);
    assert.equal(released?.leaseHeartbeatAt, undefined);

    const running = repo.updateRun({
      runId: queued.runId,
      status: "running",
      leaseOwnerId: "worker-c",
      leaseHeartbeatAt: "2026-04-21T00:06:00.000Z",
      leaseExpiresAt: "2026-04-21T00:07:00.000Z",
      expectedVersion: released!.version,
    });
    assert.equal(running.leaseOwnerId, "worker-c");
    assert.deepEqual(repo.listExpiredRunningRunIds("2026-04-21T00:08:00.000Z"), [queued.runId]);
    assert.deepEqual(repo.listRunIdsByStatus("completed"), [completed.runId]);
    assert.equal(repo.countRuns(), 2);
    assert.deepEqual(repo.statusCounts(), { completed: 1, running: 1 });
    assert.deepEqual(
      repo.listRuns(1).map((run) => run.runId),
      [completed.runId],
    );

    assert.throws(() => repo.upsertRetry({ runId: queued.runId, attemptNo: 0, reason: "   " }), /reason is required/);
    assert.throws(() => repo.upsertDeadLetter({ runId: queued.runId, reason: "   " }), /reason is required/);
    assert.equal(repo.getDeadLetterByRun("missing-run"), undefined);
    assert.throws(
      () => repo.getDeadLetterById("missing-dead-letter"),
      /Durable dead letter missing-dead-letter not found/,
    );

    const deadLetter = repo.upsertDeadLetter({
      deadLetterId: "dead-edge",
      runId: queued.runId,
      reason: "first failure",
      payload: [] as unknown as Record<string, unknown>,
      resolutionNote: "   ",
      createdAt: "2026-04-21T00:10:00.000Z",
    });
    assert.deepEqual(deadLetter.payload, {});
    assert.equal(deadLetter.resolutionNote, undefined);
    assert.deepEqual(
      repo.listDeadLetters(5).map((item) => item.deadLetterId),
      ["dead-edge"],
    );

    const internal = repo as unknown as {
      listCheckpointsStmt: { all: (...args: unknown[]) => unknown };
      listRetriesStmt: { all: (...args: unknown[]) => unknown };
      countRunsStmt: { get: (...args: unknown[]) => unknown };
    };
    internal.listCheckpointsStmt = { all: () => [null] };
    internal.listRetriesStmt = { all: () => ({ not: "an array" }) };
    internal.countRunsStmt = { get: () => null };
    assert.deepEqual(repo.listCheckpoints(queued.runId), []);
    assert.deepEqual(repo.listRetries(queued.runId), []);
    assert.equal(repo.countRuns(), 0);
    internal.countRunsStmt = { get: () => ({ count: "bad" }) };
    assert.equal(repo.countRuns(), 0);
  });

  it("preserves existing run fields when optional update inputs are omitted", () => {
    const repo = createRepo();
    const run = repo.createRun({
      runId: "run-preserve",
      workflowKey: "workflow.preserve",
      status: "running",
      attemptCount: 2,
      maxAttempts: 5,
      payload: { step: "execute" },
      metadata: { source: "test" },
      startedAt: "2026-04-22T00:00:00.000Z",
      finishedAt: "2026-04-22T00:05:00.000Z",
      lastError: "previous warning",
      leaseOwnerId: "worker-a",
      leaseHeartbeatAt: "2026-04-22T00:01:00.000Z",
      leaseExpiresAt: "2026-04-22T00:10:00.000Z",
      now: "2026-04-22T00:00:00.000Z",
    });

    const updated = repo.updateRun({
      runId: run.runId,
      status: "waiting",
      expectedVersion: run.version,
    });

    assert.equal(updated.status, "waiting");
    assert.equal(updated.attemptCount, 2);
    assert.equal(updated.maxAttempts, 5);
    assert.deepEqual(updated.payload, { step: "execute" });
    assert.deepEqual(updated.metadata, { source: "test" });
    assert.equal(updated.startedAt, "2026-04-22T00:00:00.000Z");
    assert.equal(updated.finishedAt, "2026-04-22T00:05:00.000Z");
    assert.equal(updated.lastError, "previous warning");
    assert.equal(updated.leaseOwnerId, "worker-a");
    assert.equal(updated.leaseHeartbeatAt, "2026-04-22T00:01:00.000Z");
    assert.equal(updated.leaseExpiresAt, "2026-04-22T00:10:00.000Z");
    assert.ok(updated.updatedAt);
  });

  it("uses existing start time and default timestamps during lease transitions", () => {
    const repo = createRepo();
    const run = repo.createRun({
      runId: "run-lease-defaults",
      workflowKey: "workflow.lease",
      startedAt: "2026-04-23T00:00:00.000Z",
      now: "2026-04-23T00:00:00.000Z",
    });

    const claimed = repo.tryClaimQueuedRun(leaseInput(run.runId, "worker-a"));
    assert.equal(claimed?.startedAt, "2026-04-23T00:00:00.000Z");
    assert.equal(claimed?.updatedAt, "2026-04-21T00:03:00.000Z");

    const renewed = repo.renewLease({
      ...leaseInput(run.runId, "worker-a"),
      leaseHeartbeatAt: "2026-04-23T00:01:00.000Z",
      leaseExpiresAt: "2026-04-23T00:11:00.000Z",
    });
    assert.equal(renewed?.updatedAt, "2026-04-23T00:01:00.000Z");

    const released = repo.releaseLease(run.runId, "worker-a");
    assert.equal(released?.leaseOwnerId, undefined);
    assert.ok(released?.updatedAt);
  });

  it("filters malformed durable rows from list helpers", () => {
    const repo = createRepo();
    const internal = repo as unknown as {
      listRunsStmt: { all: (...args: unknown[]) => unknown };
      listCheckpointsStmt: { all: (...args: unknown[]) => unknown };
      listRetriesStmt: { all: (...args: unknown[]) => unknown };
      listDeadLettersStmt: { all: (...args: unknown[]) => unknown };
      getDeadLetterByRunStmt: { get: (...args: unknown[]) => unknown };
    };

    internal.listRunsStmt = { all: () => ({ not: "an array" }) };
    internal.listCheckpointsStmt = { all: () => ({ not: "an array" }) };
    internal.listRetriesStmt = { all: () => [null, { retry_id: 1 }] };
    internal.listDeadLettersStmt = { all: () => [null, { dead_letter_id: 1 }] };
    internal.getDeadLetterByRunStmt = { get: () => ({ dead_letter_id: 1 }) };

    assert.deepEqual(repo.listRuns(), []);
    assert.deepEqual(repo.listCheckpoints("run-missing"), []);
    assert.deepEqual(repo.listRetries("run-missing"), []);
    assert.deepEqual(repo.listDeadLetters(), []);
    assert.equal(repo.getDeadLetterByRun("run-missing"), undefined);
  });

  it("falls back for affected-row and post-write lookup edge cases", () => {
    const repo = createRepo();
    const run = repo.createRun({
      runId: "run-tail-branches",
      workflowKey: "workflow.tail",
      now: "2026-04-24T00:00:00.000Z",
    });

    const internal = repo as unknown as {
      updateRunStmt: { run: (...args: unknown[]) => unknown };
      listRetries: (runId: string, limit?: number) => ReturnType<DurableRunRepository["listRetries"]>;
      getDeadLetterByRun: (runId: string) => ReturnType<DurableRunRepository["getDeadLetterByRun"]>;
      listDeadLettersStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.updateRunStmt = { run: () => ({}) };
    assert.throws(
      () => repo.updateRun({ runId: run.runId, status: "running", expectedVersion: run.version }),
      /update conflict/,
    );

    const claimRepo = createRepo();
    const claimRun = claimRepo.createRun({
      runId: "run-claim-no-change-count",
      workflowKey: "workflow.claim",
    });
    const claimInternal = claimRepo as unknown as {
      updateRunStmt: { run: (...args: unknown[]) => unknown };
    };
    claimInternal.updateRunStmt = { run: () => ({}) };
    assert.equal(claimRepo.tryClaimQueuedRun(leaseInput(claimRun.runId, "worker-a")), undefined);

    const retryRepo = createRepo();
    const retryRun = retryRepo.createRun({ runId: "run-retry-fallback", workflowKey: "workflow.retry" });
    const retryInternal = retryRepo as unknown as {
      listRetries: (runId: string, limit?: number) => ReturnType<DurableRunRepository["listRetries"]>;
    };
    retryInternal.listRetries = () => [];
    const retry = retryRepo.upsertRetry({
      retryId: "retry-fallback",
      runId: retryRun.runId,
      attemptNo: 2,
      reason: "fallback row",
    });
    assert.equal(retry.retryId, "retry-fallback");

    const deadLetterRepo = createRepo();
    const deadRun = deadLetterRepo.createRun({ runId: "run-dead-fallback", workflowKey: "workflow.dead" });
    const deadInternal = deadLetterRepo as unknown as {
      getDeadLetterByRun: (runId: string) => ReturnType<DurableRunRepository["getDeadLetterByRun"]>;
      listDeadLettersStmt: { all: (...args: unknown[]) => unknown };
    };
    deadInternal.getDeadLetterByRun = () => undefined;
    const deadLetter = deadLetterRepo.upsertDeadLetter({
      deadLetterId: "dead-fallback",
      runId: deadRun.runId,
      reason: "fallback row",
    });
    assert.equal(deadLetter.deadLetterId, "dead-fallback");

    deadInternal.listDeadLettersStmt = { all: () => ({ not: "rows" }) };
    assert.deepEqual(deadLetterRepo.listDeadLetters(), []);

    const resolvable = createRepo();
    const resolveRun = resolvable.createRun({ runId: "run-resolve-defaults", workflowKey: "workflow.resolve" });
    const inserted = resolvable.upsertDeadLetter({
      deadLetterId: "dead-resolve-defaults",
      runId: resolveRun.runId,
      reason: "needs default resolution fields",
    });
    const resolved = resolvable.resolveDeadLetter(inserted.deadLetterId);
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.resolutionNote, undefined);
  });
  describe("pruneCheckpoints", () => {
    it("removes orphan checkpoints whose run was deleted", () => {
      const repo = createRepo();
      const run = repo.createRun({ workflowKey: "test.workflow" });
      repo.createCheckpoint({
        runId: run.runId,
        checkpointKind: "run_created",
        state: { step: 1 },
      });
      // Force-orphan: directly write a checkpoint pointing at a non-existent run
      const dbForOrphan = (repo as unknown as { db: import("./db.js").DatabaseClient }).db;
      dbForOrphan.exec("PRAGMA foreign_keys = OFF");
      dbForOrphan
        .prepare(
          "INSERT INTO durable_checkpoints (checkpoint_id, run_id, checkpoint_kind, state_json, created_at) VALUES (@id, @runId, @kind, @state, @at)",
        )
        .run({
          id: "orphan-1",
          runId: "no-such-run",
          kind: "run_created",
          state: "{}",
          at: "2026-05-15T00:00:00.000Z",
        });
      dbForOrphan.exec("PRAGMA foreign_keys = ON");

      const summary = repo.pruneCheckpoints({ keepPerRun: 50, diskBudgetBytes: 1024 * 1024 });
      assert.equal(summary.prunedOrphans, 1);
      assert.equal(summary.prunedAged, 0);
      assert.equal(repo.listCheckpoints(run.runId, 100).length, 1);
    });

    it("keeps at most keepPerRun checkpoints per terminal run, pruning oldest", () => {
      const repo = createRepo();
      const run = repo.createRun({ workflowKey: "test.workflow" });
      for (let i = 0; i < 5; i += 1) {
        repo.createCheckpoint({
          runId: run.runId,
          checkpointKind: "run_started",
          state: { step: i },
          createdAt: new Date(2026, 0, 1, i).toISOString(),
        });
      }
      repo.updateRun({
        runId: run.runId,
        status: "completed",
        finishedAt: "2026-05-15T00:00:00.000Z",
        expectedVersion: run.version,
      });

      const summary = repo.pruneCheckpoints({ keepPerRun: 2, diskBudgetBytes: 1024 * 1024 });
      assert.equal(summary.prunedAged, 3);
      const remaining = repo.listCheckpoints(run.runId, 100);
      assert.equal(remaining.length, 2);
      // Oldest pruned, newest kept
      const r0 = remaining[0];
      const r1 = remaining[1];
      assert.ok(r0);
      assert.ok(r1);
      assert.equal((r0.state as { step: number }).step, 3);
      assert.equal((r1.state as { step: number }).step, 4);
    });

    it("never prunes active (non-terminal) run checkpoints even when over budget", () => {
      const repo = createRepo();
      const run = repo.createRun({ workflowKey: "test.workflow" });
      for (let i = 0; i < 10; i += 1) {
        repo.createCheckpoint({
          runId: run.runId,
          checkpointKind: "run_started",
          state: { step: i, big: "x".repeat(1024) },
          createdAt: new Date(2026, 0, 1, i).toISOString(),
        });
      }
      // Run stays "queued" — non-terminal

      const summary = repo.pruneCheckpoints({ keepPerRun: 2, diskBudgetBytes: 10 });
      assert.equal(summary.prunedAged, 0);
      assert.equal(repo.listCheckpoints(run.runId, 100).length, 10);
    });

    it("prunes oldest across terminal runs to fit disk budget", () => {
      const repo = createRepo();
      const runA = repo.createRun({ workflowKey: "test.a" });
      const runB = repo.createRun({ workflowKey: "test.b" });
      for (let i = 0; i < 5; i += 1) {
        repo.createCheckpoint({
          runId: runA.runId,
          checkpointKind: "run_started",
          state: { run: "A", step: i, pad: "x".repeat(200) },
          createdAt: new Date(2026, 0, 1, i).toISOString(),
        });
        repo.createCheckpoint({
          runId: runB.runId,
          checkpointKind: "run_started",
          state: { run: "B", step: i, pad: "y".repeat(200) },
          createdAt: new Date(2026, 1, 1, i).toISOString(),
        });
      }
      repo.updateRun({
        runId: runA.runId,
        status: "completed",
        finishedAt: "2026-05-15T00:00:00.000Z",
        expectedVersion: runA.version,
      });
      repo.updateRun({
        runId: runB.runId,
        status: "completed",
        finishedAt: "2026-05-15T00:00:00.000Z",
        expectedVersion: runB.version,
      });

      const summary = repo.pruneCheckpoints({ keepPerRun: 100, diskBudgetBytes: 1024 });
      assert.ok(summary.prunedAged > 0, "should prune to fit disk budget");
      assert.ok(summary.finalBytes <= 1024 + 250, "final bytes should be at or under budget+headroom");
    });

    it("returns zero counts when nothing to prune", () => {
      const repo = createRepo();
      const summary = repo.pruneCheckpoints({ keepPerRun: 50, diskBudgetBytes: 1024 });
      assert.equal(summary.prunedOrphans, 0);
      assert.equal(summary.prunedAged, 0);
      assert.equal(summary.finalBytes, 0);
    });

    it("accounts for UTF-8 byte length of multi-byte characters in disk budget", () => {
      const repo = createRepo();
      const run = repo.createRun({ workflowKey: "test.utf8" });
      // 100-character string of multi-byte UTF-8 chars (é = 2 bytes each)
      const padding = "é".repeat(100);
      for (let i = 0; i < 5; i += 1) {
        repo.createCheckpoint({
          runId: run.runId,
          checkpointKind: "run_started",
          state: { run: "utf8", step: i, pad: padding },
          createdAt: new Date(2026, 0, 1, i).toISOString(),
        });
      }
      repo.updateRun({
        runId: run.runId,
        status: "completed",
        finishedAt: "2026-05-15T00:00:00.000Z",
        expectedVersion: run.version,
      });

      // Set a tight budget that requires pruning AT LEAST some checkpoints
      // when bytes are counted correctly. 100 multi-byte chars + json overhead
      // per checkpoint is roughly 250 bytes; 5 checkpoints ~= 1250 bytes.
      const summary = repo.pruneCheckpoints({ keepPerRun: 100, diskBudgetBytes: 600 });
      assert.ok(summary.prunedAged > 0, "should prune some checkpoints under 600-byte budget");
      assert.ok(
        summary.finalBytes <= 600 + 300,
        `finalBytes should be at or under budget+headroom, got ${summary.finalBytes}`,
      );
      // The budget guard must work consistently — re-running with no slack should not over-prune
      const second = repo.pruneCheckpoints({ keepPerRun: 100, diskBudgetBytes: 600 });
      // Second pass should not destroy more than already needed
      assert.ok(second.finalBytes <= summary.finalBytes + 300, "second pass should be idempotent within tolerance");
    });
  });
});

function leaseInput(runId: string, workerId: string) {
  return {
    runId,
    workerId,
    leaseHeartbeatAt: "2026-04-21T00:03:00.000Z",
    leaseExpiresAt: "2026-04-21T00:08:00.000Z",
  };
}
