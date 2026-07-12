import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient, DbRunResult, DbStatement } from "./db.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { applyPostgresMigrationsSync, runPostgresMigrations } from "./postgres/migrator.js";
import type { PostgresMigration } from "./postgres/migrations.js";

interface QueryCall {
  sql: string;
  params?: readonly unknown[];
}

type QueryRows = QueryResultRow[];
type QueryResponse = QueryRows | Error;
type TransactionResponse = number | null | Error;

class FakePool {
  public readonly calls: QueryCall[] = [];
  public readonly clients: FakePoolClient[] = [];
  private readonly responses: QueryResponse[];
  private readonly transactionResponses: TransactionResponse[];

  public constructor(responses: QueryResponse[] = [], transactionResponses: TransactionResponse[] = []) {
    this.responses = [...responses];
    this.transactionResponses = [...transactionResponses];
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
    const client = new FakePoolClient(this.transactionResponses);
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

  public constructor(private readonly transactionResponses: TransactionResponse[]) {}

  public async query(sql: string, params?: readonly unknown[]): Promise<{ rows: QueryRows; rowCount: number | null }> {
    this.calls.push({ sql, params });
    if (sql.trim() === "BATCH SCRUB") {
      let response: TransactionResponse = 0;
      if (this.transactionResponses.length > 0) {
        response = this.transactionResponses.shift() as TransactionResponse;
      }
      if (response instanceof Error) {
        throw response;
      }
      return { rows: [], rowCount: response };
    }
    return { rows: [], rowCount: null };
  }

  public release(): void {
    this.released = true;
  }
}

class InterruptingStatement implements DbStatement {
  public constructor(
    private readonly delegate: DbStatement,
    private readonly beforeRun: () => void,
  ) {}

  public run(...params: unknown[]): DbRunResult {
    this.beforeRun();
    return this.delegate.run(...params);
  }

  public get<T = unknown>(...params: unknown[]): T | undefined {
    return this.delegate.get<T>(...params);
  }

  public all<T = unknown>(...params: unknown[]): T[] {
    return this.delegate.all<T>(...params);
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

function batchedMigration(sql = "BATCH SCRUB"): PostgresMigration {
  return {
    version: 1,
    name: "bounded_scrub",
    sql: "",
    batchedStatements: [{ name: "scrub_rows", sql }],
  };
}

function createTempDatabasePath(prefix: string): string {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return dbPath;
}

function createOneTimeInterruptingDatabase(db: DatabaseClient, statementMarker: string): DatabaseClient {
  let matchingRuns = 0;
  let interrupted = false;
  return {
    dialect: db.dialect,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes(statementMarker)) {
        return statement;
      }
      return new InterruptingStatement(statement, () => {
        matchingRuns += 1;
        if (!interrupted && matchingRuns === 2) {
          interrupted = true;
          throw new Error("simulated batched migration interruption");
        }
      });
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
    transaction(mode, callback) {
      return db.transaction(mode, callback);
    },
  };
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

  it("commits bounded async migration statements independently and records the ledger only after a zero pass", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], []], [2, 1, 0]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await runPostgresMigrations(client, [batchedMigration()]);

