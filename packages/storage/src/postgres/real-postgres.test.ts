import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./client.js";
import { applyPostgresMigrationsSync, runPostgresMigrations } from "./migrator.js";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import { PostgresSyncDatabaseClient } from "./sync.js";
import { CommsDeliveryRepository } from "../comms-delivery-repo.js";
import { ApprovalEffectRepository } from "../approval-effect-repo.js";
import {
  assertSingleObservabilityChain,
  runConcurrentObservabilityWorkers,
} from "../approval-observability-concurrency.test-support.js";

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
  "real Postgres applies the full ledger and scrubs legacy remote approval bearers",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_full_migrations_${suffix}`;
    const pool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString() });
    const client = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );
    const rawToken = `grat_${"p".repeat(43)}`;
    const trailingHyphenToken = `grat_${"h".repeat(42)}-`;
    const benignTokenlike = "grat_community_discount_code";
    const benignLongTokenlike = `grat_${"c".repeat(42)}`;
    const benignMessage = `grateful operator note ${benignTokenlike} ${benignLongTokenlike}`;
    const now = "2026-07-10T00:00:00.000Z";

    try {
      await pool.query(`CREATE SCHEMA ${schemaName}`);
      const beforeScrub = POSTGRES_MIGRATIONS.filter((migration) => migration.version < 81);
      const initial = await runPostgresMigrations(client, beforeScrub);
      assert.equal(initial.latestVersion, 80);

      await client.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'connector.delivery', 'queued', 0, 3, $2, '{}', 1, $3, $3)
        `,
        ["legacy-remote-run", JSON.stringify({ payload: { token: rawToken } }), now],
      );
      await client.query(
        `UPDATE durable_runs
         SET lease_owner_id = $1, lease_expires_at = $2, lease_heartbeat_at = $3
         WHERE run_id = $4`,
        ["worker-legacy", "2099-07-10T00:05:00.000Z", now, "legacy-remote-run"],
      );
      await client.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'connector.delivery', 'queued', 0, 3, $2, '{}', 1, $3, $3)
        `,
        ["legacy-hyphen-run", JSON.stringify({ payload: { token: `x${trailingHyphenToken}y` } }), now],
      );
      await client.query(
        `
          INSERT INTO durable_runs (
            run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
            version, created_at, updated_at
          ) VALUES ($1, 'connector.delivery', 'queued', 0, 3, $2, '{}', 1, $3, $3)
        `,
        ["benign-grateful-run", JSON.stringify({ message: benignMessage }), now],
      );
      await client.query(
        `
          INSERT INTO approval_inbox_items (
            inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
            action_type, state, approval_kind, risk_level, approval_status, preview_json,
            created_at, updated_at, expires_at, delivery_count, last_delivered_at
          ) VALUES ($1, $2, $3, 'mcp', $4, $5, $6, 'approval.resolve', 'pending', 'tool.invoke', 'danger',
            'pending', '{}', $7, $7, $8, 1, $7)
        `,
        [
          "benign-inbox",
          "benign-approval",
          "mcp:server-1",
          "server-1",
          "benign-token-id",
          benignTokenlike,
          now,
          "2026-07-10T00:15:00.000Z",
        ],
      );
      await client.query(
        `
          INSERT INTO approval_inbox_items (
            inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
            action_type, state, approval_kind, risk_level, approval_status, preview_json,
            created_at, updated_at, expires_at, delivery_count, last_delivered_at
          ) VALUES ($1, $2, $3, 'mcp', $4, $5, $6, 'approval.resolve', 'pending', 'tool.invoke', 'danger',
            'pending', '{}', $7, $7, $8, 1, $7)
        `,
        [
          "legacy-decorated-inbox",
          "legacy-decorated-approval",
          "mcp:server-1",
          "server-1",
          "legacy-decorated-token-id",
          `x${trailingHyphenToken}y`,
          now,
          "2026-07-10T00:15:00.000Z",
        ],
      );
      await client.query(
        `
          INSERT INTO audit_events (
            stream_name, event_id, event_sequence, occurred_at, payload
          ) VALUES ('approvals', 'legacy-remote-audit', 1, $1::timestamptz, $2::jsonb)
        `,
        [now, JSON.stringify({ callbackData: `gca:${rawToken}:a` })],
      );

      const final = await runPostgresMigrations(client, POSTGRES_MIGRATIONS);
      assert.deepEqual(final.appliedVersions, [81]);
      assert.equal(final.latestVersion, 81);

      const [durable] = await client.query<{
        status: string;
        payload_json: string;
        lease_owner_id: string | null;
        lease_expires_at: string | null;
        lease_heartbeat_at: string | null;
      }>(
        `SELECT status, payload_json, lease_owner_id, lease_expires_at, lease_heartbeat_at
         FROM durable_runs WHERE run_id = $1`,
        ["legacy-remote-run"],
      );
      const [audit] = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_events WHERE event_id = $1`,
        ["legacy-remote-audit"],
      );
      const [hyphenDurable] = await client.query<{ status: string; payload_json: string }>(
        `SELECT status, payload_json FROM durable_runs WHERE run_id = $1`,
        ["legacy-hyphen-run"],
      );
      const [benignDurable] = await client.query<{ status: string; payload_json: string }>(
        `SELECT status, payload_json FROM durable_runs WHERE run_id = $1`,
        ["benign-grateful-run"],
      );
      const [benignInbox] = await client.query<{ token: string }>(
        `SELECT token FROM approval_inbox_items WHERE inbox_item_id = $1`,
        ["benign-inbox"],
      );
      const [legacyDecoratedInbox] = await client.query<{ token: string }>(
        `SELECT token FROM approval_inbox_items WHERE inbox_item_id = $1`,
        ["legacy-decorated-inbox"],
      );
      assert.equal(durable?.status, "failed");
      assert.equal(durable?.lease_owner_id, null);
      assert.equal(durable?.lease_expires_at, null);
      assert.equal(durable?.lease_heartbeat_at, null);
      assert.equal(JSON.stringify({ durable, audit }).includes(rawToken), false);
      assert.match(durable?.payload_json ?? "", /\[REDACTED\]/);
      assert.match(JSON.stringify(audit?.payload ?? {}), /\[REDACTED\]/);
      assert.equal(hyphenDurable?.status, "failed");
      assert.equal(hyphenDurable?.payload_json.includes(trailingHyphenToken), false);
      assert.match(hyphenDurable?.payload_json ?? "", /\[REDACTED\]/);
      assert.deepEqual(benignDurable, {
        status: "queued",
        payload_json: JSON.stringify({ message: benignMessage }),
      });
      assert.equal(benignInbox?.token, benignTokenlike);
      assert.equal(legacyDecoratedInbox?.token, "redacted:legacy-decorated-token-id");

      await client.query(
        `
          INSERT INTO audit_events (
            stream_name, event_id, event_sequence, occurred_at, payload
          )
          SELECT
            'sync-scrub',
            'sync-scrub-' || item::text,
            item,
            $1::timestamptz,
            jsonb_build_object('callbackData', 'gca:x' || $2::text || 'y:a')
          FROM generate_series(1, 251) AS items(item)
        `,
        [now, trailingHyphenToken],
      );
      const scrubMigration = POSTGRES_MIGRATIONS.find(
        (migration) => migration.name === "scrub_legacy_remote_approval_bearers",
      );
      assert.ok(scrubMigration);
      const syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-batched-scrub-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        applyPostgresMigrationsSync(syncClient, {
          migrationsTable: `sync_scrub_migrations_${suffix}`,
          migrations: [scrubMigration],
        });
      } finally {
        syncClient.close();
      }
      const [syncScrubResult] = await client.query<{ total: number; redacted: number; leaked: number }>(
        `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE payload::text LIKE '%[REDACTED]%')::int AS redacted,
            COUNT(*) FILTER (WHERE POSITION($1 IN payload::text) > 0)::int AS leaked
          FROM audit_events
          WHERE stream_name = 'sync-scrub'
        `,
        [trailingHyphenToken],
      );
      assert.deepEqual(syncScrubResult, { total: 251, redacted: 251, leaked: 0 });
    } finally {
      await client.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
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

test(
  "real Postgres serializes concurrent approval observability batches into one predecessor chain",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `coverage_approval_observability_${suffix}`;
    const approvalId = `approval-observability-${suffix}`;
    const pool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    try {
      await pool.query(`CREATE SCHEMA ${schemaName}`);
      await pool.query(`
        CREATE TABLE ${schemaName}.approvals (
          approval_id TEXT PRIMARY KEY
        );
        CREATE TABLE ${schemaName}.approval_effects (
          effect_id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL REFERENCES ${schemaName}.approvals(approval_id) ON DELETE CASCADE,
          effect_kind TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          outcome TEXT,
          detail TEXT,
          attempt_count BIGINT NOT NULL DEFAULT 0,
          details_json TEXT NOT NULL DEFAULT '{}',
          payload_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT,
          claimed_by TEXT,
          claimed_at TEXT,
          lease_expires_at TEXT,
          version BIGINT NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE UNIQUE INDEX idx_approval_observability_idempotency_${suffix}
          ON ${schemaName}.approval_effects(idempotency_key);
      `);
      await pool.query(`INSERT INTO ${schemaName}.approvals (approval_id) VALUES ($1)`, [approvalId]);

      await runConcurrentObservabilityWorkers({
        kind: "postgres",
        workerOptions: {
          connectionString: scopedUrl.toString(),
          database: "goatcitadel_test",
          applicationName: "goatcitadel-real-postgres-approval-observability-test",
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        },
        approvalId,
        countPerWorker: 20,
      });

      const syncClient = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database: "goatcitadel_test",
        applicationName: "goatcitadel-real-postgres-approval-observability-read-test",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      try {
        const repo = new ApprovalEffectRepository(syncClient);
        assertSingleObservabilityChain(repo.listByApproval(approvalId), 40);
      } finally {
        syncClient.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  },
);
