import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { createRemediationParentFixture, createRemediationParentState, createRemediationReleaseFixture, createRemediationResumeFixture } from "./governed-remediation-parent-reservation-fixture.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL resumes a verified repair atomically and validates its sealed reference", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "remediation_resume");
  try {
    const { db } = scope;
    const { repo, resume, resolution, runId } = createRemediationResumeFixture(db);
    const runs = new DurableRunRepository(db);
    assert.equal(repo.findDurableChatRemediationResume(resume), undefined);
    db.exec(`CREATE FUNCTION test_resume_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected resume seal failure'; END $$;
      CREATE TRIGGER test_resume_failure BEFORE INSERT ON chat_turn_user_input_continuation_seals
      FOR EACH ROW EXECUTE FUNCTION test_resume_failure()`);
    assert.throws(() => repo.resumeDurableChatRemediation(resume), /injected resume seal failure/u);
    assert.equal(runs.getRun(runId)?.version, 3);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM governed_remediation_parent_resolutions").get<{ count: unknown }>()?.count), 0);
    assert.throws(() => runs.updateRun({ runId, status: "queued", expectedVersion: 3 }));
    db.exec("DROP TRIGGER test_resume_failure ON chat_turn_user_input_continuation_seals; DROP FUNCTION test_resume_failure()");
    const resumed = repo.resumeDurableChatRemediation(resume);
    assert.equal(resumed.resultingRunVersion, 4);
    assert.equal(runs.getRun(runId)?.status, "queued");
    repo.requireExactDurableTurnPayloadIdentity({ ...resolution.admissionIdentity, durableRunId: runId });
    runs.updateRun({ runId, status: "running", expectedVersion: 4 });
    assert.deepEqual(repo.findDurableChatRemediationResume(resume), { ...resumed, replayed: true });
    assert.equal(repo.findDurableChatRemediationResume({ ...resume, operationId: "foreign" }), undefined);
    assert.throws(() => repo.findDurableChatRemediationResume({ ...resume, requesterActorId: "foreign" }));
    assert.deepEqual(repo.resumeDurableChatRemediation(resume), { ...resumed, replayed: true });
    assert.throws(() => repo.resumeDurableChatRemediation({ ...resume, operationId: "foreign" }));
    assert.equal(runs.getRun(runId)?.version, 5);
  } finally { await scope.teardown(); }
});

test("PostgreSQL releases an exact no-effect reservation atomically and replays after continuation", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "remediation_release");
  try {
    const { db } = scope;
    const { repo, release, resolution, runId } = createRemediationReleaseFixture(db);
    const runs = new DurableRunRepository(db);
    db.exec(`CREATE FUNCTION test_release_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected release failure'; END $$;
      CREATE TRIGGER test_release_failure BEFORE INSERT ON governed_remediation_parent_resolutions
      FOR EACH ROW EXECUTE FUNCTION test_release_failure()`);
    assert.throws(() => repo.releaseDurableChatRemediation(release), /injected release failure/u);
    assert.equal(runs.getRun(runId)?.version, 3);
    assert.throws(() => runs.updateRun({ runId, status: "queued", expectedVersion: 3 }));
    db.exec("DROP TRIGGER test_release_failure ON governed_remediation_parent_resolutions; DROP FUNCTION test_release_failure()");
    const first = repo.releaseDurableChatRemediation(release);
    assert.equal(first.resultingRunVersion, 4);
    assert.equal(runs.getRun(runId)?.status, "waiting");
    repo.resolveDurableChatUserInput({ ...resolution, expectedWaitingRunVersion: 4 });
    assert.equal(runs.getRun(runId)?.version, 5);
    assert.deepEqual(repo.releaseDurableChatRemediation(release), { ...first, replayed: true });
    assert.throws(() => repo.releaseDurableChatRemediation({ ...release, operationId: "foreign-operation" }));
    assert.equal(runs.getRun(runId)?.version, 5);
  } finally { await scope.teardown(); }
});