    assert.deepEqual(result, { appliedVersions: [1], latestVersion: 1 });
    assert.equal(pool.clients.length, 4);
    for (const transaction of pool.clients.slice(0, 3)) {
      assert.deepEqual(
        transaction.calls.map((call) => call.sql.trim()),
        ["BEGIN", "BATCH SCRUB", "COMMIT"],
      );
      assert.equal(transaction.released, true);
    }
    assert.deepEqual(
      pool.clients[3]?.calls.map((call) => call.sql.trim()),
      [
        "BEGIN",
        `INSERT INTO schema_migrations (version, name, applied_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (version) DO NOTHING`,
        "COMMIT",
      ],
    );
  });

  it("does not record an interrupted async batched migration after earlier batches committed", async () => {
    const pool = new FakePool(
      [[], [], [{ server_encoding: "UTF8" }], []],
      [2, new Error("simulated async batch failure")],
    );
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(runPostgresMigrations(client, [batchedMigration()]), /simulated async batch failure/);

    assert.equal(pool.clients.length, 2);
    assert.deepEqual(
      pool.clients[0]?.calls.map((call) => call.sql.trim()),
      ["BEGIN", "BATCH SCRUB", "COMMIT"],
    );
    assert.deepEqual(
      pool.clients[1]?.calls.map((call) => call.sql.trim()),
      ["BEGIN", "BATCH SCRUB", "ROLLBACK"],
    );
    assert.equal(
      pool.clients.some((transaction) =>
        transaction.calls.some((call) => call.sql.includes("INSERT INTO schema_migrations")),
      ),
      false,
    );
  });

  it("fails closed when an async batched statement does not report an affected-row count", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], []], [null]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      runPostgresMigrations(client, [batchedMigration()]),
      /did not report a valid affected-row count/,
    );

    assert.deepEqual(
      pool.clients[0]?.calls.map((call) => call.sql.trim()),
      ["BEGIN", "BATCH SCRUB", "ROLLBACK"],
    );
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

  it("resumes a sync batched migration after an interruption and records it only after convergence", () => {
    const db = createDatabase({ dbPath: createTempDatabasePath("goatcitadel-postgres-batched-resume") });
    db.exec(`
      CREATE TABLE scrub_rows (row_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO scrub_rows (row_id, payload) VALUES
        (1, 'secret:first'),
        (2, 'secret:second'),
        (3, 'secret:third');
    `);
    const batchSql = `
      UPDATE scrub_rows
      SET payload = '[REDACTED]'
      WHERE row_id IN (
        SELECT row_id
        FROM scrub_rows
        WHERE payload LIKE 'secret:%'
        ORDER BY row_id
        LIMIT 2
      )
    `;
    const interruptingDb = createOneTimeInterruptingDatabase(db, "UPDATE scrub_rows");
    const migration = batchedMigration(batchSql);

    assert.throws(
      () =>
        applyPostgresMigrationsSync(interruptingDb, {
          migrationsTable: "batched_schema_migrations",
          migrations: [migration],
        }),
      /simulated batched migration interruption/,
    );
    assert.deepEqual(
      db
        .prepare("SELECT payload FROM scrub_rows ORDER BY row_id")
        .all<{ payload: string }>()
        .map((row) => row.payload),
      ["[REDACTED]", "[REDACTED]", "secret:third"],
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM batched_schema_migrations").get<{ count: number }>()?.count,
      0,
    );

    applyPostgresMigrationsSync(interruptingDb, {
      migrationsTable: "batched_schema_migrations",
      migrations: [migration],
    });
    applyPostgresMigrationsSync(interruptingDb, {
      migrationsTable: "batched_schema_migrations",
      migrations: [migration],
    });

    assert.deepEqual(
      db
        .prepare("SELECT payload FROM scrub_rows ORDER BY row_id")
        .all<{ payload: string }>()
        .map((row) => row.payload),
      ["[REDACTED]", "[REDACTED]", "[REDACTED]"],
    );
    const applied = db
      .prepare("SELECT version, name FROM batched_schema_migrations")
      .get<{ version: number; name: string }>();
    assert.equal(applied?.version, 1);
    assert.equal(applied?.name, "bounded_scrub");
  });

  it("rejects ambiguous or incomplete batched migration definitions", () => {
    const db = createDatabase({ dbPath: createTempDatabasePath("goatcitadel-postgres-batched-validation") });
    const invalidMigrations: Array<{ migration: PostgresMigration; message: RegExp }> = [
      {
        migration: {
          ...batchedMigration(),
          sql: "SELECT 1",
        },
        message: /cannot define both atomic SQL and batched statements/,
      },
      {
        migration: {
          ...batchedMigration(),
          batchedStatements: [],
        },
        message: /must define at least one batched statement/,
      },
      {
        migration: {
          ...batchedMigration(),
          batchedStatements: [{ name: "scrub_rows", sql: " " }],
        },
        message: /unnamed or empty batched statement/,
      },
      {
        migration: {
          version: 1,
          name: "empty",
          sql: "",
        },
        message: /must define atomic SQL or batched statements/,
      },
      {
        migration: {
          ...batchedMigration(),
          integritySha256: "0".repeat(64),
        },
        message: /integrity hash mismatch/,
      },
    ];

    for (const { migration, message } of invalidMigrations) {
      assert.throws(
        () =>
          applyPostgresMigrationsSync(db, {
            migrationsTable: "invalid_schema_migrations",
            migrations: [migration],
          }),
        message,
      );
    }
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
