import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration } from "./postgres/migrations.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

function errorChainContains(error: unknown, pattern: RegExp): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (pattern.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

describe("Postgres dynamic-bootstrap replacement locking", () => {
  postgresIt(
    "never drops an authority row committed while the governed-remediation bridge is waiting",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `bootstrap_bridge_${suffix}`;
      const publicationName = `bridge_pub_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const migrationPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
      const migrationClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: migrationPool },
      );
      const writerPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);

        // Commit the canonical prefix without asking the final-shape validator
        // to bless an intentionally incomplete ledger. The synthetic tail
        // fails in its own transaction after versions 1..133 are durable.
        const setupStop: PostgresMigration = {
          version: 134,
          name: "bootstrap_bridge_setup_stop",
          sql: "DO $setup$ BEGIN RAISE EXCEPTION 'bootstrap_bridge_setup_stop'; END $setup$;",
        };
        await assert.rejects(
          runPostgresMigrations(migrationClient, [...POSTGRES_MIGRATIONS.slice(0, 133), setupStop]),
          /bootstrap_bridge_setup_stop/u,
        );

        const prebridgeOwnedObjects = await adminPool.query<{ checks: number; triggers: number }>(`
          SELECT
            (SELECT COUNT(*)::int
              FROM pg_catalog.pg_constraint AS constraint_row
              JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = '${schemaName}'
                AND relation.relname LIKE 'governed_remediation_%'
                AND constraint_row.contype = 'c') AS checks,
            (SELECT COUNT(*)::int
              FROM pg_catalog.pg_trigger AS trigger_row
              JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = '${schemaName}'
                AND relation.relname LIKE 'governed_remediation_%'
                AND NOT trigger_row.tgisinternal) AS triggers
        `);
        assert.deepEqual(prebridgeOwnedObjects.rows[0], { checks: 0, triggers: 0 });

        await adminPool.query(`
          CREATE INDEX extra_governed_bridge_index
            ON ${schemaName}.governed_remediation_states (updated_at)
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 134)),
          /exact current empty v135 shape/u,
        );
        const corruptBridge = await adminPool.query<{ object_exists: boolean; migration_134: number }>(`
          SELECT
            pg_catalog.to_regclass('${schemaName}.extra_governed_bridge_index') IS NOT NULL AS object_exists,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 134) AS migration_134
        `);
        assert.deepEqual(corruptBridge.rows[0], { object_exists: true, migration_134: 0 });
        await adminPool.query(`DROP INDEX ${schemaName}.extra_governed_bridge_index`);

        await adminPool.query(`
          DROP INDEX ${schemaName}.idx_governed_remediation_phase_claims_active;
          CREATE UNIQUE INDEX idx_governed_remediation_phase_claims_active
            ON ${schemaName}.governed_remediation_phase_claims (
              aggregate_kind, aggregate_id, phase, expected_aggregate_revision
            )
            WHERE status = 'ACTIVE'
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 134)),
          /exact current empty v135 shape/u,
        );
        const predicateBridge = await adminPool.query<{ predicate: string | null; migration_134: number }>(`
          SELECT
            pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false) AS predicate,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 134) AS migration_134
          FROM pg_catalog.pg_index AS index_row
          WHERE index_row.indexrelid = pg_catalog.to_regclass(
            '${schemaName}.idx_governed_remediation_phase_claims_active'
          )
        `);
        assert.match(predicateBridge.rows[0]?.predicate ?? "", /'ACTIVE'/u);
        assert.equal(predicateBridge.rows[0]?.migration_134, 0);
        await adminPool.query(`
          DROP INDEX ${schemaName}.idx_governed_remediation_phase_claims_active;
          CREATE UNIQUE INDEX idx_governed_remediation_phase_claims_active
            ON ${schemaName}.governed_remediation_phase_claims (
              aggregate_kind, aggregate_id, phase, expected_aggregate_revision
            )
            WHERE status = 'active'
        `);

        await adminPool.query(`
          CREATE STATISTICS ${schemaName}.extra_governed_bridge_statistics
            ON state, updated_at FROM ${schemaName}.governed_remediation_states
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 134)),
          /exact current empty v135 shape/u,
        );
        const statisticsBridge = await adminPool.query<{ object_exists: boolean; migration_134: number }>(`
          SELECT
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_statistic_ext AS statistics
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = statistics.stxnamespace
              WHERE namespace.nspname = '${schemaName}'
                AND statistics.stxname = 'extra_governed_bridge_statistics'
            ) AS object_exists,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 134) AS migration_134
        `);
        assert.deepEqual(statisticsBridge.rows[0], { object_exists: true, migration_134: 0 });
        await adminPool.query(`DROP STATISTICS ${schemaName}.extra_governed_bridge_statistics`);

        await adminPool.query(`
          CREATE SEQUENCE ${schemaName}.extra_governed_bridge_sequence;
          ALTER SEQUENCE ${schemaName}.extra_governed_bridge_sequence
            OWNED BY ${schemaName}.governed_remediation_states.updated_at
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 134)),
          /exact current empty v135 shape/u,
        );
        const sequenceBridge = await adminPool.query<{ object_exists: boolean; migration_134: number }>(`
          SELECT
            pg_catalog.to_regclass('${schemaName}.extra_governed_bridge_sequence') IS NOT NULL AS object_exists,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 134) AS migration_134
        `);
        assert.deepEqual(sequenceBridge.rows[0], { object_exists: true, migration_134: 0 });
        await adminPool.query(`DROP SEQUENCE ${schemaName}.extra_governed_bridge_sequence`);

        await adminPool.query(`
          CREATE RULE extra_governed_bridge_rule AS
            ON INSERT TO ${schemaName}.governed_remediation_states DO ALSO NOTHING
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 134)),
          /exact current empty v135 shape/u,
        );
        const ruleBridge = await adminPool.query<{ object_exists: boolean; migration_134: number }>(`
          SELECT
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_rewrite AS rewrite_rule
              WHERE rewrite_rule.ev_class = pg_catalog.to_regclass('${schemaName}.governed_remediation_states')
                AND rewrite_rule.rulename = 'extra_governed_bridge_rule'
            ) AS object_exists,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 134) AS migration_134
        `);
        assert.deepEqual(ruleBridge.rows[0], { object_exists: true, migration_134: 0 });
        await adminPool.query(`
          DROP RULE extra_governed_bridge_rule ON ${schemaName}.governed_remediation_states
        `);

        await adminPool.query(`
          CREATE PUBLICATION ${publicationName}
            FOR TABLE ${schemaName}.governed_remediation_states
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 134)),
          /exact current empty v135 shape/u,
        );
        const publicationBridge = await adminPool.query<{ object_exists: boolean; migration_134: number }>(`
          SELECT
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_publication_rel AS membership
              JOIN pg_catalog.pg_publication AS publication ON publication.oid = membership.prpubid
              WHERE membership.prrelid = pg_catalog.to_regclass('${schemaName}.governed_remediation_states')
                AND publication.pubname = '${publicationName}'
            ) AS object_exists,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 134) AS migration_134
        `);
        assert.deepEqual(publicationBridge.rows[0], { object_exists: true, migration_134: 0 });
        await adminPool.query(`DROP PUBLICATION ${publicationName}`);

        const writer = await writerPool.connect();
        let writerFinished = false;
        try {
          await writer.query("BEGIN");
          const writerPid = await writer.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid()::int AS pid");
          const pid = writerPid.rows[0]?.pid;
          assert.ok(pid);
          await writer.query(`LOCK TABLE ${schemaName}.governed_remediation_cas_transitions IN ROW EXCLUSIVE MODE`);
          const writerXid = await writer.query<{ xid: string | null }>(
            "SELECT pg_catalog.pg_current_xact_id_if_assigned()::text AS xid",
          );
          assert.equal(writerXid.rows[0]?.xid, null, "the lock holder must stay invisible to the XID quiescence pass");

          const migration = runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 134));
          let migrationSettled = false;
          void migration.then(
            () => {
              migrationSettled = true;
            },
            () => {
              migrationSettled = true;
            },
          );
          const relationName = `${schemaName}.governed_remediation_cas_transitions`;
          const deadline = Date.now() + 10_000;
          let blocked = false;
          while (Date.now() < deadline) {
            const waiter = await adminPool.query<{ blocked: boolean }>(
              `
                SELECT COALESCE(pg_catalog.bool_or(
                  lock_row.mode = 'AccessExclusiveLock'
                  AND NOT lock_row.granted
                  AND lock_row.pid <> $2
                  AND $2 = ANY(pg_catalog.pg_blocking_pids(lock_row.pid))
                ), false) AS blocked
                FROM pg_catalog.pg_locks AS lock_row
                WHERE lock_row.relation = pg_catalog.to_regclass($1)
              `,
              [relationName, pid],
            );
            if (waiter.rows[0]?.blocked) {
              blocked = true;
              break;
            }
            assert.equal(migrationSettled, false, "migration settled before reaching the replacement lock");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(blocked, true, "migration never waited on the writer's bridge-table lock");

          await writer.query(`
            INSERT INTO governed_remediation_cas_transitions (
              aggregate_kind, aggregate_id, idempotency_key, request_sha256,
              expected_revision, resulting_revision, from_state, to_state, recorded_at
            ) VALUES (
              'state', 'race-proof', 'race-proof', repeat('a', 64),
              0, 1, 'awaiting_secure_input', 'applying', '2026-08-09T00:00:00.000Z'
            )
          `);
          await writer.query("COMMIT");
          writerFinished = true;

          await assert.rejects(migration, /bootstrap relations contain rows/u);
        } finally {
          if (!writerFinished) await writer.query("ROLLBACK").catch(() => undefined);
          writer.release();
        }

        const durable = await adminPool.query<{ row_count: number; migration_134: number }>(`
          SELECT
            (SELECT COUNT(*)::int FROM ${schemaName}.governed_remediation_cas_transitions
              WHERE aggregate_id = 'race-proof') AS row_count,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 134) AS migration_134
        `);
        assert.deepEqual(durable.rows[0], { row_count: 1, migration_134: 0 });
      } finally {
        await migrationClient.close();
        await writerPool.end();
        await adminPool.query(`DROP PUBLICATION IF EXISTS ${publicationName}`);
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );

  postgresIt(
    "refuses an unowned local dependency before resetting the mesh provenance column",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `mesh_bridge_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 1 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const migrationPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
      const migrationClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: migrationPool },
      );

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        const setupStop: PostgresMigration = {
          version: 137,
          name: "mesh_bridge_setup_stop",
          sql: "DO $setup$ BEGIN RAISE EXCEPTION 'mesh_bridge_setup_stop'; END $setup$;",
        };
        await assert.rejects(
          runPostgresMigrations(migrationClient, [...POSTGRES_MIGRATIONS.slice(0, 136), setupStop]),
          /mesh_bridge_setup_stop/u,
        );
        await adminPool.query(`
          CREATE TABLE ${schemaName}.extra_mesh_inheritance_child ()
            INHERITS (${schemaName}.mesh_capability_node_admissions)
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 137)),
          /exact current empty v137 shape/u,
        );
        const inherited = await adminPool.query<{ column_exists: boolean; migration_137: number }>(`
          SELECT
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = pg_catalog.to_regclass('${schemaName}.extra_mesh_inheritance_child')
                AND attribute.attname = 'provenance_kind'
                AND NOT attribute.attisdropped
            ) AS column_exists,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 137) AS migration_137
        `);
        assert.deepEqual(inherited.rows[0], { column_exists: true, migration_137: 0 });
        await adminPool.query(`DROP TABLE ${schemaName}.extra_mesh_inheritance_child`);

        await adminPool.query(`
          COMMENT ON COLUMN ${schemaName}.mesh_capability_node_admissions.provenance_kind
            IS 'operator-owned provenance note'
        `);
        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 137)),
          /exact current empty v137 shape/u,
        );
        const columnPosture = await adminPool.query<{ comment: string | null; migration_137: number }>(`
          SELECT
            pg_catalog.col_description(
              pg_catalog.to_regclass('${schemaName}.mesh_capability_node_admissions'),
              attribute.attnum
            ) AS comment,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 137) AS migration_137
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = pg_catalog.to_regclass('${schemaName}.mesh_capability_node_admissions')
            AND attribute.attname = 'provenance_kind'
        `);
        assert.deepEqual(columnPosture.rows[0], { comment: "operator-owned provenance note", migration_137: 0 });
        await adminPool.query(`
          COMMENT ON COLUMN ${schemaName}.mesh_capability_node_admissions.provenance_kind IS NULL
        `);

        await adminPool.query(`
          CREATE INDEX extra_mesh_provenance_index
            ON ${schemaName}.mesh_capability_node_admissions (provenance_kind)
        `);

        await assert.rejects(
          runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 137)),
          /exact current empty v137 shape/u,
        );
        const durable = await adminPool.query<{ object_exists: boolean; migration_137: number }>(`
          SELECT
            pg_catalog.to_regclass('${schemaName}.extra_mesh_provenance_index') IS NOT NULL AS object_exists,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 137) AS migration_137
        `);
        assert.deepEqual(durable.rows[0], { object_exists: true, migration_137: 0 });
        await adminPool.query(`DROP INDEX ${schemaName}.extra_mesh_provenance_index`);

        const converged = await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 138));
        assert.deepEqual(converged.appliedVersions, [137, 138]);
        const ledger = await adminPool.query<{ migration_137: number; migration_138: number }>(`
          SELECT
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 137) AS migration_137,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 138) AS migration_138
        `);
        assert.deepEqual(ledger.rows[0], { migration_137: 1, migration_138: 1 });
      } finally {
        await migrationClient.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );

  postgresIt(
    "rejects non-canonical named CHECK posture and literal case before v140 is ledgered",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `v140_check_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 1 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const migrationPool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
      const migrationClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: migrationPool },
      );

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS.slice(0, 139));

        await adminPool.query(`
          DROP INDEX ${schemaName}.idx_audit_events_stream_time;
          CREATE UNIQUE INDEX idx_audit_events_stream_time
            ON ${schemaName}.audit_events (stream_name, occurred_at DESC, event_sequence DESC)
        `);
        await assert.rejects(runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS), (error) =>
          errorChainContains(error, /drifted ordered index idx_audit_events_stream_time/u),
        );
        const orderedIndexDrift = await adminPool.query<{ indisunique: boolean; migration_140: number }>(`
          SELECT
            index_row.indisunique,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 140) AS migration_140
          FROM pg_catalog.pg_index AS index_row
          WHERE index_row.indexrelid = pg_catalog.to_regclass('${schemaName}.idx_audit_events_stream_time')
        `);
        assert.deepEqual(orderedIndexDrift.rows[0], { indisunique: true, migration_140: 0 });
        await adminPool.query(`
          DROP INDEX ${schemaName}.idx_audit_events_stream_time;
          CREATE INDEX idx_audit_events_stream_time
            ON ${schemaName}.audit_events (stream_name, occurred_at DESC, event_sequence DESC)
        `);

        await adminPool.query(`
          DROP INDEX ${schemaName}.idx_approvals_status_expires_at;
          CREATE INDEX idx_approvals_status_expires_at
            ON ${schemaName}.approvals (status, approval_id)
        `);
        await assert.rejects(runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS), (error) =>
          errorChainContains(error, /drifted approvals status\/expiry index/u),
        );
        const approvalsIndexDrift = await adminPool.query<{ predicate: string | null; migration_140: number }>(`
          SELECT
            pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, false) AS predicate,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 140) AS migration_140
          FROM pg_catalog.pg_index AS index_row
          WHERE index_row.indexrelid = pg_catalog.to_regclass('${schemaName}.idx_approvals_status_expires_at')
        `);
        assert.deepEqual(approvalsIndexDrift.rows[0], { predicate: null, migration_140: 0 });
        await adminPool.query(`
          DROP INDEX ${schemaName}.idx_approvals_status_expires_at;
          CREATE INDEX idx_approvals_status_expires_at
            ON ${schemaName}.approvals (status, approval_id)
            WHERE expires_at IS NOT NULL
        `);

        await adminPool.query(`
          ALTER TABLE ${schemaName}.external_source_configs
            ADD CONSTRAINT external_source_configs_input_flavor_posix_check
            CHECK(input_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl', 'posix')) NOT VALID
        `);
        await assert.rejects(runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS), (error) =>
          errorChainContains(error, /drifted constraint external_source_configs_input_flavor_posix_check/u),
        );
        const unvalidated = await adminPool.query<{ convalidated: boolean; migration_140: number }>(`
          SELECT
            constraint_row.convalidated,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 140) AS migration_140
          FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = pg_catalog.to_regclass('${schemaName}.external_source_configs')
            AND constraint_row.conname = 'external_source_configs_input_flavor_posix_check'
        `);
        assert.deepEqual(unvalidated.rows[0], { convalidated: false, migration_140: 0 });
        await adminPool.query(`
          ALTER TABLE ${schemaName}.external_source_configs
            DROP CONSTRAINT external_source_configs_input_flavor_posix_check
        `);

        await adminPool.query(`
          ALTER TABLE ${schemaName}.chat_routed_context_snapshots
            ADD CONSTRAINT chat_routed_context_snapshots_schema_version_v2_check
            CHECK(schema_version IN ('CHAT.ROUTED-CONTEXT-SNAPSHOT.V1', 'chat.routed-context-snapshot.v2'))
        `);
        await assert.rejects(runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS), (error) =>
          errorChainContains(error, /drifted constraint chat_routed_context_snapshots_schema_version_v2_check/u),
        );
        const caseDrift = await adminPool.query<{ expression: string; migration_140: number }>(`
          SELECT
            pg_catalog.pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false) AS expression,
            (SELECT COUNT(*)::int FROM ${schemaName}.schema_migrations WHERE version = 140) AS migration_140
          FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = pg_catalog.to_regclass('${schemaName}.chat_routed_context_snapshots')
            AND constraint_row.conname = 'chat_routed_context_snapshots_schema_version_v2_check'
        `);
        assert.match(caseDrift.rows[0]?.expression ?? "", /CHAT\.ROUTED-CONTEXT-SNAPSHOT\.V1/u);
        assert.equal(caseDrift.rows[0]?.migration_140, 0);
        await adminPool.query(`
          ALTER TABLE ${schemaName}.chat_routed_context_snapshots
            DROP CONSTRAINT chat_routed_context_snapshots_schema_version_v2_check
        `);

        const converged = await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
        assert.deepEqual(converged.appliedVersions, [140, 141, 142, 143, 144]);
      } finally {
        await migrationClient.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});
