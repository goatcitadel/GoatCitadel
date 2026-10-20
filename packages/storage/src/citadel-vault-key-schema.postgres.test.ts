import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
const legacySealed = JSON.stringify({ iv: "synthetic-iv", ciphertext: "synthetic-ciphertext", tag: "synthetic-tag" });
const VAULT_TABLES = [
  "citadel_vault_secrets",
  "citadel_vault_keys",
  "citadel_vault_key_state",
  "citadel_vault_rotations",
];

interface ColumnShape {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

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

async function vaultShape(admin: Pool, schema: string) {
  const columns = await admin.query<ColumnShape>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2)
     ORDER BY table_name, column_name`,
    [schema, VAULT_TABLES],
  );
  const indexes = await admin.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, regexp_replace(indexdef, $3, '', 'g') AS indexdef
     FROM pg_indexes WHERE schemaname = $1 AND tablename = ANY($2) ORDER BY indexname`,
    [schema, VAULT_TABLES, `${schema}\\.`],
  );
  return { columns: columns.rows, indexes: indexes.rows };
}

test("real PostgreSQL fresh installs create the Vault key tables in the canonical shape", { skip }, async () => {
  await withSchema("vault_keys_fresh", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    const shape = await vaultShape(admin, schema);
    assert.deepEqual(
      shape.columns
        .filter((column) => column.table_name === "citadel_vault_secrets")
        .map((column) => column.column_name),
      [
        "chamber_id",
        "citadel_id",
        "created_at",
        "envelope_version",
        "key_id",
        "sealed_value_json",
        "secret_id",
        "secret_name",
        "updated_at",
      ],
    );
    assert.ok(shape.indexes.some((index) => index.indexname === "idx_citadel_vault_keys_active"));
    assert.ok(shape.indexes.some((index) => index.indexname === "idx_citadel_vault_rotations_open"));
  });
});

test("real PostgreSQL upgraded installs converge the Vault key tables and keep sealed rows", { skip }, async () => {
  const upTo = (version: number) => POSTGRES_MIGRATIONS.filter((migration) => migration.version <= version);
  let freshShape: Awaited<ReturnType<typeof vaultShape>> | undefined;
  await withSchema("vault_keys_reference", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    freshShape = await vaultShape(admin, schema);
  });

  await withSchema("vault_keys_upgrade", async ({ admin, schema, migrations }) => {
    // v2 renders from the current blueprint, so an install whose v2 predates
    // these tables is simulated by removing them before v217 runs.
    await runPostgresMigrations(migrations, upTo(216));
    await admin.query(`
      DROP TABLE ${schema}.citadel_vault_keys, ${schema}.citadel_vault_key_state, ${schema}.citadel_vault_rotations CASCADE;
      DROP INDEX ${schema}.idx_citadel_vault_secrets_key;
      ALTER TABLE ${schema}.citadel_vault_secrets DROP COLUMN chamber_id, DROP COLUMN key_id, DROP COLUMN envelope_version;
    `);
    await admin.query(
      `INSERT INTO ${schema}.citadel_vault_secrets (secret_id, citadel_id, secret_name, sealed_value_json, created_at, updated_at)
       VALUES ('s1', 'c1', 'Legacy', $1, '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z')`,
      [legacySealed],
    );

    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);

    assert.deepEqual(await vaultShape(admin, schema), freshShape);
    const row = await admin.query(`SELECT * FROM ${schema}.citadel_vault_secrets WHERE secret_id = 's1'`);
    assert.equal(row.rows[0]?.sealed_value_json, legacySealed);
    assert.equal(Number(row.rows[0]?.envelope_version), 1);
    assert.equal(row.rows[0]?.key_id, null);
    assert.equal(row.rows[0]?.chamber_id, null);
  });
});
