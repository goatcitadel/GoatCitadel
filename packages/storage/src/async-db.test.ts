import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { PostgresAsyncDatabaseClient, SqliteAsyncDatabaseClient } from "./async-db.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { createDatabase } from "./sqlite.js";

test("SQLite async adapter commits and rolls back Promise-based transactions", async () => {
  const db = new SqliteAsyncDatabaseClient(createDatabase({ dbPath: ":memory:" }));
  try {
    await db.exec("CREATE TABLE async_adapter_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await db.transaction("immediate", async (tx) => {
      await tx.prepare("INSERT INTO async_adapter_test (id, value) VALUES (?, ?)").run(1, "committed");
      const row = await tx.prepare("SELECT value FROM async_adapter_test WHERE id = ?").get<{ value: string }>(1);
      assert.equal(row?.value, "committed");
    });

    await assert.rejects(
      db.transaction("immediate", async (tx) => {
        await tx.prepare("INSERT INTO async_adapter_test (id, value) VALUES (?, ?)").run(2, "rolled back");
        throw new Error("rollback fixture");
      }),
      /rollback fixture/,
    );

    const rows = await db
      .prepare("SELECT id, value FROM async_adapter_test ORDER BY id")
      .all<{ id: number; value: string }>();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ id: 1, value: "committed" }],
    );
  } finally {
    await db.close();
  }
});

test("PostgreSQL async adapter translates shared placeholders and uses awaited transactions", async () => {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const query = async (sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params });
    if (/SELECT/.test(sql)) {
      return { rows: [{ value: params?.[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const transactionClient = {
    query,
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = {
    query,
    connect: async () => transactionClient,
    end: async () => undefined,
  } as unknown as Pool;
  const native = new PostgresDatabaseClient({ database: "test" }, { pool });
  const db = new PostgresAsyncDatabaseClient(native);

  const row = await db.prepare("SELECT @value AS value").get<{ value: string }>({ value: "named" });
  assert.equal(row?.value, "named");
  assert.deepEqual(calls[1], { sql: "SELECT $1 AS value", params: ["named"] });

  await db.transaction("immediate", async (tx) => {
    await tx.prepare("INSERT INTO example (left_value, right_value) VALUES (?, ?)").run("a", "b");
  });
  assert.deepEqual(
    calls.map((call) => call.sql),
    [
      "SELECT current_setting('server_encoding') AS server_encoding",
      "SELECT $1 AS value",
      "BEGIN",
      "INSERT INTO example (left_value, right_value) VALUES ($1, $2)",
      "COMMIT",
    ],
  );

  await db.close();
});
