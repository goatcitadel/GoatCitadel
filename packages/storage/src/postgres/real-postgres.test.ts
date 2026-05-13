import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./client.js";
import { runPostgresMigrations } from "./migrator.js";
import { PostgresSyncDatabaseClient } from "./sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres migrator/client lane applies migrations and writes through the client",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const tableName = `coverage_real_pg_${suffix}`;
    const syncTableName = `coverage_real_pg_sync_${suffix}`;
    const migrationsTable = `coverage_real_pg_migrations_${suffix}`;
    const pool = new Pool({ connectionString });
    const client = new PostgresDatabaseClient(
      { connectionString, database: "goatcitadel_test" },
      { pool, migrationsTable },
    );

    try {
      const result = await runPostgresMigrations(client, [
        {
          version: 1,
          name: "create_real_postgres_lane_table",
          sql: `CREATE TABLE ${tableName} (id SERIAL PRIMARY KEY, payload TEXT NOT NULL)`,
        },
      ]);
      assert.deepEqual(result, { appliedVersions: [1], latestVersion: 1 });

      const rows = await client.query<{ payload: string }>(
        `INSERT INTO ${tableName} (payload) VALUES ($1) RETURNING payload`,
        ["real postgres lane"],
      );
      assert.deepEqual(rows, [{ payload: "real postgres lane" }]);

      const transactionResult = await client.transaction(async (transactionClient) => {
        await transactionClient.query(`INSERT INTO ${tableName} (payload) VALUES ($1)`, ["transaction row"]);
        return "committed";
      });
      assert.equal(transactionResult, "committed");

      const syncClient = new PostgresSyncDatabaseClient({
        connectionString,
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        syncClient.exec(`CREATE TABLE ${syncTableName} (id SERIAL PRIMARY KEY, payload TEXT NOT NULL)`);
        const insert = syncClient.prepare(`INSERT INTO ${syncTableName} (payload) VALUES (?)`);
        assert.equal(insert.run("sync worker row").changes, 1);
        const row = syncClient
          .prepare(`SELECT payload FROM ${syncTableName} WHERE payload = ?`)
          .get<{ payload: string }>("sync worker row");
        assert.deepEqual(row, { payload: "sync worker row" });

        const nestedResult = syncClient.transaction("immediate", () => {
          syncClient.prepare(`INSERT INTO ${syncTableName} (payload) VALUES (@payload)`).run({
            payload: "sync transaction row",
          });
          return syncClient.prepare(`SELECT COUNT(*)::int AS count FROM ${syncTableName}`).get<{ count: number }>();
        });
        assert.equal(nestedResult?.count, 2);
      } finally {
        syncClient.close();
      }
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${syncTableName}`);
      await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
      await pool.query(`DROP TABLE IF EXISTS ${migrationsTable}`);
      await pool.end();
    }
  },
);
