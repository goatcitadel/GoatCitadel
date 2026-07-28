import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Pool, type PoolClient } from "pg";
import { PostgresDatabaseClient } from "./client.js";
import {
  assertLegacyCompoundV124Catalog,
  POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL,
  quotePostgresIdentifier,
} from "./migration-ledger-compatibility.js";
import { applyPostgresMigrationsSync, runPostgresMigrations } from "./migrator.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration } from "./migrations.js";
import { PostgresSyncDatabaseClient } from "./sync.js";
import { CommsDeliveryRepository } from "../comms-delivery-repo.js";
import { ApprovalEffectRepository } from "../approval-effect-repo.js";
import { DurableRunRepository } from "../durable-run-repo.js";
import { ChatDelegationStepRepository } from "../chat-delegation-step-repo.js";
import { MutationIdempotencyRepository } from "../mutation-idempotency-repo.js";
import { ApprovalRepository } from "../approval-repo.js";
import { OrchestrationRepository } from "../orchestration-repo.js";
import { PermissionProfileRepository } from "../permission-profile-repo.js";
import { RealtimeEventRepository } from "../realtime-event-repo.js";
import { MemoryMaintenanceRepository } from "../memory-maintenance-repo.js";
import { SystemSettingsRepository } from "../system-settings-repo.js";
import { ExternalSideEffectRunRepository } from "../external-side-effect-run-repo.js";
import { RemoteActionTokenRepository } from "../remote-action-token-repo.js";
import { ToolGrantRepository } from "../tool-grant-repo.js";
import { Storage } from "../index.js";
import { ChatSessionLifecycleRepository } from "../chat-session-lifecycle-repo.js";
import {
  assertSingleObservabilityChain,
  runConcurrentObservabilityWorkers,
} from "../approval-observability-concurrency.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

function escapePostgresLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

