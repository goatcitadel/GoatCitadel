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

    const cleared = repo.updateRun({
      runId: run.runId,
      status: "queued",
      clearFinishedAt: true,
      clearLastError: true,
      expectedVersion: preserved.version,
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
