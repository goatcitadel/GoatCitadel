import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import type { DatabaseClient } from "./db.js";

describe("canonical waiting checkpoint authority", () => {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-waiting-checkpoint-${randomUUID()}.db`);
  let db: DatabaseClient;
  let repo: DurableRunRepository;
  before(() => {
    db = createDatabase({ dbPath });
    repo = new DurableRunRepository(db);
  });
  after(() => {
    db?.close();
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
  });

  it("resolves an exact checkpoint beyond the diagnostic cap and keeps the version CAS in its transaction", () => {
    const run = repo.createRun({ workflowKey: "chat.turn.execute", status: "waiting" });
    db.transaction("immediate", () => {
      for (let index = 0; index < 2_005; index += 1) {
        repo.createCheckpoint({
          runId: run.runId,
          checkpointId: `waiting-${index.toString().padStart(4, "0")}`,
          checkpointKind: "run_waiting",
          state: { index },
          createdAt: "2026-09-15T12:00:00.000Z",
        });
      }
    });
    assert.equal(repo.listCheckpoints(run.runId, 2_000).some((row) => row.checkpointId === "waiting-2004"), false);
    db.transaction("immediate", () => {
      assert.equal(repo.lockWaitingCheckpointForUpdate({
        runId: run.runId, checkpointId: "waiting-0000", expectedRunVersion: run.version,
      }), undefined);
      const locked = repo.lockWaitingCheckpointForUpdate({
        runId: run.runId, checkpointId: "waiting-2004", expectedRunVersion: run.version,
      });
      assert.ok(locked);
      assert.deepEqual(locked.checkpoint.state, { index: 2_004 });
      repo.updateRun({ runId: run.runId, status: "waiting", expectedVersion: locked.run.version });
      assert.equal(repo.lockWaitingCheckpointForUpdate({
        runId: run.runId, checkpointId: "waiting-2004", expectedRunVersion: run.version,
      }), undefined);
    });
  });

  it("refuses missing, foreign, wrong-kind, and no-longer-waiting checkpoints", () => {
    const run = repo.createRun({ workflowKey: "chat.turn.execute", status: "waiting" });
    const foreign = repo.createRun({ workflowKey: "chat.turn.execute", status: "waiting" });
    const checkpoint = repo.createCheckpoint({ runId: foreign.runId, checkpointKind: "run_waiting" });
    const wrongKind = repo.createCheckpoint({ runId: run.runId, checkpointKind: "run_started" });
    const own = repo.createCheckpoint({ runId: run.runId, checkpointKind: "run_waiting" });
    db.transaction("immediate", () => {
      for (const checkpointId of ["missing-checkpoint", checkpoint.checkpointId, wrongKind.checkpointId]) {
        assert.equal(repo.lockWaitingCheckpointForUpdate({ runId: run.runId, checkpointId, expectedRunVersion: run.version }), undefined);
      }
      const cancelled = repo.updateRun({ runId: run.runId, status: "cancelled", expectedVersion: run.version });
      assert.equal(repo.lockWaitingCheckpointForUpdate({
        runId: run.runId, checkpointId: own.checkpointId, expectedRunVersion: cancelled.version,
      }), undefined);
    });
  });

  it("rejects malformed stored state and invalid expected versions without diagnostic fallback", () => {
    const run = repo.createRun({ workflowKey: "chat.turn.execute", status: "waiting" });
    const checkpoint = repo.createCheckpoint({ runId: run.runId, checkpointKind: "run_waiting" });
    db.transaction("immediate", () => {
      for (const value of ["{", "[]", "null", "true", '"text"']) {
        db.prepare("UPDATE durable_checkpoints SET state_json = ? WHERE checkpoint_id = ?").run(value, checkpoint.checkpointId);
        assert.throws(() => repo.lockWaitingCheckpointForUpdate({
          runId: run.runId, checkpointId: checkpoint.checkpointId, expectedRunVersion: run.version,
        }), /checkpoint/iu);
      }
      for (const expectedRunVersion of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => repo.lockWaitingCheckpointForUpdate({
          runId: run.runId, checkpointId: checkpoint.checkpointId, expectedRunVersion,
        }), /positive run version/u);
      }
    });
  });
});