async function waitForProofSignal<T>(
  signal: Promise<void>,
  operation: Promise<T>,
  description: string,
  timeoutMs = 7_000,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const operationSettled = operation.then(
    () => {
      throw new Error(`${description} operation completed before the expected proof signal.`);
    },
    (error: unknown) => {
      throw error;
    },
  );
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${description} proof signal timed out.`)), timeoutMs);
  });
  try {
    await Promise.race([signal, operationSettled, timedOut]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function waitForOperation<T>(operation: Promise<T>, description: string, timeoutMs = 7_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${description} timed out.`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

test(
  "real Postgres canonical usage ownership reads hold deletion fences until commit",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_usage_attribution_lock_${suffix}`;
    const sessionId = `session-${suffix}`;
    const turnId = `turn-${suffix}`;
    const eventId = `usage-${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 3 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let locker: PoolClient | undefined;
    let contender: PoolClient | undefined;
    let lifecycleDb: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      lifecycleDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `coverage-usage-lifecycle-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      lifecycleDb.exec(`SET search_path TO ${schemaName}`);
      new ChatSessionLifecycleRepository(lifecycleDb).initialize({
        workspaceId: "workspace-a",
        sessionId,
        actorId: "operator-test",
        idempotencyKey: `lifecycle:init:${sessionId}`,
        correlationId: `correlation:lifecycle:init:${sessionId}`,
        metadataTimestamp: "2026-07-13T00:00:00.000Z",
      });
      await scopedPool.query(
        `INSERT INTO chat_turn_traces (
           turn_id, session_id, user_message_id, status, mode, web_mode, memory_mode,
           thinking_level, routing_json, started_at
         ) VALUES ($1, $2, $3, 'running', 'chat', 'off', 'off', 'standard', '{}', $4)`,
        [turnId, sessionId, `message-${suffix}`, "2026-07-13T00:00:00.500Z"],
      );
      await scopedPool.query(
        `INSERT INTO model_usage_events (
           event_id, idempotency_key, source, call_kind, operation_id, dispatch_generation,
           dispatch_owner_id, dispatch_lease_expires_at, workspace_id, session_id, started_at
         ) VALUES ($1, $2, 'manual_test', 'chat_initial', $3, 'generation-1',
                   'owner-a', $4, 'workspace-a', $5, $6)`,
        [
          eventId,
          `key-${suffix}`,
          `operation-${suffix}`,
          "2026-07-13T00:10:00.000Z",
          sessionId,
          "2026-07-13T00:00:01.000Z",
        ],
      );

      locker = await scopedPool.connect();
      contender = await scopedPool.connect();
      await locker.query("BEGIN");
      await locker.query("SELECT * FROM chat_session_meta WHERE session_id = $1 FOR UPDATE", [sessionId]);
      await locker.query("SELECT * FROM chat_turn_traces WHERE turn_id = $1 FOR UPDATE", [turnId]);
      await locker.query("SELECT * FROM model_usage_events WHERE event_id = $1 FOR UPDATE", [eventId]);

      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        contender.query("DELETE FROM chat_session_meta WHERE session_id = $1", [sessionId]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
      await contender.query("ROLLBACK");

      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        contender.query("DELETE FROM chat_turn_traces WHERE turn_id = $1", [turnId]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
      await contender.query("ROLLBACK");

      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout = '100ms'");
      await assert.rejects(
        contender.query("DELETE FROM model_usage_events WHERE event_id = $1", [eventId]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
      await contender.query("ROLLBACK");

      await locker.query("COMMIT");
      await contender.query("DELETE FROM model_usage_events WHERE event_id = $1", [eventId]);
      await contender.query("DELETE FROM chat_turn_traces WHERE turn_id = $1", [turnId]);
      await assert.rejects(
        contender.query("DELETE FROM chat_session_meta WHERE session_id = $1", [sessionId]),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
      const lifecycle = new ChatSessionLifecycleRepository(lifecycleDb);
      lifecycleDb.transaction("immediate", () => {
        lifecycle.deleteTree(
          {
            workspaceId: "workspace-a",
            rootSessionId: sessionId,
            expectedRootRevision: 1,
            actorId: "operator-test",
            idempotencyKey: `lifecycle:delete:${sessionId}`,
            correlationId: `correlation:lifecycle:delete:${sessionId}`,
          },
          () => undefined,
        );
      });
    } finally {
      lifecycleDb?.close();
      if (contender) {
        try {
          await contender.query("ROLLBACK");
        } catch (error) {
          void error;
        }
        contender.release();
      }
      if (locker) {
        try {
          await locker.query("ROLLBACK");
        } catch (error) {
          void error;
        }
        locker.release();
      }
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres usage recovery skips live owner locks and preserves renewed or accepted truth",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_usage_recovery_lock_${suffix}`;
    const intentEventId = `usage-intent-${suffix}`;
    const acceptedEventId = `usage-accepted-${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 3 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let owner: PoolClient | undefined;
    let recoveryStorage: Storage | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      recoveryStorage = new Storage({
        db: new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: `gc-usage-recovery-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        }),
        transcriptsDir: ".",
        auditDir: ".",
      });
      await scopedPool.query(
        `INSERT INTO model_usage_events (
           event_id, idempotency_key, source, call_kind, operation_id, dispatch_generation,
           transport_status, dispatch_owner_id, dispatch_lease_expires_at, workspace_id, started_at
         ) VALUES
           ($1, $2, 'manual_test', 'chat_initial', $3, 'generation-1', 'intent', 'owner-a', $4, 'workspace-a', $5),
           ($6, $7, 'manual_test', 'chat_initial', $8, 'generation-1', 'accepted', 'owner-b', $4, 'workspace-a', $5)`,
        [
          intentEventId,
          `intent-key-${suffix}`,
          `intent-operation-${suffix}`,
          "2000-01-01T00:00:00.000Z",
          "2026-07-13T00:00:00.000Z",
          acceptedEventId,
          `accepted-key-${suffix}`,
          `accepted-operation-${suffix}`,
        ],
      );

      owner = await scopedPool.connect();
      await owner.query("BEGIN");
      await owner.query(
        `UPDATE model_usage_events
         SET transport_status = 'accepted', dispatch_lease_expires_at = $2
         WHERE event_id = $1 AND transport_status = 'intent'`,
        [intentEventId, "2999-01-01T00:00:00.000Z"],
      );
      await owner.query(
        `UPDATE model_usage_events
         SET dispatch_lease_expires_at = $2
         WHERE event_id = $1 AND transport_status = 'accepted'`,
        [acceptedEventId, "2999-01-01T00:00:00.000Z"],
      );

      const whileLocked = recoveryStorage.modelUsageEvents.recoverExpiredBacklog("2026-07-13T10:00:00.000Z", {
        batchSize: 10,
        maxBatches: 2,
      });
      assert.deepEqual(whileLocked, {
        recoveredIntentCount: 0,
        recoveredAcceptedCount: 0,
        batchCount: 1,
        batchLimitReached: false,
      });

      await owner.query("COMMIT");
      const afterCommit = recoveryStorage.modelUsageEvents.recoverExpiredBacklog("2026-07-13T10:00:00.000Z", {
        batchSize: 10,
        maxBatches: 2,
      });
      assert.equal(afterCommit.recoveredIntentCount, 0);
      assert.equal(afterCommit.recoveredAcceptedCount, 0);
      const rows = await scopedPool.query<{
        event_id: string;
        transport_status: string;
        terminal_outcome: string;
        dispatch_lease_expires_at: string;
      }>(
        `SELECT event_id, transport_status, terminal_outcome, dispatch_lease_expires_at
         FROM model_usage_events WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
        [[intentEventId, acceptedEventId]],
      );
      assert.equal(rows.rows.length, 2);
      for (const row of rows.rows) {
        assert.equal(row.transport_status, "accepted");
        assert.equal(row.terminal_outcome, "in_flight");
        assert.equal(row.dispatch_lease_expires_at, "2999-01-01T00:00:00.000Z");
      }
    } finally {
      if (owner) {
        try {
          await owner.query("ROLLBACK");
        } catch {
          // Transaction may already be committed.
        }
        owner.release();
      }
      recoveryStorage?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres preserves dependency-plan truth through the delegation step repository",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_delegation_plan_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-delegation-plan-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      syncClient.prepare("SELECT 1 AS ready").get();
      syncClient
        .prepare(
          `
            INSERT INTO chat_delegation_runs (
              run_id, session_id, task_id, objective, roles_json, mode, status, citations_json, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          `run-${suffix}`,
          `session-${suffix}`,
          `task-${suffix}`,
          "Persist A before B",
          '["architect","qa"]',
          "parallel",
          "running",
          "[]",
          "2026-07-11T00:00:00.000Z",
        );
      const repo = new ChatDelegationStepRepository(syncClient);
      const architect = repo.create({
        stepId: `architect-${suffix}`,
        runId: `run-${suffix}`,
        role: "architect",
        index: 0,
        status: "completed",
        parallelizable: true,
        dependsOnStepIds: [],
        output: "architecture handoff",
        startedAt: "2026-07-11T00:00:00.000Z",
        finishedAt: "2026-07-11T00:00:01.000Z",
      });
      const qa = repo.create({
        stepId: `qa-${suffix}`,
        runId: `run-${suffix}`,
        role: "qa",
        index: 1,
        status: "pending",
        parallelizable: false,
        dependsOnStepIds: [architect.stepId],
        startedAt: "2026-07-11T00:00:00.000Z",
      });

      assert.equal(architect.parallelizable, true);
      assert.deepEqual(qa.dependsOnStepIds, [architect.stepId]);
      const running = repo.patch(qa.stepId, {
        status: "running",
        parallelizable: true,
        startedAt: "2026-07-11T00:00:02.000Z",
      });
      assert.equal(running.parallelizable, true);
      assert.equal(running.startedAt, "2026-07-11T00:00:02.000Z");
      assert.deepEqual(
        repo.listByRun(`run-${suffix}`).map((step) => ({
          stepId: step.stepId,
          dependsOnStepIds: step.dependsOnStepIds,
        })),
        [
          { stepId: architect.stepId, dependsOnStepIds: [] },
          { stepId: qa.stepId, dependsOnStepIds: [architect.stepId] },
        ],
      );
    } finally {
      syncClient?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres serializes disjoint full-row delegation-step patches across a row-lock wait",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_delegation_step_lock_${suffix}`;
    const runId = `delegation-step-lock-run-${suffix}`;
    const stepId = `delegation-step-lock-${suffix}`;
    const barrierKey = `delegation-step-lock:${suffix}`;
    const workerAApplicationName = `gc-delegation-step-rmw-a-${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let barrierClient: PoolClient | undefined;
    let workerA: Worker | undefined;
    let workerB: Storage | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      workerB = new Storage({
        db: new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: `gc-delegation-step-rmw-b-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        }),
        transcriptsDir: ".",
        auditDir: ".",
      });
      await scopedPool.query(
        `
          INSERT INTO chat_delegation_runs (
            run_id, session_id, task_id, objective, roles_json, mode, status, citations_json, started_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          runId,
          `session-${suffix}`,
          `task-${suffix}`,
          "Preserve disjoint delegation step patches",
          '["qa"]',
          "sequential",
          "running",
          "[]",
          "2026-07-11T00:00:00.000Z",
        ],
      );
      workerB.chatDelegationSteps.create({
        stepId,
        runId,
        role: "qa",
        index: 0,
        status: "running",
        summary: "initial summary",
        providerId: "openai",
        model: "gpt-initial",
        startedAt: "2026-07-11T00:00:00.000Z",
      });

      await scopedPool.query(`
        CREATE FUNCTION delegation_step_update_lock_barrier_${suffix}() RETURNS trigger AS $$
        BEGIN
          IF current_setting('application_name') = '${escapePostgresLiteral(workerAApplicationName)}' THEN
            PERFORM pg_advisory_xact_lock(hashtext('${escapePostgresLiteral(barrierKey)}'));
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER delegation_step_update_lock_barrier_${suffix}
          BEFORE UPDATE ON chat_delegation_steps
          FOR EACH ROW EXECUTE FUNCTION delegation_step_update_lock_barrier_${suffix}();
      `);

      barrierClient = await scopedPool.connect();
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKey]);
      const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
      workerA = new Worker(DELEGATION_STEP_PATCH_WORKER_SOURCE, {
        eval: true,
        workerData: {
          connectionOptions: {
            connectionString: scopedUrl.toString(),
            database: "goatcitadel_test",
            applicationName: workerAApplicationName,
            pool: { max: 1, connectionTimeoutMs: 10_000 },
          },
          stepId,
          stepPatch: {
            summary: "worker A committed summary",
            output: "worker A committed output",
          },
          storageModuleUrl: new URL(`../index${runtimeModuleExtension}`, import.meta.url).href,
          postgresModuleUrl: new URL(`./sync${runtimeModuleExtension}`, import.meta.url).href,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
        },
      });
      const workerACompletion = waitForDelegationStepPatchWorker(workerA);

      const waitDeadline = Date.now() + 10_000;
      let workerAOwnsStepLock = false;
      while (!workerAOwnsStepLock && Date.now() < waitDeadline) {
        const waitState = await scopedPool.query<{ waiting: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity AS activity
              INNER JOIN pg_locks AS lock ON lock.pid = activity.pid
              WHERE activity.application_name = $1
                AND lock.locktype = 'advisory'
                AND lock.granted = FALSE
            ) AS waiting
          `,
          [workerAApplicationName],
        );
        workerAOwnsStepLock = waitState.rows[0]?.waiting === true;
        if (!workerAOwnsStepLock) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(workerAOwnsStepLock, true, "worker A should hold the step row lock before worker B patches");

      const releaseBarrier = barrierClient.query(
        `SELECT pg_sleep(1); SELECT pg_advisory_unlock(hashtext('${escapePostgresLiteral(barrierKey)}'));`,
      );
      const workerBStartedAt = Date.now();
      const workerBUpdate = workerB.chatDelegationSteps.patch(stepId, {
        providerId: "anthropic",
        model: "claude-worker-b",
      });
      const workerBWaitedMs = Date.now() - workerBStartedAt;
      await releaseBarrier;
      const workerAUpdate = await workerACompletion;

      assert.ok(workerBWaitedMs >= 750, `worker B should wait for worker A's row lock (${workerBWaitedMs}ms)`);
      assert.equal(workerAUpdate.summary, "worker A committed summary");
      assert.equal(workerBUpdate.summary, "worker A committed summary");
      assert.equal(workerBUpdate.output, "worker A committed output");
      assert.equal(workerBUpdate.providerId, "anthropic");
      assert.equal(workerBUpdate.model, "claude-worker-b");
      assert.deepEqual(workerB.chatDelegationSteps.get(stepId), workerBUpdate);

      workerB.chatDelegationSteps.patch(stepId, {
        childSessionId: `child-session-${suffix}`,
        childTurnId: `child-turn-${suffix}`,
      });
      const approvalMaterialized = workerB.chatDelegationSteps.materializeApprovalOutcome({
        stepId,
        expectedChildSessionId: `child-session-${suffix}`,
        expectedChildTurnId: `child-turn-${suffix}`,
        status: "completed",
        output: "approval materialized output",
        summary: "approval materialized output",
        citations: [],
        finishedAt: "2026-07-11T00:00:03.000Z",
      });
      assert.equal(approvalMaterialized.outcome, "applied");
      assert.equal(approvalMaterialized.step.status, "completed");
      assert.equal(approvalMaterialized.step.output, "approval materialized output");
    } finally {
      if (barrierClient) {
        try {
          await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKey]);
        } catch {
          // Best-effort cleanup: the scheduled release normally unlocks the barrier.
        }
        barrierClient.release();
      }
      if (workerA) {
        await workerA.terminate();
      }
      workerB?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres serializes sibling approval fan-in through the parent-run lock before step materialization",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_approval_fanin_lock_${suffix}`;
    const runId = `approval-fanin-run-${suffix}`;
    const parentSessionId = `approval-fanin-parent-${suffix}`;
    const barrierKeys = {
      a: `approval-fanin-a:${suffix}`,
      b: `approval-fanin-b:${suffix}`,
    };
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let barrierClient: PoolClient | undefined;
    let setupStorage: Storage | undefined;
    let workerA: Worker | undefined;
    let workerB: Worker | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      setupStorage = new Storage({
        db: new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: `gc-approval-fanin-setup-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        }),
        transcriptsDir: ".",
        auditDir: ".",
      });
      setupStorage.chatDelegationRuns.create({
        runId,
        sessionId: parentSessionId,
        taskId: `task-${suffix}`,
        objective: "Materialize two approved children",
        roles: ["architect", "qa"],
        mode: "parallel",
        status: "running",
        citations: [],
        startedAt: "2026-07-11T00:00:00.000Z",
      });
      const children = {
        a: { sessionId: `child-a-${suffix}`, turnId: `turn-a-${suffix}`, stepId: `step-a-${suffix}` },
        b: { sessionId: `child-b-${suffix}`, turnId: `turn-b-${suffix}`, stepId: `step-b-${suffix}` },
      };
      setupStorage.chatDelegationSteps.create({
        stepId: children.a.stepId,
        runId,
        role: "architect",
        index: 0,
        status: "running",
        childSessionId: children.a.sessionId,
        childTurnId: children.a.turnId,
        startedAt: "2026-07-11T00:00:00.000Z",
      });
      setupStorage.chatDelegationSteps.create({
        stepId: children.b.stepId,
        runId,
        role: "qa",
        index: 1,
        status: "running",
        childSessionId: children.b.sessionId,
        childTurnId: children.b.turnId,
        startedAt: "2026-07-11T00:00:00.000Z",
      });

      barrierClient = await scopedPool.connect();
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKeys.a]);
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKeys.b]);
      const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
      const commonWorkerData = {
        connectionOptions: {
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        },
        runId,
        parentSessionId,
        storageModuleUrl: new URL(`../index${runtimeModuleExtension}`, import.meta.url).href,
        postgresModuleUrl: new URL(`./sync${runtimeModuleExtension}`, import.meta.url).href,
        approvalServiceModuleUrl: new URL(
          `../../../../apps/gateway/src/services/approval-resolution-effects-service${runtimeModuleExtension}`,
          import.meta.url,
        ).href,
        tsxApiUrl: import.meta.resolve("tsx/esm/api"),
      };
      workerA = new Worker(DELEGATION_APPROVAL_FANIN_WORKER_SOURCE, {
        eval: true,
        workerData: {
          ...commonWorkerData,
          workerId: "a",
          barrierKey: barrierKeys.a,
          child: children.a,
          connectionOptions: {
            ...commonWorkerData.connectionOptions,
            applicationName: `gc-approval-fanin-a-${suffix}`,
          },
        },
      });
      workerB = new Worker(DELEGATION_APPROVAL_FANIN_WORKER_SOURCE, {
        eval: true,
        workerData: {
          ...commonWorkerData,
          workerId: "b",
          barrierKey: barrierKeys.b,
          child: children.b,
          connectionOptions: {
            ...commonWorkerData.connectionOptions,
            applicationName: `gc-approval-fanin-b-${suffix}`,
          },
        },
      });
      const reachedBarriers: string[] = [];
      const workerACompletion = observeDelegationApprovalFanInWorker(workerA, reachedBarriers);
      const workerBCompletion = observeDelegationApprovalFanInWorker(workerB, reachedBarriers);

      await waitForWorkerStageCount(reachedBarriers, 1, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(reachedBarriers.length, 1, "only the parent-run lock winner may reach the stable-step-set read");

      const firstWorkerId = reachedBarriers[0] as "a" | "b";
      await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKeys[firstWorkerId]]);
      await waitForWorkerStageCount(reachedBarriers, 2, 10_000);
      const secondWorkerId = reachedBarriers[1] as "a" | "b";
      await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKeys[secondWorkerId]]);
      await Promise.all([workerACompletion, workerBCompletion]);

      assert.equal(setupStorage.chatDelegationSteps.get(children.a.stepId).status, "completed");
      assert.equal(setupStorage.chatDelegationSteps.get(children.b.stepId).status, "completed");
      assert.equal(setupStorage.chatDelegationRuns.get(runId).status, "completed");
    } finally {
      if (barrierClient) {
        try {
          await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKeys.a]);
          await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKeys.b]);
        } catch {
          // Best-effort cleanup for a worker or assertion failure.
        }
        barrierClient.release();
      }
      if (workerA) {
        await workerA.terminate();
      }
      if (workerB) {
        await workerB.terminate();
      }
      setupStorage?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres converges deterministic delegation state and fences a late dispatch owner across two Storage clients",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_delegation_cas_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 3 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let workerA: Storage | undefined;
    let workerB: Storage | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      const createWorker = (applicationName: string): Storage =>
        new Storage({
          db: new PostgresSyncDatabaseClient({
            connectionString: scopedUrl.toString(),
            database: "goatcitadel_test",
            applicationName,
            pool: { max: 1, connectionTimeoutMs: 10_000 },
          }),
          transcriptsDir: ".",
          auditDir: ".",
        });
      workerA = createWorker("goatcitadel-real-postgres-delegation-worker-a");
      workerB = createWorker("goatcitadel-real-postgres-delegation-worker-b");

      const ids = {
        task: `delegation-task-${suffix}`,
        run: `delegation-run-${suffix}`,
        step: `delegation-step-${suffix}`,
        errorStep: `delegation-error-step-${suffix}`,
        waitingStep: `delegation-waiting-step-${suffix}`,
        subagent: `delegation-subagent-${suffix}`,
        session: `sess_delegation_${suffix}`,
        userMessage: `delegation-user-${suffix}`,
        turn: `delegation-turn-${suffix}`,
        assistantMessage: `delegation-assistant-${suffix}`,
        durableRun: `durable-chat-${suffix}`,
      };
      const now = workerA.chatDelegationSteps.readDatabaseNow();
      const sessionInput = {
        sessionId: ids.session,
        sessionKey: `mission:operator:chat_${suffix}`,
        kind: "dm" as const,
        channel: "mission",
        account: "operator",
        displayName: "Deterministic delegated child",
        timestamp: now,
      };
      workerA.sessions.upsert(sessionInput);
      workerB.sessions.upsert(sessionInput);
      const taskInput = {
        workspaceId: "default",
        title: "Deterministic delegated child",
        description: "Cross-worker convergence proof",
        status: "in_progress" as const,
        priority: "normal" as const,
      };
      workerA.tasks.create(taskInput, now, { taskId: ids.task });
      assert.throws(() => workerB?.tasks.create(taskInput, now, { taskId: ids.task }));
      workerA.taskSubagents.create(ids.task, {
        agentSessionId: ids.subagent,
        agentName: "coder",
        metadata: { runId: ids.run, profileId: "coder", heartbeatAt: now },
      });
      const runInput = {
        runId: ids.run,
        sessionId: ids.session,
        taskId: ids.task,
        objective: "Execute exactly once",
        roles: ["coder"],
        mode: "sequential" as const,
        status: "running" as const,
        startedAt: now,
      };
      workerA.chatDelegationRuns.create(runInput);
      assert.throws(() => workerB?.chatDelegationRuns.create(runInput));
      const stepInput = {
        stepId: ids.step,
        runId: ids.run,
        role: "coder",
        index: 0,
        status: "pending" as const,
        startedAt: now,
      };
      workerA.chatDelegationSteps.create(stepInput);
      assert.throws(() => workerB?.chatDelegationSteps.create(stepInput));
      const userMessage = {
        messageId: ids.userMessage,
        sessionId: ids.session,
        role: "user" as const,
        actorType: "user" as const,
        actorId: "operator",
        content: "Execute exactly once",
        timestamp: now,
      };
      workerA.chatMessages.upsert(userMessage);
      workerB.chatMessages.upsert(userMessage);
      const traceInput = {
        turnId: ids.turn,
        sessionId: ids.session,
        userMessageId: ids.userMessage,
        assistantMessageId: ids.assistantMessage,
        status: "queued" as const,
        mode: "chat" as const,
        webMode: "off" as const,
        memoryMode: "off" as const,
        thinkingLevel: "standard" as const,
        routing: {},
        startedAt: now,
      };
      workerA.chatTurnTraces.create(traceInput);
      workerB.chatTurnTraces.create(traceInput);
      const durableRunInput = {
        runId: ids.durableRun,
        workflowKey: "chat.turn.execute",
        status: "queued" as const,
        payload: { runId: ids.durableRun, sessionId: ids.session, turnId: ids.turn },
        now,
      };
      workerA.durableRuns.createRun(durableRunInput);
      assert.throws(() => workerB?.durableRuns.createRun(durableRunInput));

      const claimA = `dispatch-claim:${ids.turn}:a`;
      const claimB = `dispatch-claim:${ids.turn}:b`;
      const dispatchA = `dispatch-linked:${ids.turn}:a`;
      const dispatchB = `dispatch-linked:${ids.turn}:b`;
      const claimExpiresAt = "2099-01-01T00:00:00.000Z";
      const claimed = workerA.chatDelegationSteps.claimPendingForDispatch(ids.step, claimA, claimExpiresAt, now);
      assert.equal(claimed?.childSessionId, undefined);
      assert.equal(claimed?.childTurnId, undefined);
      assert.equal(
        workerB.chatDelegationSteps.claimPendingForDispatch(ids.step, claimB, claimExpiresAt, now),
        undefined,
      );
      assert.equal(
        workerB.chatDelegationSteps.finishUnclaimedPendingWithError({
          stepId: ids.step,
          status: "skipped",
          label: "coder",
          summary: "Child cancelled.",
          error: "stale pre-claim abort",
          failureGuidance: "Retry",
          finishedAt: now,
          durationMs: 0,
        }),
        undefined,
      );
      assert.equal(workerA.chatDelegationSteps.getDispatchClaim(ids.step)?.token, claimA);
      const linked = workerA.chatDelegationSteps.linkClaimedDispatch(
        ids.step,
        claimA,
        ids.session,
        dispatchA,
        claimExpiresAt,
      );
      assert.equal(linked?.childSessionId, ids.session);
      assert.equal(linked?.childTurnId, undefined);
      assert.ok(
        workerB.chatDelegationSteps.reclaimLinkedDispatch(
          ids.step,
          ids.session,
          dispatchA,
          dispatchB,
          claimExpiresAt,
          now,
        ),
      );
      assert.equal(workerA.chatDelegationSteps.ownsLinkedDispatch(ids.step, ids.session, dispatchA), false);
      assert.equal(workerB.chatDelegationSteps.ownsLinkedDispatch(ids.step, ids.session, dispatchB), true);
      assert.equal(
        workerA.chatDelegationSteps.finishOwnedDispatchWithError({
          stepId: ids.step,
          expectedDispatchToken: dispatchA,
          expectedChildSessionId: ids.session,
          status: "failed",
          label: "coder",
          error: "late stale-owner provider rejection",
          failureGuidance: "Retry",
          finishedAt: now,
          durationMs: 0,
        }),
        undefined,
      );
      assert.equal(workerB.chatDelegationSteps.get(ids.step).status, "running");
      assert.equal(workerB.chatDelegationSteps.getDispatchClaim(ids.step)?.token, dispatchB);
      assert.equal(
        workerA.chatDelegationSteps.finishOwnedDispatchWithResponse({
          stepId: ids.step,
          expectedDispatchToken: dispatchA,
          childSessionId: ids.session,
          childTurnId: ids.turn,
          status: "completed",
          providerId: "openai",
          model: "gpt-test",
          label: "coder",
          summary: "stale response",
          output: "stale response",
          citations: [],
        }),
        undefined,
      );
      const finalized = workerB.chatDelegationSteps.finishOwnedDispatchWithResponse({
        stepId: ids.step,
        expectedDispatchToken: dispatchB,
        childSessionId: ids.session,
        childTurnId: ids.turn,
        status: "completed",
        providerId: "openai",
        model: "gpt-test",
        label: "coder",
        summary: "replacement response",
        output: "replacement response",
        citations: [
          {
            citationId: `citation-${suffix}`,
            title: "Replacement evidence",
            url: "https://example.test/replacement-evidence",
          },
        ],
        durableRunId: ids.durableRun,
        finishedAt: now,
        durationMs: 1,
      });
      assert.equal(finalized?.childTurnId, ids.turn);
      assert.equal(finalized?.output, "replacement response");
      assert.equal(workerB.chatDelegationSteps.ownsLinkedDispatch(ids.step, ids.session, dispatchB), false);

      workerA.chatDelegationSteps.create({
        ...stepInput,
        stepId: ids.errorStep,
        index: 1,
      });
      assert.ok(workerA.chatDelegationSteps.claimPendingForDispatch(ids.errorStep, claimA, claimExpiresAt, now));
      assert.ok(
        workerA.chatDelegationSteps.linkClaimedDispatch(ids.errorStep, claimA, ids.session, dispatchA, claimExpiresAt),
      );
      const ownedError = workerA.chatDelegationSteps.finishOwnedDispatchWithError({
        stepId: ids.errorStep,
        expectedDispatchToken: dispatchA,
        expectedChildSessionId: ids.session,
        status: "failed",
        label: "coder",
        error: "provider rejected",
        failureGuidance: "Retry",
        finishedAt: now,
        durationMs: 1,
      });
      assert.equal(ownedError?.status, "failed");
      assert.equal(workerB.chatDelegationSteps.getDispatchClaim(ids.errorStep), undefined);

      workerA.chatDelegationSteps.create({
        ...stepInput,
        stepId: ids.waitingStep,
        index: 2,
      });
      assert.ok(workerA.chatDelegationSteps.claimPendingForDispatch(ids.waitingStep, claimA, claimExpiresAt, now));
      assert.ok(
        workerA.chatDelegationSteps.linkClaimedDispatch(
          ids.waitingStep,
          claimA,
          ids.session,
          dispatchA,
          claimExpiresAt,
        ),
      );
      const waitingTurnId = `${ids.turn}-waiting`;
      const commitWaitingResponse = () =>
        workerA!.chatDelegationSteps.finishOwnedDispatchWithResponse({
          stepId: ids.waitingStep,
          expectedDispatchToken: dispatchA,
          childSessionId: ids.session,
          childTurnId: waitingTurnId,
          status: "running",
          providerId: "openai",
          model: "gpt-test",
          label: "coder",
          summary: "waiting for approval",
          output: "waiting for approval",
          citations: [],
        });
      assert.throws(() =>
        workerA?.runImmediateTransaction(() => {
          assert.equal(commitWaitingResponse()?.status, "running");
          assert.ok(
            workerA?.chatDelegationSteps.releaseOwnedWaitingDispatch({
              stepId: ids.waitingStep,
              expectedDispatchToken: dispatchA,
              childSessionId: ids.session,
              childTurnId: waitingTurnId,
            }),
          );
          workerA?.taskSubagents.updateByAgentSessionIdWithMetadataPatch(ids.subagent, {
            status: "paused",
            metadataPatch: {
              waiting: {
                status: "waiting_for_approval",
                reason: "waiting for approval",
                childTurnId: waitingTurnId,
                observedAt: now,
              },
            },
          });
          throw new Error("rollback waiting outcome");
        }),
      );
      assert.equal(workerB.chatDelegationSteps.get(ids.waitingStep).childTurnId, undefined);
      assert.equal(workerB.chatDelegationSteps.get(ids.waitingStep).output, undefined);
      assert.equal(workerB.chatDelegationSteps.getDispatchClaim(ids.waitingStep)?.token, dispatchA);
      assert.equal(workerB.taskSubagents.getByAgentSessionId(ids.subagent).metadata?.waiting, undefined);

      let waitingResponse: ReturnType<typeof commitWaitingResponse>;
      workerA.runImmediateTransaction(() => {
        waitingResponse = commitWaitingResponse();
        assert.ok(
          workerA?.chatDelegationSteps.releaseOwnedWaitingDispatch({
            stepId: ids.waitingStep,
            expectedDispatchToken: dispatchA,
            childSessionId: ids.session,
            childTurnId: waitingTurnId,
          }),
        );
        workerA?.taskSubagents.updateByAgentSessionIdWithMetadataPatch(ids.subagent, {
          status: "paused",
          metadataPatch: {
            waiting: {
              status: "waiting_for_approval",
              reason: "waiting for approval",
              childTurnId: waitingTurnId,
              observedAt: now,
            },
          },
        });
      });
      assert.equal(waitingResponse?.status, "running");
      assert.equal(workerB.chatDelegationSteps.getDispatchClaim(ids.waitingStep), undefined);
      assert.equal(
        workerB.taskSubagents.getByAgentSessionId(ids.subagent).metadata?.waiting?.childTurnId,
        waitingTurnId,
      );

      const blocker = await scopedPool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT agent_session_id FROM task_subagent_sessions WHERE agent_session_id = $1 FOR UPDATE",
          [ids.subagent],
        );
        const blockedWaiting = {
          runId: ids.run,
          profileId: "coder",
          waiting: {
            status: "waiting_for_approval",
            reason: "operator approval still required",
            childTurnId: waitingTurnId,
            observedAt: now,
          },
        };
        await blocker.query("UPDATE task_subagent_sessions SET metadata_json = $2 WHERE agent_session_id = $1", [
          ids.subagent,
          JSON.stringify(blockedWaiting),
        ]);
        const releaseBlocker = blocker.query("SELECT pg_sleep(1); COMMIT");
        const heartbeatStartedAt = Date.now();
        const heartbeat = workerB.taskSubagents.updateByAgentSessionIdWithMetadataPatch(ids.subagent, {
          metadataPatch: { heartbeatAt: "2026-07-11T00:05:00.000Z" },
        });
        const heartbeatWaitedMs = Date.now() - heartbeatStartedAt;
        await releaseBlocker;
        assert.ok(heartbeatWaitedMs >= 750, `heartbeat should wait for the row lock (${heartbeatWaitedMs}ms)`);
        assert.equal(heartbeat.metadata?.waiting?.reason, "operator approval still required");
        assert.equal(heartbeat.metadata?.heartbeatAt, "2026-07-11T00:05:00.000Z");
      } finally {
        try {
          await blocker.query("ROLLBACK");
        } catch {
          // Best-effort cleanup: the blocker normally committed in the timed release query.
        }
        blocker.release();
      }

      const counts = await scopedPool.query<{
        tasks: number;
        runs: number;
        steps: number;
        sessions: number;
        messages: number;
        turns: number;
        durable_runs: number;
        subagents: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM tasks) AS tasks,
          (SELECT COUNT(*)::int FROM chat_delegation_runs) AS runs,
          (SELECT COUNT(*)::int FROM chat_delegation_steps) AS steps,
          (SELECT COUNT(*)::int FROM sessions) AS sessions,
          (SELECT COUNT(*)::int FROM chat_messages) AS messages,
          (SELECT COUNT(*)::int FROM chat_turn_traces) AS turns,
          (SELECT COUNT(*)::int FROM durable_runs) AS durable_runs
          , (SELECT COUNT(*)::int FROM task_subagent_sessions) AS subagents
      `);
      assert.deepEqual(counts.rows[0], {
        tasks: 1,
        runs: 1,
        steps: 3,
        sessions: 1,
        messages: 1,
        turns: 1,
        durable_runs: 1,
        subagents: 1,
      });
    } finally {
      workerB?.close();
      workerA?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres serializes disjoint full-row task updates across two repository clients",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_task_update_lock_${suffix}`;
    const taskId = `task-update-lock-${suffix}`;
    const barrierKey = `task-update-lock:${suffix}`;
    const workerAApplicationName = `gc-task-rmw-a-${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let barrierClient: PoolClient | undefined;
    let workerA: Worker | undefined;
    let workerB: Storage | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      workerB = new Storage({
        db: new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: `gc-task-rmw-b-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        }),
        transcriptsDir: ".",
        auditDir: ".",
      });
      workerB.tasks.create(
        {
          workspaceId: "default",
          title: "Preserve disjoint task updates",
          description: "initial description",
          status: "inbox",
          priority: "normal",
          proactiveContext: {
            sessionId: `session-${suffix}`,
            originSurface: "chat",
            proactiveRunId: `proactive-${suffix}`,
          },
        },
        "2026-07-11T00:00:00.000Z",
        { taskId },
      );

      await scopedPool.query(`
        CREATE FUNCTION task_update_lock_barrier_${suffix}() RETURNS trigger AS $$
        BEGIN
          IF current_setting('application_name') = '${escapePostgresLiteral(workerAApplicationName)}' THEN
            PERFORM pg_advisory_xact_lock(hashtext('${escapePostgresLiteral(barrierKey)}'));
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER task_update_lock_barrier_${suffix}
          BEFORE UPDATE ON tasks
          FOR EACH ROW EXECUTE FUNCTION task_update_lock_barrier_${suffix}();
      `);

      barrierClient = await scopedPool.connect();
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKey]);
      const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
      workerA = new Worker(TASK_UPDATE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          connectionOptions: {
            connectionString: scopedUrl.toString(),
            database: "goatcitadel_test",
            applicationName: workerAApplicationName,
            pool: { max: 1, connectionTimeoutMs: 10_000 },
          },
          taskId,
          taskUpdate: {
            description: "worker A committed description",
            priority: "high",
          },
          now: "2026-07-11T00:00:01.000Z",
          storageModuleUrl: new URL(`../index${runtimeModuleExtension}`, import.meta.url).href,
          postgresModuleUrl: new URL(`./sync${runtimeModuleExtension}`, import.meta.url).href,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
        },
      });
      const workerACompletion = waitForTaskUpdateWorker(workerA);

      const waitDeadline = Date.now() + 10_000;
      let workerAOwnsTaskLock = false;
      while (!workerAOwnsTaskLock && Date.now() < waitDeadline) {
        const waitState = await scopedPool.query<{ waiting: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity AS activity
              INNER JOIN pg_locks AS lock ON lock.pid = activity.pid
              WHERE activity.application_name = $1
                AND lock.locktype = 'advisory'
                AND lock.granted = FALSE
            ) AS waiting
          `,
          [workerAApplicationName],
        );
        workerAOwnsTaskLock = waitState.rows[0]?.waiting === true;
        if (!workerAOwnsTaskLock) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(workerAOwnsTaskLock, true, "worker A should hold the task row lock before worker B updates");

      const releaseBarrier = barrierClient.query(
        `SELECT pg_sleep(1); SELECT pg_advisory_unlock(hashtext('${escapePostgresLiteral(barrierKey)}'));`,
      );
      const workerBStartedAt = Date.now();
      const workerBUpdate = workerB.tasks.update(
        taskId,
        {
          agenticContext: {
            runId: `run-${suffix}`,
            status: "running",
            contextMode: "fork",
            workspaceScope: { kind: "session" },
          },
        },
        "2026-07-11T00:00:02.000Z",
      );
      const workerBWaitedMs = Date.now() - workerBStartedAt;
      await releaseBarrier;
      const workerAUpdate = await workerACompletion;

      assert.ok(workerBWaitedMs >= 750, `worker B should wait for worker A's row lock (${workerBWaitedMs}ms)`);
      assert.equal(workerAUpdate.description, "worker A committed description");
      assert.equal(workerAUpdate.priority, "high");
      assert.equal(workerBUpdate.description, "worker A committed description");
      assert.equal(workerBUpdate.priority, "high");
      assert.equal(workerBUpdate.agenticContext?.runId, `run-${suffix}`);
      assert.equal(workerBUpdate.proactiveContext?.proactiveRunId, `proactive-${suffix}`);
      assert.deepEqual(workerB.tasks.get(taskId), workerBUpdate);
    } finally {
      if (barrierClient) {
        try {
          await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKey]);
        } catch {
          // Best-effort cleanup: the scheduled release normally unlocks the barrier.
        }
        barrierClient.release();
      }
      if (workerA) {
        await workerA.terminate();
      }
      workerB?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres preserves applied A2A cancellation truth across a row-lock wait",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_a2a_update_lock_${suffix}`;
    const a2aTaskId = `a2a-update-lock-${suffix}`;
    const controlId = `a2a-cancel-${suffix}`;
    const barrierKey = `a2a-update-lock:${suffix}`;
    const workerAApplicationName = `gc-a2a-rmw-a-${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let barrierClient: PoolClient | undefined;
    let workerA: Worker | undefined;
    let workerB: Storage | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      workerB = new Storage({
        db: new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: `gc-a2a-rmw-b-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        }),
        transcriptsDir: ".",
        auditDir: ".",
      });
      workerB.a2aTaskBindings.createOrGet(
        {
          a2aTaskId,
          contextId: `context-${suffix}`,
          peerId: `peer-${suffix}`,
          idempotencyKey: `dispatch-${suffix}`,
          state: "working",
          metadata: { cancellation: { status: "pending", attempt: 1, controlId } },
        },
        "2026-07-11T00:00:00.000Z",
      );

      await scopedPool.query(`
        CREATE FUNCTION a2a_update_lock_barrier_${suffix}() RETURNS trigger AS $$
        BEGIN
          IF current_setting('application_name') = '${escapePostgresLiteral(workerAApplicationName)}' THEN
            PERFORM pg_advisory_xact_lock(hashtext('${escapePostgresLiteral(barrierKey)}'));
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER a2a_update_lock_barrier_${suffix}
          BEFORE UPDATE ON a2a_task_bindings
          FOR EACH ROW EXECUTE FUNCTION a2a_update_lock_barrier_${suffix}();
      `);

      barrierClient = await scopedPool.connect();
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKey]);
      const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
      workerA = new Worker(A2A_BINDING_UPDATE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          connectionOptions: {
            connectionString: scopedUrl.toString(),
            database: "goatcitadel_test",
            applicationName: workerAApplicationName,
            pool: { max: 1, connectionTimeoutMs: 10_000 },
          },
          a2aTaskId,
          bindingUpdate: {
            state: "canceled",
            metadata: {
              cancellation: { status: "applied", attempt: 1, controlId, runtimeEffect: "runtime_cancel" },
            },
          },
          now: "2026-07-11T00:00:01.000Z",
          storageModuleUrl: new URL(`../index${runtimeModuleExtension}`, import.meta.url).href,
          postgresModuleUrl: new URL(`./sync${runtimeModuleExtension}`, import.meta.url).href,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
        },
      });
      const workerACompletion = waitForA2ABindingUpdateWorker(workerA);

      const waitDeadline = Date.now() + 10_000;
      let workerAOwnsBindingLock = false;
      while (!workerAOwnsBindingLock && Date.now() < waitDeadline) {
        const waitState = await scopedPool.query<{ waiting: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity AS activity
              INNER JOIN pg_locks AS lock ON lock.pid = activity.pid
              WHERE activity.application_name = $1
                AND lock.locktype = 'advisory'
                AND lock.granted = FALSE
            ) AS waiting
          `,
          [workerAApplicationName],
        );
        workerAOwnsBindingLock = waitState.rows[0]?.waiting === true;
        if (!workerAOwnsBindingLock) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(workerAOwnsBindingLock, true, "worker A should hold the binding row lock before worker B updates");

      const releaseBarrier = barrierClient.query(
        `SELECT pg_sleep(1); SELECT pg_advisory_unlock(hashtext('${escapePostgresLiteral(barrierKey)}'));`,
      );
      const workerBStartedAt = Date.now();
      const workerBUpdate = workerB.a2aTaskBindings.update(
        a2aTaskId,
        { lastEventSequence: 7 },
        "2026-07-11T00:00:02.000Z",
      );
      const workerBWaitedMs = Date.now() - workerBStartedAt;
      await releaseBarrier;
      const workerAUpdate = await workerACompletion;

      assert.ok(workerBWaitedMs >= 750, `worker B should wait for worker A's row lock (${workerBWaitedMs}ms)`);
      assert.equal(workerAUpdate.state, "canceled");
      assert.equal(workerBUpdate.state, "canceled");
      assert.equal(workerBUpdate.lastEventSequence, 7);
      assert.deepEqual(workerBUpdate.metadata, {
        cancellation: { status: "applied", attempt: 1, controlId, runtimeEffect: "runtime_cancel" },
      });
    } finally {
      if (barrierClient) {
        try {
          await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKey]);
        } catch {
          // Best-effort cleanup: the scheduled release normally unlocks the barrier.
        }
        barrierClient.release();
      }
      if (workerA) {
        await workerA.terminate();
      }
      workerB?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres A2A reservations converge for one peer and reject a concurrent cross-peer collision",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_a2a_create_race_${suffix}`;
    const a2aTaskId = `a2a-create-race-${suffix}`;
    const barrierKey = `a2a-create-race:${suffix}`;
    const workerAApplicationName = `gc-a2a-create-a-${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let barrierClient: PoolClient | undefined;
    let workerA: Worker | undefined;
    let workerB: Storage | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      workerB = new Storage({
        db: new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: `gc-a2a-create-b-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        }),
        transcriptsDir: ".",
        auditDir: ".",
      });

      await scopedPool.query(`
        CREATE FUNCTION a2a_create_race_barrier_${suffix}() RETURNS trigger AS $$
        BEGIN
          IF current_setting('application_name') = '${escapePostgresLiteral(workerAApplicationName)}' THEN
            PERFORM pg_advisory_xact_lock(hashtext('${escapePostgresLiteral(barrierKey)}'));
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER a2a_create_race_barrier_${suffix}
          BEFORE INSERT ON a2a_task_bindings
          FOR EACH ROW EXECUTE FUNCTION a2a_create_race_barrier_${suffix}();
      `);

      barrierClient = await scopedPool.connect();
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKey]);
      const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
      workerA = new Worker(A2A_BINDING_CREATE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          connectionOptions: {
            connectionString: scopedUrl.toString(),
            database: "goatcitadel_test",
            applicationName: workerAApplicationName,
            pool: { max: 1, connectionTimeoutMs: 10_000 },
          },
          bindingInput: {
            a2aTaskId,
            contextId: `context-${suffix}`,
            peerId: `peer-${suffix}`,
            workspaceId: "default",
            idempotencyKey: `dispatch-${suffix}`,
            state: "submitted",
            metadata: { creator: "loser" },
          },
          now: "2026-07-11T00:00:00.000Z",
          storageModuleUrl: new URL(`../index${runtimeModuleExtension}`, import.meta.url).href,
          postgresModuleUrl: new URL(`./sync${runtimeModuleExtension}`, import.meta.url).href,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
        },
      });
      const workerACompletion = waitForA2ABindingCreateWorker(workerA);

      const waitDeadline = Date.now() + 10_000;
      let workerAReachedInsertBarrier = false;
      while (!workerAReachedInsertBarrier && Date.now() < waitDeadline) {
        const waitState = await scopedPool.query<{ waiting: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity AS activity
              INNER JOIN pg_locks AS lock ON lock.pid = activity.pid
              WHERE activity.application_name = $1
                AND lock.locktype = 'advisory'
                AND lock.granted = FALSE
            ) AS waiting
          `,
          [workerAApplicationName],
        );
        workerAReachedInsertBarrier = waitState.rows[0]?.waiting === true;
        if (!workerAReachedInsertBarrier) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(workerAReachedInsertBarrier, true, "worker A should pause before its binding insert");

      const winner = workerB.a2aTaskBindings.createOrGet(
        {
          a2aTaskId,
          contextId: `context-${suffix}`,
          peerId: `peer-${suffix}`,
          workspaceId: "default",
          idempotencyKey: `dispatch-${suffix}`,
          state: "submitted",
          metadata: { creator: "winner" },
        },
        "2026-07-11T00:00:01.000Z",
      );
      await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKey]);
      const loser = await workerACompletion;

      assert.equal(winner.sessionId, undefined);
      assert.equal(loser.sessionId, winner.sessionId);
      assert.equal(loser.localTaskId, winner.localTaskId);
      assert.deepEqual(loser.metadata, winner.metadata);
      const rows = await scopedPool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM a2a_task_bindings WHERE a2a_task_id = $1",
        [a2aTaskId],
      );
      assert.equal(rows.rows[0]?.count, "1");

      await workerA.terminate();
      workerA = undefined;
      const collisionTaskId = `a2a-cross-peer-race-${suffix}`;
      await barrierClient.query("SELECT pg_advisory_lock(hashtext($1))", [barrierKey]);
      workerA = new Worker(A2A_BINDING_CREATE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          connectionOptions: {
            connectionString: scopedUrl.toString(),
            database: "goatcitadel_test",
            applicationName: workerAApplicationName,
            pool: { max: 1, connectionTimeoutMs: 10_000 },
          },
          bindingInput: {
            a2aTaskId: collisionTaskId,
            contextId: `collision-context-${suffix}`,
            peerId: `collision-loser-${suffix}`,
            workspaceId: "default",
            idempotencyKey: `collision-loser-dispatch-${suffix}`,
            state: "submitted",
          },
          now: "2026-07-11T00:01:00.000Z",
          storageModuleUrl: new URL(`../index${runtimeModuleExtension}`, import.meta.url).href,
          postgresModuleUrl: new URL(`./sync${runtimeModuleExtension}`, import.meta.url).href,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
        },
      });
      const collisionCompletion = waitForA2ABindingCreateWorker(workerA).then(
        (binding) => ({ binding, error: undefined }),
        (error: unknown) => ({ binding: undefined, error }),
      );
      const collisionWaitDeadline = Date.now() + 10_000;
      let collisionReachedInsertBarrier = false;
      while (!collisionReachedInsertBarrier && Date.now() < collisionWaitDeadline) {
        const waitState = await scopedPool.query<{ waiting: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity AS activity
              INNER JOIN pg_locks AS lock ON lock.pid = activity.pid
              WHERE activity.application_name = $1
                AND lock.locktype = 'advisory'
                AND lock.granted = FALSE
            ) AS waiting
          `,
          [workerAApplicationName],
        );
        collisionReachedInsertBarrier = waitState.rows[0]?.waiting === true;
        if (!collisionReachedInsertBarrier) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(collisionReachedInsertBarrier, true, "cross-peer worker should pause before reservation");

      const collisionWinner = workerB.a2aTaskBindings.createOrGet(
        {
          a2aTaskId: collisionTaskId,
          contextId: `collision-context-${suffix}`,
          peerId: `collision-winner-${suffix}`,
          workspaceId: "default",
          idempotencyKey: `collision-winner-dispatch-${suffix}`,
          state: "submitted",
        },
        "2026-07-11T00:01:01.000Z",
      );
      await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKey]);
      const collisionLoser = await collisionCompletion;

      assert.equal(collisionWinner.peerId, `collision-winner-${suffix}`);
      assert.equal(collisionLoser.binding, undefined);
      assert.match(
        collisionLoser.error instanceof Error ? collisionLoser.error.message : String(collisionLoser.error),
        /conflicts with the persisted A2A binding owner or request identity/,
      );
      assert.equal(workerB.a2aTaskBindings.get(collisionTaskId).peerId, collisionWinner.peerId);
      const collisionRows = await scopedPool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM a2a_task_bindings WHERE a2a_task_id = $1",
        [collisionTaskId],
      );
      assert.equal(collisionRows.rows[0]?.count, "1");
    } finally {
      if (barrierClient) {
        try {
          await barrierClient.query("SELECT pg_advisory_unlock(hashtext($1))", [barrierKey]);
        } catch {
          // Best-effort cleanup: the explicit release normally unlocks the barrier.
        }
        barrierClient.release();
      }
      if (workerA) {
        await workerA.terminate();
      }
      workerB?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres migrator/client lane applies migrations and writes through the client",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const tableName = `coverage_real_pg_${suffix}`;
    const syncTableName = `coverage_real_pg_sync_${suffix}`;
    const migrationsTable = `coverage_real_pg_migrations_${suffix}`;
    const pool = new Pool({ connectionString });
    const client = new PostgresDatabaseClient(
      { connectionString, database: "goatcitadel_test" },
      { pool, migrationsTable },
    );

    try {
      const result = await runPostgresMigrations(client, [
        {
          version: 1,
          name: "create_real_postgres_lane_table",
          sql: `CREATE TABLE ${tableName} (id SERIAL PRIMARY KEY, payload TEXT NOT NULL)`,
        },
      ]);
      assert.deepEqual(result, { appliedVersions: [1], latestVersion: 1 });

      const rows = await client.query<{ payload: string }>(
        `INSERT INTO ${tableName} (payload) VALUES ($1) RETURNING payload`,
        ["real postgres lane"],
      );
      assert.deepEqual(rows, [{ payload: "real postgres lane" }]);

      const transactionResult = await client.transaction(async (transactionClient) => {
        await transactionClient.query(`INSERT INTO ${tableName} (payload) VALUES ($1)`, ["transaction row"]);
        return "committed";
      });
      assert.equal(transactionResult, "committed");

      const syncClient = new PostgresSyncDatabaseClient({
        connectionString,
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        syncClient.exec(`CREATE TABLE ${syncTableName} (id SERIAL PRIMARY KEY, payload TEXT NOT NULL)`);
        const insert = syncClient.prepare(`INSERT INTO ${syncTableName} (payload) VALUES (?)`);
        assert.equal(insert.run("sync worker row").changes, 1);
        const row = syncClient
          .prepare(`SELECT payload FROM ${syncTableName} WHERE payload = ?`)
          .get<{ payload: string }>("sync worker row");
        assert.deepEqual(row, { payload: "sync worker row" });

        const nestedResult = syncClient.transaction("immediate", () => {
          syncClient.prepare(`INSERT INTO ${syncTableName} (payload) VALUES (@payload)`).run({
            payload: "sync transaction row",
          });
          return syncClient.prepare(`SELECT COUNT(*)::int AS count FROM ${syncTableName}`).get<{ count: number }>();
        });
        assert.equal(nestedResult?.count, 2);
      } finally {
        syncClient.close();
      }
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${syncTableName}`);
      await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
      await pool.query(`DROP TABLE IF EXISTS ${migrationsTable}`);
      await pool.end();
    }
  },
);

test(
  "real Postgres accepts a durable quoted current schema after an emptied temp namespace",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage.migration_"${suffix}`;
    const quotedSchema = quotePostgresIdentifier(schemaName);
    const migrationsTable = `quoted_schema_migrations_${suffix}`;
    const effectsTable = `quoted_schema_effects_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const pool = new Pool({ connectionString, max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString, database: "goatcitadel_test" },
      { pool, migrationsTable },
    );

    try {
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      const session = await pool.connect();
      await session.query(`SET search_path TO ${quotedSchema}`);
      await session.query("CREATE TEMPORARY TABLE unrelated_temp_probe (sentinel TEXT)");
      await session.query("DROP TABLE unrelated_temp_probe");
      const backendPid = (await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      assert.equal(
        (await session.query<{ schema_name: string }>("SELECT current_schema() AS schema_name")).rows[0]?.schema_name,
        schemaName,
      );
      session.release();

      const result = await runPostgresMigrations(client, [
        {
          version: 1,
          name: "create_quoted_schema_effect",
          sql: `CREATE TABLE ${effectsTable} (effect_id INTEGER PRIMARY KEY)`,
        },
      ]);
      assert.deepEqual(result.appliedVersions, [1]);
      assert.equal((await client.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid"))?.pid, backendPid);
      const durableTables = await adminPool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = ANY($2::text[])
         ORDER BY table_name`,
        [schemaName, [effectsTable, migrationsTable]],
      );
      assert.deepEqual(
        durableTables.rows.map((row) => row.table_name),
        [effectsTable, migrationsTable].sort(),
      );
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects temporary migration objects and retires async and sync sessions",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_temp_objects_${suffix}`;
    const asyncLedger = `async_temp_object_migrations_${suffix}`;
    const typeLedger = `async_temp_type_migrations_${suffix}`;
    const syncLedger = `sync_temp_object_migrations_${suffix}`;
    const asyncEffect = `async_temp_object_effect_${suffix}`;
    const typeEffect = `async_temp_type_effect_${suffix}`;
    const syncEffect = `sync_temp_object_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const asyncPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const typePool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const asyncClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: asyncPool, migrationsTable: asyncLedger },
    );
    const typeClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: typePool, migrationsTable: typeLedger },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);

      const asyncSession = await asyncPool.connect();
      const asyncContaminatedPid = (await asyncSession.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      await asyncSession.query(`CREATE TEMPORARY TABLE ${asyncEffect} (sentinel TEXT)`);
      asyncSession.release();
      await assert.rejects(
        runPostgresMigrations(asyncClient, [
          { version: 1, name: "async_temp_object_probe", sql: `CREATE TABLE ${asyncEffect} (effect_id INTEGER)` },
        ]),
        /temporary relation .* contaminates the pinned migration session/,
      );
      const asyncReplacement = await asyncClient.queryOne<{ pid: number; relation: string | null }>(
        `SELECT pg_backend_pid() AS pid, to_regclass('pg_temp.${asyncEffect}')::text AS relation`,
      );
      assert.notEqual(asyncReplacement?.pid, asyncContaminatedPid);
      assert.equal(asyncReplacement?.relation, null);

      const typeSession = await typePool.connect();
      const typeContaminatedPid = (await typeSession.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      await typeSession.query("CREATE DOMAIN pg_temp.text AS pg_catalog.text");
      typeSession.release();
      await assert.rejects(
        runPostgresMigrations(typeClient, [
          { version: 1, name: "async_temp_type_probe", sql: `CREATE TABLE ${typeEffect} (payload TEXT)` },
        ]),
        /temporary type .* contaminates the pinned migration session/,
      );
      assert.notEqual(
        (await typeClient.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid"))?.pid,
        typeContaminatedPid,
      );

      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-temp-object-migration-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      const syncContaminatedPid = syncClient.prepare("SELECT pg_backend_pid() AS pid").get<{ pid: number }>()?.pid;
      syncClient.exec(`CREATE TEMPORARY TABLE ${syncEffect} (sentinel TEXT)`);
      assert.throws(
        () =>
          applyPostgresMigrationsSync(syncClient as PostgresSyncDatabaseClient, {
            migrationsTable: syncLedger,
            migrations: [
              { version: 1, name: "sync_temp_object_probe", sql: `CREATE TABLE ${syncEffect} (effect_id INTEGER)` },
            ],
          }),
        /temporary relation .* contaminates the pinned migration session/,
      );
      const syncReplacementPid = syncClient.prepare("SELECT pg_backend_pid() AS pid").get<{ pid: number }>()?.pid;
      assert.notEqual(syncReplacementPid, syncContaminatedPid);

      syncClient.exec("CREATE TEMPORARY TABLE empty_namespace_probe (sentinel TEXT)");
      syncClient.exec("DROP TABLE empty_namespace_probe");
      const cleanSyncPid = syncClient.prepare("SELECT pg_backend_pid() AS pid").get<{ pid: number }>()?.pid;
      applyPostgresMigrationsSync(syncClient, {
        migrationsTable: syncLedger,
        migrations: [
          { version: 1, name: "sync_empty_temp_probe", sql: `CREATE TABLE ${syncEffect} (effect_id INTEGER)` },
        ],
      });
      assert.equal(syncClient.prepare("SELECT pg_backend_pid() AS pid").get<{ pid: number }>()?.pid, cleanSyncPid);

      const durableState = await adminPool.query<{ relation_name: string; relation: string | null }>(
        `SELECT relation_name, to_regclass($1 || '.' || relation_name)::text AS relation
         FROM unnest($2::text[]) AS relation_name
         ORDER BY relation_name`,
        [schemaName, [asyncLedger, asyncEffect, typeLedger, typeEffect, syncLedger, syncEffect]],
      );
      assert.deepEqual(
        durableState.rows,
        [
          { relation_name: asyncEffect, relation: null },
          { relation_name: asyncLedger, relation: null },
          { relation_name: syncEffect, relation: `${schemaName}.${syncEffect}` },
          { relation_name: syncLedger, relation: `${schemaName}.${syncLedger}` },
          { relation_name: typeEffect, relation: null },
          { relation_name: typeLedger, relation: null },
        ].sort((left, right) => left.relation_name.localeCompare(right.relation_name)),
      );
    } finally {
      syncClient?.close();
      await Promise.allSettled([asyncClient.close(), typeClient.close()]);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects pooled transaction and advisory-lock contamination without committing prior work",
  {
    skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane",
    timeout: 20_000,
  },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_session_state_${suffix}`;
    const asyncLedger = `async_session_state_migrations_${suffix}`;
    const syncLedger = `sync_session_state_migrations_${suffix}`;
    const asyncPriorEffect = `async_prior_uncommitted_${suffix}`;
    const syncPriorEffect = `sync_prior_uncommitted_${suffix}`;
    const asyncEffect = `async_session_state_effect_${suffix}`;
    const syncEffect = `sync_session_state_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const asyncPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const asyncClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: asyncPool, migrationsTable: asyncLedger },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);

      const asyncSession = await asyncPool.connect();
      await asyncSession.query("BEGIN");
      await asyncSession.query(`CREATE TABLE ${asyncPriorEffect} (effect_id INTEGER)`);
      const asyncTransactionPid = (await asyncSession.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      asyncSession.release();
      await assert.rejects(
        runPostgresMigrations(asyncClient, [
          { version: 1, name: "async_session_state", sql: `CREATE TABLE ${asyncEffect} (effect_id INTEGER)` },
        ]),
        /already inside a transaction before lock acquisition/,
      );
      assert.notEqual(
        (await asyncClient.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid"))?.pid,
        asyncTransactionPid,
      );

      const asyncLockSession = await asyncPool.connect();
      const asyncLockPid = (
        await asyncLockSession.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid, " +
            "pg_catalog.pg_advisory_lock_shared(2147483000, pg_catalog.pg_backend_pid())",
        )
      ).rows[0]?.pid;
      asyncLockSession.release();
      await assert.rejects(
        runPostgresMigrations(asyncClient, [
          { version: 1, name: "async_session_state", sql: `CREATE TABLE ${asyncEffect} (effect_id INTEGER)` },
        ]),
        /already held an advisory lock before lock acquisition/,
      );
      assert.notEqual(
        (await asyncClient.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid"))?.pid,
        asyncLockPid,
      );
      assert.deepEqual(
        (
          await runPostgresMigrations(asyncClient, [
            { version: 1, name: "async_session_state", sql: `CREATE TABLE ${asyncEffect} (effect_id INTEGER)` },
          ])
        ).appliedVersions,
        [1],
      );

      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-session-state-migration-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      syncClient.exec("BEGIN");
      syncClient.exec(`CREATE TABLE ${syncPriorEffect} (effect_id INTEGER)`);
      const syncTransactionPid = syncClient.prepare("SELECT pg_backend_pid() AS pid").get<{ pid: number }>()?.pid;
      assert.throws(
        () =>
          applyPostgresMigrationsSync(syncClient as PostgresSyncDatabaseClient, {
            migrationsTable: syncLedger,
            migrations: [
              { version: 1, name: "sync_session_state", sql: `CREATE TABLE ${syncEffect} (effect_id INTEGER)` },
            ],
          }),
        /already inside a transaction before lock acquisition/,
      );
      assert.notEqual(
        syncClient.prepare("SELECT pg_backend_pid() AS pid").get<{ pid: number }>()?.pid,
        syncTransactionPid,
      );

      const syncLockPid = syncClient
        .prepare("SELECT pg_backend_pid() AS pid, pg_catalog.pg_advisory_lock(2147482001)")
        .get<{ pid: number }>()?.pid;
      assert.throws(
        () =>
          applyPostgresMigrationsSync(syncClient as PostgresSyncDatabaseClient, {
            migrationsTable: syncLedger,
            migrations: [
              { version: 1, name: "sync_session_state", sql: `CREATE TABLE ${syncEffect} (effect_id INTEGER)` },
            ],
          }),
        /already held an advisory lock before lock acquisition/,
      );
      assert.notEqual(syncClient.prepare("SELECT pg_backend_pid() AS pid").get<{ pid: number }>()?.pid, syncLockPid);
      applyPostgresMigrationsSync(syncClient, {
        migrationsTable: syncLedger,
        migrations: [{ version: 1, name: "sync_session_state", sql: `CREATE TABLE ${syncEffect} (effect_id INTEGER)` }],
      });

      const state = await adminPool.query<{
        async_prior: string | null;
        sync_prior: string | null;
        async_ledger: string | null;
        async_effect: string | null;
        sync_ledger: string | null;
        sync_effect: string | null;
      }>(
        `SELECT to_regclass($1)::text AS async_prior,
                to_regclass($2)::text AS sync_prior,
                to_regclass($3)::text AS async_ledger,
                to_regclass($4)::text AS async_effect,
                to_regclass($5)::text AS sync_ledger,
                to_regclass($6)::text AS sync_effect`,
        [
          `${schemaName}.${asyncPriorEffect}`,
          `${schemaName}.${syncPriorEffect}`,
          `${schemaName}.${asyncLedger}`,
          `${schemaName}.${asyncEffect}`,
          `${schemaName}.${syncLedger}`,
          `${schemaName}.${syncEffect}`,
        ],
      );
      assert.deepEqual(state.rows[0], {
        async_prior: null,
        sync_prior: null,
        async_ledger: `${schemaName}.${asyncLedger}`,
        async_effect: `${schemaName}.${asyncEffect}`,
        sync_ledger: `${schemaName}.${syncLedger}`,
        sync_effect: `${schemaName}.${syncEffect}`,
      });
    } finally {
      syncClient?.close();
      await asyncClient.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects a removed migration schema after preflight",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_schema_identity_${suffix}`;
    const effectTable = `schema_identity_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool },
    );
    const originalPreflight = client.assertMigrationsTableNotShadowed.bind(client);
    let droppedAfterPreflight = false;
    client.assertMigrationsTableNotShadowed = async (pinnedClient) => {
      const identity = await originalPreflight(pinnedClient);
      if (!droppedAfterPreflight) {
        droppedAfterPreflight = true;
        await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
      }
      return identity;
    };

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await assert.rejects(
        runPostgresMigrations(client, [
          { version: 1, name: "schema_identity_probe", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
        ]),
        /migration schema .* changed after preflight/,
      );
      assert.equal(droppedAfterPreflight, true);
      const replacement = await client.queryOne<{
        ledger: string | null;
        effect: string | null;
      }>(
        `SELECT to_regclass('pg_temp.schema_migrations')::text AS ledger,
                to_regclass('pg_temp.${effectTable}')::text AS effect`,
      );
      assert.deepEqual(replacement, { ledger: null, effect: null });
      assert.equal(
        (
          await adminPool.query<{ schema_name: string | null }>(
            "SELECT nspname AS schema_name FROM pg_catalog.pg_namespace WHERE nspname = $1",
            [schemaName],
          )
        ).rows[0],
        undefined,
      );
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres does not redirect migration effects after a guarded schema rename",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_rename_${suffix}`;
    const movedSchemaName = `${schemaName}_moved`;
    const ledgerTable = `rename_migrations_${suffix}`;
    const effectTable = `rename_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool, migrationsTable: ledgerTable },
    );
    const originalConfigure = client.configureMigrationTransaction.bind(client);
    let configureCalls = 0;
    client.configureMigrationTransaction = async (pinnedClient, migrationSchema, historyRepairBridge) => {
      await originalConfigure(pinnedClient, migrationSchema, historyRepairBridge);
      configureCalls += 1;
      if (configureCalls === 2) {
        await adminPool.query(`ALTER SCHEMA ${schemaName} RENAME TO ${movedSchemaName}`);
      }
    };

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await assert.rejects(
        runPostgresMigrations(client, [
          { version: 1, name: "schema_rename_probe", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
        ]),
        /no schema has been selected to create in/,
      );
      assert.equal(configureCalls, 2);
      const state = await adminPool.query<{ ledger_rows: number; effect: string | null }>(
        `SELECT (SELECT COUNT(*)::int FROM ${movedSchemaName}.${ledgerTable}) AS ledger_rows,
                to_regclass($1)::text AS effect`,
        [`${movedSchemaName}.${effectTable}`],
      );
      assert.deepEqual(state.rows[0], { ledger_rows: 0, effect: null });
      assert.equal(
        (
          await adminPool.query<{ schema_name: string }>(
            "SELECT nspname AS schema_name FROM pg_catalog.pg_namespace WHERE nspname = $1",
            [schemaName],
          )
        ).rows[0],
        undefined,
      );
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${movedSchemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rolls back replacement-schema migration effects before commit",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_replacement_${suffix}`;
    const movedSchemaName = `${schemaName}_moved`;
    const ledgerTable = `replacement_migrations_${suffix}`;
    const effectTable = `replacement_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool, migrationsTable: ledgerTable },
    );
    const originalConfigure = client.configureMigrationTransaction.bind(client);
    let configureCalls = 0;
    client.configureMigrationTransaction = async (pinnedClient, migrationSchema, historyRepairBridge) => {
      await originalConfigure(pinnedClient, migrationSchema, historyRepairBridge);
      configureCalls += 1;
      if (configureCalls === 2) {
        await adminPool.query(`
          ALTER SCHEMA ${schemaName} RENAME TO ${movedSchemaName};
          CREATE SCHEMA ${schemaName};
          CREATE TABLE ${schemaName}.${ledgerTable} (
            version pg_catalog.int4 PRIMARY KEY,
            name pg_catalog.text NOT NULL,
            applied_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now()
          );
        `);
      }
    };

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await assert.rejects(
        runPostgresMigrations(client, [
          { version: 1, name: "schema_replacement_probe", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
        ]),
        /migration schema .* changed after preflight/,
      );
      assert.equal(configureCalls, 2);
      const state = await adminPool.query<{
        moved_ledger_rows: number;
        replacement_ledger_rows: number;
        moved_effect: string | null;
        replacement_effect: string | null;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM ${movedSchemaName}.${ledgerTable}) AS moved_ledger_rows,
           (SELECT COUNT(*)::int FROM ${schemaName}.${ledgerTable}) AS replacement_ledger_rows,
           to_regclass($1)::text AS moved_effect,
           to_regclass($2)::text AS replacement_effect`,
        [`${movedSchemaName}.${effectTable}`, `${schemaName}.${effectTable}`],
      );
      assert.deepEqual(state.rows[0], {
        moved_ledger_rows: 0,
        replacement_ledger_rows: 0,
        moved_effect: null,
        replacement_effect: null,
      });
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${movedSchemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres health fails closed after a guarded schema rename",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_health_rename_${suffix}`;
    const movedSchemaName = `${schemaName}_moved`;
    const ledgerTable = `health_rename_migrations_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool, migrationsTable: ledgerTable },
    );
    const originalConfigure = client.configureMigrationTransaction.bind(client);
    let renamed = false;
    client.configureMigrationTransaction = async (pinnedClient, migrationSchema, historyRepairBridge) => {
      await originalConfigure(pinnedClient, migrationSchema, historyRepairBridge);
      if (!renamed) {
        renamed = true;
        await adminPool.query(`ALTER SCHEMA ${schemaName} RENAME TO ${movedSchemaName}`);
      }
    };

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      const result = await client.healthCheck();
      assert.equal(renamed, true);
      assert.equal(result.reachable, false);
      assert.match(result.issues[0] ?? "", /does not exist|changed after preflight/);
      const state = await adminPool.query<{ ledger: string | null }>("SELECT to_regclass($1)::text AS ledger", [
        `${movedSchemaName}.${ledgerTable}`,
      ]);
      assert.equal(state.rows[0]?.ledger, null);
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${movedSchemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres serializes concurrent fresh-schema health initialization",
  {
    skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane",
    timeout: 15_000,
  },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_health_concurrency_${suffix}`;
    const ledgerTable = `health_concurrency_migrations_${suffix}`;
    const firstApplicationName = `health-concurrency-first-${suffix}`;
    const secondApplicationName = `health-concurrency-second-${suffix}`;
    const adminPool = new Pool({ connectionString });
    const firstUrl = new URL(connectionString);
    firstUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    firstUrl.searchParams.set("application_name", firstApplicationName);
    const secondUrl = new URL(connectionString);
    secondUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    secondUrl.searchParams.set("application_name", secondApplicationName);
    const firstClient = new PostgresDatabaseClient(
      { connectionString: firstUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: firstUrl.toString(), max: 1 }), migrationsTable: ledgerTable },
    );
    const secondClient = new PostgresDatabaseClient(
      { connectionString: secondUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: secondUrl.toString(), max: 1 }), migrationsTable: ledgerTable },
    );
    let releaseFirstLock: (() => void) | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      let firstLockResolve: (() => void) | undefined;
      const firstLock = new Promise<void>((resolve) => {
        firstLockResolve = resolve;
      });
      const firstLockRelease = new Promise<void>((resolve) => {
        releaseFirstLock = resolve;
      });
      const originalFirstWithLock = firstClient.withMigrationLock.bind(firstClient);
      firstClient.withMigrationLock = (callback, options) =>
        originalFirstWithLock(async (pinnedClient) => {
          firstLockResolve?.();
          await firstLockRelease;
          return callback(pinnedClient);
        }, options);

      let secondLockAcquired = false;
      const originalSecondWithLock = secondClient.withMigrationLock.bind(secondClient);
      secondClient.withMigrationLock = (callback, options) =>
        originalSecondWithLock(async (pinnedClient) => {
          secondLockAcquired = true;
          return callback(pinnedClient);
        }, options);

      const firstHealth = firstClient.healthCheck();
      await waitForProofSignal(firstLock, firstHealth, "first health advisory lock");
      const secondHealth = secondClient.healthCheck();
      const secondResult = await waitForOperation(secondHealth, "contended health check", 2_000);
      assert.equal(secondResult.reachable, true);
      assert.equal(secondResult.migrationVersion, undefined);
      assert.match(secondResult.issues[0] ?? "", /migration work is in progress/);
      assert.equal(secondLockAcquired, false);

      releaseFirstLock?.();
      releaseFirstLock = undefined;
      const firstResult = await waitForOperation(firstHealth, "first health completion", 5_000);
      assert.equal(firstResult.reachable, true);
      const retryResult = await waitForOperation(secondClient.healthCheck(), "health retry after lock release", 2_000);
      assert.equal(retryResult.reachable, true);
      assert.deepEqual(retryResult.issues, []);
      assert.equal(secondLockAcquired, true);
      const ledger = await adminPool.query<{ ledger: string | null }>("SELECT to_regclass($1)::text AS ledger", [
        `${schemaName}.${ledgerTable}`,
      ]);
      assert.equal(ledger.rows[0]?.ledger, `${schemaName}.${ledgerTable}`);
    } finally {
      releaseFirstLock?.();
      await Promise.allSettled([firstClient.close(), secondClient.close()]);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres accepts pg_database_owner ownership for the current database owner",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const ledgerTable = `public_owner_migrations_${suffix}`;
    const effectTable = `public_owner_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", "-csearch_path=public");
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: scopedUrl.toString(), max: 1 }), migrationsTable: ledgerTable },
    );

    try {
      const ownership = await adminPool.query<{
        current_role_name: string;
        database_owner: string;
        schema_owner: string;
      }>(`
        SELECT CURRENT_USER::text AS current_role_name,
               pg_catalog.pg_get_userbyid(database.datdba)::text AS database_owner,
               pg_catalog.pg_get_userbyid(namespace.nspowner)::text AS schema_owner
        FROM pg_catalog.pg_database AS database
        CROSS JOIN pg_catalog.pg_namespace AS namespace
        WHERE database.datname = pg_catalog.current_database()
          AND namespace.nspname = 'public'
      `);
      assert.equal(ownership.rows[0]?.current_role_name, ownership.rows[0]?.database_owner);
      assert.equal(ownership.rows[0]?.schema_owner, "pg_database_owner");
      assert.deepEqual(
        (
          await runPostgresMigrations(client, [
            { version: 1, name: "public_database_owner", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
          ])
        ).appliedVersions,
        [1],
      );
      const state = await adminPool.query<{ ledger: string | null; effect: string | null }>(
        "SELECT to_regclass($1)::text AS ledger, to_regclass($2)::text AS effect",
        [`public.${ledgerTable}`, `public.${effectTable}`],
      );
      assert.deepEqual(state.rows[0], {
        ledger: ledgerTable,
        effect: effectTable,
      });
    } finally {
      await client.close();
      await adminPool.query(`DROP TABLE IF EXISTS public.${effectTable}`);
      await adminPool.query(`DROP TABLE IF EXISTS public.${ledgerTable}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres resolves quoted effective-role ownership without regrole text casts",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const roleName = `Gc Owner ${suffix}`;
    const quotedRoleName = quotePostgresIdentifier(roleName);
    const schemaName = `coverage_quoted_owner_${suffix}`;
    const ledgerTable = `quoted_owner_migrations_${suffix}`;
    const effectTable = `quoted_owner_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool, migrationsTable: ledgerTable },
    );

    try {
      await adminPool.query(`CREATE ROLE ${quotedRoleName} NOLOGIN`);
      await adminPool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION ${quotedRoleName}`);
      const session = await pool.connect();
      await session.query(`SET ROLE ${quotedRoleName}`);
      session.release();
      assert.deepEqual(
        (
          await runPostgresMigrations(client, [
            { version: 1, name: "quoted_role_owner", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
          ])
        ).appliedVersions,
        [1],
      );
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS ${quotedRoleName}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects a split schema-owner and migration-role topology",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerRole = `split_owner_${suffix}`;
    const migrationRole = `split_migrator_${suffix}`;
    const schemaName = `coverage_split_owner_${suffix}`;
    const ledgerTable = `split_owner_migrations_${suffix}`;
    const effectTable = `split_owner_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const databaseName = (
      await adminPool.query<{ database_name: string }>("SELECT pg_catalog.current_database() AS database_name")
    ).rows[0]!.database_name;
    const quotedDatabaseName = quotePostgresIdentifier(databaseName);
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: databaseName },
      { pool, migrationsTable: ledgerTable },
    );

    try {
      await adminPool.query(`CREATE ROLE ${ownerRole} NOLOGIN`);
      await adminPool.query(`CREATE ROLE ${migrationRole} NOLOGIN`);
      await adminPool.query(`GRANT CREATE ON DATABASE ${quotedDatabaseName} TO ${ownerRole}`);
      await adminPool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION ${ownerRole}`);
      await adminPool.query(`GRANT USAGE, CREATE ON SCHEMA ${schemaName} TO ${migrationRole}`);
      await adminPool.query(`
        CREATE TABLE ${schemaName}.${ledgerTable} (
          version pg_catalog.int4 PRIMARY KEY,
          name pg_catalog.text NOT NULL,
          applied_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now()
        );
        ALTER TABLE ${schemaName}.${ledgerTable} OWNER TO ${migrationRole};
      `);
      const session = await pool.connect();
      await session.query(`SET ROLE ${migrationRole}`);
      session.release();

      await assert.rejects(
        runPostgresMigrations(client, [
          { version: 1, name: "split_owner_probe", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
        ]),
        /migration role must own schema/,
      );
      const state = await adminPool.query<{ ledger_rows: number; effect: string | null }>(
        `SELECT (SELECT COUNT(*)::int FROM ${schemaName}.${ledgerTable}) AS ledger_rows,
                to_regclass($1)::text AS effect`,
        [`${schemaName}.${effectTable}`],
      );
      assert.deepEqual(state.rows[0], { ledger_rows: 0, effect: null });
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`REVOKE CREATE ON DATABASE ${quotedDatabaseName} FROM ${ownerRole}`).catch(() => undefined);
      await adminPool.query(`DROP ROLE IF EXISTS ${migrationRole}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${ownerRole}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects shared CREATE authority and pre-existing foreign-owned relations",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const migrationRole = `exclusive_migrator_${suffix}`;
    const creatorRole = `external_creator_${suffix}`;
    const schemaName = `coverage_exclusive_create_${suffix}`;
    const ledgerTable = `exclusive_migrations_${suffix}`;
    const effectTable = `exclusive_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool, migrationsTable: ledgerTable },
    );
    const migration: PostgresMigration = {
      version: 1,
      name: "exclusive_create_probe",
      sql: `CREATE TABLE IF NOT EXISTS ${effectTable} (expected_shape INTEGER)`,
    };
    const setMigrationRole = async (): Promise<void> => {
      const session = await pool.connect();
      await session.query(`SET ROLE ${migrationRole}`);
      session.release();
    };

    try {
      await adminPool.query(`CREATE ROLE ${migrationRole} NOLOGIN`);
      await adminPool.query(`CREATE ROLE ${creatorRole} NOLOGIN`);
      await adminPool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION ${migrationRole}`);
      await adminPool.query(`GRANT USAGE, CREATE ON SCHEMA ${schemaName} TO ${creatorRole}`);
      const creatorSession = await adminPool.connect();
      try {
        await creatorSession.query("BEGIN");
        await creatorSession.query(`SET LOCAL ROLE ${creatorRole}`);
        await creatorSession.query(`CREATE TABLE ${schemaName}.${effectTable} (wrong_shape TEXT)`);
        await creatorSession.query("COMMIT");
      } finally {
        creatorSession.release();
      }

      await setMigrationRole();
      await assert.rejects(runPostgresMigrations(client, [migration]), /grants CREATE to another role or PUBLIC/);

      await adminPool.query(`REVOKE CREATE ON SCHEMA ${schemaName} FROM ${creatorRole}`);
      await setMigrationRole();
      await assert.rejects(runPostgresMigrations(client, [migration]), /contains relation .* owned by another role/);

      await adminPool.query(`DROP TABLE ${schemaName}.${effectTable}`);
      await setMigrationRole();
      assert.deepEqual((await runPostgresMigrations(client, [migration])).appliedVersions, [1]);
      const columns = await adminPool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schemaName, effectTable],
      );
      assert.deepEqual(columns.rows, [{ column_name: "expected_shape", data_type: "integer" }]);
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS ${creatorRole}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${migrationRole}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres waits out pre-existing DDL before trusting exclusive schema authority",
  {
    skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane",
    timeout: 15_000,
  },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const migrationRole = `barrier_migrator_${suffix}`;
    const creatorRole = `barrier_creator_${suffix}`;
    const migrationPassword = `Migration_${suffix}_p9!`;
    const creatorPassword = `Creator_${suffix}_p9!`;
    const schemaName = `coverage_ddl_barrier_${suffix}`;
    const ledgerTable = `barrier_migrations_${suffix}`;
    const foreignEffectTable = `barrier_foreign_effect_${suffix}`;
    const migrationEffectTable = `barrier_migration_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const migrationUrl = new URL(connectionString);
    migrationUrl.username = migrationRole;
    migrationUrl.password = migrationPassword;
    migrationUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const creatorUrl = new URL(connectionString);
    creatorUrl.username = creatorRole;
    creatorUrl.password = creatorPassword;
    const migrationPool = new Pool({ connectionString: migrationUrl.toString(), max: 1 });
    const creatorPool = new Pool({ connectionString: creatorUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: migrationUrl.toString(), database: "goatcitadel_test" },
      { pool: migrationPool, migrationsTable: ledgerTable },
    );
    let creatorSession: PoolClient | undefined;
    let releaseBarrierClassification: (() => void) | undefined;

    try {
      await adminPool.query(
        `CREATE ROLE ${migrationRole} LOGIN PASSWORD '${escapePostgresLiteral(migrationPassword)}'`,
      );
      await adminPool.query(`CREATE ROLE ${creatorRole} LOGIN PASSWORD '${escapePostgresLiteral(creatorPassword)}'`);
      await adminPool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION ${migrationRole}`);
      await adminPool.query(`GRANT USAGE, CREATE ON SCHEMA ${schemaName} TO ${creatorRole}`);
      creatorSession = await creatorPool.connect();
      await creatorSession.query("BEGIN");
      await creatorSession.query(`CREATE TABLE ${schemaName}.${foreignEffectTable} (wrong_shape TEXT)`);
      const creatorTransaction = await creatorSession.query<{ active_xid: string }>(
        "SELECT pg_catalog.pg_current_xact_id()::pg_catalog.text AS active_xid",
      );
      const creatorTransactionId = creatorTransaction.rows[0]?.active_xid;
      assert.match(creatorTransactionId ?? "", /^\d+$/);
      await adminPool.query(`REVOKE CREATE ON SCHEMA ${schemaName} FROM ${creatorRole}`);

      let barrierClassificationResolve: (() => void) | undefined;
      const barrierClassification = new Promise<void>((resolve) => {
        barrierClassificationResolve = resolve;
      });
      const barrierClassificationRelease = new Promise<void>((resolve) => {
        releaseBarrierClassification = resolve;
      });
      const originalBarrier = client.awaitMigrationSchemaQuiescence.bind(client);
      client.awaitMigrationSchemaQuiescence = async (pinnedClient) => {
        const observedClient = new Proxy(pinnedClient, {
          get(target, property) {
            if (property !== "query") {
              return Reflect.get(target, property, target);
            }
            return async (sql: string, params?: unknown[]) => {
              const result = await target.query(sql, params);
              const classification = result.rows[0] as
                | {
                    transaction_status?: unknown;
                    observed_database_count?: unknown;
                    current_database_observed?: unknown;
                  }
                | undefined;
              if (
                sql.includes("observed_database_count") &&
                params?.[0] === creatorTransactionId &&
                classification?.transaction_status === "in progress" &&
                classification.observed_database_count === "1" &&
                classification.current_database_observed === true
              ) {
                barrierClassificationResolve?.();
                barrierClassificationResolve = undefined;
                await barrierClassificationRelease;
              }
              return result;
            };
          },
        }) as PoolClient;
        return originalBarrier(observedClient);
      };
      const migrationPromise = runPostgresMigrations(client, [
        {
          version: 1,
          name: "preexisting_ddl_barrier",
          sql: `CREATE TABLE ${migrationEffectTable} (expected_shape INTEGER)`,
        },
      ]);
      await waitForProofSignal(barrierClassification, migrationPromise, "current-database migration barrier");
      await creatorSession.query("COMMIT");
      releaseBarrierClassification?.();
      releaseBarrierClassification = undefined;

      await assert.rejects(migrationPromise, /gained relation .* owned by another role after preflight/);
      const state = await adminPool.query<{
        ledger: string | null;
        migration_effect: string | null;
        column_name: string;
        data_type: string;
      }>(
        `SELECT to_regclass($1)::text AS ledger, to_regclass($2)::text AS migration_effect, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $3 AND table_name = $4
         ORDER BY ordinal_position`,
        [`${schemaName}.${ledgerTable}`, `${schemaName}.${migrationEffectTable}`, schemaName, foreignEffectTable],
      );
      assert.deepEqual(state.rows, [
        { ledger: null, migration_effect: null, column_name: "wrong_shape", data_type: "text" },
      ]);
    } finally {
      releaseBarrierClassification?.();
      await creatorSession?.query("ROLLBACK").catch(() => undefined);
      creatorSession?.release();
      await Promise.allSettled([client.close(), creatorPool.end()]);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS ${creatorRole}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${migrationRole}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres migration quiescence ignores transactions in another database",
  {
    skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane",
    timeout: 15_000,
  },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const migrationRole = `barrier_db_migrator_${suffix}`;
    const otherRole = `barrier_db_other_${suffix}`;
    const migrationPassword = `Migration_${suffix}_p9!`;
    const otherPassword = `Other_${suffix}_p9!`;
    const schemaName = `coverage_db_barrier_${suffix}`;
    const ledgerTable = `db_barrier_migrations_${suffix}`;
    const effectTable = `db_barrier_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const migrationUrl = new URL(connectionString);
    migrationUrl.username = migrationRole;
    migrationUrl.password = migrationPassword;
    migrationUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const targetDatabase = decodeURIComponent(migrationUrl.pathname.replace(/^\//, ""));
    const otherDatabase = targetDatabase === "postgres" ? "template1" : "postgres";
    const otherUrl = new URL(connectionString);
    otherUrl.username = otherRole;
    otherUrl.password = otherPassword;
    otherUrl.pathname = `/${otherDatabase}`;
    otherUrl.searchParams.delete("options");
    const migrationPool = new Pool({ connectionString: migrationUrl.toString(), max: 1 });
    const otherPool = new Pool({ connectionString: otherUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: migrationUrl.toString(), database: targetDatabase },
      { pool: migrationPool, migrationsTable: ledgerTable },
    );
    let otherSession: PoolClient | undefined;

    try {
      await adminPool.query(
        `CREATE ROLE ${migrationRole} LOGIN PASSWORD '${escapePostgresLiteral(migrationPassword)}'`,
      );
      await adminPool.query(`CREATE ROLE ${otherRole} LOGIN PASSWORD '${escapePostgresLiteral(otherPassword)}'`);
      await adminPool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION ${migrationRole}`);
      otherSession = await otherPool.connect();
      await otherSession.query("BEGIN");
      const otherTransaction = await otherSession.query<{ active_xid: string }>(
        "SELECT pg_catalog.pg_current_xact_id()::pg_catalog.text AS active_xid",
      );
      const otherTransactionId = otherTransaction.rows[0]?.active_xid;
      assert.match(otherTransactionId ?? "", /^\d+$/);

      let snapshotCapturedOtherTransaction = false;
      let otherDatabaseClassificationResolve: (() => void) | undefined;
      const otherDatabaseClassification = new Promise<void>((resolve) => {
        otherDatabaseClassificationResolve = resolve;
      });
      const originalBarrier = client.awaitMigrationSchemaQuiescence.bind(client);
      client.awaitMigrationSchemaQuiescence = async (pinnedClient) => {
        const observedClient = new Proxy(pinnedClient, {
          get(target, property) {
            if (property !== "query") {
              return Reflect.get(target, property, target);
            }
            return async (sql: string, params?: unknown[]) => {
              const result = await target.query(sql, params);
              if (sql.includes("pg_catalog.pg_snapshot_xip")) {
                snapshotCapturedOtherTransaction = result.rows.some((row) => {
                  const activeXid = (row as { active_xid?: unknown }).active_xid;
                  return activeXid === otherTransactionId;
                });
              }
              const classifiedTransactionId = params?.[0];
              if (sql.includes("observed_database_count") && classifiedTransactionId === otherTransactionId) {
                assert.equal(snapshotCapturedOtherTransaction, true);
                assert.deepEqual(result.rows[0], {
                  transaction_status: "in progress",
                  observed_database_count: "1",
                  current_database_observed: false,
                });
                otherDatabaseClassificationResolve?.();
                otherDatabaseClassificationResolve = undefined;
              }
              return result;
            };
          },
        }) as PoolClient;
        return originalBarrier(observedClient);
      };

      const migrationPromise = runPostgresMigrations(client, [
        {
          version: 1,
          name: "current_database_only_barrier",
          sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)`,
        },
      ]);
      await waitForProofSignal(
        otherDatabaseClassification,
        migrationPromise,
        "cross-database migration classification",
      );
      assert.deepEqual((await migrationPromise).appliedVersions, [1]);
      const effect = await adminPool.query<{ effect: string | null }>("SELECT to_regclass($1)::text AS effect", [
        `${schemaName}.${effectTable}`,
      ]);
      assert.equal(effect.rows[0]?.effect, `${schemaName}.${effectTable}`);
    } finally {
      await otherSession?.query("ROLLBACK").catch(() => undefined);
      otherSession?.release();
      await Promise.allSettled([client.close(), otherPool.end()]);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS ${otherRole}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${migrationRole}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres migration guards support a least-privilege schema owner",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const roleName = `migration_owner_${suffix}`;
    const rolePassword = `Migration_${suffix}_p9!`;
    const schemaName = `coverage_migration_owner_${suffix}`;
    const asyncLedger = `owner_async_migrations_${suffix}`;
    const syncLedger = `owner_sync_migrations_${suffix}`;
    const asyncEffect = `owner_async_effect_${suffix}`;
    const syncEffect = `owner_sync_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.username = roleName;
    scopedUrl.password = rolePassword;
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const asyncPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const asyncClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: asyncPool, migrationsTable: asyncLedger },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${escapePostgresLiteral(rolePassword)}'`);
      await adminPool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION ${roleName}`);

      const asyncMigrations: PostgresMigration[] = [
        { version: 1, name: "least_privilege_async", sql: `CREATE TABLE ${asyncEffect} (effect_id INTEGER)` },
      ];
      assert.deepEqual((await runPostgresMigrations(asyncClient, asyncMigrations)).appliedVersions, [1]);
      const originalConfigure = asyncClient.configureMigrationTransaction.bind(asyncClient);
      let configureCalls = 0;
      let concurrentDropCode: string | undefined;
      asyncClient.configureMigrationTransaction = async (pinnedClient, migrationSchema, historyRepairBridge) => {
        await originalConfigure(pinnedClient, migrationSchema, historyRepairBridge);
        configureCalls += 1;
        if (configureCalls === 2) {
          const dropSession = await adminPool.connect();
          try {
            await dropSession.query("BEGIN");
            await dropSession.query("SET LOCAL lock_timeout = '300ms'");
            try {
              await dropSession.query(`DROP SCHEMA ${schemaName} CASCADE`);
              concurrentDropCode = "dropped";
            } catch (error) {
              concurrentDropCode =
                error && typeof error === "object" && "code" in error ? String(error.code) : String(error);
            }
            await dropSession.query("ROLLBACK");
          } finally {
            dropSession.release();
          }
        }
      };
      assert.deepEqual(
        (
          await runPostgresMigrations(asyncClient, [
            ...asyncMigrations,
            { version: 2, name: "least_privilege_drop_guard", sql: "SELECT 1" },
          ])
        ).appliedVersions,
        [2],
      );
      asyncClient.configureMigrationTransaction = originalConfigure;
      assert.equal(concurrentDropCode, "55P03");
      assert.equal((await asyncClient.healthCheck()).reachable, true);

      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-least-privilege-migration-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      applyPostgresMigrationsSync(syncClient, {
        migrationsTable: syncLedger,
        migrations: [
          { version: 1, name: "least_privilege_sync", sql: `CREATE TABLE ${syncEffect} (effect_id INTEGER)` },
        ],
      });

      const relations = await adminPool.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = ANY($2::text[])
         ORDER BY table_name`,
        [schemaName, [asyncLedger, asyncEffect, syncLedger, syncEffect]],
      );
      assert.deepEqual(
        relations.rows.map((row) => row.table_name),
        [asyncLedger, asyncEffect, syncLedger, syncEffect].sort(),
      );
    } finally {
      syncClient?.close();
      await asyncClient.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.query(`DROP ROLE IF EXISTS ${roleName}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects system schemas as migration owners",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const ledgerTable = `system_schema_migrations_${suffix}`;
    const effectTable = `system_schema_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const systemUrl = new URL(connectionString);
    systemUrl.searchParams.set("options", "-csearch_path=information_schema");
    const client = new PostgresDatabaseClient(
      { connectionString: systemUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: systemUrl.toString(), max: 1 }), migrationsTable: ledgerTable },
    );

    try {
      await assert.rejects(
        runPostgresMigrations(client, [
          { version: 1, name: "system_schema_probe", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
        ]),
        /system schema "information_schema" cannot own GoatCitadel migration state/,
      );
      const state = await adminPool.query<{ ledger: string | null; effect: string | null }>(
        `SELECT to_regclass($1)::text AS ledger, to_regclass($2)::text AS effect`,
        [`information_schema.${ledgerTable}`, `information_schema.${effectTable}`],
      );
      assert.deepEqual(state.rows[0], { ledger: null, effect: null });
    } finally {
      await client.close();
      await adminPool.query(`DROP TABLE IF EXISTS information_schema.${ledgerTable}`);
      await adminPool.query(`DROP TABLE IF EXISTS information_schema.${effectTable}`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects duplicate async migration ledger rows before payload execution",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_duplicate_migration_ledger_${suffix}`;
    const ledgerTable = `duplicate_migrations_${suffix}`;
    const effectTable = `duplicate_migration_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      {
        pool: new Pool({ connectionString: scopedUrl.toString(), max: 1 }),
        migrationsTable: ledgerTable,
      },
    );

    try {
      await adminPool.query(`
        CREATE SCHEMA ${schemaName};
        CREATE TABLE ${schemaName}.${ledgerTable} (
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO ${schemaName}.${ledgerTable} (version, name)
        VALUES (1, 'duplicate_probe'), (1, 'duplicate_probe');
      `);
      await assert.rejects(
        runPostgresMigrations(client, [
          { version: 1, name: "duplicate_probe", sql: `CREATE TABLE ${effectTable} (effect_id INTEGER)` },
        ]),
        /migration ledger contains duplicate version 1/,
      );
      const state = await adminPool.query<{ ledger_count: string; effect: string | null }>(
        `SELECT (SELECT COUNT(*)::text FROM ${schemaName}.${ledgerTable}) AS ledger_count,
                to_regclass($1)::text AS effect`,
        [`${schemaName}.${effectTable}`],
      );
      assert.deepEqual(state.rows[0], { ledger_count: "2", effect: null });
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres health checks reject ephemeral migration state and retire the session",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_ephemeral_health_${suffix}`;
    const ledgerTable = `ephemeral_health_migrations_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=pg_temp,${schemaName}`);
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool, migrationsTable: ledgerTable },
    );

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      const session = await pool.connect();
      await session.query("CREATE TEMPORARY TABLE health_temp_probe (sentinel TEXT)");
      await session.query("DROP TABLE health_temp_probe");
      const contaminatedPid = (await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      session.release();

      const result = await client.healthCheck();
      assert.equal(result.reachable, false);
      assert.match(result.issues[0] ?? "", /temporary current schema cannot own the migrations table/);
      assert.notEqual((await client.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid"))?.pid, contaminatedPid);
      assert.equal(
        (
          await adminPool.query<{ relation: string | null }>("SELECT to_regclass($1)::text AS relation", [
            `${schemaName}.${ledgerTable}`,
          ])
        ).rows[0]?.relation,
        null,
      );
    } finally {
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres migration locks ignore search-path function shadowing",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_lock_shadow_${suffix}`;
    const quotedSchema = quotePostgresIdentifier(schemaName);
    const asyncLedger = `async_lock_migrations_${suffix}`;
    const syncLedger = `sync_lock_migrations_${suffix}`;
    const asyncEffect = `async_lock_effect_${suffix}`;
    const syncEffect = `sync_lock_effect_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName},pg_catalog,public`);
    const asyncClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: scopedUrl.toString(), max: 1 }), migrationsTable: asyncLedger },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`
        CREATE SCHEMA ${quotedSchema};
        CREATE TABLE ${quotedSchema}.hook_log (kind TEXT NOT NULL);

        CREATE DOMAIN ${quotedSchema}.text AS pg_catalog.text;
        CREATE DOMAIN ${quotedSchema}.integer AS pg_catalog.int4;
        CREATE DOMAIN ${quotedSchema}.timestamptz AS pg_catalog.timestamptz;

        CREATE FUNCTION ${quotedSchema}.now() RETURNS pg_catalog.timestamptz AS $$
        BEGIN
          INSERT INTO ${quotedSchema}.hook_log(kind) VALUES ('fake_now');
          RETURN '2000-01-01T00:00:00Z'::pg_catalog.timestamptz;
        END;
        $$ LANGUAGE plpgsql VOLATILE;

        CREATE FUNCTION ${quotedSchema}.pg_advisory_lock(BIGINT) RETURNS VOID AS $$
        BEGIN
          INSERT INTO ${quotedSchema}.hook_log(kind) VALUES ('fake_lock');
        END;
        $$ LANGUAGE plpgsql;

        CREATE FUNCTION ${quotedSchema}.pg_try_advisory_lock(BIGINT) RETURNS BOOLEAN AS $$
        BEGIN
          INSERT INTO ${quotedSchema}.hook_log(kind) VALUES ('fake_try_lock');
          RETURN TRUE;
        END;
        $$ LANGUAGE plpgsql;

        CREATE FUNCTION ${quotedSchema}.pg_advisory_unlock(BIGINT) RETURNS BOOLEAN AS $$
        BEGIN
          INSERT INTO ${quotedSchema}.hook_log(kind) VALUES ('fake_unlock');
          RETURN TRUE;
        END;
        $$ LANGUAGE plpgsql;

        CREATE FUNCTION ${quotedSchema}.fake_text_concat(
          left_value pg_catalog.text,
          right_value pg_catalog.text
        ) RETURNS pg_catalog.text AS $$
        BEGIN
          INSERT INTO ${quotedSchema}.hook_log(kind) VALUES ('fake_concat');
          RETURN pg_catalog.concat(left_value, right_value);
        END;
        $$ LANGUAGE plpgsql VOLATILE;

        CREATE OPERATOR ${quotedSchema}.|| (
          LEFTARG = pg_catalog.text,
          RIGHTARG = pg_catalog.text,
          FUNCTION = ${quotedSchema}.fake_text_concat
        );
      `);

      assert.deepEqual(
        (
          await runPostgresMigrations(asyncClient, [
            {
              version: 1,
              name: "async_lock_shadow_probe",
              sql:
                `CREATE TABLE ${asyncEffect} (` +
                "effect_id INTEGER PRIMARY KEY, payload TEXT NOT NULL DEFAULT 'ok', " +
                "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
            },
          ])
        ).appliedVersions,
        [1],
      );

      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-lock-shadow-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      applyPostgresMigrationsSync(syncClient, {
        migrationsTable: syncLedger,
        migrations: [
          {
            version: 1,
            name: "sync_lock_shadow_probe",
            sql:
              `CREATE TABLE ${syncEffect} (` +
              "effect_id INTEGER PRIMARY KEY, payload TEXT NOT NULL DEFAULT 'ok', " +
              "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
          },
        ],
      });

      const hooks = await adminPool.query<{ kind: string }>(`SELECT kind FROM ${quotedSchema}.hook_log`);
      assert.deepEqual(hooks.rows, []);
      const columnTypes = await adminPool.query<{
        table_name: string;
        column_name: string;
        type_schema: string;
      }>(
        `
          SELECT relation.relname AS table_name,
                 attribute.attname AS column_name,
                 type_namespace.nspname AS type_schema
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
          JOIN pg_catalog.pg_type AS column_type
            ON column_type.oid = attribute.atttypid
          JOIN pg_catalog.pg_namespace AS type_namespace
            ON type_namespace.oid = column_type.typnamespace
          WHERE relation_namespace.nspname = $1
            AND relation.relname = ANY($2::pg_catalog.text[])
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
          ORDER BY relation.relname, attribute.attnum
        `,
        [schemaName, [asyncLedger, syncLedger, asyncEffect, syncEffect]],
      );
      assert.equal(columnTypes.rows.length, 12);
      assert.deepEqual(new Set(columnTypes.rows.map((row) => row.type_schema)), new Set(["pg_catalog"]));
    } finally {
      syncClient?.close();
      await asyncClient.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects malformed legacy compound catalogs before ledger reconciliation",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_v124_catalog_${suffix}`;
    const quotedSchema = quotePostgresIdentifier(schemaName);
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const legacyCompound = POSTGRES_MIGRATIONS.find((migration) => migration.version === 129);
    assert.equal(legacyCompound?.name, "compound_engineering_foundation");
    let session: PoolClient | undefined;

    const readCatalog = async (): Promise<{ matches_expected: boolean }> => {
      assert.ok(session);
      const result = await session.query<{ matches_expected: boolean }>(POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL);
      const row = result.rows[0];
      assert.ok(row);
      return row;
    };

    const assertCatalogMutationRejected = async (sql: string): Promise<void> => {
      assert.ok(session);
      await session.query("BEGIN");
      try {
        await session.query(sql);
        const row = await readCatalog();
        assert.equal(row.matches_expected, false);
        assert.throws(() => assertLegacyCompoundV124Catalog(row), /catalog does not match/);
      } finally {
        await session.query("ROLLBACK");
      }
    };

    try {
      await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
      session = await scopedPool.connect();
      await session.query(`
        CREATE TABLE prompt_pack_benchmark_runs (probe_id TEXT PRIMARY KEY);
        CREATE TABLE replay_regression_runs (probe_id TEXT PRIMARY KEY);
        CREATE TABLE chat_delegation_steps (probe_id TEXT PRIMARY KEY);
      `);
      await session.query(legacyCompound!.sql);

      const exactCatalog = await readCatalog();
      assert.equal(exactCatalog.matches_expected, true);
      assert.doesNotThrow(() => assertLegacyCompoundV124Catalog(exactCatalog));

      await assertCatalogMutationRejected(
        "ALTER TABLE prompt_retune_campaigns ALTER COLUMN repeat_count TYPE TEXT USING repeat_count::text",
      );
      await assertCatalogMutationRejected("ALTER TABLE prompt_retune_campaigns ALTER COLUMN status DROP NOT NULL");
      await assertCatalogMutationRejected(
        "ALTER TABLE structured_review_runs ALTER COLUMN preflight_json DROP DEFAULT",
      );
    } finally {
      session?.release();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres repairs only the exact pre-v47 ledger aliases before requiring canonical history",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_v47_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    const repairSlice = POSTGRES_MIGRATIONS.filter((migration) => migration.version >= 32 && migration.version <= 47);
    let syncClient: PostgresSyncDatabaseClient | undefined;

    const seedLegacyLedger = async (): Promise<void> => {
      await scopedPool.query("DROP TABLE IF EXISTS schema_migrations");
      await scopedPool.query(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      for (const migration of repairSlice.filter((candidate) => candidate.version < 47)) {
        await scopedPool.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          migration.version,
          migration.version === 32
            ? "cron_jobs_workdir_and_context_from"
            : migration.version === 33
              ? "cron_jobs_last_run_output_and_run_id"
              : migration.name,
        ]);
      }
    };

    const assertCanonicalRepair = async (): Promise<void> => {
      const rows = await scopedPool.query<{ version: number; name: string }>(
        "SELECT version, name FROM schema_migrations WHERE version IN (32, 33, 47) ORDER BY version",
      );
      assert.deepEqual(rows.rows, [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);
    };

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await seedLegacyLedger();

      const asyncResult = await runPostgresMigrations(client, repairSlice);
      assert.deepEqual(asyncResult.appliedVersions, [47]);
      await assertCanonicalRepair();
      await scopedPool.query(
        "UPDATE schema_migrations SET name = 'cron_jobs_workdir_and_context_from' WHERE version = 32",
      );
      await assert.rejects(runPostgresMigrations(client, repairSlice), /migration ledger mismatch at version 32/);

      await seedLegacyLedger();
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-v47-ledger-repair-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      applyPostgresMigrationsSync(syncClient, { migrations: repairSlice });
      await assertCanonicalRepair();
      syncClient
        .prepare("UPDATE schema_migrations SET name = 'cron_jobs_workdir_and_context_from' WHERE version = 32")
        .run();
      assert.throws(
        () => applyPostgresMigrationsSync(syncClient as PostgresSyncDatabaseClient, { migrations: repairSlice }),
        /migration ledger mismatch at version 32/,
      );
    } finally {
      syncClient?.close();
      await client.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres bridges frozen v47 to configured ledgers without touching permanent default history",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_v47_custom_${suffix}`;
    const shadowLedger = `shadow_migrations_${suffix}`;
    const ephemeralAsyncLedger = `ephemeral_async_migrations_${suffix}`;
    const ephemeralSyncLedger = `ephemeral_sync_migrations_${suffix}`;
    const guardLedger = `guard_migrations_${suffix}`;
    const lateAsyncLedger = `late_async_migrations_${suffix}`;
    const lateSyncLedger = `late_sync_migrations_${suffix}`;
    const asyncLedger = `async_migrations_${suffix}`;
    const syncLedger = `sync_migrations_${suffix}`;
    const rollbackLedger = `rollback_migrations_${suffix}`;
    const noopAsyncLedger = `noop_async_migrations_${suffix}`;
    const noopSyncLedger = `noop_sync_migrations_${suffix}`;
    const suppressRepairFunction = `suppress_history_repair_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const migrationsThroughRepair = POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 47);
    let guardClient: PostgresDatabaseClient | undefined;
    let shadowClient: PostgresDatabaseClient | undefined;
    let ephemeralAsyncClient: PostgresDatabaseClient | undefined;
    let ephemeralSyncClient: PostgresSyncDatabaseClient | undefined;
    let lateAsyncClient: PostgresDatabaseClient | undefined;
    let lateSyncClient: PostgresSyncDatabaseClient | undefined;
    let asyncClient: PostgresDatabaseClient | undefined;
    let rollbackClient: PostgresDatabaseClient | undefined;
    let noopAsyncClient: PostgresDatabaseClient | undefined;
    let syncClient: PostgresSyncDatabaseClient | undefined;

    const createLedger = async (tableName: string, legacyAliases: boolean, rejectRepair = false): Promise<void> => {
      await scopedPool.query(`
        CREATE TABLE ${tableName} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          ${
            rejectRepair
              ? ", CONSTRAINT reject_canonical_history CHECK (name NOT IN ('state_validation_quarantine', 'cron_jobs_workdir_context_from_run_output_run_id'))"
              : ""
          }
        )
      `);
      for (const migration of migrationsThroughRepair.filter((candidate) => candidate.version < 47)) {
        await scopedPool.query(`INSERT INTO ${tableName} (version, name) VALUES ($1, $2)`, [
          migration.version,
          legacyAliases && migration.version === 32
            ? "cron_jobs_workdir_and_context_from"
            : legacyAliases && migration.version === 33
              ? "cron_jobs_last_run_output_and_run_id"
              : migration.name,
        ]);
      }
    };

    const readRepairRows = async (tableName: string): Promise<Array<{ version: number; name: string }>> =>
      (
        await scopedPool.query<{ version: number; name: string }>(
          `SELECT version, name FROM ${tableName} WHERE version IN (32, 33, 47) ORDER BY version`,
        )
      ).rows;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await scopedPool.query(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await scopedPool.query(
        `INSERT INTO schema_migrations (version, name) VALUES
          (32, 'cron_jobs_workdir_and_context_from'),
          (33, 'cron_jobs_last_run_output_and_run_id')`,
      );

      await createLedger(shadowLedger, false);
      const shadowPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
      const shadowSession = await shadowPool.connect();
      const shadowBackendPid = (await shadowSession.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      await shadowSession.query(`
        CREATE TEMPORARY TABLE ${shadowLedger} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      shadowSession.release();
      shadowClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
        { pool: shadowPool, migrationsTable: shadowLedger },
      );
      await assert.rejects(
        runPostgresMigrations(shadowClient, migrationsThroughRepair),
        /temporary relation .* shadows the configured migrations table/,
      );
      assert.equal(
        (await readRepairRows(shadowLedger)).some((row) => row.version === 47),
        false,
      );
      const shadowReplacement = await shadowClient.queryOne<{ pid: number; relation: string | null }>(
        `SELECT pg_backend_pid() AS pid, to_regclass('pg_temp.${shadowLedger}')::text AS relation`,
      );
      assert.notEqual(shadowReplacement?.pid, shadowBackendPid);
      assert.equal(shadowReplacement?.relation, null);
      await shadowClient.close();
      shadowClient = undefined;

      const tempCurrentUrl = new URL(scopedUrl.toString());
      tempCurrentUrl.searchParams.set("options", `-csearch_path=pg_temp,${schemaName}`);
      await createLedger(ephemeralAsyncLedger, false);
      const ephemeralAsyncPool = new Pool({ connectionString: tempCurrentUrl.toString(), max: 1 });
      const ephemeralAsyncSession = await ephemeralAsyncPool.connect();
      const ephemeralAsyncBackendPid = (
        await ephemeralAsyncSession.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      ephemeralAsyncSession.release();
      ephemeralAsyncClient = new PostgresDatabaseClient(
        { connectionString: tempCurrentUrl.toString(), database: "goatcitadel_test" },
        { pool: ephemeralAsyncPool, migrationsTable: ephemeralAsyncLedger },
      );
      await assert.rejects(
        runPostgresMigrations(ephemeralAsyncClient, migrationsThroughRepair),
        /temporary current schema cannot own the migrations table/,
      );
      assert.equal(
        (await readRepairRows(ephemeralAsyncLedger)).some((row) => row.version === 47),
        false,
      );
      const ephemeralAsyncReplacement = await ephemeralAsyncClient.queryOne<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      assert.notEqual(ephemeralAsyncReplacement?.pid, ephemeralAsyncBackendPid);
      await ephemeralAsyncClient.close();
      ephemeralAsyncClient = undefined;

      await createLedger(ephemeralSyncLedger, false);
      ephemeralSyncClient = new PostgresSyncDatabaseClient({
        connectionString: tempCurrentUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-temp-current-schema-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      const ephemeralSyncBackendPid = ephemeralSyncClient
        .prepare("SELECT pg_backend_pid() AS pid")
        .get<{ pid: number }>()?.pid;
      assert.throws(
        () =>
          applyPostgresMigrationsSync(ephemeralSyncClient as PostgresSyncDatabaseClient, {
            migrationsTable: ephemeralSyncLedger,
            migrations: migrationsThroughRepair,
          }),
        /temporary current schema cannot own the migrations table/,
      );
      assert.equal(
        (await readRepairRows(ephemeralSyncLedger)).some((row) => row.version === 47),
        false,
      );
      const ephemeralSyncReplacement = ephemeralSyncClient
        .prepare("SELECT pg_backend_pid() AS pid")
        .get<{ pid: number }>();
      assert.notEqual(ephemeralSyncReplacement?.pid, ephemeralSyncBackendPid);
      ephemeralSyncClient.close();
      ephemeralSyncClient = undefined;

      await createLedger(guardLedger, false);
      const guardPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
      const guardSession = await guardPool.connect();
      const guardBackendPid = (await guardSession.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      await guardSession.query("CREATE TEMPORARY TABLE schema_migrations (sentinel TEXT)");
      guardSession.release();
      guardClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
        { pool: guardPool, migrationsTable: guardLedger },
      );
      await assert.rejects(
        runPostgresMigrations(guardClient, migrationsThroughRepair),
        /temporary relation .* contaminates the pinned migration session/,
      );
      assert.equal(
        (await readRepairRows(guardLedger)).some((row) => row.version === 47),
        false,
      );
      assert.equal(
        (
          await scopedPool.query<{ relation: string | null }>(
            "SELECT to_regclass('state_validation_quarantine')::text AS relation",
          )
        ).rows[0]?.relation,
        null,
      );
      const guardReplacement = await guardClient.queryOne<{ pid: number; relation: string | null }>(
        "SELECT pg_backend_pid() AS pid, to_regclass('pg_temp.schema_migrations')::text AS relation",
      );
      assert.notEqual(guardReplacement?.pid, guardBackendPid);
      assert.equal(guardReplacement?.relation, null);
      await guardClient.close();
      guardClient = undefined;

      const lateTempUrl = new URL(scopedUrl.toString());
      lateTempUrl.searchParams.set("options", `-csearch_path=${schemaName},pg_temp`);
      await createLedger(lateAsyncLedger, false);
      lateAsyncClient = new PostgresDatabaseClient(
        { connectionString: lateTempUrl.toString(), database: "goatcitadel_test" },
        {
          pool: new Pool({ connectionString: lateTempUrl.toString(), max: 1 }),
          migrationsTable: lateAsyncLedger,
        },
      );
      assert.deepEqual((await runPostgresMigrations(lateAsyncClient, migrationsThroughRepair)).appliedVersions, [47]);
      assert.deepEqual(await readRepairRows(lateAsyncLedger), [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);

      await createLedger(lateSyncLedger, false);
      lateSyncClient = new PostgresSyncDatabaseClient({
        connectionString: lateTempUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-v47-late-temp-search-path-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      applyPostgresMigrationsSync(lateSyncClient, {
        migrationsTable: lateSyncLedger,
        migrations: migrationsThroughRepair,
      });
      assert.deepEqual(await readRepairRows(lateSyncLedger), [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);
      assert.deepEqual(await readRepairRows("schema_migrations"), [
        { version: 32, name: "cron_jobs_workdir_and_context_from" },
        { version: 33, name: "cron_jobs_last_run_output_and_run_id" },
      ]);
      assert.equal(
        (
          await scopedPool.query<{ relation: string | null }>(
            "SELECT to_regclass('state_validation_quarantine')::text AS relation",
          )
        ).rows[0]?.relation,
        "state_validation_quarantine",
      );
      await lateAsyncClient.close();
      lateAsyncClient = undefined;
      lateSyncClient.close();
      lateSyncClient = undefined;

      await createLedger(asyncLedger, false);
      asyncClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
        { pool: new Pool({ connectionString: scopedUrl.toString(), max: 1 }), migrationsTable: asyncLedger },
      );
      assert.deepEqual((await runPostgresMigrations(asyncClient, migrationsThroughRepair)).appliedVersions, [47]);
      assert.deepEqual((await runPostgresMigrations(asyncClient, migrationsThroughRepair)).appliedVersions, []);
      assert.deepEqual(await readRepairRows(asyncLedger), [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);
      assert.equal(
        (
          await asyncClient.queryOne<{ relation: string | null }>(
            "SELECT to_regclass('pg_temp.schema_migrations')::text AS relation",
          )
        )?.relation,
        null,
      );

      await createLedger(syncLedger, true);
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-v47-custom-ledger-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      applyPostgresMigrationsSync(syncClient, {
        migrationsTable: syncLedger,
        migrations: migrationsThroughRepair,
      });
      applyPostgresMigrationsSync(syncClient, {
        migrationsTable: syncLedger,
        migrations: migrationsThroughRepair,
      });
      assert.deepEqual(await readRepairRows(syncLedger), [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);
      assert.equal(
        syncClient
          .prepare("SELECT to_regclass('pg_temp.schema_migrations')::text AS relation")
          .get<{ relation: string | null }>()?.relation,
        null,
      );

      assert.deepEqual(await readRepairRows("schema_migrations"), [
        { version: 32, name: "cron_jobs_workdir_and_context_from" },
        { version: 33, name: "cron_jobs_last_run_output_and_run_id" },
      ]);
      const runtimeState = await scopedPool.query<{ current_schema: string; relation: string | null }>(
        "SELECT current_schema() AS current_schema, to_regclass('state_validation_quarantine')::text AS relation",
      );
      assert.equal(runtimeState.rows[0]?.current_schema, schemaName);
      assert.equal(runtimeState.rows[0]?.relation, "state_validation_quarantine");

      await scopedPool.query("DROP TABLE state_validation_quarantine");
      await createLedger(rollbackLedger, true, true);
      rollbackClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
        { pool: new Pool({ connectionString: scopedUrl.toString(), max: 1 }), migrationsTable: rollbackLedger },
      );
      await assert.rejects(runPostgresMigrations(rollbackClient, migrationsThroughRepair), /reject_canonical_history/);
      assert.deepEqual(await readRepairRows(rollbackLedger), [
        { version: 32, name: "cron_jobs_workdir_and_context_from" },
        { version: 33, name: "cron_jobs_last_run_output_and_run_id" },
      ]);
      assert.equal(
        (
          await rollbackClient.queryOne<{ relation: string | null }>(
            "SELECT to_regclass('pg_temp.schema_migrations')::text AS relation",
          )
        )?.relation,
        null,
      );
      assert.equal(
        (
          await scopedPool.query<{ relation: string | null }>(
            "SELECT to_regclass('state_validation_quarantine')::text AS relation",
          )
        ).rows[0]?.relation,
        null,
      );

      await scopedPool.query(`ALTER TABLE ${rollbackLedger} DROP CONSTRAINT reject_canonical_history`);
      assert.deepEqual((await runPostgresMigrations(rollbackClient, migrationsThroughRepair)).appliedVersions, [47]);
      assert.deepEqual(await readRepairRows(rollbackLedger), [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);

      await scopedPool.query("DROP TABLE state_validation_quarantine");
      await createLedger(noopAsyncLedger, true);
      await scopedPool.query(`
        CREATE FUNCTION ${suppressRepairFunction}() RETURNS trigger AS $$
        BEGIN
          IF OLD.version IN (32, 33) AND NEW.name IS DISTINCT FROM OLD.name THEN
            RETURN OLD;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER suppress_history_repair
        BEFORE UPDATE OF name ON ${noopAsyncLedger}
        FOR EACH ROW EXECUTE FUNCTION ${suppressRepairFunction}();
      `);
      noopAsyncClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
        { pool: new Pool({ connectionString: scopedUrl.toString(), max: 1 }), migrationsTable: noopAsyncLedger },
      );
      await assert.rejects(
        runPostgresMigrations(noopAsyncClient, migrationsThroughRepair),
        /migration ledger mismatch at version 32/,
      );
      assert.deepEqual(await readRepairRows(noopAsyncLedger), [
        { version: 32, name: "cron_jobs_workdir_and_context_from" },
        { version: 33, name: "cron_jobs_last_run_output_and_run_id" },
      ]);
      assert.equal(
        (
          await noopAsyncClient.queryOne<{ relation: string | null }>(
            "SELECT to_regclass('pg_temp.schema_migrations')::text AS relation",
          )
        )?.relation,
        null,
      );
      assert.equal(
        (
          await scopedPool.query<{ relation: string | null }>(
            "SELECT to_regclass('state_validation_quarantine')::text AS relation",
          )
        ).rows[0]?.relation,
        null,
      );
      await scopedPool.query(`DROP TRIGGER suppress_history_repair ON ${noopAsyncLedger}`);
      assert.deepEqual((await runPostgresMigrations(noopAsyncClient, migrationsThroughRepair)).appliedVersions, [47]);
      assert.deepEqual(await readRepairRows(noopAsyncLedger), [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);

      await scopedPool.query("DROP TABLE state_validation_quarantine");
      await createLedger(noopSyncLedger, true);
      await scopedPool.query(`
        CREATE TRIGGER suppress_history_repair
        BEFORE UPDATE OF name ON ${noopSyncLedger}
        FOR EACH ROW EXECUTE FUNCTION ${suppressRepairFunction}();
      `);
      assert.throws(
        () =>
          applyPostgresMigrationsSync(syncClient as PostgresSyncDatabaseClient, {
            migrationsTable: noopSyncLedger,
            migrations: migrationsThroughRepair,
          }),
        /migration ledger mismatch at version 32/,
      );
      assert.deepEqual(await readRepairRows(noopSyncLedger), [
        { version: 32, name: "cron_jobs_workdir_and_context_from" },
        { version: 33, name: "cron_jobs_last_run_output_and_run_id" },
      ]);
      assert.equal(
        syncClient
          .prepare("SELECT to_regclass('pg_temp.schema_migrations')::text AS relation")
          .get<{ relation: string | null }>()?.relation,
        null,
      );
      assert.equal(
        (
          await scopedPool.query<{ relation: string | null }>(
            "SELECT to_regclass('state_validation_quarantine')::text AS relation",
          )
        ).rows[0]?.relation,
        null,
      );
      await scopedPool.query(`DROP TRIGGER suppress_history_repair ON ${noopSyncLedger}`);
      applyPostgresMigrationsSync(syncClient, {
        migrationsTable: noopSyncLedger,
        migrations: migrationsThroughRepair,
      });
      assert.deepEqual(await readRepairRows(noopSyncLedger), [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ]);
    } finally {
      ephemeralSyncClient?.close();
      lateSyncClient?.close();
      syncClient?.close();
      await Promise.allSettled([
        guardClient?.close(),
        shadowClient?.close(),
        ephemeralAsyncClient?.close(),
        lateAsyncClient?.close(),
        asyncClient?.close(),
        rollbackClient?.close(),
        noopAsyncClient?.close(),
      ]);
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres serializes same-build concurrent migration runners",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_same_${suffix}`;
    const migrationsTable = `migration_same_ledger_${suffix}`;
    const effectsTable = `migration_same_effects_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const clientA = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: scopedUrl.toString() }), migrationsTable },
    );
    const clientB = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: scopedUrl.toString() }), migrationsTable },
    );

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await adminPool.query(`
        CREATE TABLE ${schemaName}.${migrationsTable} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${schemaName}.${effectsTable} (
          effect_id BIGSERIAL PRIMARY KEY,
          runner TEXT NOT NULL
        );
      `);
      const migration = {
        version: 1,
        name: "same_build_concurrent_startup",
        sql: `SELECT pg_sleep(0.8); INSERT INTO ${effectsTable} (runner) VALUES ('same-build')`,
      } satisfies PostgresMigration;

      const results = await Promise.all([
        runPostgresMigrations(clientA, [migration]),
        runPostgresMigrations(clientB, [migration]),
      ]);

      assert.deepEqual(
        results.map((result) => result.appliedVersions).sort((left, right) => left.length - right.length),
        [[], [1]],
      );
      const effects = await adminPool.query<{ runner: string }>(
        `SELECT runner FROM ${schemaName}.${effectsTable} ORDER BY effect_id`,
      );
      assert.deepEqual(effects.rows, [{ runner: "same-build" }]);
    } finally {
      await Promise.allSettled([clientA.close(), clientB.close()]);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rejects a divergent concurrent migration before its payload commits",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_migration_divergent_${suffix}`;
    const migrationsTable = `migration_divergent_ledger_${suffix}`;
    const effectsTable = `migration_divergent_effects_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const clientA = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: scopedUrl.toString() }), migrationsTable },
    );
    const clientB = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: new Pool({ connectionString: scopedUrl.toString() }), migrationsTable },
    );

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await adminPool.query(`
        CREATE TABLE ${schemaName}.${migrationsTable} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${schemaName}.${effectsTable} (
          effect_id BIGSERIAL PRIMARY KEY,
          runner TEXT NOT NULL
        );
      `);
      const outcomes = await Promise.allSettled([
        runPostgresMigrations(clientA, [
          {
            version: 1,
            name: "divergent_runner_a",
            sql: `SELECT pg_sleep(0.8); INSERT INTO ${effectsTable} (runner) VALUES ('runner-a')`,
          },
        ]),
        runPostgresMigrations(clientB, [
          {
            version: 1,
            name: "divergent_runner_b",
            sql: `SELECT pg_sleep(0.8); INSERT INTO ${effectsTable} (runner) VALUES ('runner-b')`,
          },
        ]),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(String(rejected[0]?.reason), /migration ledger mismatch at version 1/);

      const ledger = await adminPool.query<{ name: string }>(
        `SELECT name FROM ${schemaName}.${migrationsTable} WHERE version = 1`,
      );
      const effects = await adminPool.query<{ runner: string }>(
        `SELECT runner FROM ${schemaName}.${effectsTable} ORDER BY effect_id`,
      );
      assert.equal(ledger.rows.length, 1);
      assert.deepEqual(
        effects.rows,
        ledger.rows[0]?.name === "divergent_runner_a" ? [{ runner: "runner-a" }] : [{ runner: "runner-b" }],
      );
    } finally {
      await Promise.allSettled([clientA.close(), clientB.close()]);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres sync migrators serialize divergent startup on one pinned worker session",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_sync_migration_${suffix}`;
    const migrationsTable = `sync_migration_ledger_${suffix}`;
    const effectsTable = `sync_migration_effects_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
    const commonWorkerData = {
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
      postgresModuleUrl: new URL(`./sync${runtimeModuleExtension}`, import.meta.url).href,
      migratorModuleUrl: new URL(`./migrator${runtimeModuleExtension}`, import.meta.url).href,
      connectionOptions: {
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-sync-migration-concurrency-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      migrationsTable,
    };
    let workerA: Worker | undefined;
    let workerB: Worker | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await adminPool.query(`
        CREATE TABLE ${schemaName}.${migrationsTable} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE ${schemaName}.${effectsTable} (
          effect_id BIGSERIAL PRIMARY KEY,
          runner TEXT NOT NULL
        );
      `);
      workerA = new Worker(MIGRATION_RUNNER_WORKER_SOURCE, {
        eval: true,
        workerData: {
          ...commonWorkerData,
          migration: {
            version: 1,
            name: "sync_divergent_runner_a",
            sql: `SELECT pg_sleep(0.8); INSERT INTO ${effectsTable} (runner) VALUES ('runner-a')`,
          },
        },
      });
      workerB = new Worker(MIGRATION_RUNNER_WORKER_SOURCE, {
        eval: true,
        workerData: {
          ...commonWorkerData,
          migration: {
            version: 1,
            name: "sync_divergent_runner_b",
            sql: `SELECT pg_sleep(0.8); INSERT INTO ${effectsTable} (runner) VALUES ('runner-b')`,
          },
        },
      });

      const outcomes = await Promise.all([waitForMigrationRunner(workerA), waitForMigrationRunner(workerB)]);
      assert.equal(outcomes.filter((outcome) => outcome.type === "done").length, 1);
      const failed = outcomes.filter((outcome) => outcome.type === "error");
      assert.equal(failed.length, 1);
      assert.match(failed[0]?.error ?? "", /migration ledger mismatch at version 1/);

      const ledger = await adminPool.query<{ name: string }>(
        `SELECT name FROM ${schemaName}.${migrationsTable} WHERE version = 1`,
      );
      const effects = await adminPool.query<{ runner: string }>(
        `SELECT runner FROM ${schemaName}.${effectsTable} ORDER BY effect_id`,
      );
      assert.deepEqual(
        effects.rows,
        ledger.rows[0]?.name === "sync_divergent_runner_a" ? [{ runner: "runner-a" }] : [{ runner: "runner-b" }],
      );
    } finally {
      await Promise.allSettled([workerA?.terminate(), workerB?.terminate()]);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres executes typed optional-CAS, cursor, expiry, and recovery predicates",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_typed_predicates_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-typed-predicates-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      syncClient.prepare("SELECT 1 AS ready").get();

      const durableRuns = new DurableRunRepository(syncClient);
      const linkedRunId = `a-linked-${suffix}`;
      const autonomousRunId = `b-autonomous-${suffix}`;
      const generalRunId = `c-general-${suffix}`;
      durableRuns.createRun({
        runId: linkedRunId,
        workflowKey: "chat.turn.execute",
        status: "failed",
        metadata: { linkedFinalizationPending: { finalizationId: `finalize-${suffix}` } },
      });
      durableRuns.createRun({
        runId: autonomousRunId,
        workflowKey: "chat.turn.execute",
        status: "completed",
        metadata: { autonomousChatPostCommitPending: { version: 1, requestedAt: "2026-07-11T00:00:00.000Z" } },
      });
      durableRuns.createRun({
        runId: generalRunId,
        workflowKey: "chat.turn.execute",
        status: "completed",
        metadata: {
          generalChatPostCommitPending: {
            version: 1,
            generationId: `generation-${suffix}`,
            traceStatus: "completed",
            requestedAt: "2026-07-11T00:00:00.000Z",
            completedEffects: [],
            durableEffectRunIds: {},
          },
        },
      });
      assert.deepEqual(durableRuns.listPendingLinkedFinalizationRunIds(), [linkedRunId]);
      assert.deepEqual(durableRuns.listPendingAutonomousChatPostCommitRunIds(), [autonomousRunId]);
      assert.deepEqual(durableRuns.listPendingGeneralChatPostCommitRunIds(), [generalRunId]);
      assert.deepEqual(durableRuns.listPendingGeneralChatPostCommitRunIds(500, generalRunId), []);

      const mutationIdempotency = new MutationIdempotencyRepository(syncClient);
      const mutationIdentity = {
        method: "POST",
        routePath: "/api/v1/chat/sessions/:sessionId/agent-send/stream",
        idempotencyKey: `stale-claim-${suffix}`,
        actorScope: "operator:postgres-proof",
        payloadHash: "payload-hash",
        leaseDurationMs: 1_000,
      };
      const originalClaim = mutationIdempotency.claim({
        ...mutationIdentity,
        now: "2026-07-11T12:00:00.000Z",
      });
      assert.equal(originalClaim.outcome, "claimed");
      const winningClaim = mutationIdempotency.claim({
        ...mutationIdentity,
        now: "2026-07-11T12:00:02.000Z",
      });
      assert.equal(winningClaim.outcome, "claimed");
      assert.equal(winningClaim.outcome === "claimed" ? winningClaim.claimKind : undefined, "retry_after_stale_claim");
      assert.equal(
        mutationIdempotency.markCompleted({
          ...mutationIdentity,
          claimToken: originalClaim.record.claimToken,
        }),
        false,
      );
      assert.equal(
        mutationIdempotency.markCompleted({
          ...mutationIdentity,
          claimToken: winningClaim.record.claimToken,
        }),
        true,
      );
      const discardIdentity = {
        method: "POST",
        routePath: "external_side_effect:integration_operator_action",
        idempotencyKey: `discard-pending-${suffix}`,
        actorScope: "operator:postgres-proof",
        payloadHash: "discard-payload-hash",
      };
      const discardClaim = mutationIdempotency.claim(discardIdentity);
      assert.equal(discardClaim.outcome, "claimed");
      assert.equal(
        mutationIdempotency.discardPending({
          ...discardIdentity,
          claimToken: "wrong-generation",
        }),
        false,
      );
      assert.equal(
        mutationIdempotency.discardPending({
          ...discardIdentity,
          claimToken: discardClaim.record.claimToken!,
        }),
        true,
      );
      assert.equal(mutationIdempotency.get(discardIdentity), undefined);

      const approvals = new ApprovalRepository(syncClient);
      const approvalDatabaseNow = Date.now();
      const expiredApproval = approvals.create({
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { command: "expired-offset" },
        preview: { command: "expired-offset" },
        expiresAt: new Date(approvalDatabaseNow - 60_000).toISOString(),
      });
      const activeApproval = approvals.create({
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { command: "active-offset" },
        preview: { command: "active-offset" },
        expiresAt: new Date(approvalDatabaseNow + 60_000).toISOString(),
      });
      assert.deepEqual(
        approvals
          .listExpiredPending("1900-01-01T00:00:00.000Z", 20, "auth.device_access")
          .map((approval) => approval.approvalId),
        [expiredApproval.approvalId],
      );
      assert.throws(
        () =>
          approvals.resolve(
            expiredApproval.approvalId,
            { decision: "approve", resolvedBy: "operator" },
            { resolvedAt: "2000-01-01T00:00:00.000Z" },
          ),
        /expired/i,
      );
      assert.equal(
        approvals.resolve(
          activeApproval.approvalId,
          { decision: "approve", resolvedBy: "operator" },
          { resolvedAt: "2099-01-01T00:00:00.000Z" },
        ).status,
        "approved",
      );

      const orchestration = new OrchestrationRepository(syncClient);
      const planId = `plan-${suffix}`;
      const orchestrationRunId = `orchestration-${suffix}`;
      orchestration.upsertPlan({
        planId,
        goal: "Prove typed CAS",
        mode: "auto",
        maxIterations: 1,
        maxRuntimeMinutes: 1,
        maxCostUsd: 1,
        waves: [],
      });
      const orchestrationRun = orchestration.createRun({
        runId: orchestrationRunId,
        planId,
        status: "queued",
        startedAt: "2026-07-11T00:00:00.000Z",
        totalCostUsd: 0,
        totalIterations: 0,
        workspaceId: "default",
      });
      assert.equal(
        orchestration.updateRunIfCurrentState(
          { ...orchestrationRun, status: "running", executionState: "queued" },
          { status: "queued", executionState: undefined },
        )?.status,
        "running",
      );
      const generationOwner = orchestration.updateRun({
        ...orchestration.getRun(orchestrationRunId),
        worktreePath: "/tmp/worktree",
        worktreeStatus: "ready",
        worktreeBaseRef: "HEAD",
        worktreeLeaseOwnerId: "postgres-owner-a",
        worktreeLeaseGeneration: 3,
        worktreeLeaseExpiresAt: "2026-07-11T00:05:00.000Z",
      });
      const sameGenerationStaleOwner = orchestration.updateRun({
        ...generationOwner,
        worktreeLeaseOwnerId: "postgres-owner-b",
        worktreeLeaseGeneration: 3,
        worktreeLeaseExpiresAt: "2026-07-11T00:06:00.000Z",
      });
      assert.equal(sameGenerationStaleOwner.worktreeLeaseOwnerId, "postgres-owner-a");
      assert.equal(sameGenerationStaleOwner.worktreeLeaseGeneration, 3);
      assert.equal(sameGenerationStaleOwner.worktreeLeaseExpiresAt, "2026-07-11T00:05:00.000Z");
      assert.equal(
        orchestration.updateRun({
          ...sameGenerationStaleOwner,
          worktreeLeaseExpiresAt: "2026-07-11T00:07:00.000Z",
        }).worktreeLeaseExpiresAt,
        "2026-07-11T00:07:00.000Z",
      );
      assert.equal(
        orchestration.renewWorktreeLease({
          runId: orchestrationRunId,
          worktreeLeaseOwnerId: "postgres-owner-a",
          worktreeLeaseGeneration: 3,
          worktreeLeaseExpiresAt: "2026-07-11T00:08:00.000Z",
        })?.worktreeLeaseExpiresAt,
        "2026-07-11T00:08:00.000Z",
      );
      const adoptedGeneration = orchestration.adoptWorktreeLease({
        runId: orchestrationRunId,
        worktreePath: "/tmp/worktree",
        expectedWorktreeLeaseOwnerId: "postgres-owner-a",
        expectedWorktreeLeaseGeneration: 3,
        worktreeLeaseOwnerId: "postgres-owner-c",
        worktreeLeaseGeneration: 4,
        worktreeLeaseExpiresAt: "2026-07-11T00:09:00.000Z",
      });
      assert.equal(adoptedGeneration?.worktreeLeaseOwnerId, "postgres-owner-c");
      assert.equal(adoptedGeneration?.worktreeLeaseGeneration, 4);
      const staleMixedGeneration = orchestration.updateRunIfCurrentState(
        {
          ...sameGenerationStaleOwner,
          worktreePath: "/tmp/stale-worktree",
          worktreeStatus: "blocked",
          worktreeBaseRef: "stale-ref",
          worktreeLeaseOwnerId: "postgres-owner-a",
          worktreeLeaseGeneration: 3,
          worktreeLeaseExpiresAt: "2026-07-11T00:10:00.000Z",
        },
        {
          status: adoptedGeneration!.status,
          executionState: adoptedGeneration!.executionState,
        },
      );
      assert.equal(staleMixedGeneration?.worktreePath, "/tmp/worktree");
      assert.equal(staleMixedGeneration?.worktreeStatus, "ready");
      assert.equal(staleMixedGeneration?.worktreeBaseRef, "HEAD");
      assert.equal(staleMixedGeneration?.worktreeLeaseOwnerId, "postgres-owner-c");
      assert.equal(staleMixedGeneration?.worktreeLeaseGeneration, 4);
      assert.equal(
        orchestration.fenceWorktreeLease({
          runId: orchestrationRunId,
          worktreePath: "/tmp/worktree",
          worktreeLeaseOwnerId: "postgres-owner-b",
          worktreeLeaseGeneration: 4,
          endedAt: "2026-07-11T00:11:00.000Z",
          lastError: "stale owner must not fence",
        }),
        undefined,
      );
      const fencedOrchestration = orchestration.fenceWorktreeLease({
        runId: orchestrationRunId,
        worktreePath: "/tmp/worktree",
        worktreeLeaseOwnerId: "postgres-owner-c",
        worktreeLeaseGeneration: 4,
        endedAt: "2026-07-11T00:11:00.000Z",
        lastError: "worktree lease lost",
      });
      assert.equal(fencedOrchestration?.status, "failed");
      assert.equal(fencedOrchestration?.worktreeStatus, "blocked");

      const permissionProfiles = new PermissionProfileRepository(syncClient);
      const profile = permissionProfiles.createProfile({
        label: "Typed predicate proof",
        scope: "workspace",
        scopeRef: "workspace-typed-proof",
        approvalMode: "approve_risky",
        createdBy: "operator",
      });
      permissionProfiles.activateProfile({
        profileId: profile.profileId,
        workspaceId: "workspace-typed-proof",
        createdBy: "operator",
      });
      assert.equal(
        permissionProfiles.deactivateProfileActivations({
          profileId: profile.profileId,
          workspaceId: "workspace-typed-proof",
        }),
        1,
      );

      const realtimeEvents = new RealtimeEventRepository(syncClient);
      const firstEvent = realtimeEvents.append(
        "storage_predicate_probe",
        "review",
        { order: 1 },
        undefined,
        "2026-07-11T00:00:00.000Z",
      );
      const secondEvent = realtimeEvents.append(
        "storage_predicate_probe",
        "review",
        { order: 2 },
        undefined,
        "2026-07-11T00:00:01.000Z",
      );
      assert.deepEqual(
        realtimeEvents.list(10, `${secondEvent.timestamp}|${secondEvent.eventId}`).map((event) => event.eventId),
        [firstEvent.eventId],
      );
    } finally {
      syncClient?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres fences two-client agentic control reservations and stale takeover generations",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_agentic_control_claim_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let firstClient: PostgresSyncDatabaseClient | undefined;
    let secondClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      firstClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-agentic-control-owner-a",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      secondClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-agentic-control-owner-b",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      const firstRepository = new MutationIdempotencyRepository(firstClient);
      const secondRepository = new MutationIdempotencyRepository(secondClient);
      const identity = {
        method: "AGENTIC_CONTROL",
        routePath: "/internal/agentic-controls",
        idempotencyKey: `pause-control-${suffix}`,
        actorScope: `task-${suffix}`,
        payloadHash: `control-payload-${suffix}`,
        leaseDurationMs: 1_000,
      };

      const firstClaim = firstRepository.claim({ ...identity, now: "2026-07-11T12:00:00.000Z" });
      assert.equal(firstClaim.outcome, "claimed");
      const concurrentClaim = secondRepository.claim({ ...identity, now: "2026-07-11T12:00:00.500Z" });
      assert.equal(concurrentClaim.outcome, "in_progress");
      const mismatch = secondRepository.claim({
        ...identity,
        payloadHash: `different-control-payload-${suffix}`,
        now: "2026-07-11T12:00:00.500Z",
      });
      assert.equal(mismatch.outcome, "payload_mismatch");

      const replacementClaim = secondRepository.claim({ ...identity, now: "2026-07-11T12:00:02.000Z" });
      assert.equal(replacementClaim.outcome, "claimed");
      assert.equal(
        replacementClaim.outcome === "claimed" ? replacementClaim.claimKind : undefined,
        "retry_after_stale_claim",
      );
      assert.equal(
        firstRepository.markCompleted({
          method: identity.method,
          routePath: identity.routePath,
          idempotencyKey: identity.idempotencyKey,
          actorScope: identity.actorScope,
          claimToken: firstClaim.record.claimToken,
        }),
        false,
      );
      assert.equal(
        secondRepository.markCompleted({
          method: identity.method,
          routePath: identity.routePath,
          idempotencyKey: identity.idempotencyKey,
          actorScope: identity.actorScope,
          claimToken: replacementClaim.record.claimToken,
        }),
        true,
      );
      assert.equal(firstRepository.get(identity)?.status, "completed");
    } finally {
      secondClient?.close();
      firstClient?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres rechecks durable lease freshness after the row-lock wait and before commit",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_durable_lease_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 3 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let blocker: PoolClient | undefined;
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      const waitRunId = `durable-lease-wait-${suffix}`;
      const workRunId = `durable-lease-work-${suffix}`;
      const leaseOwnerId = `worker-${suffix}`;
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-durable-lease-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      syncClient.prepare("SELECT 1 AS ready").get();
      const repo = new DurableRunRepository(syncClient);
      const databaseClockRun = repo.createRun({
        runId: `durable-lease-database-clock-${suffix}`,
        workflowKey: "chat.turn.execute",
      });
      const databaseClockClaim = repo.tryClaimQueuedRunWithDatabaseClock({
        runId: databaseClockRun.runId,
        workerId: leaseOwnerId,
        leaseDurationMs: 60_000,
      });
      assert.ok(Math.abs(Date.parse(databaseClockClaim?.leaseHeartbeatAt ?? "") - Date.now()) < 5_000);
      assert.ok(
        Math.abs(
          Date.parse(databaseClockClaim?.leaseExpiresAt ?? "") -
            Date.parse(databaseClockClaim?.leaseHeartbeatAt ?? "") -
            60_000,
        ) < 5,
      );
      const databaseClockRenewal = repo.renewLeaseWithDatabaseClock({
        runId: databaseClockRun.runId,
        workerId: leaseOwnerId,
        leaseDurationMs: 60_000,
      });
      assert.ok(databaseClockRenewal);
      await scopedPool.query(
        "UPDATE durable_runs SET lease_expires_at = (clock_timestamp() - interval '1 second')::text WHERE run_id = $1",
        [databaseClockRun.runId],
      );
      assert.equal(
        repo.renewLeaseWithDatabaseClock({
          runId: databaseClockRun.runId,
          workerId: leaseOwnerId,
          leaseDurationMs: 60_000,
        }),
        undefined,
      );

      const freshRecoveryRun = repo.createRun({
        runId: `durable-recovery-fresh-${suffix}`,
        workflowKey: "chat.turn.execute",
        status: "running",
        leaseOwnerId,
      });
      const expiredRecoveryRun = repo.createRun({
        runId: `durable-recovery-expired-${suffix}`,
        workflowKey: "chat.turn.execute",
        status: "running",
        leaseOwnerId,
      });
      await scopedPool.query(
        "UPDATE durable_runs SET lease_expires_at = (clock_timestamp() + interval '5 minutes')::text WHERE run_id = $1",
        [freshRecoveryRun.runId],
      );
      await scopedPool.query(
        "UPDATE durable_runs SET lease_expires_at = (clock_timestamp() - interval '5 minutes')::text WHERE run_id = $1",
        [expiredRecoveryRun.runId],
      );
      const fastHostRecoveryIds = repo.listExpiredRunningRunIds("2100-01-01T00:00:00.000Z");
      const slowHostRecoveryIds = repo.listExpiredRunningRunIds("2000-01-01T00:00:00.000Z");
      assert.equal(fastHostRecoveryIds.includes(freshRecoveryRun.runId), false);
      assert.equal(slowHostRecoveryIds.includes(freshRecoveryRun.runId), false);
      assert.equal(fastHostRecoveryIds.includes(expiredRecoveryRun.runId), true);
      assert.equal(slowHostRecoveryIds.includes(expiredRecoveryRun.runId), true);

      const retryGateRun = repo.createRun({
        runId: `durable-retry-gate-${suffix}`,
        workflowKey: "chat.turn.execute",
      });
      const retryGate = repo.upsertRetryWithDatabaseClock({
        runId: retryGateRun.runId,
        attemptNo: 1,
        reason: "temporary provider outage",
        delayMs: 60_000,
      });
      assert.ok(Math.abs(Date.parse(retryGate.nextRetryAt ?? "") - Date.parse(retryGate.createdAt) - 60_000) < 5);
      assert.equal(
        repo.tryClaimQueuedRunWithDatabaseClock({
          runId: retryGateRun.runId,
          workerId: "worker-too-early",
          leaseDurationMs: 60_000,
        }),
        undefined,
      );
      await scopedPool.query(
        "UPDATE durable_retries SET next_retry_at = (clock_timestamp() - interval '1 second')::text WHERE run_id = $1",
        [retryGateRun.runId],
      );
      assert.equal(
        repo.tryClaimQueuedRunWithDatabaseClock({
          runId: retryGateRun.runId,
          workerId: "worker-ready",
          leaseDurationMs: 60_000,
        })?.leaseOwnerId,
        "worker-ready",
      );
      await scopedPool.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            lease_owner_id, lease_expires_at, lease_heartbeat_at, version, created_at, updated_at
          ) VALUES (
            $1, 'chat.turn.execute', 'running', 1, 3, '{}', '{}', $2,
            (clock_timestamp() + interval '1 second')::text,
            clock_timestamp()::text, 1, clock_timestamp()::text, clock_timestamp()::text
          )
        `,
        [waitRunId, leaseOwnerId],
      );

      blocker = await scopedPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT run_id FROM durable_runs WHERE run_id = $1 FOR UPDATE", [waitRunId]);
      const releaseBlocker = blocker.query("SELECT pg_sleep(2); COMMIT");

      const waitStartedAt = Date.now();
      const postWaitLease = syncClient.transaction("immediate", () =>
        repo.lockFreshActiveLeaseForUpdate(waitRunId, leaseOwnerId),
      );
      const waitedMs = Date.now() - waitStartedAt;
      await releaseBlocker;

      assert.ok(waitedMs >= 1_500, `lease fence should wait for the row lock (waited ${waitedMs}ms)`);
      assert.equal(postWaitLease, undefined, "a lease that expires during the row-lock wait must fail");

      await scopedPool.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            lease_owner_id, lease_expires_at, lease_heartbeat_at, version, created_at, updated_at
          ) VALUES (
            $1, 'chat.turn.execute', 'running', 1, 3, '{}', '{}', $2,
            (clock_timestamp() + interval '1 second')::text,
            clock_timestamp()::text, 1, clock_timestamp()::text, clock_timestamp()::text
          )
        `,
        [workRunId, leaseOwnerId],
      );
      const postWorkLease = syncClient.transaction("immediate", () => {
        const initialLease = repo.lockFreshActiveLeaseForUpdate(workRunId, leaseOwnerId);
        assert.ok(initialLease, "the lease should be fresh before fenced work starts");
        syncClient?.prepare("SELECT pg_sleep(1.5)").get();
        return repo.lockFreshActiveLeaseForUpdate(workRunId, leaseOwnerId);
      });

      assert.equal(postWorkLease, undefined, "a lease that expires during fenced work must fail before commit");

      const takeoverRun = repo.createRun({
        runId: `durable-recovery-takeover-${suffix}`,
        workflowKey: "chat.turn.execute",
        status: "running",
        leaseOwnerId,
      });
      await scopedPool.query(
        "UPDATE durable_runs SET lease_expires_at = (clock_timestamp() - interval '1 second')::text WHERE run_id = $1",
        [takeoverRun.runId],
      );
      const observedTakeover = repo.getRun(takeoverRun.runId);
      await blocker.query("BEGIN");
      await blocker.query("SELECT run_id FROM durable_runs WHERE run_id = $1 FOR UPDATE", [takeoverRun.runId]);
      const takeoverRelease = blocker.query(`
        UPDATE durable_runs
        SET lease_owner_id = 'replacement-${suffix}',
            lease_expires_at = (clock_timestamp() + interval '5 minutes')::text,
            version = version + 1,
            updated_at = clock_timestamp()::text
        WHERE run_id = '${takeoverRun.runId}';
        SELECT pg_sleep(1.5);
        COMMIT
      `);
      const takeoverWaitStartedAt = Date.now();
      const staleRecoveryLock = syncClient.transaction("immediate", () =>
        repo.lockExpiredLeaseForUpdate({
          runId: observedTakeover.runId,
          expectedLeaseOwnerId: observedTakeover.leaseOwnerId,
          expectedLeaseExpiresAt: observedTakeover.leaseExpiresAt!,
        }),
      );
      const takeoverWaitedMs = Date.now() - takeoverWaitStartedAt;
      await takeoverRelease;
      assert.ok(takeoverWaitedMs >= 1_000, `recovery fence should wait for takeover commit (${takeoverWaitedMs}ms)`);
      assert.equal(staleRecoveryLock, undefined, "a renewed replacement lease must fence the stale reaper");
      assert.equal(repo.getRun(takeoverRun.runId).leaseOwnerId, `replacement-${suffix}`);
    } finally {
      if (blocker) {
        try {
          await blocker.query("ROLLBACK");
        } catch (error) {
          // The blocker normally committed in the timed release query.
          void error;
        }
        blocker.release();
      }
      syncClient?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres serializes general Chat post-commit receipts across workers",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_chat_post_commit_${suffix}`;
    const runId = `parent-chat-post-commit-${suffix}`;
    const effectIdentity = `${runId}:generation-1:learned_memory_user`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 3 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let firstWorker: PoolClient | undefined;
    let secondWorker: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      await scopedPool.query(
        `CREATE TABLE post_commit_effect_log (effect_identity TEXT PRIMARY KEY, worker_id TEXT NOT NULL)`,
      );
      await scopedPool.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'chat.turn.execute', 'completed', 0, 3, '{}', $2, 1, clock_timestamp()::text, clock_timestamp()::text)
        `,
        [
          runId,
          JSON.stringify({
            generalChatPostCommitPending: {
              version: 1,
              generationId: "generation-1",
              traceStatus: "completed",
              requestedAt: "2026-07-11T00:00:00.000Z",
              completedEffects: [],
              durableEffectRunIds: {},
            },
          }),
        ],
      );

      firstWorker = await scopedPool.connect();
      await firstWorker.query("BEGIN");
      await firstWorker.query("SELECT run_id FROM durable_runs WHERE run_id = $1 FOR UPDATE", [runId]);
      await firstWorker.query(
        "INSERT INTO post_commit_effect_log (effect_identity, worker_id) VALUES ($1, 'worker-a')",
        [effectIdentity],
      );
      const committedMetadata = JSON.stringify({
        generalChatPostCommitPending: {
          version: 1,
          generationId: "generation-1",
          traceStatus: "completed",
          requestedAt: "2026-07-11T00:00:00.000Z",
          completedEffects: ["learned_memory_user"],
          durableEffectRunIds: {},
        },
      });
      secondWorker = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-chat-post-commit-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      secondWorker.prepare("SELECT 1 AS ready").get();
      const secondRepo = new DurableRunRepository(secondWorker);
      const releaseFirstWorker = firstWorker.query(
        `
          UPDATE durable_runs
          SET metadata_json = '${escapePostgresLiteral(committedMetadata)}', version = version + 1
          WHERE run_id = '${escapePostgresLiteral(runId)}';
          SELECT pg_sleep(1);
          COMMIT;
        `,
      );
      const waitStartedAt = Date.now();
      const observed = secondWorker.transaction("immediate", () => {
        const locked = secondRepo.getRunForUpdate(runId);
        const marker = locked.metadata?.generalChatPostCommitPending as { completedEffects?: unknown[] } | undefined;
        if (!marker?.completedEffects?.includes("learned_memory_user")) {
          secondWorker
            ?.prepare("INSERT INTO post_commit_effect_log (effect_identity, worker_id) VALUES (?, 'worker-b')")
            .run(effectIdentity);
        }
        return locked;
      });
      const waitedMs = Date.now() - waitStartedAt;
      await releaseFirstWorker;

      assert.ok(waitedMs >= 750, `second worker should wait for the parent row lock (waited ${waitedMs}ms)`);
      assert.deepEqual(
        (observed.metadata?.generalChatPostCommitPending as { completedEffects?: unknown[] } | undefined)
          ?.completedEffects,
        ["learned_memory_user"],
      );
      const logCount = await scopedPool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM post_commit_effect_log WHERE effect_identity = $1",
        [effectIdentity],
      );
      assert.equal(logCount.rows[0]?.count, 1, "the second worker must observe the committed receipt and skip");
    } finally {
      if (firstWorker) {
        try {
          await firstWorker.query("ROLLBACK");
        } catch (error) {
          void error;
        }
        firstWorker.release();
      }
      secondWorker?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres scopes canonical and legacy memory items before the result limit",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_memory_scope_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      await scopedPool.query(`
        INSERT INTO memory_items (
          item_id, namespace, title, content, metadata_json, pinned,
          ttl_override_seconds, expires_at, status, created_at, updated_at, workspace_id
        )
        SELECT
          'mem-legacy-b-' || series::text,
          'shared.notes',
          'Foreign B',
          'Must not enter workspace A',
          '{"workspaceId":"workspace-b"}',
          0,
          NULL,
          NULL,
          'active',
          '2026-04-02T10:00:00.000Z',
          '2026-04-02T10:00:00.000Z',
          NULL
        FROM generate_series(1, 200) AS series
      `);
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-memory-scope-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      const insert = syncClient.prepare(`
        INSERT INTO memory_items (
          item_id, namespace, title, content, metadata_json, pinned,
          ttl_override_seconds, expires_at, status, created_at, updated_at, workspace_id
        ) VALUES (?, 'shared.notes', ?, 'content', ?, 0, NULL, NULL, 'active', ?, ?, ?)
      `);
      insert.run(
        "mem-canonical-a",
        "Canonical A",
        '{"workspaceId":"workspace-b"}',
        "2026-04-01T08:00:00.000Z",
        "2026-04-01T08:00:00.000Z",
        "workspace-a",
      );
      insert.run(
        "mem-legacy-a",
        "Legacy A",
        '{"workspaceId":"workspace-a"}',
        "2026-04-01T07:00:00.000Z",
        "2026-04-01T07:00:00.000Z",
        null,
      );
      insert.run("mem-global", "Global", "{}", "2026-04-01T06:00:00.000Z", "2026-04-01T06:00:00.000Z", null);

      const repo = new MemoryMaintenanceRepository(syncClient);
      assert.deepEqual(
        repo
          .listActiveMemoryItems(3, "workspace-a")
          .map((item) => item.itemId)
          .sort(),
        ["mem-canonical-a", "mem-global", "mem-legacy-a"],
      );
    } finally {
      syncClient?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres serializes cross-child background counters and workspace maintenance enqueue decisions",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_post_commit_cross_child_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let firstWorker: PoolClient | undefined;
    let secondWorker: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      const childIds = {
        backgroundA: `background-a-${suffix}`,
        backgroundB: `background-b-${suffix}`,
        maintenanceA: `maintenance-a-${suffix}`,
        maintenanceB: `maintenance-b-${suffix}`,
      };
      const owners = {
        backgroundA: `worker-background-a-${suffix}`,
        backgroundB: `worker-background-b-${suffix}`,
        maintenanceA: `worker-maintenance-a-${suffix}`,
        maintenanceB: `worker-maintenance-b-${suffix}`,
      };
      for (const [key, runId] of Object.entries(childIds)) {
        const effect = key.startsWith("background") ? "background_review" : "memory_maintenance";
        await scopedPool.query(
          `
            INSERT INTO durable_runs (
              run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
              lease_owner_id, lease_expires_at, lease_heartbeat_at, version, created_at, updated_at
            ) VALUES (
              $1, 'chat.post_commit.effect', 'running', 1, 3, '{}', $2, $3,
              (clock_timestamp() + interval '2 minutes')::text, clock_timestamp()::text,
              1, clock_timestamp()::text, clock_timestamp()::text
            )
          `,
          [runId, JSON.stringify({ effect }), owners[key as keyof typeof owners]],
        );
      }
      await scopedPool.query(
        `INSERT INTO system_settings (setting_key, value_json, updated_at) VALUES ($1, '3', clock_timestamp()::text)`,
        ["background_review_turns_since_v1"],
      );

      secondWorker = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-post-commit-cross-child-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      secondWorker.prepare("SELECT 1 AS ready").get();
      const secondDurable = new DurableRunRepository(secondWorker);
      const secondSettings = new SystemSettingsRepository(secondWorker);
      const secondMaintenance = new MemoryMaintenanceRepository(secondWorker);

      firstWorker = await scopedPool.connect();
      await firstWorker.query("BEGIN");
      await firstWorker.query("SELECT run_id FROM durable_runs WHERE run_id = $1 FOR UPDATE", [childIds.backgroundA]);
      await firstWorker.query("SELECT setting_key FROM system_settings WHERE setting_key = $1 FOR UPDATE", [
        "background_review_turns_since_v1",
      ]);
      await firstWorker.query(
        "UPDATE system_settings SET value_json = '4', updated_at = clock_timestamp()::text WHERE setting_key = $1",
        ["background_review_turns_since_v1"],
      );
      await firstWorker.query("UPDATE durable_runs SET metadata_json = $2, version = version + 1 WHERE run_id = $1", [
        childIds.backgroundA,
        JSON.stringify({
          effect: "background_review",
          generalChatPostCommitCanonical: {
            version: 1,
            effect: "background_review",
            stages: { background_counter: { completedAt: "2026-07-11T00:00:00.000Z", result: { due: false } } },
          },
        }),
      ]);
      const releaseBackgroundA = firstWorker.query("SELECT pg_sleep(1); COMMIT");
      const backgroundWaitStartedAt = Date.now();
      const secondCounter = secondWorker.transaction("immediate", () => {
        const child = secondDurable.lockFreshActiveLeaseForUpdate(childIds.backgroundB, owners.backgroundB);
        assert.ok(child);
        const counter = secondSettings.advanceCyclicCounter("background_review_turns_since_v1", 5);
        secondDurable.updateRun({
          runId: child.runId,
          status: child.status,
          metadata: {
            ...(child.metadata ?? {}),
            generalChatPostCommitCanonical: {
              version: 1,
              effect: "background_review",
              stages: {
                background_counter: {
                  completedAt: "2026-07-11T00:00:01.000Z",
                  result: { due: counter.due },
                },
              },
            },
          },
          updatedAt: "2026-07-11T00:00:01.000Z",
          expectedVersion: child.version,
        });
        return counter;
      });
      const backgroundWaitedMs = Date.now() - backgroundWaitStartedAt;
      await releaseBackgroundA;

      assert.ok(
        backgroundWaitedMs >= 750,
        `second counter child should wait for the shared row (${backgroundWaitedMs}ms)`,
      );
      assert.deepEqual(secondCounter, { previous: 4, value: 0, due: true });
      assert.equal(secondSettings.get<number>("background_review_turns_since_v1")?.value, 0);
      assert.equal(
        (
          secondDurable.getRun(childIds.backgroundB).metadata?.generalChatPostCommitCanonical as {
            stages?: { background_counter?: { result?: { due?: unknown } } };
          }
        )?.stages?.background_counter?.result?.due,
        true,
      );

      await firstWorker.query("BEGIN");
      await firstWorker.query("SELECT run_id FROM durable_runs WHERE run_id = $1 FOR UPDATE", [childIds.maintenanceA]);
      await firstWorker.query(
        `
          INSERT INTO workspace_memory_maintenance_state (
            workspace_id, changed_session_count, created_at, updated_at
          ) VALUES ('workspace-shared', 4, clock_timestamp()::text, clock_timestamp()::text)
          ON CONFLICT(workspace_id) DO NOTHING
        `,
      );
      await firstWorker.query(
        "SELECT workspace_id FROM workspace_memory_maintenance_state WHERE workspace_id = 'workspace-shared' FOR UPDATE",
      );
      const maintenanceDurableRunId = `memory-durable-${suffix}`;
      const maintenanceRunId = `memory-run-${suffix}`;
      await firstWorker.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'memory.maintenance', 'queued', 0, 3, '{}', '{}', 1, clock_timestamp()::text, clock_timestamp()::text)
        `,
        [maintenanceDurableRunId],
      );
      await firstWorker.query(
        `
          INSERT INTO memory_maintenance_runs (
            run_id, durable_run_id, workspace_id, trigger_source, status, policy_snapshot_json,
            source_session_count, changed_artifact_count, created_at, updated_at
          ) VALUES ($1, $2, 'workspace-shared', 'hybrid_due', 'queued', '{}', 0, 0, clock_timestamp()::text, clock_timestamp()::text)
        `,
        [maintenanceRunId, maintenanceDurableRunId],
      );
      await firstWorker.query(
        "UPDATE workspace_memory_maintenance_state SET active_run_id = $1, updated_at = clock_timestamp()::text WHERE workspace_id = 'workspace-shared'",
        [maintenanceRunId],
      );
      await firstWorker.query("UPDATE durable_runs SET metadata_json = $2, version = version + 1 WHERE run_id = $1", [
        childIds.maintenanceA,
        JSON.stringify({
          effect: "memory_maintenance",
          generalChatPostCommitCanonical: {
            version: 1,
            effect: "memory_maintenance",
            stages: {
              memory_maintenance_evaluation: {
                completedAt: "2026-07-11T00:00:02.000Z",
                result: {
                  status: "enqueued",
                  memoryMaintenanceRunId: maintenanceRunId,
                  durableRunId: maintenanceDurableRunId,
                },
              },
            },
          },
        }),
      ]);
      const releaseMaintenanceA = firstWorker.query("SELECT pg_sleep(1); COMMIT");
      const maintenanceWaitStartedAt = Date.now();
      const observedState = secondWorker.transaction("immediate", () => {
        const child = secondDurable.lockFreshActiveLeaseForUpdate(childIds.maintenanceB, owners.maintenanceB);
        assert.ok(child);
        const state = secondMaintenance.lockStateForUpdate({
          workspaceId: "workspace-shared",
          changedSessionCount: 0,
          createdAt: "2026-07-11T00:00:03.000Z",
          updatedAt: "2026-07-11T00:00:03.000Z",
        });
        secondDurable.updateRun({
          runId: child.runId,
          status: child.status,
          metadata: {
            ...(child.metadata ?? {}),
            generalChatPostCommitCanonical: {
              version: 1,
              effect: "memory_maintenance",
              stages: {
                memory_maintenance_evaluation: {
                  completedAt: "2026-07-11T00:00:03.000Z",
                  result: { status: "evaluated", reason: state.activeRunId ? "active_run" : "not_due" },
                },
              },
            },
          },
          updatedAt: "2026-07-11T00:00:03.000Z",
          expectedVersion: child.version,
        });
        return state;
      });
      const maintenanceWaitedMs = Date.now() - maintenanceWaitStartedAt;
      await releaseMaintenanceA;

      assert.ok(
        maintenanceWaitedMs >= 750,
        `second maintenance child should wait for workspace state (${maintenanceWaitedMs}ms)`,
      );
      assert.equal(observedState.activeRunId, maintenanceRunId);
      assert.equal(secondMaintenance.listRuns("workspace-shared").length, 1);
      assert.equal(secondDurable.listRuns(100).filter((run) => run.workflowKey === "memory.maintenance").length, 1);
      assert.equal(
        (
          secondDurable.getRun(childIds.maintenanceB).metadata?.generalChatPostCommitCanonical as {
            stages?: { memory_maintenance_evaluation?: { result?: { reason?: unknown } } };
          }
        )?.stages?.memory_maintenance_evaluation?.result?.reason,
        "active_run",
      );
    } finally {
      if (firstWorker) {
        try {
          await firstWorker.query("ROLLBACK");
        } catch (error) {
          void error;
        }
        firstWorker.release();
      }
      secondWorker?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres owns approval expiry, grant consumption, and approval-effect leases with its database clock",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_approval_authority_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;
    let revokingWorker: PoolClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-approval-authority-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      syncClient.prepare("SELECT 1 AS ready").get();

      const approvals = new ApprovalRepository(syncClient);
      const expired = approvals.create({
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { command: "expired" },
        preview: { command: "expired" },
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const active = approvals.create({
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { command: "active" },
        preview: { command: "active" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.throws(
        () =>
          approvals.resolve(
            expired.approvalId,
            { decision: "approve", resolvedBy: "slow-app-clock" },
            { resolvedAt: "2000-01-01T00:00:00.000Z" },
          ),
        /expired/i,
      );
      assert.equal(
        approvals.resolve(
          active.approvalId,
          { decision: "approve", resolvedBy: "fast-app-clock" },
          { resolvedAt: "2099-01-01T00:00:00.000Z" },
        ).status,
        "approved",
      );
      assert.deepEqual(
        approvals.listExpiredPending("1900-01-01T00:00:00.000Z").map((item) => item.approvalId),
        [expired.approvalId],
      );
      const malformedExpiry = approvals.create({
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { command: "legacy-malformed" },
        preview: { command: "legacy-malformed" },
        expiresAt: "not-a-timestamp",
      });
      assert.equal(approvals.isExpiredPendingAtDatabaseNow(malformedExpiry.approvalId), true);
      assert.equal(
        approvals
          .listExpiredPending("2099-01-01T00:00:00.000Z")
          .some((item) => item.approvalId === malformedExpiry.approvalId),
        true,
      );
      assert.throws(
        () => approvals.resolve(malformedExpiry.approvalId, { decision: "approve", resolvedBy: "operator" }),
        /expired/i,
      );
      assert.equal(
        approvals.resolve(
          malformedExpiry.approvalId,
          { decision: "reject", resolvedBy: "system:approval-expiry" },
          { allowExpired: true },
        ).status,
        "rejected",
      );

      const remoteTokens = new RemoteActionTokenRepository(syncClient);
      const issuedToken = remoteTokens.createWithTtl({
        tokenHash: `hash-pg-issued-${suffix}`,
        actionType: "approval.resolve",
        approvalId: active.approvalId,
        connectorId: `connector-pg-${suffix}`,
        expiresInMs: 60_000,
      });
      assert.ok(Math.abs(Date.parse(issuedToken.expiresAt) - Date.parse(issuedToken.createdAt) - 60_000) < 5);
      assert.equal(remoteTokens.findPendingFresh(issuedToken.tokenId)?.tokenId, issuedToken.tokenId);
      const claimedToken = remoteTokens.claimPending(issuedToken.tokenId, {
        consumedAt: "2099-01-01T00:00:00.000Z",
        consumedBy: "fast-host",
        claimFingerprint: `sha256:pg-${suffix}`,
      });
      assert.equal(claimedToken.outcome, "claimed");
      assert.ok(Math.abs(Date.parse(claimedToken.record?.consumedAt ?? "") - Date.now()) < 5_000);

      const expiredToken = remoteTokens.createWithTtl({
        tokenHash: `hash-pg-expired-${suffix}`,
        actionType: "approval.resolve",
        approvalId: expired.approvalId,
        connectorId: `connector-pg-${suffix}`,
        expiresInMs: 60_000,
      });
      await scopedPool.query(
        "UPDATE remote_action_tokens SET expires_at = (clock_timestamp() - interval '1 second')::text WHERE token_id = $1",
        [expiredToken.tokenId],
      );
      assert.equal(
        remoteTokens.claimPending(expiredToken.tokenId, {
          consumedAt: "2000-01-01T00:00:00.000Z",
          consumedBy: "slow-host",
          claimFingerprint: `sha256:expired-${suffix}`,
        }).outcome,
        "unavailable",
      );
      assert.equal(remoteTokens.expirePendingIfExpired(expiredToken.tokenId).state, "expired");

      const grants = new ToolGrantRepository(syncClient);
      const raceGrant = grants.create({
        toolPattern: "channel.send",
        decision: "allow",
        scope: "global",
        grantType: "one_time",
        createdBy: "operator",
      });
      revokingWorker = await scopedPool.connect();
      await revokingWorker.query("BEGIN");
      await revokingWorker.query(
        "UPDATE tool_grants SET revoked_at = clock_timestamp()::text, revoked_by = 'revoking-worker' WHERE grant_id = $1",
        [raceGrant.grantId],
      );
      const releaseRevocation = revokingWorker.query("SELECT pg_sleep(1); COMMIT");
      const consumeStartedAt = Date.now();
      assert.equal(grants.consumeOne(raceGrant.grantId), false);
      const consumeWaitedMs = Date.now() - consumeStartedAt;
      await releaseRevocation;
      assert.ok(consumeWaitedMs >= 750, `grant consume should wait for revoke row ownership (${consumeWaitedMs}ms)`);
      assert.equal(grants.get(raceGrant.grantId).usesRemaining, 1);
      assert.equal(grants.get(raceGrant.grantId).revokedBy, "revoking-worker");
      assert.equal(
        grants.list("global", "global").some((grant) => grant.grantId === raceGrant.grantId),
        true,
      );
      assert.equal(
        grants.listActive("global", "global").some((grant) => grant.grantId === raceGrant.grantId),
        false,
      );

      const exhaustedGrant = grants.create({
        toolPattern: "http.post",
        decision: "allow",
        scope: "global",
        grantType: "one_time",
        createdBy: "operator",
      });
      assert.equal(
        grants.listActive("global", "global").some((grant) => grant.grantId === exhaustedGrant.grantId),
        true,
      );
      assert.equal(grants.consumeOne(exhaustedGrant.grantId), true);
      assert.equal(grants.get(exhaustedGrant.grantId).usesRemaining, 0);
      assert.equal(
        grants.list("global", "global").some((grant) => grant.grantId === exhaustedGrant.grantId),
        true,
      );
      assert.equal(
        grants.listActive("global", "global").some((grant) => grant.grantId === exhaustedGrant.grantId),
        false,
      );

      const linkageApproval = approvals.create({
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: { toolName: "channel.send" },
        preview: { toolName: "channel.send" },
      });
      await revokingWorker.query("BEGIN");
      await revokingWorker.query("SELECT approval_id FROM approvals WHERE approval_id = $1 FOR UPDATE", [
        linkageApproval.approvalId,
      ]);
      const mergedLinkage = {
        durableRunId: `durable-linkage-${suffix}`,
        turnId: `turn-linkage-${suffix}`,
        connectorId: `connector-linkage-${suffix}`,
      };
      await revokingWorker.query(
        `UPDATE approvals
         SET linkage_json = $2,
             payload_json = $3
         WHERE approval_id = $1`,
        [
          linkageApproval.approvalId,
          JSON.stringify(mergedLinkage),
          JSON.stringify({ toolName: "channel.send", __gcApprovalLinkage: mergedLinkage }),
        ],
      );
      const releaseLinkageMerge = revokingWorker.query("SELECT pg_sleep(1); COMMIT");
      const resolveStartedAt = Date.now();
      const linkedResolution = approvals.resolve(linkageApproval.approvalId, {
        decision: "approve",
        resolvedBy: "operator-linkage-race",
      });
      const resolveWaitedMs = Date.now() - resolveStartedAt;
      await releaseLinkageMerge;
      assert.ok(
        resolveWaitedMs >= 750,
        `approval resolve should wait for linkage row ownership (${resolveWaitedMs}ms)`,
      );
      assert.deepEqual(linkedResolution.linkage, mergedLinkage);
      assert.deepEqual(linkedResolution.payload, { toolName: "channel.send" });

      const resolutionFirstApproval = approvals.create({
        kind: "approval.remote_token.create",
        riskLevel: "danger",
        payload: {},
        preview: {},
      });
      await revokingWorker.query("BEGIN");
      await revokingWorker.query(
        `UPDATE approvals
         SET status = 'approved',
             resolved_at = clock_timestamp()::text,
             resolved_by = 'concurrent-resolution'
         WHERE approval_id = $1`,
        [resolutionFirstApproval.approvalId],
      );
      const releaseResolutionFirst = revokingWorker.query("SELECT pg_sleep(1); COMMIT");
      const rejectedTokenId = `token-resolution-first-${suffix}`;
      const resolutionFirstStartedAt = Date.now();
      assert.throws(
        () =>
          syncClient!.transaction("immediate", () => {
            approvals.lockPendingForUpdate(resolutionFirstApproval.approvalId);
            remoteTokens.createWithTtl({
              tokenId: rejectedTokenId,
              tokenHash: `hash-${rejectedTokenId}`,
              actionType: "approval.resolve",
              approvalId: resolutionFirstApproval.approvalId,
              connectorId: `connector-resolution-first-${suffix}`,
              mutation: { approvalId: resolutionFirstApproval.approvalId },
              expiresInMs: 60_000,
            });
          }),
        /already resolved/i,
      );
      const resolutionFirstWaitedMs = Date.now() - resolutionFirstStartedAt;
      await releaseResolutionFirst;
      assert.ok(
        resolutionFirstWaitedMs >= 750,
        `token issuance should wait for resolution row ownership (${resolutionFirstWaitedMs}ms)`,
      );
      assert.deepEqual(remoteTokens.listByApprovalId(resolutionFirstApproval.approvalId), []);

      const issuanceFirstApproval = approvals.create({
        kind: "approval.remote_token.create",
        riskLevel: "danger",
        payload: {},
        preview: {},
      });
      const issuanceFirstTokenId = `token-issuance-first-${suffix}`;
      await revokingWorker.query("BEGIN");
      await revokingWorker.query("SELECT approval_id FROM approvals WHERE approval_id = $1 FOR UPDATE", [
        issuanceFirstApproval.approvalId,
      ]);
      await revokingWorker.query(
        `INSERT INTO remote_action_tokens (
           token_id, token_hash, action_type, approval_id, connector_id, mutation_json,
           created_at, expires_at, state, consumed_at, consumed_by
         ) VALUES (
           $1, $2, 'approval.resolve', $3, $4, $5,
           clock_timestamp()::text, (clock_timestamp() + interval '1 minute')::text,
           'pending', NULL, NULL
         )`,
        [
          issuanceFirstTokenId,
          `hash-${issuanceFirstTokenId}`,
          issuanceFirstApproval.approvalId,
          `connector-issuance-first-${suffix}`,
          JSON.stringify({ approvalId: issuanceFirstApproval.approvalId }),
        ],
      );
      const releaseIssuanceFirst = revokingWorker.query("SELECT pg_sleep(1); COMMIT");
      let expiredIssuedTokens = 0;
      let resolvedAfterIssuance!: ReturnType<ApprovalRepository["resolve"]>;
      const issuanceFirstStartedAt = Date.now();
      syncClient.transaction("immediate", () => {
        resolvedAfterIssuance = approvals.resolve(issuanceFirstApproval.approvalId, {
          decision: "approve",
          resolvedBy: "resolution-after-issuance",
        });
        expiredIssuedTokens = remoteTokens.expirePendingByApprovalId(issuanceFirstApproval.approvalId);
      });
      const issuanceFirstWaitedMs = Date.now() - issuanceFirstStartedAt;
      await releaseIssuanceFirst;
      assert.ok(
        issuanceFirstWaitedMs >= 750,
        `approval resolution should wait for token issuance row ownership (${issuanceFirstWaitedMs}ms)`,
      );
      assert.equal(resolvedAfterIssuance.status, "approved");
      assert.equal(expiredIssuedTokens, 1);
      assert.equal(remoteTokens.get(issuanceFirstTokenId).state, "expired");

      const approvalForEffect = approvals.create({
        kind: "tool.invoke",
        riskLevel: "danger",
        payload: { toolName: "channel.send" },
        preview: { toolName: "channel.send" },
      });
      const effects = new ApprovalEffectRepository(syncClient);
      const effect = effects.upsert({
        approvalId: approvalForEffect.approvalId,
        effectKind: "pending_action_execute",
        targetKind: "pending_action",
        targetId: approvalForEffect.approvalId,
      });
      const claimed = effects.claimNextPendingEffect(
        "slow-worker",
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:05:00.000Z",
      );
      assert.equal(claimed?.effectId, effect.effectId);
      assert.ok(Math.abs(Date.parse(claimed?.claimedAt ?? "") - Date.now()) < 5_000);
      assert.equal(
        effects.claimNextPendingEffect("fast-worker", "2099-01-01T00:00:00.000Z", "2099-01-01T00:05:00.000Z"),
        undefined,
      );
      const renewed = effects.renewEffectLease(
        effect.effectId,
        "slow-worker",
        claimed!.version,
        "2099-01-01T00:00:00.000Z",
        "2099-01-01T00:05:00.000Z",
      );
      assert.ok(Date.parse(renewed?.leaseExpiresAt ?? "") - Date.now() > 4 * 60_000);
      await scopedPool.query(
        "UPDATE approval_effects SET lease_expires_at = (clock_timestamp() - interval '1 second')::text WHERE effect_id = $1",
        [effect.effectId],
      );
      assert.equal(
        effects.renewEffectLease(
          effect.effectId,
          "slow-worker",
          renewed!.version,
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:05:00.000Z",
        ),
        undefined,
      );
      const reclaimed = effects.claimNextPendingEffect(
        "slow-worker",
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:05:00.000Z",
      );
      assert.equal(reclaimed?.effectId, effect.effectId);
      assert.equal(reclaimed?.claimedBy, "slow-worker");
      assert.equal(
        effects.completeEffect(effect.effectId, "slow-worker", renewed!.version, { result: { stale: true } }),
        undefined,
      );
      assert.equal(
        effects.completeEffect(effect.effectId, "slow-worker", reclaimed!.version, { result: { fresh: true } })?.status,
        "completed",
      );

      const heartbeatEffect = effects.upsert({
        approvalId: approvalForEffect.approvalId,
        effectKind: "linked_chat_turn_wake",
        targetKind: "chat_turn",
        targetId: `heartbeat-turn-${suffix}`,
      });
      const heartbeatClaim = effects.claimNextPendingEffect(
        "heartbeat-worker",
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:05:00.000Z",
      );
      assert.equal(heartbeatClaim?.effectId, heartbeatEffect.effectId);
      const heartbeatRenewed = effects.renewEffectLease(
        heartbeatEffect.effectId,
        "heartbeat-worker",
        heartbeatClaim!.version,
        "2099-01-01T00:00:00.000Z",
        "2099-01-01T00:05:00.000Z",
      );
      assert.equal(heartbeatRenewed?.version, heartbeatClaim?.version);
      assert.equal(
        effects.completeEffect(heartbeatEffect.effectId, "heartbeat-worker", heartbeatClaim!.version, {
          result: { completedAfterHeartbeat: true },
        })?.status,
        "completed",
      );
    } finally {
      if (revokingWorker) {
        try {
          await revokingWorker.query("ROLLBACK");
        } catch (error) {
          void error;
        }
        revokingWorker.release();
      }
      syncClient?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres applies the full ledger and scrubs legacy remote approval bearers",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_full_migrations_${suffix}`;
    const pool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    const rawToken = `grat_${"p".repeat(43)}`;
    const trailingHyphenToken = `grat_${"h".repeat(42)}-`;
    const benignTokenlike = "grat_community_discount_code";
    const benignLongTokenlike = `grat_${"c".repeat(42)}`;
    const benignMessage = `grateful operator note ${benignTokenlike} ${benignLongTokenlike}`;
    const now = "2026-07-10T00:00:00.000Z";

    try {
      await pool.query(`CREATE SCHEMA ${schemaName}`);
      const beforeScrub = POSTGRES_MIGRATIONS.filter((migration) => migration.version < 81);
      const initial = await runPostgresMigrations(client, beforeScrub);
      assert.equal(initial.latestVersion, 80);

      const legacyDelegationExpiresAt = "2099-01-01T00:00:00.000Z";
      const legacyDelegationExpiresAtMs = Date.parse(legacyDelegationExpiresAt);
      const legacyClaimToken = `delegation-claim:v1:${legacyDelegationExpiresAtMs}:turn-claim:worker-a`;
      const legacyDispatchToken = `delegation-dispatch:v1:${legacyDelegationExpiresAtMs}:turn-dispatch:worker-b`;
      await client.query(
        `
          INSERT INTO chat_delegation_steps (
            step_id, run_id, role, step_index, status, child_session_id, child_turn_id, started_at
          ) VALUES
            ('legacy-claim-step', 'legacy-run', 'coder', 0, 'running', $1, NULL, $3),
            ('legacy-dispatch-step', 'legacy-run', 'qa', 1, 'running', 'canonical-child-session', $2, $3)
        `,
        [legacyClaimToken, legacyDispatchToken, now],
      );

      await client.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'connector.delivery', 'queued', 0, 3, $2, '{}', 1, $3, $3)
        `,
        ["legacy-remote-run", JSON.stringify({ payload: { token: rawToken } }), now],
      );
      await client.query(
        `UPDATE durable_runs
         SET lease_owner_id = $1, lease_expires_at = $2, lease_heartbeat_at = $3
         WHERE run_id = $4`,
        ["worker-legacy", "2099-07-10T00:05:00.000Z", now, "legacy-remote-run"],
      );
      await client.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'connector.delivery', 'queued', 0, 3, $2, '{}', 1, $3, $3)
        `,
        ["legacy-hyphen-run", JSON.stringify({ payload: { token: `x${trailingHyphenToken}y` } }), now],
      );
      await client.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'connector.delivery', 'queued', 0, 3, $2, '{}', 1, $3, $3)
        `,
        ["benign-grateful-run", JSON.stringify({ message: benignMessage }), now],
      );
      await client.query(
        `
          INSERT INTO approval_inbox_items (
            inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
            action_type, state, approval_kind, risk_level, approval_status, preview_json,
            created_at, updated_at, expires_at, delivery_count, last_delivered_at
          ) VALUES ($1, $2, $3, 'mcp', $4, $5, $6, 'approval.resolve', 'pending', 'tool.invoke', 'danger',
            'pending', '{}', $7, $7, $8, 1, $7)
        `,
        [
          "benign-inbox",
          "benign-approval",
          "mcp:server-1",
          "server-1",
          "benign-token-id",
          benignTokenlike,
          now,
          "2026-07-10T00:15:00.000Z",
        ],
      );
      await client.query(
        `
          INSERT INTO approval_inbox_items (
            inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
            action_type, state, approval_kind, risk_level, approval_status, preview_json,
            created_at, updated_at, expires_at, delivery_count, last_delivered_at
          ) VALUES ($1, $2, $3, 'mcp', $4, $5, $6, 'approval.resolve', 'pending', 'tool.invoke', 'danger',
            'pending', '{}', $7, $7, $8, 1, $7)
        `,
        [
          "legacy-decorated-inbox",
          "legacy-decorated-approval",
          "mcp:server-1",
          "server-1",
          "legacy-decorated-token-id",
          `x${trailingHyphenToken}y`,
          now,
          "2026-07-10T00:15:00.000Z",
        ],
      );
      await client.query(
        `
          INSERT INTO audit_events (
            stream_name, event_id, event_sequence, occurred_at, payload
          ) VALUES ('approvals', 'legacy-remote-audit', 1, $1::timestamptz, $2::jsonb)
        `,
        [now, JSON.stringify({ callbackData: `gca:${rawToken}:a` })],
      );
      await client.query(
        `
          INSERT INTO mutation_idempotency (
            method, route_path, idempotency_key, actor_scope, payload_hash, status, created_at, updated_at
          ) VALUES ('POST', '/api/v1/chat/probe', $1, 'operator:probe', 'payload-hash', 'pending', $2, $2)
        `,
        [`legacy-mutation-${suffix}`, now],
      );
      await client.query(
        `INSERT INTO approvals (
           approval_id, kind, risk_level, status, payload_json, preview_json, explanation_status, created_at
         ) VALUES
           ('legacy-effect-approval', 'tool.invoke', 'danger', 'approved', '{}', '{}', 'not_requested', $1),
           ('benign-effect-approval', 'tool.invoke', 'danger', 'approved', '{}', '{}', 'not_requested', $1)`,
        [now],
      );
      await client.query(
        `INSERT INTO approval_effects (
           effect_id, approval_id, effect_kind, target_kind, target_id, idempotency_key, status,
           outcome, detail, details_json, attempt_count, payload_json, result_json, version, created_at, updated_at
         ) VALUES
           ('legacy-effect-result', 'legacy-effect-approval', 'pending_action_execute', 'pending_action',
            'legacy-effect-approval', 'legacy-effect-result-key', 'completed', $1, $2, $3, 1, '{}', $4, 1, $5, $5),
           ('benign-effect-result', 'benign-effect-approval', 'pending_action_execute', 'pending_action',
            'benign-effect-approval', 'benign-effect-result-key', 'completed', $6, $6, $7, 1, '{}', $7, 1, $5, $5)`,
        [
          `sent:${rawToken}`,
          `detail:${rawToken}`,
          JSON.stringify({ token: rawToken }),
          JSON.stringify({ callbackData: `gca:${rawToken}:approve` }),
          now,
          benignTokenlike,
          JSON.stringify({ note: benignTokenlike }),
        ],
      );

      const final = await runPostgresMigrations(client, POSTGRES_MIGRATIONS);
      // The seeded database is pinned at v80 above, so the full ledger applies every
      // migration after it. Derive the tail from the registry so appended migrations
      // do not require a hand-edited snapshot here.
      const expectedLedgerTail = POSTGRES_MIGRATIONS.map((migration) => migration.version).filter(
        (version) => version > 80,
      );
      const expectedLatestVersion = expectedLedgerTail[expectedLedgerTail.length - 1];
      assert.deepEqual(final.appliedVersions, expectedLedgerTail);
      assert.equal(final.latestVersion, expectedLatestVersion);
      const replay = await runPostgresMigrations(client, POSTGRES_MIGRATIONS);
      assert.deepEqual(replay.appliedVersions, []);
      assert.equal(replay.latestVersion, expectedLatestVersion);

      const legacyDelegationSteps = await client.query<{
        step_id: string;
        child_session_id: string | null;
        child_turn_id: string | null;
        dispatch_claim_token: string | null;
        dispatch_claim_expires_at: string | null;
      }>(
        `SELECT step_id, child_session_id, child_turn_id, dispatch_claim_token, dispatch_claim_expires_at
         FROM chat_delegation_steps WHERE run_id = 'legacy-run' ORDER BY step_index`,
      );
      assert.deepEqual(legacyDelegationSteps, [
        {
          step_id: "legacy-claim-step",
          child_session_id: null,
          child_turn_id: null,
          dispatch_claim_token: legacyClaimToken,
          dispatch_claim_expires_at: legacyDelegationExpiresAt,
        },
        {
          step_id: "legacy-dispatch-step",
          child_session_id: "canonical-child-session",
          child_turn_id: null,
          dispatch_claim_token: legacyDispatchToken,
          dispatch_claim_expires_at: legacyDelegationExpiresAt,
        },
      ]);

      const [durable] = await client.query<{
        status: string;
        payload_json: string;
        lease_owner_id: string | null;
        lease_expires_at: string | null;
        lease_heartbeat_at: string | null;
      }>(
        `SELECT status, payload_json, lease_owner_id, lease_expires_at, lease_heartbeat_at
         FROM durable_runs WHERE run_id = $1`,
        ["legacy-remote-run"],
      );
      const [audit] = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_events WHERE event_id = $1`,
        ["legacy-remote-audit"],
      );
      const [hyphenDurable] = await client.query<{ status: string; payload_json: string }>(
        `SELECT status, payload_json FROM durable_runs WHERE run_id = $1`,
        ["legacy-hyphen-run"],
      );
      const [benignDurable] = await client.query<{ status: string; payload_json: string }>(
        `SELECT status, payload_json FROM durable_runs WHERE run_id = $1`,
        ["benign-grateful-run"],
      );
      const [benignInbox] = await client.query<{ token: string }>(
        `SELECT token FROM approval_inbox_items WHERE inbox_item_id = $1`,
        ["benign-inbox"],
      );
      const [legacyDecoratedInbox] = await client.query<{ token: string }>(
        `SELECT token FROM approval_inbox_items WHERE inbox_item_id = $1`,
        ["legacy-decorated-inbox"],
      );
      const [legacyMutation] = await client.query<{
        claim_token: string | null;
        claim_expires_at: string | null;
      }>(
        `SELECT claim_token, claim_expires_at
         FROM mutation_idempotency
         WHERE idempotency_key = $1`,
        [`legacy-mutation-${suffix}`],
      );
      const [legacyEffectResult] = await client.query<{
        outcome: string;
        detail: string;
        details_json: string;
        result_json: string;
      }>(`SELECT outcome, detail, details_json, result_json FROM approval_effects WHERE effect_id = $1`, [
        "legacy-effect-result",
      ]);
      const [benignEffectResult] = await client.query<{
        outcome: string;
        detail: string;
        details_json: string;
        result_json: string;
      }>(`SELECT outcome, detail, details_json, result_json FROM approval_effects WHERE effect_id = $1`, [
        "benign-effect-result",
      ]);
      assert.equal(durable?.status, "failed");
      assert.equal(durable?.lease_owner_id, null);
      assert.equal(durable?.lease_expires_at, null);
      assert.equal(durable?.lease_heartbeat_at, null);
      assert.equal(JSON.stringify({ durable, audit }).includes(rawToken), false);
      assert.match(durable?.payload_json ?? "", /\[REDACTED\]/);
      assert.match(JSON.stringify(audit?.payload ?? {}), /\[REDACTED\]/);
      assert.equal(hyphenDurable?.status, "failed");
      assert.equal(hyphenDurable?.payload_json.includes(trailingHyphenToken), false);
      assert.match(hyphenDurable?.payload_json ?? "", /\[REDACTED\]/);
      assert.deepEqual(benignDurable, {
        status: "queued",
        payload_json: JSON.stringify({ message: benignMessage }),
      });
      assert.equal(benignInbox?.token, benignTokenlike);
      assert.equal(legacyDecoratedInbox?.token, "redacted:legacy-decorated-token-id");
      assert.match(legacyMutation?.claim_token ?? "", /^legacy-[a-f0-9]{32}$/);
      assert.equal(legacyMutation?.claim_expires_at, now);
      assert.equal(JSON.stringify(legacyEffectResult).includes(rawToken), false);
      assert.match(JSON.stringify(legacyEffectResult), /\[REDACTED\]/);
      assert.equal(JSON.stringify(benignEffectResult).includes(benignTokenlike), true);
      assert.equal(JSON.stringify(benignEffectResult).includes("[REDACTED]"), false);

      await client.query(
        `
          INSERT INTO audit_events (
            stream_name, event_id, event_sequence, occurred_at, payload
          )
          SELECT
            'sync-scrub',
            'sync-scrub-' || item::text,
            item,
            $1::timestamptz,
            jsonb_build_object('callbackData', 'gca:x' || $2::text || 'y:a')
          FROM generate_series(1, 251) AS items(item)
        `,
        [now, trailingHyphenToken],
      );
      const scrubMigration = POSTGRES_MIGRATIONS.find(
        (migration) => migration.name === "scrub_legacy_remote_approval_bearers",
      );
      assert.ok(scrubMigration);
      const syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-batched-scrub-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        applyPostgresMigrationsSync(syncClient, {
          migrationsTable: `sync_scrub_migrations_${suffix}`,
          migrations: [scrubMigration],
        });
      } finally {
        syncClient.close();
      }
      const [syncScrubResult] = await client.query<{ total: number; redacted: number; leaked: number }>(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE payload::text LIKE '%[REDACTED]%')::int AS redacted,
            COUNT(*) FILTER (WHERE POSITION($1 IN payload::text) > 0)::int AS leaked
          FROM audit_events
          WHERE stream_name = 'sync-scrub'
        `,
        [trailingHyphenToken],
      );
      assert.deepEqual(syncScrubResult, { total: 251, redacted: 251, leaked: 0 });
    } finally {
      await client.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  },
);

test(
  "real Postgres comms delivery CAS handles nullable leases without overwriting sent truth",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_comms_cas_${suffix}`;
    const pool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    try {
      await pool.query(`CREATE SCHEMA ${schemaName}`);
      await pool.query(`
        CREATE TABLE ${schemaName}.comms_deliveries (
          delivery_id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          channel_key TEXT NOT NULL,
          target TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          payload_json TEXT,
          status TEXT NOT NULL,
          delivery_status TEXT,
          idempotency_key TEXT,
          attempts BIGINT NOT NULL DEFAULT 0,
          max_attempts BIGINT NOT NULL DEFAULT 3,
          next_attempt_at TEXT,
          stale_after_ms BIGINT,
          base_backoff_ms BIGINT,
          max_backoff_ms BIGINT,
          provider_msg_id TEXT,
          error TEXT,
          stale_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      const syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-comms-cas-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        const repo = new CommsDeliveryRepository(syncClient);
        const stale = repo.createQueued(
          {
            connectionId: "conn-real-pg-stale",
            channelKey: "slack",
            target: "C123",
            payload: { message: "stale once" },
          },
          "2026-05-05T00:00:00.000Z",
        );
        assert.equal(
          repo.markStaleIfUnchanged(stale.deliveryId, 0, undefined, "stale delivery", "2026-05-05T00:01:00.000Z"),
          true,
        );

        const sent = repo.createQueued(
          {
            connectionId: "conn-real-pg-sent",
            channelKey: "slack",
            target: "C123",
            payload: { message: "sent wins" },
          },
          "2026-05-05T00:00:00.000Z",
        );
        repo.markSent(sent.deliveryId, "provider-real-pg", "2026-05-05T00:00:01.000Z");
        assert.equal(
          repo.markStaleIfUnchanged(sent.deliveryId, 0, undefined, "stale snapshot", "2026-05-05T00:01:00.000Z"),
          false,
        );
        assert.equal(repo.list("conn-real-pg-sent", 1)[0]?.providerMessageId, "provider-real-pg");
      } finally {
        syncClient.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  },
);

test(
  "real Postgres serializes concurrent approval observability batches into one predecessor chain",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_approval_observability_${suffix}`;
    const approvalId = `approval-observability-${suffix}`;
    const pool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    try {
      await pool.query(`CREATE SCHEMA ${schemaName}`);
      await pool.query(`
        CREATE TABLE ${schemaName}.approvals (
          approval_id TEXT PRIMARY KEY
        );
        CREATE TABLE ${schemaName}.approval_effects (
          effect_id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL REFERENCES ${schemaName}.approvals(approval_id) ON DELETE CASCADE,
          effect_kind TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          outcome TEXT,
          detail TEXT,
          attempt_count BIGINT NOT NULL DEFAULT 0,
          details_json TEXT NOT NULL DEFAULT '{}',
          payload_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT,
          claimed_by TEXT,
          claimed_at TEXT,
          lease_expires_at TEXT,
          version BIGINT NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE UNIQUE INDEX idx_approval_observability_idempotency_${suffix}
          ON ${schemaName}.approval_effects(idempotency_key);
      `);
      await pool.query(`INSERT INTO ${schemaName}.approvals (approval_id) VALUES ($1)`, [approvalId]);

      await runConcurrentObservabilityWorkers({
        kind: "postgres",
        workerOptions: {
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: "goatcitadel-real-postgres-approval-observability-test",
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        },
        approvalId,
        countPerWorker: 20,
      });

      const syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-approval-observability-read-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        const repo = new ApprovalEffectRepository(syncClient);
        assertSingleObservabilityChain(repo.listByApproval(approvalId), 40);
      } finally {
        syncClient.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  },
);

test(
  "real Postgres owns external side-effect stale eligibility and terminalization with its database clock",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_external_effect_clock_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    let syncClient: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-external-effect-clock-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      const repo = new ExternalSideEffectRunRepository(syncClient);
      const run = repo.createOrGet(
        {
          workspaceId: "workspace-clock",
          boundary: "approved_external_runtime",
          routePath: `external_side_effect:approved_external_runtime:plugin.mutate:unknown_connection:${suffix}`,
          catalogId: "plugin.mutate",
          actionId: suffix,
          actorScope: "workspace-clock",
          idempotencyKey: `approved-external-runtime:${suffix}`,
          payloadHash: `payload-${suffix}`,
        },
        "1900-01-01T00:00:00.000Z",
      );

      assert.equal(repo.isStatusStale(run.runId, "claimed_not_sent", 5 * 60 * 1000), false);
      await scopedPool.query(
        "UPDATE external_side_effect_runs SET updated_at = (clock_timestamp() - interval '10 minutes')::text WHERE run_id = $1",
        [run.runId],
      );
      assert.equal(repo.isStatusStale(run.runId, "claimed_not_sent", 5 * 60 * 1000), true);
      const reconciled = repo.markFailureIfStatusStale(run.runId, "claimed_not_sent", 5 * 60 * 1000, {
        status: "unknown_external_outcome",
        errorText: "database-clock stale owner",
      });
      assert.equal(reconciled.status, "unknown_external_outcome");
      assert.equal(reconciled.resumeState, "manual_review_unknown_external_outcome");

      const wardRoute = `external_side_effect:integration_local_bridge_action:productivity.apple-notes:conn-${suffix}:write`;
      const wardInput = {
        workspaceId: "workspace-clock",
        boundary: "integration_local_bridge_action",
        routePath: wardRoute,
        catalogId: "productivity.apple-notes",
        connectionId: `conn-${suffix}`,
        actionId: "write",
        actorScope: `conn-${suffix}`,
        idempotencyKey: `ward-approved:${suffix}`,
        payloadHash: `ward-payload-${suffix}`,
      };
      const wardRefusal = repo.createOrGet({
        ...wardInput,
        status: "idempotency_unavailable",
        replayOutcome: "idempotency_unavailable",
        replayAttempt: "blocked",
      });
      const wardClaimed = repo.createOrGet({
        ...wardInput,
        status: "claimed_not_sent",
        replayOutcome: "claimed",
        replayAttempt: "new",
      });
      assert.equal(wardClaimed.runId, wardRefusal.runId);
      assert.equal(wardClaimed.status, "claimed_not_sent");
      assert.equal(wardClaimed.replayOutcome, "claimed");
      assert.equal(wardClaimed.replayAttempt, "new");
      assert.equal(repo.markExternalCallStarted(wardClaimed.runId).status, "external_call_started");
    } finally {
      syncClient?.close();
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

function waitForDelegationStepPatchWorker(
  worker: Worker,
): Promise<{ summary?: string; output?: string; providerId?: string; model?: string }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const typed = message as { type?: unknown; step?: unknown; error?: unknown };
      if (typed.type === "done") {
        cleanup();
        resolve((typed.step ?? {}) as { summary?: string; output?: string; providerId?: string; model?: string });
      } else if (typed.type === "error") {
        cleanup();
        reject(new Error(String(typed.error ?? "Delegation step patch worker failed.")));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Delegation step patch worker exited before reporting completion (code ${code}).`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function observeDelegationApprovalFanInWorker(worker: Worker, reachedBarriers: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const typed = message as { type?: unknown; workerId?: unknown; error?: unknown };
      if (typed.type === "at_step_set" && typeof typed.workerId === "string") {
        reachedBarriers.push(typed.workerId);
      } else if (typed.type === "done") {
        cleanup();
        resolve();
      } else if (typed.type === "error") {
        cleanup();
        reject(new Error(String(typed.error ?? "Delegation approval fan-in worker failed.")));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Delegation approval fan-in worker exited before reporting completion (code ${code}).`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

async function waitForWorkerStageCount(stages: string[], expected: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (stages.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(stages.length >= expected, `expected ${expected} worker stage(s), received ${stages.length}`);
}

function waitForTaskUpdateWorker(worker: Worker): Promise<{ description?: string; priority?: string }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const typed = message as { type?: unknown; task?: unknown; error?: unknown };
      if (typed.type === "done") {
        cleanup();
        resolve((typed.task ?? {}) as { description?: string; priority?: string });
      } else if (typed.type === "error") {
        cleanup();
        reject(new Error(String(typed.error ?? "Task update worker failed.")));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Task update worker exited before reporting completion (code ${code}).`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function waitForA2ABindingUpdateWorker(worker: Worker): Promise<{ state?: string }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const typed = message as { type?: unknown; binding?: unknown; error?: unknown };
      if (typed.type === "done") {
        cleanup();
        resolve((typed.binding ?? {}) as { state?: string });
      } else if (typed.type === "error") {
        cleanup();
        reject(new Error(String(typed.error ?? "A2A binding update worker failed.")));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`A2A binding update worker exited before reporting completion (code ${code}).`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function waitForA2ABindingCreateWorker(worker: Worker): Promise<{
  sessionId?: string;
  localTaskId?: string;
  metadata?: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const typed = message as { type?: unknown; binding?: unknown; error?: unknown };
      if (typed.type === "done") {
        cleanup();
        resolve(
          (typed.binding ?? {}) as {
            sessionId?: string;
            localTaskId?: string;
            metadata?: Record<string, unknown>;
          },
        );
      } else if (typed.type === "error") {
        cleanup();
        reject(new Error(String(typed.error ?? "A2A binding create worker failed.")));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`A2A binding create worker exited before reporting completion (code ${code}).`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function waitForMigrationRunner(worker: Worker): Promise<{ type: "done" | "error"; error?: string }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const typed = message as { type?: unknown; error?: unknown };
      if (typed.type === "done" || typed.type === "error") {
        cleanup();
        resolve({
          type: typed.type,
          ...(typed.error === undefined ? {} : { error: String(typed.error) }),
        });
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Migration runner exited before reporting completion (code ${code}).`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

const MIGRATION_RUNNER_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      const { applyPostgresMigrationsSync } = await tsImport(
        workerData.migratorModuleUrl,
        workerData.migratorModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      applyPostgresMigrationsSync(db, {
        migrationsTable: workerData.migrationsTable,
        migrations: [workerData.migration],
      });
      parentPort.postMessage({ type: "done" });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      if (db) {
        db.close();
      }
    }
  })();
`;

const DELEGATION_STEP_PATCH_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    let db;
    let storage;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { Storage } = await tsImport(workerData.storageModuleUrl, workerData.storageModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      storage = new Storage({ db, transcriptsDir: ".", auditDir: "." });
      const step = storage.chatDelegationSteps.patch(workerData.stepId, workerData.stepPatch);
      parentPort.postMessage({ type: "done", step });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      if (storage) {
        storage.close();
      } else if (db) {
        db.close();
      }
    }
  })();
`;

const DELEGATION_APPROVAL_FANIN_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    let db;
    let storage;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { Storage } = await tsImport(workerData.storageModuleUrl, workerData.storageModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      const { ApprovalEffectsService } = await tsImport(
        workerData.approvalServiceModuleUrl,
        workerData.approvalServiceModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      storage = new Storage({ db, transcriptsDir: ".", auditDir: "." });

      let reachedStepSet = false;
      for (const methodName of ["listByRun", "listByRunForUpdate"]) {
        const original = storage.chatDelegationSteps[methodName].bind(storage.chatDelegationSteps);
        storage.chatDelegationSteps[methodName] = (...args) => {
          if (!reachedStepSet) {
            reachedStepSet = true;
            parentPort.postMessage({ type: "at_step_set", workerId: workerData.workerId });
            db.prepare("SELECT pg_advisory_lock(hashtext(?)) AS locked").get(workerData.barrierKey);
            db.prepare("SELECT pg_advisory_unlock(hashtext(?)) AS unlocked").get(workerData.barrierKey);
          }
          return original(...args);
        };
      }

      const service = new ApprovalEffectsService(
        { storage, publishRealtime() {} },
        {
          backgroundTasks: new Set(),
          wakeDurableRun() {},
          requestRunProcessing() {},
          findProactiveDurableRunIdsForApproval() { return []; },
          async executeCodeModePendingApproval() {},
          async executeApprovedPendingAction() {},
          enqueueAfterHooks() {},
          resolveApprovalHookWorkspaceId() { return "default"; },
        },
      );
      storage.runImmediateTransaction(() =>
        service.materializeDelegationParentsFromApprovedChild({
          childTrace: {
            sessionId: workerData.child.sessionId,
            turnId: workerData.child.turnId,
            citations: [],
          },
          outputText: workerData.workerId + " approved output",
          now: "2026-07-11T00:00:02.000Z",
          approvalId: "approval-" + workerData.workerId,
        }),
      );
      parentPort.postMessage({ type: "done", workerId: workerData.workerId });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        workerId: workerData.workerId,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      if (storage) {
        storage.close();
      } else if (db) {
        db.close();
      }
    }
  })();
`;

const TASK_UPDATE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    let db;
    let storage;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { Storage } = await tsImport(workerData.storageModuleUrl, workerData.storageModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      storage = new Storage({ db, transcriptsDir: ".", auditDir: "." });
      const task = storage.tasks.update(workerData.taskId, workerData.taskUpdate, workerData.now);
      parentPort.postMessage({ type: "done", task });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      if (storage) {
        storage.close();
      } else if (db) {
        db.close();
      }
    }
  })();
`;

const A2A_BINDING_UPDATE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    let db;
    let storage;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { Storage } = await tsImport(workerData.storageModuleUrl, workerData.storageModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      storage = new Storage({ db, transcriptsDir: ".", auditDir: "." });
      const binding = storage.a2aTaskBindings.update(
        workerData.a2aTaskId,
        workerData.bindingUpdate,
        workerData.now,
      );
      parentPort.postMessage({ type: "done", binding });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      if (storage) {
        storage.close();
      } else if (db) {
        db.close();
      }
    }
  })();
`;

const A2A_BINDING_CREATE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    let db;
    let storage;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { Storage } = await tsImport(workerData.storageModuleUrl, workerData.storageModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      storage = new Storage({ db, transcriptsDir: ".", auditDir: "." });
      const binding = storage.a2aTaskBindings.createOrGet(workerData.bindingInput, workerData.now);
      parentPort.postMessage({ type: "done", binding });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      if (storage) {
        storage.close();
      } else if (db) {
        db.close();
      }
    }
  })();
`;
