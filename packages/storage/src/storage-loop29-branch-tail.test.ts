import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DurableRunRepository } from "./durable-run-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): DurableRunRepository {
  const dbPath = tempDbs.path("goatcitadel-storage-loop29");
  return new DurableRunRepository(tempDbs.open({ dbPath }));
}

describe("storage loop 29 branch tails", () => {
  it("serializes cleared lease fields and omitted expected versions during updates", () => {
    const repo = createRepo();
    const run = repo.createRun({
      runId: "run-loop29-clear-lease",
      workflowKey: "workflow.loop29",
      status: "running",
      leaseOwnerId: "worker-a",
      leaseExpiresAt: "2026-05-15T00:10:00.000Z",
      leaseHeartbeatAt: "2026-05-15T00:05:00.000Z",
      now: "2026-05-15T00:00:00.000Z",
    });

    const updated = repo.updateRun({
      runId: run.runId,
      status: "waiting",
      clearLease: true,
      updatedAt: "2026-05-15T00:06:00.000Z",
    });

    assert.equal(updated.status, "waiting");
    assert.equal(updated.leaseOwnerId, undefined);
    assert.equal(updated.leaseExpiresAt, undefined);
    assert.equal(updated.leaseHeartbeatAt, undefined);
    assert.equal(updated.version, run.version + 1);
    assert.equal(updated.updatedAt, "2026-05-15T00:06:00.000Z");
  });

  it("tolerates omitted lease inputs when claiming a queued run", () => {
    const repo = createRepo();
    const run = repo.createRun({
      runId: "run-loop29-omitted-lease",
      workflowKey: "workflow.loop29",
      now: "2026-05-15T00:00:00.000Z",
    });

    const claimed = repo.tryClaimQueuedRun({
      runId: run.runId,
      workerId: undefined,
      leaseHeartbeatAt: undefined,
      leaseExpiresAt: undefined,
    } as never);

    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.startedAt, undefined);
    assert.equal(claimed?.leaseOwnerId, undefined);
    assert.equal(claimed?.leaseExpiresAt, undefined);
    assert.equal(claimed?.leaseHeartbeatAt, undefined);
  });
});
