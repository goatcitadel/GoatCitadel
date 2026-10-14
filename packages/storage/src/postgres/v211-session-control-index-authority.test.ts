import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import { assertPostgresMigrationIntegrity } from "./migrator.js";
import { buildPostgresSchemaShapeManifest } from "./schema-shape.js";
import { __sqliteInternals } from "../sqlite.js";

const migration = POSTGRES_MIGRATIONS.find((entry) => entry.version === 211)!;
const tableNames = new Set([
  "chat_session_control_auth_revoke_operation_targets",
  "chat_session_lifecycle_intents",
  "chat_session_mutation_admission_events",
  "chat_session_mutation_admissions",
  "chat_turn_capability_profile_incarnation_bindings",
  "chat_turn_mutation_admission_durable_bindings",
  "chat_turn_session_incarnation_bindings",
  "chat_turn_user_input_continuation_seals",
]);
const canonicalIndexes = buildPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS)
  .indexes.filter((index) => tableNames.has(index.tableName) && index.unique && index.predicate === null)
  .sort((left, right) => left.name.localeCompare(right.name));
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = connectionString ? it : it.skip;

describe("session-control unique-index forward authority", () => {
  it("pins generated SQL and all nineteen canonical unique-index identities", () => {
    assert.equal(migration.name, "session_control_unique_index_authority");
    assert.doesNotThrow(() => assertPostgresMigrationIntegrity(migration));
    assert.throws(
      () => assertPostgresMigrationIntegrity({ ...migration, sql: migration.sql + " SELECT 1;" }),
      /integrity hash mismatch/iu,
    );
    assert.equal(canonicalIndexes.length, 19);
    const renderedNames = [...migration.sql.matchAll(/IF pg_catalog.to_regclass\('([^']+)'\) IS NULL THEN/gu)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(renderedNames, canonicalIndexes.map((index) => index.name).sort());
    for (const index of canonicalIndexes) {
      assert.equal(index.method, "btree");
      assert.equal(index.predicate, null);
    }
    assert.doesNotMatch(migration.sql, /\b(?:DROP|DELETE|TRUNCATE|CREATE\s+(?:UNIQUE\s+)?INDEX)\b/iu);
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(264), migration.name);
  });

  it("leaves SQLite schema, data, and historical ledger bytes unchanged", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE sentinel (id TEXT PRIMARY KEY, value TEXT UNIQUE); INSERT INTO sentinel VALUES ('a', 'kept'); CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT); INSERT INTO schema_migrations VALUES (263, 'approval_execution_linkage_index_sort_convergence');",
      );
      const snapshot = () => ({
        schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all(),
        data: db.prepare("SELECT * FROM sentinel").all(),
        ledger: db.prepare("SELECT * FROM schema_migrations").all(),
      });
      const before = snapshot();
      __sqliteInternals.applySchemaMigrationForTest(264, db);
      __sqliteInternals.applySchemaMigrationForTest(264, db);
      assert.deepEqual(snapshot(), before);
    } finally {
      db.close();
    }
  });

  postgresIt("renames backing indexes without replacing rows, constraints, dependent FKs, or indexes", async () => {
    await withLegacyIndexes(async (client) => {
      const before = await snapshot(client);
      await client.query(migration.sql);
      assert.deepEqual(await snapshot(client), before);
      const names = await client.query<{ name: string }>(
        "SELECT relname AS name FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = ANY($1::text[]) ORDER BY relname",
        [canonicalIndexes.map((index) => index.name)],
      );
      assert.deepEqual(names.rows.map((row) => row.name).sort(), canonicalIndexes.map((index) => index.name).sort());
      await client.query(migration.sql);
      assert.deepEqual(await snapshot(client), before);
      await assert.rejects(client.query("INSERT INTO authority_fk VALUES ('missing')"), /foreign key constraint/iu);
    });
  });

  postgresIt("rejects ambiguous constraint lineage and rolls back earlier renames", async () => {
    await withLegacyIndexes(async (client) => {
      const last = canonicalIndexes.at(-1)!;
      await client.query(
        "ALTER TABLE " +
          quote(last.tableName) +
          " ADD CONSTRAINT extra_unique UNIQUE (" +
          last.keys.map(quote).join(", ") +
          ")",
      );
      await rejectsAtomically(client, /unsupported unique-constraint lineage/iu);
    });
  });

  postgresIt("rejects drifted backing indexes and rolls back earlier renames", async () => {
    await withLegacyIndexes(async (client) => {
      const index = await client.query<{ index_name: string }>(
        "SELECT index_relation.relname AS index_name FROM pg_constraint c JOIN pg_class index_relation ON index_relation.oid = c.conindid WHERE c.conrelid = $1::regclass AND c.contype = 'u' ORDER BY index_relation.relname LIMIT 1",
        [canonicalIndexes.at(-1)!.tableName],
      );
      await client.query("ALTER INDEX " + quote(index.rows[0]!.index_name) + " SET (fillfactor = 80)");
      await rejectsAtomically(client, /drifted unique-constraint index/iu);
    });
  });
});

