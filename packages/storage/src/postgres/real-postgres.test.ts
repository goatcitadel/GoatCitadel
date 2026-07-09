import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./client.js";
import { runPostgresMigrations } from "./migrator.js";
import { PostgresSyncDatabaseClient } from "./sync.js";
import { CommsDeliveryRepository } from "../comms-delivery-repo.js";

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

test(
  "real Postgres comms delivery CAS handles nullable leases without overwriting sent truth",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_comms_cas_${suffix}`;
    const pool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    try {
      await pool.query(`CREATE SCHEMA ${schemaName}`);
      await pool.query(`
        CREATE TABLE ${schemaName}.comms_deliveries (
          delivery_id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          channel_key TEXT NOT NULL,
          target TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          payload_json TEXT,
          status TEXT NOT NULL,
          delivery_status TEXT,
          idempotency_key TEXT,
          attempts BIGINT NOT NULL DEFAULT 0,
          max_attempts BIGINT NOT NULL DEFAULT 3,
          next_attempt_at TEXT,
          stale_after_ms BIGINT,
          base_backoff_ms BIGINT,
          max_backoff_ms BIGINT,
          provider_msg_id TEXT,
          error TEXT,
          stale_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      const syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-comms-cas-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        const repo = new CommsDeliveryRepository(syncClient);
        const stale = repo.createQueued(
          {
            connectionId: "conn-real-pg-stale",
            channelKey: "slack",
            target: "C123",
            payload: { message: "stale once" },
          },
          "2026-05-05T00:00:00.000Z",
        );
        assert.equal(
          repo.markStaleIfUnchanged(stale.deliveryId, 0, undefined, "stale delivery", "2026-05-05T00:01:00.000Z"),
          true,
        );

        const sent = repo.createQueued(
          {
            connectionId: "conn-real-pg-sent",
            channelKey: "slack",
            target: "C123",
            payload: { message: "sent wins" },
          },
          "2026-05-05T00:00:00.000Z",
        );
        repo.markSent(sent.deliveryId, "provider-real-pg", "2026-05-05T00:00:01.000Z");
        assert.equal(
          repo.markStaleIfUnchanged(sent.deliveryId, 0, undefined, "stale snapshot", "2026-05-05T00:01:00.000Z"),
          false,
        );
        assert.equal(repo.list("conn-real-pg-sent", 1)[0]?.providerMessageId, "provider-real-pg");
      } finally {
        syncClient.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  },
);
