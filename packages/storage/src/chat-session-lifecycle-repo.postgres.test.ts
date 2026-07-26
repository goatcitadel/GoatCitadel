import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = connectionString ? it : it.skip;

const HX411_NEW_RELATIONS = [
  "chat_turn_capability_profile_incarnation_bindings",
  "chat_turn_user_input_continuation_seals",
  "chat_turn_mutation_admission_durable_bindings",
  "chat_turn_session_incarnation_bindings",
  "chat_session_control_auth_revoke_operations",
  "chat_session_control_auth_revoke_operation_targets",
  "chat_session_lifecycle_intents",
  "chat_session_mutation_admissions",
  "chat_session_mutation_admission_events",
] as const;
const HX411_NEW_TRIGGERS = [
  "trg_chat_session_lifecycle_intents_insert_guard",
  "trg_chat_session_lifecycle_intents_no_update",
  "trg_chat_session_lifecycle_intents_no_delete",
  "trg_chat_session_meta_lifecycle_guard",
  "trg_chat_session_meta_lifecycle_after_insert",
  "trg_chat_session_control_operator_generation_lifecycle_guard",
  "trg_chat_session_mutation_admissions_guard",
  "trg_chat_session_mutation_admissions_event",
  "trg_chat_session_mutation_admissions_no_delete",
  "trg_chat_session_mutation_admission_events_no_update",
  "trg_chat_session_mutation_admission_events_no_delete",
  "trg_chat_session_control_auth_revoke_operations_guard",
  "trg_chat_session_control_auth_revoke_operations_no_update",
  "trg_chat_session_control_auth_revoke_operations_no_delete",
  "trg_chat_session_control_auth_revoke_targets_guard",
  "trg_chat_session_control_auth_revoke_targets_no_update",
  "trg_chat_session_control_auth_revoke_targets_no_delete",
] as const;
const HX411_NEW_FUNCTIONS = [
  "gc_reject_session_lifecycle_immutable_mutation",
  "gc_session_lifecycle_intent_insert_guard",
  "gc_chat_session_meta_lifecycle_guard",
  "gc_chat_session_meta_lifecycle_after_insert",
  "gc_session_control_operator_generation_lifecycle_guard",
  "gc_session_mutation_admission_guard",
  "gc_session_mutation_admission_event",
  "gc_auth_revoke_operation_guard",
  "gc_auth_revoke_target_guard",
] as const;
const HX411_REPLACED_FUNCTIONS = [
  "gc_session_control_request_transition_guard",
  "gc_session_control_grant_insert_guard",
  "gc_session_control_grant_update_guard",
  "gc_session_control_event_insert_guard",
  "gc_session_control_auth_revoke_receipt_insert_guard",
] as const;

