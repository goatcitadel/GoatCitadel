import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
const INDEX_NAME = "idx_chat_turn_traces_user_message";

async function withSchema(
  prefix: string,
  run: (ctx: { admin: Pool; schema: string; migrations: PostgresDatabaseClient }) => Promise<void>,
) {
  assert.ok(connectionString);
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, new RegExp(`^${prefix}_[a-f0-9]{32}$`));
  const admin = new Pool({ connectionString });
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
  const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: "postgres" });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run({ admin, schema, migrations });
  } finally {
    await migrations.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function userMessageIndexDefinitions(admin: Pool, schema: string): Promise<string[]> {
  const result = await admin.query<{ indexdef: string }>(
    `SELECT regexp_replace(indexdef, $2, '', 'g') AS indexdef
     FROM pg_indexes WHERE schemaname = $1 AND tablename = 'chat_turn_traces' AND indexname = $3`,
    [schema, `${schema}[.]`, INDEX_NAME],
  );
  return result.rows.map((row) => row.indexdef);
}

test("real PostgreSQL fresh installs create the chat turn trace user-message index", { skip }, async () => {
  await withSchema("trace_user_msg_fresh", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    assert.equal((await userMessageIndexDefinitions(admin, schema)).length, 1);
  });
});

test("real PostgreSQL upgraded installs get an index identical to a fresh install", { skip }, async () => {
  const upTo = (version: number) => POSTGRES_MIGRATIONS.filter((migration) => migration.version <= version);
  let freshDefinitions: string[] = [];
  await withSchema("trace_user_msg_ref", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    freshDefinitions = await userMessageIndexDefinitions(admin, schema);
  });
  assert.equal(freshDefinitions.length, 1);

  await withSchema("trace_user_msg_upgrade", async ({ admin, schema, migrations }) => {
    // v2 renders from the current blueprint, so an install whose v2 predates the
    // index is simulated by dropping it before v219 runs.
    await runPostgresMigrations(migrations, upTo(218));
    await admin.query(`DROP INDEX ${schema}.${INDEX_NAME}`);
    assert.deepEqual(await userMessageIndexDefinitions(admin, schema), []);

    const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    assert.deepEqual(migrated.appliedVersions, [219, 220, 221, 222, 223, 224]);
    assert.deepEqual(await userMessageIndexDefinitions(admin, schema), freshDefinitions);

    // Re-running is a no-op.
    const rerun = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    assert.deepEqual(rerun.appliedVersions, []);
  });
});
