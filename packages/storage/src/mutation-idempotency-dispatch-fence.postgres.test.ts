import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { MutationIdempotencyRepository } from "./mutation-idempotency-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real PostgreSQL upgraded installs gain the mutation idempotency dispatch fence and fence legacy pending claims",
  {
    skip: connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
  },
  async () => {
    assert.ok(connectionString);
    const schema = `dispatch_fence_upgrade_${randomUUID().replaceAll("-", "")}`;
    assert.match(schema, /^dispatch_fence_upgrade_[a-f0-9]{32}$/);
    const admin = new Pool({ connectionString });
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: "postgres" });
    const upTo = (version: number) => POSTGRES_MIGRATIONS.filter((migration) => migration.version <= version);
    let db: PostgresSyncDatabaseClient | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      // v2 renders from the current SQLite blueprint, so an install whose v2
      // predates the fence is simulated by dropping the column before v212.
      await runPostgresMigrations(migrations, upTo(211));
      await admin.query(`ALTER TABLE ${schema}.mutation_idempotency DROP COLUMN dispatched_at`);
      await admin.query(
        `INSERT INTO ${schema}.mutation_idempotency
           (method, route_path, idempotency_key, actor_scope, payload_hash, status, claim_token, claim_expires_at, created_at, updated_at)
         VALUES ('POST', 'external_side_effect:legacy', 'legacy-pending', 'operator:upgrade', 'legacy-hash', 'pending',
           'legacy-token', '2026-10-16T00:00:01.000Z', '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'),
           ('POST', 'external_side_effect:legacy', 'legacy-completed', 'operator:upgrade', 'legacy-hash', 'completed',
           NULL, NULL, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'),
           ('POST', '/skill-learning/candidate-transition', 'legacy-internal', 'operator:upgrade', 'legacy-hash', 'pending',
           'internal-token', '2026-10-16T00:00:01.000Z', '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z')`,
      );

      // v215 pauses enabled no_agent jobs that never ran; others keep their state.
      await admin.query(
        `INSERT INTO ${schema}.cron_jobs (job_id, name, action, schedule, enabled, last_run_at, last_run_id, updated_at)
         VALUES ('dormant-host', 'Dormant', 'no_agent', '0 8 * * *', 1, NULL, NULL, '2026-10-16T00:00:00.000Z'),
           ('ran-host', 'Ran', 'no_agent', '0 8 * * *', 1, '2026-10-01T00:00:00.000Z', 'run-1', '2026-10-16T00:00:00.000Z'),
           ('agent-task', 'Agent', 'task', '0 8 * * *', 1, NULL, NULL, '2026-10-16T00:00:00.000Z')`,
      );

      // The full registry (not a canonical prefix) runs the schema-shape gate.
      const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      assert.deepEqual(migrated.appliedVersions, [212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223]);
      assert.equal(migrated.latestVersion, 223);

      const cronRows = await admin.query<{ job_id: string; enabled: string; revision: string }>(
        `SELECT job_id, enabled::text AS enabled, revision::text AS revision FROM ${schema}.cron_jobs ORDER BY job_id`,
      );
      assert.deepEqual(cronRows.rows, [
        { job_id: "agent-task", enabled: "1", revision: "1" },
        { job_id: "dormant-host", enabled: "0", revision: "2" },
        { job_id: "ran-host", enabled: "1", revision: "1" },
      ]);

      const column = await admin.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'mutation_idempotency' AND column_name = 'dispatched_at'`,
        [schema],
      );
      assert.deepEqual(column.rows, [{ data_type: "text", is_nullable: "YES" }]);

      db = new PostgresSyncDatabaseClient({
        connectionString: scoped.toString(),
        database: "postgres",
        pool: { max: 1 },
      });
      const repo = new MutationIdempotencyRepository(db);
      const identity = {
        method: "POST",
        routePath: "external_side_effect:legacy",
        idempotencyKey: "legacy-pending",
        actorScope: "operator:upgrade",
      };
      const legacy = repo.get(identity);
      assert.equal(legacy?.status, "pending");
      assert.equal(legacy?.claimToken, "legacy-token");
      // A pre-fence holder may have dispatched without a marker: fenced fail-closed.
      assert.equal(legacy?.dispatchedAt, "2026-10-16T00:00:00.000Z");
      assert.equal(repo.get({ ...identity, idempotencyKey: "legacy-completed" })?.dispatchedAt, undefined);

      const later = repo.claim({
        ...identity,
        payloadHash: "legacy-hash",
        leaseDurationMs: 1_000,
        now: "2026-10-16T00:00:05.000Z",
      });
      assert.equal(later.outcome, "unknown_after_send");
      assert.equal(repo.get(identity)?.status, "unknown_after_send");
      assert.equal(repo.markCompleted({ ...identity, claimToken: "legacy-token" }), false);

      // Internal owners never dispatch: they stay unfenced and keep stale takeover.
      const internal = {
        ...identity,
        routePath: "/skill-learning/candidate-transition",
        idempotencyKey: "legacy-internal",
      };
      assert.equal(repo.get(internal)?.dispatchedAt, undefined);
      const takeover = repo.claim({
        ...internal,
        payloadHash: "legacy-hash",
        leaseDurationMs: 1_000,
        now: "2026-10-16T00:00:05.000Z",
      });
      assert.equal(takeover.outcome === "claimed" ? takeover.claimKind : takeover.outcome, "retry_after_stale_claim");
    } finally {
      db?.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await migrations.close();
      await admin.end();
    }
  },
);

test(
  "real PostgreSQL upgraded installs gain the sealed external side-effect replay record column",
  {
    skip: connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
  },
  async () => {
    assert.ok(connectionString);
    const schema = `replay_record_upgrade_${randomUUID().replaceAll("-", "")}`;
    assert.match(schema, /^replay_record_upgrade_[a-f0-9]{32}$/);
    const admin = new Pool({ connectionString });
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: "postgres" });
    const upTo = (version: number) => POSTGRES_MIGRATIONS.filter((migration) => migration.version <= version);
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      // v2 renders from the current SQLite blueprint, so an install that predates
      // the column is simulated by dropping it before v216.
      await runPostgresMigrations(migrations, upTo(215));
      await admin.query(`ALTER TABLE ${schema}.external_side_effect_runs DROP COLUMN replay_record_json`);

      const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      assert.deepEqual(migrated.appliedVersions, [216, 217, 218, 219, 220, 221, 222, 223]);
      assert.equal(migrated.latestVersion, 223);

      const column = await admin.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'external_side_effect_runs' AND column_name = 'replay_record_json'`,
        [schema],
      );
      assert.deepEqual(column.rows, [{ data_type: "text", is_nullable: "YES" }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await migrations.close();
      await admin.end();
    }
  },
);
