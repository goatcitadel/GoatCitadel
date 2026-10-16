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

      // The full registry (not a canonical prefix) runs the schema-shape gate.
      const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      assert.deepEqual(migrated.appliedVersions, [212, 213, 214]);
      assert.equal(migrated.latestVersion, 214);

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