async function withLegacyIndexes(run: (client: PoolClient) => Promise<void>): Promise<void> {
  assert.ok(connectionString);
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const schema = "index_authority_" + randomUUID().replaceAll("-", "");
  try {
    await client.query("CREATE SCHEMA " + quote(schema));
    await client.query("SET search_path TO " + quote(schema));
    for (const tableName of tableNames) {
      const indexes = canonicalIndexes.filter((index) => index.tableName === tableName);
      const columns = [...new Set(indexes.flatMap((index) => index.keys))];
      const definitions = columns.map((column) => quote(column) + " TEXT");
      definitions.push(...indexes.map((index) => "UNIQUE (" + index.keys.map(quote).join(", ") + ")"));
      await client.query("CREATE TABLE " + quote(tableName) + " (" + definitions.join(", ") + ")");
      await client.query(
        "INSERT INTO " +
          quote(tableName) +
          " VALUES (" +
          columns.map((_, position) => "$" + (position + 1)).join(", ") +
          ")",
        columns.map((column) => "kept-" + column),
      );
    }
    await client.query(
      "CREATE TABLE authority_fk (event_key TEXT REFERENCES chat_session_control_auth_revoke_operation_targets(event_idempotency_key))",
    );
    await client.query("INSERT INTO authority_fk VALUES ('kept-event_idempotency_key')");
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    await client.query("DROP SCHEMA IF EXISTS " + quote(schema) + " CASCADE");
    client.release();
    await pool.end();
  }
}

async function snapshot(client: PoolClient) {
  const catalog = await client.query(
    "SELECT c.oid, c.conrelid, c.conindid, c.conkey, c.confrelid, c.confkey, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.connamespace = current_schema()::regnamespace ORDER BY c.oid",
  );
  const indexes = await client.query(
    "SELECT c.oid, i.indrelid, i.indkey, i.indisunique, i.indisvalid, c.reloptions FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relnamespace = current_schema()::regnamespace ORDER BY c.oid",
  );
  const data = [];
  for (const table of [...tableNames, "authority_fk"])
    data.push({ table, rows: (await client.query("SELECT * FROM " + quote(table))).rows });
  return { catalog: catalog.rows, indexes: indexes.rows, data };
}

async function rejectsAtomically(client: PoolClient, expected: RegExp): Promise<void> {
  const before = await snapshot(client);
  const namesBefore = (
    await client.query(
      "SELECT oid, relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY oid",
    )
  ).rows;
  await client.query("BEGIN");
  await assert.rejects(client.query(migration.sql), expected);
  await client.query("ROLLBACK");
  assert.deepEqual(await snapshot(client), before);
  assert.deepEqual(
    (
      await client.query(
        "SELECT oid, relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY oid",
      )
    ).rows,
    namesBefore,
  );
}
