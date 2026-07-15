import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { __sqliteInternals, createDatabase } from "./sqlite.js";

const db = createDatabase({ dbPath: ":memory:" });
const postgresMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 114);
const postgresSql = postgresMigration?.sql ?? "";

after(() => db.close());

const TABLE_COLUMNS = {
  chat_session_control_tokens: ["token_sha256", "workspace_id", "session_id", "first_request_id", "created_at"],
  chat_session_control_requests: [
    "request_id",
    "workspace_id",
    "session_id",
    "companion_session_id",
    "device_grant_id",
    "client_instance_id",
    "principal_purpose",
    "token_sha256",
    "requested_capabilities_json",
    "requested_capabilities_sha256",
    "requested_generation",
    "status",
    "idempotency_key",
    "request_sha256",
    "expires_at",
    "created_at",
    "decided_at",
    "decided_by_actor_id",
    "decision_reason_code",
    "activated_generation",
  ],
  chat_session_control_grants: [
    "workspace_id",
    "session_id",
    "generation",
    "is_current",
    "owner_kind",
    "lease_state",
    "request_id",
    "companion_session_id",
    "device_grant_id",
    "client_instance_id",
    "principal_purpose",
    "requested_capabilities_json",
    "requested_capabilities_sha256",
    "effective_capabilities_json",
    "effective_capabilities_sha256",
    "token_sha256",
    "token_expires_at",
    "last_heartbeat_at",
    "lease_expires_at",
    "reconnect_expires_at",
    "control_revision",
    "transition_idempotency_key",
    "transition_request_sha256",
    "created_at",
    "updated_at",
    "terminal_at",
  ],
  chat_session_control_events: [
    "event_id",
    "workspace_id",
    "session_id",
    "event_sequence",
    "request_id",
    "previous_generation",
    "next_generation",
    "previous_owner_kind",
    "next_owner_kind",
    "previous_lease_state",
    "next_lease_state",
    "reason_code",
    "actor_kind",
    "actor_id",
    "companion_session_id",
    "device_grant_id",
    "idempotency_key",
    "request_sha256",
    "correlation_id",
    "created_at",
  ],
  chat_session_control_auth_revoke_receipts: [
    "idempotency_key",
    "request_sha256",
    "binding_kind",
    "binding_id",
    "actor_id",
    "correlation_id",
    "target_count",
    "session_count",
    "event_set_sha256",
    "created_at",
  ],
} as const;

