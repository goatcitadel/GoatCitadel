import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

type QueryRows = QueryResultRow[];
type QueryResponse = QueryRows | Error | ((sql: string, params?: readonly unknown[]) => QueryRows);

interface QueryCall {
  sql: string;
  params?: readonly unknown[];
}

class FakePool {
  public readonly calls: QueryCall[] = [];
  public readonly responses: QueryResponse[];
  public ended = false;
  public client?: FakePoolClient;

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
    const rows = typeof response === "function" ? response(sql, params) : response;
    return { rows: rows as T[] };
  }

  public async connect(): Promise<PoolClient> {
    this.client = new FakePoolClient();
    return this.client as unknown as PoolClient;
  }

  public async end(): Promise<void> {
    this.ended = true;
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

function asPool(pool: FakePool): Pool {
  return pool as unknown as Pool;
}

describe("PostgresDatabaseClient", () => {
  it("queries through the pool with cached server-encoding sanitization", async () => {
    const pool = new FakePool([[{ server_encoding: "WIN1252" }], [{ id: 1, payload: "stored" }], []]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const rows = await client.query<{ id: number; payload: string }>(
      "INSERT INTO demo(payload) VALUES ($1) RETURNING id, payload",
      ["plain 🧠"],
    );
    assert.deepEqual(rows, [{ id: 1, payload: "stored" }]);
    assert.equal(pool.calls[0]!.sql, "SELECT current_setting('server_encoding') AS server_encoding");
    assert.deepEqual(pool.calls[1]!.params, ["plain \\uD83E\\uDDE0"]);

    assert.equal(await client.queryOne("SELECT * FROM empty"), undefined);
    assert.equal(
      pool.calls.filter((call) => call.sql === "SELECT current_setting('server_encoding') AS server_encoding").length,
      1,
    );
  });

  it("commits successful transactions and rolls back failing transactions", async () => {
    const successPool = new FakePool();
    const successClient = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(successPool) });
    const result = await successClient.transaction(async (transactionClient) => {
      await transactionClient.query("SELECT inside");
      return "committed";
    });
    assert.equal(result, "committed");
    assert.deepEqual(
      successPool.client?.calls.map((call) => call.sql),
      ["BEGIN", "SELECT inside", "COMMIT"],
    );
    assert.equal(successPool.client?.released, true);

    const failurePool = new FakePool();
    const failureClient = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(failurePool) });
    await assert.rejects(
      () =>
        failureClient.transaction(async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.deepEqual(
      failurePool.client?.calls.map((call) => call.sql),
      ["BEGIN", "ROLLBACK"],
    );
    assert.equal(failurePool.client?.released, true);
  });

  it("manages migration bookkeeping through the configured table", async () => {
    const pool = new FakePool([
      [],
      [],
      [{ server_encoding: "UTF8" }],
      [
        { version: 1, name: "one" },
        { version: "2", name: "two" },
      ],
      [],
    ]);
    const client = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(pool), migrationsTable: "custom_migrations" },
    );

    await client.ensureMigrationsTable();
    assert.match(pool.calls[0]!.sql, /CREATE TABLE IF NOT EXISTS custom_migrations/);

    const versions = await client.getAppliedMigrationVersions();
    assert.deepEqual([...versions], [1, 2]);
    assert.match(pool.calls[3]!.sql, /SELECT version, name FROM custom_migrations/);

    await client.markMigrationApplied(3, "third");
    assert.match(pool.calls.at(-1)?.sql ?? "", /INSERT INTO custom_migrations/);
    assert.deepEqual(pool.calls.at(-1)?.params, [3, "third"]);

    const explicitClient = new FakePoolClient();
    await client.markMigrationApplied(4, "fourth", explicitClient as unknown as PoolClient);
    assert.deepEqual(explicitClient.calls[0]!.params, [4, "fourth"]);
  });

  it("reports migration drift and required schema drift in health checks", async () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 28);
    assert.ok(repairMigration);
    const pool = new FakePool([
      [],
      [{ server_encoding: "UTF8" }],
      [{ ok: 1 }],
      [
        { version: 1, name: "stale_initial_name" },
        { version: repairMigration.version, name: repairMigration.name },
        { version: 999, name: "future_unknown" },
      ],
      [{ table_name: "agent_commitments" }],
      [],
      [{ column_name: "speed_mode" }],
      [{ column_name: "heartbeat_enabled" }],
    ]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();
    assert.equal(result.reachable, true);
    assert.equal(result.migrationVersion, 999);
    assert.equal(typeof result.latencyMs, "number");
    assert.deepEqual(result.issues, [
      "schema drift: migration 1 is stale_initial_name, expected runtime_event_and_cutover_tables",
      "schema drift: unknown migration version 999 (future_unknown)",
      "schema drift: operator_profiles table is missing",
      "schema drift: memory_items.workspace_id is missing",
      "schema drift: chat_session_prefs.subagent_policy is missing",
      "schema drift: session_autonomy_prefs.heartbeat_interval_seconds is missing",
      "schema drift: session_autonomy_prefs.active_hours_json is missing",
    ]);
  });

  it("skips required schema checks before the chat prefs repair migration is present", async () => {
    const pool = new FakePool([
      [],
      [{ server_encoding: "UTF8" }],
      [{ ok: 1 }],
      [{ version: 1, name: POSTGRES_MIGRATIONS[0]!.name }],
    ]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();

    assert.equal(result.reachable, true);
    assert.deepEqual(result.issues, []);
    assert.equal(
      pool.calls.some((call) => call.sql.includes("information_schema.columns")),
      false,
    );
  });

  it("returns unreachable health results and closes pools cleanly", async () => {
    const pool = new FakePool([new Error("offline")]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();
    assert.equal(result.reachable, false);
    assert.deepEqual(result.issues, ["offline"]);

    await client.close();
    assert.equal(pool.ended, true);
  });

  it("constructs owned pools for connection strings and discrete host options", async () => {
    const clients = [
      new PostgresDatabaseClient({
        database: "ignored",
        connectionString: " postgres://user:pass@localhost:5432/goatcitadel ",
        sslMode: "require",
        applicationName: "coverage-test",
        pool: {
          min: 1,
          max: 2,
          idleTimeoutMs: 3,
          connectionTimeoutMs: 4,
        },
      }),
      new PostgresDatabaseClient({
        database: "goatcitadel",
        host: "localhost",
        port: 5433,
        user: "goat",
        password: "secret",
        sslMode: "disable",
      }),
      new PostgresDatabaseClient({
        database: "goatcitadel",
        sslMode: "prefer",
      }),
    ];

    await Promise.all(clients.map((client) => client.close()));
  });
});
