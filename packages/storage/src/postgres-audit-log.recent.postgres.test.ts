import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import type { DatabaseClient, DbBindParams } from "./db.js";
import { PostgresAuditLog } from "./postgres-audit-log.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real PostgreSQL recent audit pages stop at the newest sparse matches",
  {
    skip: connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
    timeout: 60_000,
  },
  async () => {
    assert.ok(connectionString);
    const schema = `audit_recent_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    let db: PostgresSyncDatabaseClient | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      // The existing audit schema and its unique sequence index; this change adds no schema objects.
      await admin.query(`CREATE TABLE ${schema}.audit_events (
      stream_name TEXT NOT NULL, event_id TEXT NOT NULL, event_sequence BIGINT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL,
      PRIMARY KEY (stream_name, event_id), UNIQUE (stream_name, event_sequence)
    )`);
      await admin.query(`INSERT INTO ${schema}.audit_events
      SELECT 'approvals', n::text, n, '2026-11-02'::timestamptz,
        jsonb_build_object('sequence', n, 'match', n % 300 = 0)
      FROM generate_series(1, 5000) n`);
      db = new PostgresSyncDatabaseClient({
        connectionString: scoped.toString(),
        database: scoped.pathname.slice(1),
        pool: { max: 1, connectionTimeoutMs: 5_000 },
      });
      const ownedDb = db;
      const materialized: number[] = [];
      const recorded: DatabaseClient = {
        dialect: "postgres",
        prepare: (sql) => {
          const statement = ownedDb.prepare(sql);
          return {
            get: <T>(...params: DbBindParams[]) => statement.get<T>(...params),
            run: (...params) => statement.run(...params),
            all: <T>(...params: DbBindParams[]) => {
              const rows = statement.all<T>(...params);
              materialized.push(rows.length);
              return rows;
            },
          };
        },
        exec: (sql) => ownedDb.exec(sql),
        transaction: (mode, work) => ownedDb.transaction(mode, work),
        close: () => ownedDb.close(),
      };
      const log = new PostgresAuditLog(recorded);
      const recent = await log.listRecent("approvals", 3, (row) => row.match === true);
      assert.deepEqual(
        recent.map((row) => row.sequence),
        [4200, 4500, 4800],
      );
      assert.ok(materialized.every((count) => count <= 256));
      assert.ok(materialized.reduce((total, count) => total + count, 0) <= 1024);
      assert.deepEqual(await log.listRecent("approvals", 0), []);
      assert.deepEqual(await log.listRecent("approvals", Number.NaN), []);
    } finally {
      db?.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
