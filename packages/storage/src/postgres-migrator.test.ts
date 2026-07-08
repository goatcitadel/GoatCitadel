import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createDatabase } from "./sqlite.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { applyPostgresMigrationsSync, runPostgresMigrations } from "./postgres/migrator.js";
import type { PostgresMigration } from "./postgres/migrations.js";

interface QueryCall {
  sql: string;
  params?: readonly unknown[];
}

type QueryRows = QueryResultRow[];
type QueryResponse = QueryRows | Error;

class FakePool {
  public readonly calls: QueryCall[] = [];
  public readonly clients: FakePoolClient[] = [];
  private readonly responses: QueryResponse[];

  public constructor(responses: QueryResponse[] = []) {
    this.responses = [...responses];
  }

  public async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    const response = this.responses.shift() ?? [];
    if (response instanceof Error) {
      throw response;
    }
    return { rows: response as T[] };
  }

  public async connect(): Promise<PoolClient> {
    const client = new FakePoolClient();
    this.clients.push(client);
    return client as unknown as PoolClient;
  }

  public async end(): Promise<void> {
    // no-op for migrator tests
  }
}

class FakePoolClient {
  public readonly calls: QueryCall[] = [];
  public released = false;

  public async query(sql: string, params?: readonly unknown[]): Promise<{ rows: QueryRows }> {
    this.calls.push({ sql, params });
    return { rows: [] };
  }

  public release(): void {
    this.released = true;
  }
}

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function asPool(pool: FakePool): Pool {
  return pool as unknown as Pool;
}

function migrations(): PostgresMigration[] {
  return [
    {
      version: 1,
      name: "create_existing",
      sql: "CREATE TABLE existing_table(id INTEGER PRIMARY KEY)",
    },
    {
      version: 2,
      name: "create_new",
      sql: "CREATE TABLE new_table(id INTEGER PRIMARY KEY)",
    },
  ];
}

function createTempDatabasePath(prefix: string): string {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return dbPath;
}

describe("Postgres migrator", () => {
  it("runs only unapplied async migrations and marks them inside the transaction", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], [{ version: 1, name: "create_existing" }]]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await runPostgresMigrations(client, migrations());

    assert.deepEqual(result, { appliedVersions: [2], latestVersion: 2 });
    assert.equal(pool.clients.length, 1);
    assert.deepEqual(
      pool.clients[0]?.calls.map((call) => call.sql.trim()),
      [
        "BEGIN",
        "CREATE TABLE new_table(id INTEGER PRIMARY KEY)",
        `INSERT INTO schema_migrations (version, name, applied_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (version) DO NOTHING`,
        "COMMIT",
      ],
    );
    assert.deepEqual(pool.clients[0]?.calls[2]?.params, [2, "create_new"]);
    assert.equal(pool.clients[0]?.released, true);
  });

  it("rejects when an applied async migration version was recorded under a different name", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], [{ version: 1, name: "branch_only_migration" }]]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      runPostgresMigrations(client, migrations()),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("version 1") &&
        error.message.includes("branch_only_migration") &&
        error.message.includes("create_existing"),
    );
    assert.equal(pool.clients.length, 0);
  });

  it("refuses to skip a sync migration whose ledger row was written by a divergent lineage", () => {
    const db = createDatabase({ dbPath: createTempDatabasePath("goatcitadel-postgres-migrator-drift") });
    applyPostgresMigrationsSync(db, {
      migrationsTable: "drift_schema_migrations",
      migrations: [
        { version: 1, name: "create_existing", sql: "CREATE TABLE existing_table(id INTEGER PRIMARY KEY)" },
        { version: 2, name: "branch_only_migration", sql: "CREATE TABLE branch_table(id INTEGER PRIMARY KEY)" },
      ],
    });

    assert.throws(
      () => applyPostgresMigrationsSync(db, { migrationsTable: "drift_schema_migrations", migrations: migrations() }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("version 2") &&
        error.message.includes("branch_only_migration") &&
        error.message.includes("create_new"),
    );

    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("new_table") as
      | { name: string }
      | undefined;
    assert.equal(tableRow, undefined);
  });

  it("reports zero latest version for an empty async migration set", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], []]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await runPostgresMigrations(client, []);

    assert.deepEqual(result, { appliedVersions: [], latestVersion: 0 });
    assert.equal(pool.clients.length, 0);
  });

  it("applies sync migrations idempotently through the DatabaseClient transaction API", () => {
    const db = createDatabase({ dbPath: createTempDatabasePath("goatcitadel-postgres-migrator") });
    const testMigrations = migrations();

    applyPostgresMigrationsSync(db, {
      migrationsTable: "custom_schema_migrations",
      migrations: testMigrations,
    });
    applyPostgresMigrationsSync(db, {
      migrationsTable: "custom_schema_migrations",
      migrations: testMigrations,
    });

    const migrationRows = db
      .prepare("SELECT version, name FROM custom_schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number; name: string }>;
    assert.deepEqual(
      migrationRows.map((row) => ({ version: row.version, name: row.name })),
      [
        { version: 1, name: "create_existing" },
        { version: 2, name: "create_new" },
      ],
    );
    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("new_table") as
      | { name: string }
      | undefined;
    assert.equal(tableRow?.name, "new_table");
  });

  it("quotes a reserved-word migrations table so the sync migrator does not emit invalid DDL", () => {
    const db = createDatabase({ dbPath: createTempDatabasePath("goatcitadel-postgres-migrator-reserved") });

    // `order` is a reserved word; without identifier quoting the CREATE TABLE /
    // SELECT / INSERT statements would be syntax errors.
    assert.doesNotThrow(() =>
      applyPostgresMigrationsSync(db, {
        migrationsTable: "order",
        migrations: migrations(),
      }),
    );

    const migrationRows = db.prepare(`SELECT version, name FROM "order" ORDER BY version ASC`).all() as Array<{
      version: number;
      name: string;
    }>;
    assert.deepEqual(
      migrationRows.map((row) => ({ version: row.version, name: row.name })),
      [
        { version: 1, name: "create_existing" },
        { version: 2, name: "create_new" },
      ],
    );
  });
});
