import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresSql = POSTGRES_MIGRATIONS.find((migration) => migration.version === 118)?.sql ?? "";

after(() => db.close());

const TABLE_COLUMNS = {
  remote_worker_bootstrap_request_nonces: [
    "registry_workspace_id",
    "worker_id",
    "target_worker_generation",
    "bootstrap_id",
    "nonce_sha256",
    "request_timestamp",
    "consumed_at",
    "expires_at",
  ],
  remote_worker_credential_request_nonces: [
    "registry_workspace_id",
    "worker_id",
    "worker_generation",
    "credential_generation",
    "credential_id",
    "nonce_sha256",
    "request_timestamp",
    "consumed_at",
    "expires_at",
  ],
} as const;

describe("HX-501B1 remote worker request-nonce schema parity", () => {
  it("keeps SQLite 176 and PostgreSQL 118 paired across exactly two hash-only tables", () => {
    assert.equal(
      postgresSql.match(/CREATE TABLE IF NOT EXISTS remote_worker_/gu)?.length,
      2,
      "PostgreSQL 118 must add exactly the two nonce tables",
    );
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(postgresSql, new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"));
      }
      assert.equal(columns[0], "registry_workspace_id", `${table} must prefix identity with registry workspace`);
    }
  });

  it("stores only the nonce digest and never raw authorization material in either dialect", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.equal(sql.match(/nonce_sha256/gu)!.length >= 2, true);
      assert.doesNotMatch(
        sql,
        /nonce_value|nonce_raw|authorization|tls_exporter|certificate|public_key|\bproof\b|body/iu,
      );
    }
  });

  it("pairs the exact 60-second expiry and the database-clock request window", () => {
    const sqliteSql = schemaSql(db);
    assert.equal((sqliteSql.match(/\) = 60000\)/gu) ?? []).length, 2);
    assert.match(sqliteSql, /abs\(julianday\(NEW\.request_timestamp\) - julianday\('now'\)\) \* 86400\.0 > 60\.0/u);
    assert.equal(
      (postgresSql.match(/EXTRACT\(EPOCH FROM \(gc_try_parse_timestamptz\(expires_at\)[\s\S]*?\) = 60\)/gu) ?? [])
        .length,
      2,
    );
    assert.match(
      postgresSql,
      /abs\(EXTRACT\(EPOCH FROM \(gc_try_parse_timestamptz\(NEW\.request_timestamp\) - database_now\)\)\) > 60/u,
    );
  });

  it("binds the exact authority through complete composite foreign keys with minimal parent unique keys", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(
        sql,
        /FOREIGN KEY\(registry_workspace_id, bootstrap_id, worker_id, target_worker_generation\)[\s\S]*REFERENCES remote_worker_bootstrap_requests/u,
      );
      assert.match(
        sql,
        /FOREIGN KEY\(registry_workspace_id, worker_id, worker_generation, credential_generation, credential_id\)[\s\S]*REFERENCES remote_worker_runtime_credentials/u,
      );
    }
    // SQLite realises the parent unique key as a UNIQUE index; PostgreSQL as a
    // UNIQUE constraint (its foreign keys require a constraint, not a bare index).
    const parentIndexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_nonce_authority'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.deepEqual(parentIndexes.sort(), [
      "idx_remote_worker_bootstrap_requests_nonce_authority",
      "idx_remote_worker_runtime_credentials_nonce_authority",
    ]);
    assert.match(postgresSql, /ADD CONSTRAINT uq_remote_worker_bootstrap_requests_nonce_authority\s+UNIQUE/u);
    assert.match(postgresSql, /ADD CONSTRAINT uq_remote_worker_runtime_credentials_nonce_authority\s+UNIQUE/u);
  });

  it("keeps consumed nonces immutable and deletable only after database-clock expiry in both dialects", () => {
    const sqliteSql = schemaSql(db);
    for (const table of Object.keys(TABLE_COLUMNS)) {
      assert.match(sqliteSql, new RegExp(`trg_${table}_no_update`, "u"));
      assert.match(sqliteSql, new RegExp(`trg_${table}_no_delete`, "u"));
      assert.match(postgresSql, new RegExp(`trg_${table}_no_update`, "u"));
      assert.match(postgresSql, new RegExp(`trg_${table}_no_delete`, "u"));
    }
    assert.match(sqliteSql, /OLD\.expires_at > strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)/u);
    assert.match(postgresSql, /gc_try_parse_timestamptz\(OLD\.expires_at\) > clock_timestamp\(\)/u);
  });

  it("pairs the authority-currency fencing across dialects", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      // Bootstrap: still-current target (next monotonic generation) and not-yet-consumed.
      assert.match(sql, /COALESCE\(MAX\(generation\.worker_generation\), 0\) \+ 1/u);
      assert.match(sql, /remote_worker_generations generation[\s\S]*generation\.bootstrap_id = NEW\.bootstrap_id/u);
      // Credential: latest fresh credential of the latest worker generation, no control.
      assert.match(sql, /MAX\(credential\.credential_generation\)/u);
      assert.match(sql, /remote_worker_generation_controls control/u);
    }
  });

  it("keeps PostgreSQL 118 additive and free of state-changing DML or runtime claims", () => {
    assert.doesNotMatch(
      postgresSql,
      /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+remote_worker|DROP\s+TABLE|TRUNCATE\s+TABLE)\b/iu,
    );
    assert.doesNotMatch(postgresSql, /gateway_route|readiness|listener|scheduler|assignment|inference|cell/iu);
    // The only frozen-table mutation is the minimal parent UNIQUE key.
    assert.equal(postgresSql.match(/ALTER TABLE /gu)?.length, 2);
    assert.doesNotMatch(postgresSql, /ALTER TABLE[^;]*(?:ADD COLUMN|DROP|ALTER COLUMN|RENAME)/iu);
  });
});

function tableColumns(client: DatabaseClient, table: string): string[] {
  return (client.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name);
}

function schemaSql(client: DatabaseClient): string {
  return (
    client
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE (type = 'table' OR type = 'trigger') AND name LIKE '%remote_worker%request_nonce%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql}`)
    .join("\n");
}
