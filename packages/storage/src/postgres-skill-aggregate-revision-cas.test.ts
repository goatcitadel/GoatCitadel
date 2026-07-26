import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import { Pool } from "pg";
import { SkillAggregateRevisionRepository } from "./skill-aggregate-revision-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres backfills and fences skill aggregate revisions",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_skill_aggregate_cas_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const migrationPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: migrationPool },
    );
    let clientA: PostgresSyncDatabaseClient | undefined;
    let clientB: PostgresSyncDatabaseClient | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(
        migrationClient,
        POSTGRES_MIGRATIONS.filter((migration) => migration.version < 106),
      );
      await migrationPool.query(`
        INSERT INTO skill_state (skill_id, state, updated_at)
        VALUES ('pg.skill.backfilled', 'enabled', '2026-07-13T02:00:00.000Z');
        INSERT INTO system_settings (setting_key, value_json, updated_at)
        VALUES ('skill_activation_policy_v1', '{}', '2026-07-13T02:00:00.000Z');
      `);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);

      clientA = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-skill-aggregate-cas-a-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientB = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: `gc-skill-aggregate-cas-b-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      clientA.prepare("SELECT 1 AS ready").get();
      clientB.prepare("SELECT 1 AS ready").get();
      assert.deepEqual(
        clientA
          .prepare("SELECT current_schema() AS current_schema, current_setting('client_encoding') AS client_encoding")
          .get(),
        { current_schema: schemaName, client_encoding: "UTF8" },
      );
      assert.deepEqual(
        clientA
          .prepare(
            `
              SELECT namespace.nspname AS table_schema
              FROM pg_class AS relation
              INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
              WHERE relation.oid = 'skill_aggregate_revisions'::regclass
            `,
          )
          .get(),
        { table_schema: schemaName },
      );
      assert.deepEqual(clientA.prepare("SELECT version, name FROM schema_migrations WHERE version = 106").get(), {
        version: 106,
        name: "skill_aggregate_revision_cas",
      });
      const revisionConstraints = clientA
        .prepare(
          `
            SELECT pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conrelid = 'skill_aggregate_revisions'::regclass
              AND contype = 'c'
            ORDER BY conname
          `,
        )
        .all<{ definition: string }>();
      assert.ok(
        revisionConstraints.some(
          ({ definition }) => definition.includes("aggregate_kind") && definition.includes("runtime_skill"),
        ),
        `missing aggregate-kind CHECK: ${JSON.stringify(revisionConstraints)}`,
      );
      clientA.exec("CREATE TABLE skill_revision_probe (probe_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      clientA.prepare("INSERT INTO skill_revision_probe (probe_id, value) VALUES ('pg', 'initial')").run();

      const revisionsA = new SkillAggregateRevisionRepository(clientA);
      const revisionsB = new SkillAggregateRevisionRepository(clientB);
      assert.equal(revisionsA.get("runtime_skill", "pg.skill.backfilled")?.revision, 1);
      assert.equal(revisionsA.get("activation_policy", "global")?.revision, 1);

      const winner = revisionsA.runWithRevision("runtime_skill", "pg.skill.backfilled", 1, () => {
        clientA?.prepare("UPDATE skill_revision_probe SET value = 'winner' WHERE probe_id = 'pg'").run();
        return { value: "winner", changed: true };
      });
      assert.equal(winner.revision, 2);

      let staleMutationCalled = false;
      assert.throws(
        () =>
          revisionsB.runWithRevision("runtime_skill", "pg.skill.backfilled", 1, () => {
            staleMutationCalled = true;
            return { value: "stale", changed: true };
          }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.equal(error.code, "WRITE_CONFLICT");
          assert.deepEqual(error.details, {
            resourceKind: "runtime_skill",
            resourceId: "pg.skill.backfilled",
            expectedRevision: 1,
            currentRevision: 2,
          });
          return true;
        },
      );
      assert.equal(staleMutationCalled, false);

      const batch = revisionsA.runWithRevisions(
        [
          { aggregateKind: "activation_policy", aggregateId: "global", expectedRevision: 1 },
          { aggregateKind: "candidate_skill", aggregateId: "pg.candidate.lazy", expectedRevision: 1 },
        ],
        () => ({ value: "activated", changed: true }),
      );
      assert.ok(batch.revisions.every((record) => record.revision === 2));
      assert.equal(revisionsB.get("candidate_skill", "pg.candidate.lazy")?.revision, 2);

      const invalidInsert = clientA.prepare(`
        INSERT INTO skill_aggregate_revisions (
          aggregate_kind, aggregate_id, revision, created_at, updated_at
        ) VALUES (@aggregateKind, @aggregateId, @revision, @createdAt, @updatedAt)
      `);
      const valid = {
        aggregateKind: "runtime_skill",
        aggregateId: "pg.skill.invalid",
        revision: 1,
        createdAt: "2026-07-13T02:00:00.000Z",
        updatedAt: "2026-07-13T02:00:00.000Z",
      };
      for (const input of [
        { ...valid, aggregateKind: "unknown" },
        { ...valid, aggregateId: " pg.skill.padded " },
        { ...valid, revision: 0 },
        { ...valid, createdAt: " " },
        { ...valid, updatedAt: " " },
      ]) {
        assert.throws(() => invalidInsert.run(input));
      }
    } finally {
      clientB?.close();
      clientA?.close();
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

test(
  "real Postgres preserves legacy v106 skill checks through the v123 repair",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_skill_aggregate_upgrade_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const migrationPool = new Pool({ connectionString: scopedUrl.toString() });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: migrationPool },
    );

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(
        migrationClient,
        POSTGRES_MIGRATIONS.filter((migration) => migration.version < 106),
      );
      await migrationPool.query("DROP TABLE skill_aggregate_revisions");
      await runPostgresMigrations(
        migrationClient,
        POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 106),
      );

      const readConstraints = async () =>
        (
          await migrationPool.query<{ conname: string; definition: string }>(`
            SELECT conname, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conrelid = 'skill_aggregate_revisions'::regclass
              AND contype = 'c'
            ORDER BY conname
          `)
        ).rows;
      const beforeRepair = await readConstraints();
      assert.equal(beforeRepair.length, 5);

      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      assert.deepEqual(await readConstraints(), beforeRepair);
      assert.deepEqual(
        (await migrationPool.query("SELECT version, name FROM schema_migrations WHERE version = 123")).rows,
        [{ version: 123, name: "skill_aggregate_revision_constraint_repair" }],
      );
      await assert.rejects(
        migrationPool.query(`
          INSERT INTO skill_aggregate_revisions (
            aggregate_kind, aggregate_id, revision, created_at, updated_at
          ) VALUES ('unknown', 'bad', 1, '2026-07-13T02:00:00.000Z', '2026-07-13T02:00:00.000Z')
        `),
      );
    } finally {
      await migrationPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);