test("PostgreSQL atomically reserves admitted remediation parents, rolls back faults, and retains evidence", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "remediation_transaction");
  try {
    const { db } = scope;
    assert.equal(Number(db.prepare(`SELECT count(*) AS count FROM pg_catalog.pg_constraint
      WHERE conrelid = 'governed_remediation_parent_resolutions'::regclass AND contype = 'f'`)
      .get<{ count: unknown }>()?.count), 3);
    const lineage = db.prepare(`SELECT prosrc FROM pg_proc proc JOIN pg_namespace ns ON ns.oid = proc.pronamespace
      WHERE ns.nspname = current_schema() AND proc.proname IN
      ('gc_governed_remediation_receipt_insert_guard', 'gc_governed_remediation_state_update_guard')`).all<{ prosrc: string }>();
    assert.equal(lineage.length, 2);
    for (const row of lineage) {
      assert.match(row.prosrc, /expected_waiting_run_version \+ 2/u);
      assert.doesNotMatch(row.prosrc, /expected_waiting_run_version \+ 1/u);
    }
    const { repo, input, resolution } = createRemediationParentFixture(db);
    const runs = new DurableRunRepository(db);
    for (const patch of [{ requesterActorId: "foreign-actor" }, { recipeSha256: "b".repeat(64) },
      { stateRevision: 1 }, { operationId: "foreign-operation" }, { expectedWaitingRunVersion: 3 }]) {
      assert.throws(() => repo.reserveDurableChatRemediation({ ...input, ...patch }));
    }
    db.exec(`CREATE FUNCTION test_remediation_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected reservation failure'; END $$;
      CREATE TRIGGER test_remediation_insert_failure BEFORE INSERT ON governed_remediation_parent_reservations
      FOR EACH ROW EXECUTE FUNCTION test_remediation_insert_failure()`);
    assert.throws(() => repo.reserveDurableChatRemediation(input), /injected reservation failure/u);
    assert.equal(runs.getRun(input.durableRunId)?.version, 2);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM governed_remediation_parent_reservations").get<{ count: unknown }>()?.count), 0);
    db.exec("DROP TRIGGER test_remediation_insert_failure ON governed_remediation_parent_reservations; DROP FUNCTION test_remediation_insert_failure()");
    const first = repo.reserveDurableChatRemediation(input);
    assert.equal(first.replayed, false);
    assert.equal(first.reservedRunVersion, 3);
    assert.deepEqual(repo.reserveDurableChatRemediation(input), { ...first, replayed: true });
    assert.throws(() => repo.resolveDurableChatUserInput({ ...resolution, expectedWaitingRunVersion: 3 }),
      /remediation reservation/u);
    for (const status of ["queued", "running"] as const) {
      assert.throws(() => runs.updateRun({ runId: input.durableRunId, status, expectedVersion: 3 }));
    }
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM chat_turn_user_input_continuation_seals").get<{ count: unknown }>()?.count), 0);
    const competing = createRemediationParentState(db, input, "competing-remediation", 3);
    assert.throws(() => repo.reserveDurableChatRemediation(competing));
    assert.equal(runs.getRun(input.durableRunId)?.version, 3);
    runs.createCheckpoint({ runId: input.durableRunId, checkpointKind: "run_completed", state: { disposable: true }, createdAt: "2099-01-01T00:00:00.000Z" });
    runs.updateRun({ runId: input.durableRunId, status: "completed", expectedVersion: 3 });
    const pruned = runs.pruneCheckpoints({ keepPerRun: 1, diskBudgetBytes: 0 });
    assert.equal(pruned.prunedAged, 1);
    assert.ok(pruned.finalBytes > 0);
    assert.deepEqual(runs.listCheckpoints(input.durableRunId).map((row) => row.checkpointId), [input.blockedCheckpointId]);
  } finally { await scope.teardown(); }
});

test("PostgreSQL bootstraps the reservation ledger and locks the exact waiting parent", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "remediation_parent");
  try {
    const repo = new DurableRunRepository(scope.db);
    const run = repo.createRun({ workflowKey: "chat.turn.execute", status: "waiting" });
    const checkpoint = repo.createCheckpoint({ runId: run.runId, checkpointKind: "run_waiting", state: { blocked: true } });
    scope.db.transaction("immediate", () => {
      const locked = repo.lockWaitingCheckpointForUpdate({
        runId: run.runId, checkpointId: checkpoint.checkpointId, expectedRunVersion: run.version,
      });
      assert.ok(locked);
      assert.deepEqual(locked.checkpoint.state, { blocked: true });
      repo.updateRun({ runId: run.runId, status: "waiting", expectedVersion: locked.run.version });
      assert.equal(repo.lockWaitingCheckpointForUpdate({
        runId: run.runId, checkpointId: checkpoint.checkpointId, expectedRunVersion: run.version,
      }), undefined);
    });
    assert.equal(Number(scope.db.prepare("SELECT count(*) AS count FROM governed_remediation_parent_reservations").get<{ count: unknown }>()?.count), 0);
    assert.equal(Number(scope.db.prepare(`SELECT count(*) AS count FROM pg_catalog.pg_constraint
      WHERE conrelid = 'governed_remediation_parent_reservations'::regclass AND contype = 'f'`)
      .get<{ count: unknown }>()?.count), 3);
  } finally {
    await scope.teardown();
  }
});
