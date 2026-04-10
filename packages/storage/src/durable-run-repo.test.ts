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
});