describe("HX-411 session-control schema parity", () => {
  it("pairs SQLite 172 and PostgreSQL 114 across five production-dark tables", () => {
    assert.equal(postgresMigration?.name, "session_control_foundation");
    assert.equal(postgresMigration?.batchedStatements, undefined);
    for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
      assert.match(postgresSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
      assert.deepEqual(tableColumns(db, table), [...columns], `${table} SQLite columns drifted`);
      for (const column of columns) {
        assert.match(postgresSql, new RegExp(`\\b${column}\\s+(?:TEXT|BIGINT)\\b`, "u"));
      }
    }
    assert.equal(postgresSql.match(/CREATE TABLE IF NOT EXISTS chat_session_control_/gu)?.length, 5);
  });

  it("pairs one current generation, global workspace immutability, and ordered content-free evidence", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /chat_session_control_grants_one_current/u);
      assert.match(sql, /MAX\([\s\S]*generation[\s\S]*\+ 1/u);
      assert.match(sql, /prior[\s\S]*workspace_id[\s\S]*(?:<>|IS DISTINCT FROM)[\s\S]*NEW\.workspace_id/u);
      assert.match(sql, /UNIQUE\(session_id, event_sequence\)/u);
      assert.match(sql, /events_no_update/u);
      assert.match(sql, /events_no_delete/u);
    }
    for (const column of TABLE_COLUMNS.chat_session_control_events) {
      assert.doesNotMatch(column, /(?:message|prompt|content|tool|approval|plaintext|payload)/iu);
    }
  });

  it("pairs exact external capability sets, hash-only tokens, and terminal immutability", () => {
    const sqliteSql = schemaSql(db);
    const capabilityDigests = [
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      "700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c",
      "e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14",
    ];
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /requested_capabilities_json[\s\S]*'\["send"\]'[\s\S]*'\["send","read"\]'/u);
      assert.doesNotMatch(sql, /'\["read"\]'/u);
      for (const digest of capabilityDigests) assert.match(sql, new RegExp(digest, "u"));
      assert.match(sql, /token_sha256[\s\S]*(?:PRIMARY KEY|UNIQUE)/u);
      assert.match(sql, /OLD\.is_current[\s\S]*OLD\.terminal_at/u);
      assert.match(sql, /control_revision[\s\S]*OLD\.control_revision \+ 1/u);
    }
    assert.match(sqliteSql, /token_sha256 TEXT PRIMARY KEY CHECK\(length\(token_sha256\) = 64/u);
    assert.match(postgresSql, /token_sha256 TEXT PRIMARY KEY CHECK\(token_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/u);
    assert.doesNotMatch(
      `${sqliteSql}\n${postgresSql}`,
      /control_token_(?:plaintext|secret|value)|token_plaintext|X-GoatCitadel-Session-Control-Token/iu,
    );
  });

  it("pairs cross-table identity guards and exact request terminal reason bindings", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /session_control_tokens_insert_guard/u);
      assert.match(sql, /session_control_requests_insert_guard/u);
      assert.match(sql, /session_control_events_insert_guard/u);
      assert.match(sql, /first_request_id[\s\S]*request_id/u);
      assert.match(sql, /activated_generation[\s\S]*(?:<=|>|=)[\s\S]*generation/u);
      assert.match(sql, /status = 'rejected'[\s\S]*decision_reason_code = 'request_rejected'/u);
      assert.match(sql, /status = 'cancelled'[\s\S]*decision_reason_code = 'request_cancelled'/u);
      assert.match(sql, /status = 'expired'[\s\S]*decision_reason_code = 'request_expired'/u);
      assert.match(sql, /status = 'activated'[\s\S]*decision_reason_code = 'handoff'/u);
    }
    assert.match(postgresSql, /gc_scr_capabilities_digest/u);
    assert.match(postgresSql, /gc_scg_requested_digest/u);
    assert.match(postgresSql, /gc_scg_effective_digest/u);
  });

  it("backfills and freezes the exact auth purpose chain in both dialects", () => {
    for (const table of ["auth_device_requests", "auth_device_grants", "companion_sessions"]) {
      assert.equal(tableColumns(db, table).includes("principal_purpose"), true, `${table} purpose column missing`);
      assert.match(postgresSql, new RegExp(`ALTER TABLE ${table}[\\s\\S]*principal_purpose`, "u"));
    }
    const sqliteAuthSql = authPurposeSchemaSql(db);
    for (const sql of [sqliteAuthSql, postgresSql]) {
      assert.match(sql, /general_companion/u);
      assert.match(sql, /session_control_client/u);
      assert.match(sql, /auth_device_requests_principal_purpose_immutable/u);
      assert.match(sql, /auth_device_grants_principal_purpose_guard/u);
      assert.match(sql, /companion_sessions_principal_purpose_guard/u);
      assert.match(sql, /principal_purpose[\s\S]*(?:match|=)[\s\S]*(?:request|grant)/iu);
      assert.match(sql, /NEW\.request_id[\s\S]*(?:<>|IS DISTINCT FROM)[\s\S]*OLD\.request_id/u);
      assert.match(sql, /NEW\.grant_id[\s\S]*(?:<>|IS DISTINCT FROM)[\s\S]*OLD\.grant_id/u);
    }
    assert.match(postgresSql, /gc_adr_principal_purpose/u);
    assert.match(postgresSql, /gc_adg_principal_purpose/u);
    assert.match(postgresSql, /gc_cs_principal_purpose/u);
    for (const sql of [schemaSql(db), postgresSql]) {
      assert.match(sql, /refresh_token_expires_at/u);
      assert.match(sql, /device_grant\.revoked_at|device_grant\.revoked_at/u);
      assert.match(sql, /companion_session\.grant_id[\s\S]*NEW\.device_grant_id/u);
    }
  });

  it("pairs immutable auth-revoke receipt headers with exact event and session counts", () => {
    const sqliteSql = schemaSql(db);
    for (const sql of [sqliteSql, postgresSql]) {
      assert.match(sql, /chat_session_control_auth_revoke_receipts/u);
      assert.match(sql, /target_count/u);
      assert.match(sql, /session_count/u);
      assert.match(sql, /event_set_sha256/u);
      assert.match(sql, /auth_revoke_receipts_insert_guard/u);
      assert.match(sql, /auth_revoke_receipts_no_update/u);
      assert.match(sql, /auth_revoke_receipts_no_delete/u);
      assert.match(sql, /COUNT[\s\S]*chat_session_control_events/iu);
    }
  });

  it("uses DB-clock deadlines, deterministic Postgres locks, and SQLite immediate transactions", () => {
    assert.match(postgresSql, /clock_timestamp\(\)/u);
    assert.match(postgresSql, /token_expires_at[\s\S]*900/u);
    assert.match(postgresSql, /lease_expires_at[\s\S]*60/u);
    assert.match(postgresSql, /reconnect_expires_at[\s\S]*300/u);
    assert.match(postgresSql, /pg_advisory_xact_lock\(hashtextextended\(NEW\.session_id, 411\)\)/u);
    assert.match(schemaSql(db), /strftime\('%Y-%m-%dT%H:%M:%fZ'/u);
  });

  it("backfills operator generation one without installing chat-session lifecycle triggers", () => {
    assert.match(postgresSql, /FROM chat_session_meta meta/u);
    assert.match(postgresSql, /'operator'[\s\S]*'operator_active'/u);
    assert.match(postgresSql, /'session_initialized'[\s\S]*'system'/u);
    for (const sql of [schemaSql(db), postgresSql]) {
      assert.doesNotMatch(sql, /TRIGGER[^;]*(?:INSERT|DELETE|UPDATE) ON chat_session_meta/iu);
      assert.doesNotMatch(sql, /FOREIGN KEY[^;]*REFERENCES chat_session_meta/iu);
    }
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(`
        CREATE TABLE auth_device_requests (
          request_id TEXT PRIMARY KEY,
          principal_seed TEXT
        );
        CREATE TABLE auth_device_grants (
          grant_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT
        );
        CREATE TABLE companion_sessions (
          session_id TEXT PRIMARY KEY,
          grant_id TEXT NOT NULL,
          refresh_token_expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE chat_session_meta (
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO chat_session_meta(session_id, workspace_id, created_at, updated_at)
        VALUES ('legacy-session', 'legacy-workspace', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z');
        INSERT INTO auth_device_requests(request_id) VALUES ('legacy-auth-request');
        INSERT INTO auth_device_grants(grant_id, request_id)
        VALUES ('legacy-auth-grant', 'legacy-auth-request');
        INSERT INTO companion_sessions(session_id, grant_id, refresh_token_expires_at)
        VALUES ('legacy-companion', 'legacy-auth-grant', '2099-01-01T00:00:00.000Z');
      `);
      __sqliteInternals.applySchemaMigrationForTest(172, legacy);
      for (const [table, idColumn, id] of [
        ["auth_device_requests", "request_id", "legacy-auth-request"],
        ["auth_device_grants", "grant_id", "legacy-auth-grant"],
        ["companion_sessions", "session_id", "legacy-companion"],
      ] as const) {
        assert.equal(
          (
            legacy.prepare(`SELECT principal_purpose FROM ${table} WHERE ${idColumn} = ?`).get(id) as {
              principal_purpose: string;
            }
          ).principal_purpose,
          "general_companion",
        );
      }
      assert.throws(() =>
        legacy
          .prepare(
            `UPDATE auth_device_grants SET principal_purpose = 'session_control_client'
             WHERE grant_id = 'legacy-auth-grant'`,
          )
          .run(),
      );
      const backfilled = legacy
        .prepare(
          `SELECT workspace_id, session_id, generation, is_current, owner_kind, lease_state
           FROM chat_session_control_grants`,
        )
        .get();
      assert.deepEqual(
        { ...backfilled },
        {
          workspace_id: "legacy-workspace",
          session_id: "legacy-session",
          generation: 1,
          is_current: 1,
          owner_kind: "operator",
          lease_state: "operator_active",
        },
      );
      const initializedEvent = legacy.prepare("SELECT reason_code FROM chat_session_control_events").get() as {
        reason_code: string;
      };
      assert.equal(initializedEvent.reason_code, "session_initialized");
    } finally {
      legacy.close();
    }
  });

  it("keeps the paired migration additive and outside Chat content, usage, and route owners", () => {
    assert.doesNotMatch(
      postgresSql,
      /\b(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE\s+TABLE|UPDATE\s+chat_session_meta)\b/iu,
    );
    assert.doesNotMatch(
      postgresSql,
      /chat_messages|chat_turn_traces|model_usage_events|durable_runs|gateway_route|listener|session_control_client.*route/iu,
    );
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
         WHERE (type = 'table' OR type = 'trigger' OR type = 'index')
           AND sql LIKE '%chat_session_control_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql ?? ""}`)
    .join("\n");
}

function authPurposeSchemaSql(client: DatabaseClient): string {
  return (
    client
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE sql LIKE '%principal_purpose%'
           AND (
             name IN ('auth_device_requests', 'auth_device_grants', 'companion_sessions')
             OR name LIKE 'trg_auth_device_%'
             OR name LIKE 'trg_companion_sessions_%'
           )
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .map((row) => `${row.name}\n${row.sql ?? ""}`)
    .join("\n");
}