describe("ChatSessionLifecycleRepository live PostgreSQL", () => {
  postgresIt(
    "rejects corrupt 114 state, upgrades to 115, and permits one reactivation winner",
    { timeout: 300_000 },
    async () => {
      assert.ok(connectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx411_lifecycle_${suffix}`;
      const legacySessionId = `legacy-${suffix}`;
      const freshSessionId = `fresh-${suffix}`;
      const adminPool = new Pool({ connectionString, max: 2 });
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const setupDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx411-lifecycle-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        setupDb.exec(`SET search_path TO ${schemaName}`);
        assert.deepEqual(
          POSTGRES_MIGRATIONS.filter((migration) => migration.sql.includes("chat_session_lifecycle_intents")).map(
            (migration) => migration.version,
          ),
          [2, 115],
        );
        const through113 = await runPostgresMigrations(
          migrations,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 113),
        );
        assert.equal(through113.latestVersion, 113);
        assert.equal(
          setupDb.prepare("SELECT MAX(version) AS version FROM schema_migrations").get<{ version: number }>()!.version,
          113,
        );
        assert.equal(
          (await scopedPool.query<{ schema_name: string }>("SELECT current_schema() AS schema_name")).rows[0]
            ?.schema_name,
          schemaName,
        );
        await rewindPostgresSessionLifecycleMigration(scopedPool);
        setupDb
          .prepare(
            `INSERT INTO chat_session_meta (session_id, workspace_id, created_at, updated_at)
             VALUES (@sessionId, 'workspace-a', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')`,
          )
          .run({ sessionId: legacySessionId });
        assert.deepEqual(
          (
            await runPostgresMigrations(
              migrations,
              POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 114),
            )
          ).appliedVersions,
          [114],
        );
        const beforeFailedUpgrade = await snapshotHx411PostgresObjects(scopedPool, schemaName);
        assert.deepEqual(beforeFailedUpgrade.newObjects, []);
        assert.equal(beforeFailedUpgrade.replacedFunctions.length, HX411_REPLACED_FUNCTIONS.length);

        await mutatePostgresControlGrantWithoutGuard(
          scopedPool,
          legacySessionId,
          `UPDATE chat_session_control_grants
           SET is_current = 0, lease_state = 'deleted', control_revision = control_revision + 1,
               updated_at = created_at, terminal_at = created_at
           WHERE session_id = $1`,
        );
        await assert.rejects(
          runPostgresMigrations(
            migrations,
            POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 115),
          ),
          /lifecycle preflight invariant violated/iu,
        );
        assert.equal(setupDb.prepare("SELECT 1 FROM schema_migrations WHERE version = 115").get(), undefined);
        assert.deepEqual(await snapshotHx411PostgresObjects(scopedPool, schemaName), beforeFailedUpgrade);

        await mutatePostgresControlGrantWithoutGuard(
          scopedPool,
          legacySessionId,
          `UPDATE chat_session_control_grants
           SET is_current = 1, lease_state = 'operator_active', control_revision = control_revision + 1,
               updated_at = created_at, terminal_at = NULL
           WHERE session_id = $1`,
        );
        assert.deepEqual(
          (await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS)).appliedVersions,
          POSTGRES_MIGRATIONS.filter((migration) => migration.version >= 115).map((migration) => migration.version),
        );
        assert.deepEqual((await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS)).appliedVersions, []);
        assert.equal(
          setupDb
            .prepare("SELECT lifecycle_intent_id FROM chat_session_meta WHERE session_id = @sessionId")
            .get<{ lifecycle_intent_id: string | null }>({ sessionId: legacySessionId })!.lifecycle_intent_id,
          null,
        );

        const lifecycle = new ChatSessionLifecycleRepository(setupDb);
        setupDb.transaction("immediate", () => {
          lifecycle.deleteTree(
            {
              workspaceId: "workspace-a",
              rootSessionId: legacySessionId,
              expectedRootRevision: 1,
              actorId: "operator-a",
              idempotencyKey: `lifecycle:delete:${legacySessionId}`,
              correlationId: `correlation:lifecycle:delete:${legacySessionId}`,
            },
            () => undefined,
          );
        });

        const race = await runPostgresLifecycleRace(scopedUrl.toString(), database, schemaName, legacySessionId, [
          "left",
          "right",
        ]);
        assert.equal(race.filter((result) => result.ok).length, 1, JSON.stringify(race));
        assert.equal(race.filter((result) => !result.ok).length, 1, JSON.stringify(race));
        assert.deepEqual(
          {
            ...(setupDb
              .prepare(
                `SELECT meta.workspace_id, control.generation, control.is_current, control.owner_kind,
                        event.reason_code
                 FROM chat_session_meta meta
                 JOIN chat_session_control_grants control
                   ON control.session_id = meta.session_id AND control.is_current = 1
                 JOIN chat_session_control_events event
                   ON event.session_id = meta.session_id AND event.reason_code = 'session_reactivated'
                 WHERE meta.session_id = @sessionId`,
              )
              .get({ sessionId: legacySessionId }) as Record<string, unknown>),
          },
          {
            workspace_id: "workspace-a",
            generation: 2,
            is_current: 1,
            owner_kind: "operator",
            reason_code: "session_reactivated",
          },
        );

        const fresh = lifecycle.initialize({
          workspaceId: "workspace-a",
          sessionId: freshSessionId,
          actorId: "operator-a",
          idempotencyKey: `lifecycle:init:${freshSessionId}`,
          correlationId: `correlation:lifecycle:init:${freshSessionId}`,
        });
        assert.equal(fresh.generation, 1);
        assert.throws(() =>
          setupDb
            .prepare(
              `INSERT INTO chat_session_meta (session_id, workspace_id, created_at, updated_at)
               VALUES ('forged-session', 'workspace-a', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`,
            )
            .run(),
        );
        assert.throws(() =>
          setupDb.prepare("DELETE FROM chat_session_meta WHERE session_id = @sessionId").run({
            sessionId: freshSessionId,
          }),
        );
      } finally {
        setupDb.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

async function mutatePostgresControlGrantWithoutGuard(pool: Pool, sessionId: string, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE chat_session_control_grants DISABLE TRIGGER trg_chat_session_control_grants_update_guard",
    );
    await client.query(sql, [sessionId]);
    await client.query(
      "ALTER TABLE chat_session_control_grants ENABLE TRIGGER trg_chat_session_control_grants_update_guard",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function rewindPostgresSessionLifecycleMigration(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_chat_session_meta_lifecycle_guard ON chat_session_meta;
    DROP TRIGGER IF EXISTS trg_chat_session_meta_lifecycle_after_insert ON chat_session_meta;
    DROP TRIGGER IF EXISTS trg_chat_session_control_operator_generation_lifecycle_guard
      ON chat_session_control_grants;
    DROP INDEX IF EXISTS idx_chat_session_meta_lifecycle_intent;
    ALTER TABLE chat_session_meta DROP COLUMN IF EXISTS lifecycle_intent_id;
    DROP TABLE IF EXISTS chat_turn_capability_profile_incarnation_bindings;
    DROP TABLE IF EXISTS chat_turn_user_input_continuation_seals;
    DROP TABLE IF EXISTS chat_turn_mutation_admission_durable_bindings;
    DROP TABLE IF EXISTS chat_turn_session_incarnation_bindings;
    DROP TABLE IF EXISTS chat_session_mutation_admission_events;
    -- Historical migration 2 materializes the current runtime schema. Newer
    -- runtime tables can therefore hold foreign keys into the v115 admission
    -- table even while this fixture rewinds the ledger to v113. CASCADE is
    -- scoped to the fixture's random schema and removes only those dependent
    -- constraints; their owning forward migrations recreate them below.
    DROP TABLE IF EXISTS chat_session_mutation_admissions CASCADE;
    DROP TABLE IF EXISTS chat_session_control_auth_revoke_operation_targets;
    DROP TABLE IF EXISTS chat_session_control_auth_revoke_operations;
    DROP TABLE IF EXISTS chat_session_lifecycle_intents;
    DROP FUNCTION IF EXISTS gc_reject_session_lifecycle_immutable_mutation();
    DROP FUNCTION IF EXISTS gc_session_lifecycle_intent_insert_guard();
    DROP FUNCTION IF EXISTS gc_chat_session_meta_lifecycle_guard();
    DROP FUNCTION IF EXISTS gc_chat_session_meta_lifecycle_after_insert();
    DROP FUNCTION IF EXISTS gc_session_control_operator_generation_lifecycle_guard();
    DROP FUNCTION IF EXISTS gc_session_mutation_admission_guard();
    DROP FUNCTION IF EXISTS gc_session_mutation_admission_event();
    DROP FUNCTION IF EXISTS gc_auth_revoke_operation_guard();
    DROP FUNCTION IF EXISTS gc_auth_revoke_target_guard();
  `);
}

interface Hx411PostgresObjectSnapshot {
  newObjects: string[];
  replacedFunctions: string[];
}

async function snapshotHx411PostgresObjects(pool: Pool, schemaName: string): Promise<Hx411PostgresObjectSnapshot> {
  const [relations, indexes, triggers, newFunctions, columns, replacedFunctions] = await Promise.all([
    pool.query<{ definition: string }>(
      `SELECT 'relation:' || c.relname || ':' || c.relkind::text AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`,
      [schemaName, [...HX411_NEW_RELATIONS]],
    ),
    pool.query<{ definition: string }>(
      `SELECT 'index:' || indexname || ':' || indexdef AS definition
       FROM pg_indexes
       WHERE schemaname = $1
         AND (tablename = ANY($2::text[]) OR indexname = 'idx_chat_session_meta_lifecycle_intent')
       ORDER BY indexname`,
      [schemaName, [...HX411_NEW_RELATIONS]],
    ),
    pool.query<{ definition: string }>(
      `SELECT 'trigger:' || trigger_row.tgname || ':' || pg_get_triggerdef(trigger_row.oid, true) AS definition
       FROM pg_trigger trigger_row
       JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
       JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       WHERE namespace_row.nspname = $1 AND NOT trigger_row.tgisinternal
         AND trigger_row.tgname = ANY($2::text[])
       ORDER BY trigger_row.tgname`,
      [schemaName, [...HX411_NEW_TRIGGERS]],
    ),
    pool.query<{ definition: string }>(
      `SELECT 'function:' || function_row.proname || ':' || pg_get_functiondef(function_row.oid) AS definition
       FROM pg_proc function_row
       JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = $1 AND function_row.proname = ANY($2::text[])
       ORDER BY function_row.proname`,
      [schemaName, [...HX411_NEW_FUNCTIONS]],
    ),
    pool.query<{ definition: string }>(
      `SELECT 'column:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
         || ':' || COALESCE(column_default, '') AS definition
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'chat_session_meta' AND column_name = 'lifecycle_intent_id'`,
      [schemaName],
    ),
    pool.query<{ definition: string }>(
      `SELECT 'function:' || function_row.proname || ':' || pg_get_functiondef(function_row.oid) AS definition
       FROM pg_proc function_row
       JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = $1 AND function_row.proname = ANY($2::text[])
       ORDER BY function_row.proname`,
      [schemaName, [...HX411_REPLACED_FUNCTIONS]],
    ),
  ]);
  return {
    newObjects: [relations, indexes, triggers, newFunctions, columns]
      .flatMap((result) => result.rows.map((row) => row.definition))
      .sort(),
    replacedFunctions: replacedFunctions.rows.map((row) => row.definition).sort(),
  };
}

interface LifecycleWorkerResult {
  ok: boolean;
  generation?: number;
  disposition?: string;
  error?: string;
}

async function runPostgresLifecycleRace(
  connectionString: string,
  database: string,
  schemaName: string,
  sessionId: string,
  contenders: readonly [string, string],
): Promise<[LifecycleWorkerResult, LifecycleWorkerResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = contenders.map((contender) =>
    runPostgresLifecycleWorker(connectionString, database, schemaName, sessionId, contender, startSignal),
  ) as [ReturnType<typeof runPostgresLifecycleWorker>, ReturnType<typeof runPostgresLifecycleWorker>];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[LifecycleWorkerResult, LifecycleWorkerResult]>;
}

function runPostgresLifecycleWorker(
  connectionString: string,
  database: string,
  schemaName: string,
  sessionId: string,
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<LifecycleWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(POSTGRES_LIFECYCLE_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName: `hx411-lifecycle-${contender}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      schemaName,
      sessionId,
      contender,
      startSignal,
      repositoryModuleUrl: new URL(`./chat-session-lifecycle-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (value: LifecycleWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<LifecycleWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: LifecycleWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`PostgreSQL lifecycle worker exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const POSTGRES_LIFECYCLE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { ChatSessionLifecycleRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.exec("SET search_path TO " + workerData.schemaName);
      parentPort.postMessage({ kind: "ready" });
      const state = new Int32Array(workerData.startSignal);
      Atomics.wait(state, 0, 0);
      const contender = workerData.contender;
      const value = new ChatSessionLifecycleRepository(db).reactivate({
        workspaceId: "workspace-a",
        sessionId: workerData.sessionId,
        expectedTerminalGeneration: 1,
        actorId: "operator-" + contender,
        idempotencyKey: "lifecycle:reactivate:" + workerData.sessionId + ":" + contender,
        correlationId: "correlation:lifecycle:reactivate:" + workerData.sessionId + ":" + contender,
      });
      parentPort.postMessage({
        kind: "result",
        result: { ok: true, generation: value.generation, disposition: value.disposition },
      });
    } catch (error) {
      parentPort.postMessage({
        kind: "result",
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (db) db.close();
    }
  })();
`;
