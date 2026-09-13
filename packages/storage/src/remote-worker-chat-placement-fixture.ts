import assert from "node:assert/strict";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerChatPlacementRepository } from "./remote-worker-chat-placement-repo.js";
import { RemoteWorkerBudgetRepository } from "./remote-worker-budget-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";

/** Identical ownership, rollback and recovery assertions on both SQL dialects. */
export function verifyChatExecutionPlacement(db: DatabaseClient): void {
  const placements = new RemoteWorkerChatPlacementRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const runs = new DurableRunRepository(db);
  const budgets = new RemoteWorkerBudgetRepository(db);
  const grant = {
    grantId: "placement-grant",
    registryWorkspaceId: "shared-registry",
    executionWorkspaceId: "default",
    workerId: "worker-1",
    workerGeneration: 1,
    maxRequests: 2,
    maxCostMicrousd: 100_000,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  const authorized = budgets.createGrant(grant, "operator-a");
  budgets.createGrant({ ...grant, grantId: "other-operator" }, "operator-b");
  budgets.createGrant({ ...grant, grantId: "other-workspace", executionWorkspaceId: "private" }, "operator-a");
  assert.deepEqual(
    budgets.listExecutionGrants("default", "operator-a").map((balance) => balance.grant),
    [authorized],
  );
  budgets.revokeGrant(authorized.grantId, authorized.revision);
  assert.deepEqual(budgets.listExecutionGrants("default", "operator-a"), []);
  const local = prepareChatOfferFixture(db, true, "-placement-local");
  const run = runs.getRun(local.durableRunId);
  assert.throws(() => placements.claimLocal({ ...run, leaseOwnerId: "stale-owner" }));
  assert.equal(placements.get(run.runId), undefined);
  assert.throws(() => placements.claimRemote(run, "default", "missing-assignment"), /exact persisted/);
  const selected = placements.claimLocal(run);
  assert.equal(selected.executionKind, "local");
  assert.deepEqual(placements.claimLocal(run), selected);
  assert.throws(() => assignments.scheduleTaskBoundChatOffer(local.offerInput), /another runner/);
  assert.throws(() => assignments.createAssignment(local.legacyCommand), /another runner/);
  assert.throws(
    () =>
      db.transaction("immediate", () => {
        db.prepare(
          "UPDATE chat_execution_placements SET execution_kind = 'remote_worker' WHERE durable_run_id = ?",
        ).run(run.runId);
      }),
    /immutable/,
  );
  assert.throws(
    () =>
      db.transaction("immediate", () => {
        db.prepare("DELETE FROM chat_execution_placements WHERE durable_run_id = ?").run(run.runId);
      }),
    /immutable/,
  );

  db.prepare("UPDATE durable_runs SET lease_expires_at = ? WHERE run_id = ?").run(
    "2000-01-01T00:00:00.000Z",
    run.runId,
  );
  assert.throws(() => placements.claimLocal(run));
  db.transaction("immediate", () => {
    const expired = runs.lockExpiredLeaseForUpdate({
      runId: run.runId,
      expectedLeaseOwnerId: run.leaseOwnerId!,
      expectedLeaseExpiresAt: "2000-01-01T00:00:00.000Z",
    })!;
    runs.updateRun({
      runId: run.runId,
      status: "queued",
      attemptCount: expired.attemptCount + 1,
      clearLease: true,
      expectedVersion: expired.version,
    });
  });
  const recovered = runs.tryClaimQueuedRunWithDatabaseClock({
    runId: run.runId,
    workerId: "placement-replacement",
    leaseDurationMs: 300_000,
  })!;
  assert.deepEqual(placements.claimLocal(recovered), selected);
  assert.throws(() => placements.claimLocal(run));
  assert.throws(
    () =>
      assignments.scheduleTaskBoundChatOffer({
        ...local.offerInput,
        dispatchOwnerId: recovered.leaseOwnerId!,
        durableRunAttempt: recovered.attemptCount,
        durableRunVersion: recovered.version,
      }),
    /another runner/,
  );

  const remote = prepareChatOfferFixture(db, true, "-placement-remote");
  const remoteRun = runs.getRun(remote.durableRunId);
  assert.throws(
    () =>
      db.transaction("immediate", () => {
        assignments.scheduleTaskBoundChatOffer(remote.offerInput);
        assert.equal(placements.get(remoteRun.runId)?.executionKind, "remote_worker");
        throw new Error("placement transaction rollback");
      }),
    /transaction rollback/,
  );
  assert.equal(placements.get(remoteRun.runId), undefined);
  assert.equal(
    assignments.findTaskBoundChatAssignment({
      executionWorkspaceId: "default",
      sessionId: remote.offerInput.sessionId,
      turnId: remote.offerInput.turnId,
      durableRunId: remoteRun.runId,
    }),
    undefined,
  );
  const offered = assignments.scheduleTaskBoundChatOffer(remote.offerInput).assignment;
  const remoteChoice = placements.get(remoteRun.runId)!;
  assert.equal(remoteChoice.assignmentId, offered.assignmentId);
  assert.equal(remoteChoice.executionKind, "remote_worker");
  assert.deepEqual(placements.claimLocal(remoteRun), remoteChoice);
  assert.deepEqual(placements.claimRemote(remoteRun, "default", offered.assignmentId), remoteChoice);
  assert.throws(() => placements.claimRemote(remoteRun, "foreign-registry", offered.assignmentId), /another runner/);
  assert.throws(
    () => assignments.createAssignment({ ...remote.legacyCommand, idempotencyKey: "competing-remote-placement" }),
    /another runner/,
  );

  // An old direct offer predates placement ownership; its existence prevents a
  // local claim from creating a new execution when that Chat run is recovered.
  const legacy = prepareChatOfferFixture(db, true, "-placement-existing");
  const existingAssignment = assignments.createAssignment(legacy.legacyCommand).assignment;
  assert.equal(placements.get(legacy.durableRunId), undefined);
  assert.equal(placements.claimLocal(runs.getRun(legacy.durableRunId)).assignmentId, existingAssignment.assignmentId);
}
