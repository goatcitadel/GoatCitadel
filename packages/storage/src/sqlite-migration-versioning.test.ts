import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals, createDatabase } from "./sqlite.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

describe("sqlite schema migrations", () => {
  it("records applied migration versions", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as Array<{
      version: number;
      name: string;
    }>;

    assert.equal(rows.length >= 4, true);
    assert.equal(rows[0]?.version, 1);
    assert.equal(rows[rows.length - 1]?.version, rows.length);
    assert.deepEqual(
      { ...rows.at(-1) },
      {
        version: 192,
        name: "governed_remediation_recipe_and_phase_authority",
      },
    );
    db.close();
  });

  it("backfills message authority, quarantines untrusted learned memory, and preserves legacy candidates", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE chat_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE TABLE chat_session_bindings (
        session_id TEXT PRIMARY KEY,
        transport TEXT NOT NULL
      );
      CREATE TABLE learned_memory_items (
        item_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        disabled_reason TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE learned_memory_sources (
        source_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL
      );
      CREATE TABLE memory_trace_candidates (
        candidate_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        candidate_type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_text TEXT NOT NULL,
        proposed_insight TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_refs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        authority TEXT NOT NULL,
        actor_id TEXT,
        promoted_learning_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO chat_session_bindings VALUES ('session-external', 'integration');
      INSERT INTO chat_messages VALUES
        ('msg-assistant', 'session-local', 'assistant', 'agent', 'agent-1', 'assistant output'),
        ('msg-external', 'session-external', 'user', 'user', 'operator', 'spoofed external input'),
        ('msg-operator', 'session-local', 'user', 'user', 'operator', 'local operator input'),
        ('msg-system', 'session-local', 'assistant', 'system', 'runtime', 'lifecycle output');

      INSERT INTO learned_memory_items VALUES
        ('memory-assistant', 'session-local', 'active', NULL, '2026-08-08T00:00:00.000Z'),
        ('memory-external', 'session-external', 'active', NULL, '2026-08-08T00:00:00.000Z'),
        ('memory-unresolved', 'session-external', 'active', NULL, '2026-08-08T00:00:00.000Z'),
        ('memory-operator', 'session-local', 'active', NULL, '2026-08-08T00:00:00.000Z');
      INSERT INTO learned_memory_sources VALUES
        ('source-assistant', 'memory-assistant', 'assistant', 'msg-assistant'),
        ('source-external', 'memory-external', 'user', 'msg-external'),
        ('source-operator', 'memory-operator', 'user', 'msg-operator');

      INSERT INTO memory_trace_candidates VALUES (
        'legacy-candidate', 'default', 'fact', 'rejected', 'legacy source', 'legacy insight', 0.5,
        '[]', '{}', 'agent_proposed', 'agent-1', NULL,
        '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
      );
    `);

    __sqliteInternals.applySchemaMigrationForTest(190, db);

    const authorities = db
      .prepare("SELECT message_id, source_authority FROM chat_messages ORDER BY message_id")
      .all() as Array<{ message_id: string; source_authority: string }>;
    assert.deepEqual(
      authorities.map((row) => ({ ...row })),
      [
        { message_id: "msg-assistant", source_authority: "agent_proposed" },
        { message_id: "msg-external", source_authority: "external_channel" },
        { message_id: "msg-operator", source_authority: "operator" },
        { message_id: "msg-system", source_authority: "trusted_lifecycle" },
      ],
    );
    const memories = db
      .prepare("SELECT item_id, status, disabled_reason FROM learned_memory_items ORDER BY item_id")
      .all() as Array<{ item_id: string; status: string; disabled_reason: string | null }>;
    assert.deepEqual(
      memories.map((row) => ({ ...row })),
      [
        {
          item_id: "memory-assistant",
          status: "disabled",
          disabled_reason: "external_authority_unverified_migration",
        },
        {
          item_id: "memory-external",
          status: "disabled",
          disabled_reason: "external_authority_unverified_migration",
        },
        { item_id: "memory-operator", status: "active", disabled_reason: null },
        {
          item_id: "memory-unresolved",
          status: "disabled",
          disabled_reason: "external_authority_unverified_migration",
        },
      ],
    );
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT quarantined_count, metadata_json FROM memory_authority_migration_reconciliation WHERE migration_id = 'sqlite-190'",
          )
          .get(),
      },
      {
        quarantined_count: 3,
        metadata_json: JSON.stringify({
          disabledReason: "external_authority_unverified_migration",
          reversible: true,
        }),
      },
    );
    assert.deepEqual(
      {
        ...db
          .prepare("SELECT status, dedupe_key FROM memory_trace_candidates WHERE candidate_id = 'legacy-candidate'")
          .get(),
      },
      { status: "rejected", dedupe_key: "legacy:legacy-candidate" },
    );
    db.close();
  });

  it("keeps migration 188 secret-free, version-CAS fenced, and cancellation-blocking", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const tableSql = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'chat_turn_secure_configuration_reservations'`,
      )
      .get<{ sql: string }>()?.sql;
    assert.ok(tableSql);
    assert.match(tableSql, /reserved_run_version = waiting_run_version \+ 1/u);
    assert.match(tableSql, /julianday\(expires_at\) IS NOT NULL/u);
    assert.doesNotMatch(tableSql, /(?:secret|credential|token|value|digest|hash)\s+(?:TEXT|BLOB|JSON)/iu);
    const triggerNames = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name IN (
           'trg_chat_session_mutation_admissions_secure_reservation_close_guard',
           'trg_chat_turn_secure_configuration_reservations_no_delete',
           'trg_chat_turn_secure_configuration_reservations_update_guard',
           'trg_durable_runs_secure_reservation_cancel_guard'
         ) ORDER BY name`,
      )
      .all<{ name: string }>()
      .map((row) => row.name);
    assert.deepEqual(triggerNames, [
      "trg_chat_session_mutation_admissions_secure_reservation_close_guard",
      "trg_chat_turn_secure_configuration_reservations_no_delete",
      "trg_chat_turn_secure_configuration_reservations_update_guard",
      "trg_durable_runs_secure_reservation_cancel_guard",
    ]);
    db.close();
  });

  it("repairs the deployed draft-v188 reservation shape and quarantines ambiguous active rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE chat_session_mutation_admissions (
        admission_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE durable_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO chat_session_mutation_admissions VALUES ('admission-legacy', 'active');
      INSERT INTO durable_runs VALUES ('run-legacy', 'waiting');
      CREATE TABLE chat_turn_secure_configuration_reservations (
        reservation_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version = 1),
        admission_id TEXT NOT NULL,
        session_incarnation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        durable_run_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        responder_actor_id TEXT NOT NULL,
        responder_auth_actor_source TEXT NOT NULL,
        waiting_run_version INTEGER NOT NULL,
        reserved_run_version INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved', 'completed', 'released')),
        provider TEXT,
        configuration_revision TEXT,
        scope_ref TEXT NOT NULL,
        reserved_at TEXT NOT NULL,
        completed_at TEXT,
        released_at TEXT,
        FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id),
        FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id)
      );
      INSERT INTO chat_turn_secure_configuration_reservations (
        reservation_id, version, admission_id, session_incarnation_id, workspace_id,
        session_id, turn_id, durable_run_id, prompt_id, target_id, responder_actor_id,
        responder_auth_actor_source, waiting_run_version, reserved_run_version, expires_at,
        status, provider, configuration_revision, scope_ref, reserved_at, completed_at, released_at
      ) VALUES (
        'reservation-legacy', 1, 'admission-legacy', 'incarnation-legacy', 'workspace-legacy',
        'session-legacy', 'turn-legacy', 'run-legacy', 'prompt-legacy', 'search.brave',
        'operator-legacy', 'token', 2, 3, '2099-08-07T00:00:00.000Z',
        'reserved', NULL, NULL, 'root-installation-a', '2026-08-07T00:00:00.000Z', NULL, NULL
      );
    `);

    __sqliteInternals.applySchemaMigrationForTest(189, db);

    const repaired = db
      .prepare(
        `SELECT status, expired_at, reclaimed_at, reconciled_at, reconciled_by_reservation_id
         FROM chat_turn_secure_configuration_reservations
         WHERE reservation_id = 'reservation-legacy'`,
      )
      .get() as
      | {
          status: string;
          expired_at: string;
          reclaimed_at: string | null;
          reconciled_at: string | null;
          reconciled_by_reservation_id: string | null;
        }
      | undefined;
    assert.equal(repaired?.status, "expired_unreconciled");
    assert.equal(Number.isFinite(Date.parse(repaired?.expired_at ?? "")), true);
    assert.equal(repaired?.reclaimed_at, null);
    assert.equal(repaired?.reconciled_at, null);
    assert.equal(repaired?.reconciled_by_reservation_id, null);
    assert.deepEqual(
      db
        .prepare("PRAGMA table_info(chat_turn_secure_configuration_reservations)")
        .all()
        .map((column) => (column as { name: string }).name),
      [
        "reservation_id",
        "version",
        "admission_id",
        "session_incarnation_id",
        "workspace_id",
        "session_id",
        "turn_id",
        "durable_run_id",
        "prompt_id",
        "target_id",
        "responder_actor_id",
        "responder_auth_actor_source",
        "waiting_run_version",
        "reserved_run_version",
        "expires_at",
        "status",
        "provider",
        "configuration_revision",
        "scope_ref",
        "reserved_at",
        "reclaimed_at",
        "completed_at",
        "released_at",
        "expired_at",
        "reconciled_at",
        "reconciled_by_reservation_id",
      ],
    );
    db.prepare(
      `UPDATE chat_turn_secure_configuration_reservations
       SET reclaimed_at = '2026-08-07T00:01:00.000Z'
       WHERE reservation_id = 'reservation-legacy'`,
    ).run();
    assert.equal(
      (
        db
          .prepare(
            `SELECT reclaimed_at FROM chat_turn_secure_configuration_reservations
             WHERE reservation_id = 'reservation-legacy'`,
          )
          .get() as { reclaimed_at: string }
      ).reclaimed_at,
      "2026-08-07T00:01:00.000Z",
    );
    db.close();
  });

  it("refuses draft-v188 rows whose installation scope cannot be proven", () => {
    for (const scopeRef of [null, "   "]) {
      const db = new DatabaseSync(":memory:");
      db.exec(`
        CREATE TABLE chat_turn_secure_configuration_reservations (
          reservation_id TEXT,
          version INTEGER,
          admission_id TEXT,
          session_incarnation_id TEXT,
          workspace_id TEXT,
          session_id TEXT,
          turn_id TEXT,
          durable_run_id TEXT,
          prompt_id TEXT,
          target_id TEXT,
          responder_actor_id TEXT,
          responder_auth_actor_source TEXT,
          waiting_run_version INTEGER,
          reserved_run_version INTEGER,
          expires_at TEXT,
          status TEXT,
          provider TEXT,
          configuration_revision TEXT,
          scope_ref TEXT,
          reserved_at TEXT,
          completed_at TEXT,
          released_at TEXT
        );
      `);
      db.prepare(
        `INSERT INTO chat_turn_secure_configuration_reservations VALUES (
          'reservation-unowned-scope', 1, 'admission-unowned-scope', 'incarnation-unowned-scope',
          'workspace-unowned-scope', 'session-unowned-scope', 'turn-unowned-scope',
          'run-unowned-scope', 'prompt-unowned-scope', 'search.brave', 'operator-unowned-scope',
          'token', 2, 3, '2099-08-07T00:00:00.000Z', 'reserved', NULL, NULL,
          @scopeRef, '2026-08-07T00:00:00.000Z', NULL, NULL
        )`,
      ).run({ scopeRef });

      assert.throws(
        () => __sqliteInternals.applySchemaMigrationForTest(189, db),
        /cannot infer installation scope from a missing or invalid secure configuration scope_ref/iu,
      );
      assert.equal(
        (
          db
            .prepare(
              `SELECT scope_ref FROM chat_turn_secure_configuration_reservations
               WHERE reservation_id = 'reservation-unowned-scope'`,
            )
            .get() as { scope_ref: string | null }
        ).scope_ref,
        scopeRef,
      );
      db.close();
    }
  });

  it("accepts the final migration-188 shape and refuses unknown legacy shapes without mutation", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-final-188-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    createDatabase({ dbPath }).close();
    const current = new DatabaseSync(dbPath);
    __sqliteInternals.applySchemaMigrationForTest(189, current);
    assert.equal(
      (
        current.prepare("SELECT COUNT(*) AS count FROM chat_turn_secure_configuration_reservations").get() as {
          count: number;
        }
      ).count,
      0,
    );
    current.close();

    const malformed = new DatabaseSync(":memory:");
    malformed.exec(`
      CREATE TABLE chat_turn_secure_configuration_reservations (
        reservation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO chat_turn_secure_configuration_reservations VALUES ('do-not-touch', 'reserved');
    `);
    assert.throws(
      () => __sqliteInternals.applySchemaMigrationForTest(189, malformed),
      /unsupported secure configuration reservation table shape/iu,
    );
    assert.deepEqual(
      {
        ...(malformed
          .prepare("SELECT reservation_id, status FROM chat_turn_secure_configuration_reservations")
          .get() as Record<string, unknown>),
      },
      { reservation_id: "do-not-touch", status: "reserved" },
    );
    malformed.close();
  });

  it("keeps migration 178 additive, immutable-profile, CAS-fenced, high-water-monotonic, and evidence append-only", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx505-178-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    for (const table of ["remote_worker_cells", "remote_worker_cell_evidence"]) {
      const tableSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
          | { sql: string }
          | undefined
      )?.sql;
      assert.ok(tableSql, `expected migration 178 table ${table}`);
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      // Secret-free: never a transcript, artifact payload, raw terminal, or credential column.
      for (const forbidden of [
        "transcript",
        "artifact_payload",
        "raw_terminal",
        "terminal_output",
        "credential",
        "lease_token",
        "secret",
        "token",
      ]) {
        assert.equal(
          columns.some((column) => column.toLowerCase().includes(forbidden)),
          false,
          `${table} must stay secret-free (found ${forbidden})`,
        );
      }
    }

    // The cell binds the assignment-generation authority and the evidence binds the cell.
    const cellSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'remote_worker_cells'").get() as {
        sql: string;
      }
    ).sql;
    assert.match(
      cellSql,
      /FOREIGN KEY\(registry_workspace_id, assignment_id, assignment_generation\)[\s\S]*REFERENCES remote_worker_assignment_generations/u,
    );
    assert.doesNotMatch(cellSql, /ALTER TABLE/u);

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'remote_worker_cell%'")
      .all() as Array<{ name: string }>;
    const triggerNames = triggers.map((trigger) => trigger.name);
    for (const trigger of [
      "trg_remote_worker_cells_profile_immutable",
      "trg_remote_worker_cells_revision_cas",
      "trg_remote_worker_cells_high_water_monotonic",
      "trg_remote_worker_cells_no_delete_unless_clean",
      "trg_remote_worker_cell_evidence_chain_guard",
      "trg_remote_worker_cell_evidence_no_update",
      "trg_remote_worker_cell_evidence_no_delete",
    ]) {
      assert.ok(triggerNames.includes(trigger), `migration 178 needs trigger ${trigger}`);
    }

    db.close();
  });

  it("keeps migration 179 additive across nine settlement tables, insert-only and full-identity fenced", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx506-179-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const settlementTables = [
      "remote_worker_artifact_uploads",
      "remote_worker_artifact_parts",
      "remote_worker_artifact_blobs",
      "remote_worker_artifact_manifests",
      "remote_worker_artifact_manifest_entries",
      "remote_worker_artifact_verifications",
      "remote_worker_effect_intents",
      "remote_worker_effect_transitions",
      "remote_worker_effect_receipts",
    ];
    for (const table of settlementTables) {
      const tableSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
          | { sql: string }
          | undefined
      )?.sql;
      assert.ok(tableSql, `expected migration 179 table ${table}`);
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      // Secret-free and payload-free: never a transcript, raw terminal, usage/cost, or credential column.
      for (const forbidden of [
        "transcript",
        "raw_terminal",
        "terminal_output",
        "credential",
        "lease_token",
        "secret",
        "provider_cost",
        "usage_cost",
        "token",
      ]) {
        assert.equal(
          columns.some((column) => column.toLowerCase().includes(forbidden)),
          false,
          `${table} must stay secret-free (found ${forbidden})`,
        );
      }
      // Every table binds the full identity.
      for (const identityColumn of [
        "registry_workspace_id",
        "execution_workspace_id",
        "assignment_id",
        "assignment_generation",
        "worker_id",
        "worker_generation",
        "runtime_manifest_sha256",
        "workspace_ceiling_sha256",
        "capability_ceiling_sha256",
        "assignment_manifest_sha256",
      ]) {
        assert.ok(columns.includes(identityColumn), `${table} must bind ${identityColumn}`);
      }
    }

    const fullIdentityIndex = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_remote_worker_assignment_generations_full_identity") as { sql?: string } | undefined;
    assert.ok(fullIdentityIndex?.sql, "migration 179 needs the assignment full-identity unique index");

    const triggerNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>
    ).map((trigger) => trigger.name);
    for (const insertOnly of [
      "remote_worker_artifact_parts",
      "remote_worker_artifact_blobs",
      "remote_worker_artifact_manifests",
      "remote_worker_artifact_manifest_entries",
      "remote_worker_effect_intents",
      "remote_worker_effect_transitions",
    ]) {
      assert.ok(triggerNames.includes(`trg_${insertOnly}_no_update`), `${insertOnly} needs a no-update trigger`);
      assert.ok(triggerNames.includes(`trg_${insertOnly}_no_delete`), `${insertOnly} needs a no-delete trigger`);
    }
    for (const trigger of [
      "trg_remote_worker_artifact_uploads_revision_cas",
      "trg_remote_worker_artifact_verifications_revision_cas",
      "trg_remote_worker_effect_receipts_revision_cas",
      "trg_remote_worker_effect_transitions_chain_guard",
    ]) {
      assert.ok(triggerNames.includes(trigger), `migration 179 needs trigger ${trigger}`);
    }

    db.close();
  });

  it("keeps migration 176 additive, hash-only, currency-fenced, immutable, and delete-after-expiry", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx501b1-176-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const tables = ["remote_worker_bootstrap_request_nonces", "remote_worker_credential_request_nonces"];
    for (const table of tables) {
      const tableSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
          | { sql: string }
          | undefined
      )?.sql;
      assert.ok(tableSql, `expected migration 176 table ${table}`);
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      // Hash-only: never a raw nonce or any authorization/secret material column
      // (credential_generation / credential_id are non-secret parent identity).
      for (const forbidden of [
        "nonce_value",
        "nonce_raw",
        "token",
        "secret",
        "proof",
        "body",
        "authorization",
        "certificate",
        "public_key",
        "tls_exporter",
      ]) {
        assert.equal(
          columns.some((column) => column.toLowerCase().includes(forbidden)),
          false,
          `${table} must stay hash-only (found ${forbidden})`,
        );
      }
      assert.ok(columns.includes("nonce_sha256"), `${table} stores only the nonce digest`);
      assert.ok(
        columns.includes("request_timestamp") && columns.includes("expires_at") && columns.includes("consumed_at"),
      );
      // Exact 60-second expiry relationship.
      assert.match(tableSql!, /\) = 60000\)/u);
      const triggers = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
        .all(table) as Array<{
        name: string;
        sql: string;
      }>;
      const triggerNames = triggers.map((trigger) => trigger.name);
      assert.ok(triggerNames.includes(`trg_${table}_insert_guard`), `${table} needs an insert guard`);
      assert.ok(triggerNames.includes(`trg_${table}_no_update`), `${table} needs a no-update trigger`);
      assert.ok(triggerNames.includes(`trg_${table}_no_delete`), `${table} needs a delete-after-expiry trigger`);
      const deleteGuard = triggers.find((trigger) => trigger.name === `trg_${table}_no_delete`)?.sql ?? "";
      assert.match(deleteGuard, /OLD\.expires_at > strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)/u);
    }

    const bootstrapGuard = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_remote_worker_bootstrap_request_nonces_insert_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.match(
      bootstrapGuard,
      /abs\(julianday\(NEW\.request_timestamp\) - julianday\('now'\)\) \* 86400\.0 > 60\.0/u,
    );
    assert.match(bootstrapGuard, /COALESCE\(MAX\(generation\.worker_generation\), 0\) \+ 1/u);
    assert.match(
      bootstrapGuard,
      /remote_worker_generations generation[\s\S]*generation\.bootstrap_id = NEW\.bootstrap_id/u,
    );

    const credentialGuard = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_remote_worker_credential_request_nonces_insert_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.match(credentialGuard, /MAX\(generation\.worker_generation\)/u);
    assert.match(credentialGuard, /MAX\(credential\.credential_generation\)/u);
    assert.match(credentialGuard, /remote_worker_generation_controls control/u);

    // The minimal parent UNIQUE keys the complete composite foreign keys require.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%nonce_authority'")
      .all() as Array<{ name: string }>;
    assert.deepEqual(indexes.map((index) => index.name).sort(), [
      "idx_remote_worker_bootstrap_requests_nonce_authority",
      "idx_remote_worker_runtime_credentials_nonce_authority",
    ]);

    db.close();
  });

  it("keeps migration 175 additive, content-free, registry-guarded, and immutable", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx402-175-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const tables = [
      "governed_lifecycle_events",
      "improvement_lifecycle_operations",
      "improvement_lifecycle_operation_claims",
      "improvement_lifecycle_operation_inspections",
      "improvement_lifecycle_operation_settlements",
    ];
    for (const table of tables) {
      const tableSql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
          | { sql: string }
          | undefined
      )?.sql;
      assert.ok(tableSql, `expected migration 175 table ${table}`);
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      for (const forbidden of [
        "prompt",
        "response",
        "content",
        "message_body",
        "tool_result",
        "provider_payload",
        "payload_json",
        "raw",
      ]) {
        assert.equal(
          columns.some((column) => column.toLowerCase().includes(forbidden)),
          false,
          `${table} must stay content-free (found ${forbidden})`,
        );
      }
      const triggers = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table) as Array<{
          name: string;
        }>
      ).map((trigger) => trigger.name);
      assert.ok(triggers.includes(`trg_${table}_no_update`), `${table} needs a no-update trigger`);
      assert.ok(triggers.includes(`trg_${table}_no_delete`), `${table} needs a no-delete trigger`);
    }

    const kindGuardSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_governed_lifecycle_events_kind_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.equal((kindGuardSql.match(/UNION ALL SELECT/gu) ?? []).length, 31);
    assert.match(kindGuardSql, /system_actor_only = 0 OR NEW\.actor_type = 'system'/u);
    assert.match(kindGuardSql, /not in the frozen registry/u);

    const eventsSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'governed_lifecycle_events'").get() as {
        sql: string;
      }
    ).sql;
    assert.match(eventsSql, /approval_required = 1 AND approval_id IS NOT NULL/u);
    assert.match(eventsSql, /source_required = 0 OR \(source_kind IS NOT NULL AND source_id IS NOT NULL\)/u);
    assert.match(eventsSql, /scope_kind = 'global' AND workspace_id IS NULL/u);

    const claimGuardSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_improvement_lifecycle_operation_claims_insert_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.match(claimGuardSql, /COALESCE\(MAX\(prior\.claim_generation\), 0\) \+ 1/u);
    assert.match(claimGuardSql, /lease_expires_at > strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)/u);

    const settlementGuardSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_improvement_lifecycle_operation_settlements_insert_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.match(settlementGuardSql, /MAX\(claim\.claim_generation\)/u);
    assert.match(settlementGuardSql, /observed_state_sha256 = NEW\.observed_state_sha256/u);
    assert.match(settlementGuardSql, /disposition = 'matches_intent'/u);

    db.close();
  });

  it("keeps migration 174 content-free, deferred, append-only, and recovery-indexed", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx411-174-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const columns = db.prepare("PRAGMA table_info(chat_heartbeat_occurrences)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const columnNames = columns.map((column) => column.name);
    for (const required of [
      "occurrence_id",
      "admission_id",
      "user_message_id",
      "assistant_message_id",
      "turn_id",
      "expected_durable_run_id",
      "durable_run_id",
      "capability_profile_id",
      "capability_profile_hash",
      "state",
      "revision",
      "updated_at",
    ]) {
      assert.ok(columnNames.includes(required), `expected heartbeat occurrence column ${required}`);
    }
    assert.equal(columns.find((column) => column.name === "durable_run_id")?.notnull, 0);
    assert.equal(columns.find((column) => column.name === "capability_profile_id")?.notnull, 0);
    assert.equal(columns.find((column) => column.name === "capability_profile_hash")?.notnull, 0);
    for (const forbidden of [
      "prompt",
      "response",
      "content",
      "message_body",
      "tool_result",
      "provider_payload",
      "request_json",
      "response_json",
    ]) {
      assert.equal(
        columnNames.some((column) => column.toLowerCase().includes(forbidden)),
        false,
      );
    }

    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_heartbeat_occurrences'")
        .get() as { sql: string }
    ).sql;
    assert.equal((tableSql.match(/DEFERRABLE INITIALLY DEFERRED/gu) ?? []).length, 3);
    assert.match(tableSql, /durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id/gu);
    assert.match(tableSql, /CHECK\(admission_material_sha256 = frozen_request_sha256\)/u);
    assert.match(tableSql, /user_message_id TEXT NOT NULL UNIQUE/gu);
    assert.match(tableSql, /assistant_message_id TEXT NOT NULL UNIQUE/gu);
    assert.doesNotMatch(tableSql, /dead_lettered/u);

    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_heartbeat_occurrences'")
      .all() as Array<{ name: string; sql: string | null }>;
    assert.match(
      indexes.find((index) => index.name === "idx_chat_heartbeat_occurrences_one_open")?.sql ?? "",
      /UNIQUE INDEX[\s\S]*WHERE state IN \('admitted', 'durable_bound'\)/u,
    );
    assert.match(
      indexes.find((index) => index.name === "idx_chat_heartbeat_occurrences_recovery")?.sql ?? "",
      /\(state, updated_at, occurrence_id\)/u,
    );

    const triggers = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'chat_heartbeat_occurrences'")
      .all() as Array<{ name: string; sql: string }>;
    assert.deepEqual(triggers.map((trigger) => trigger.name).sort(), [
      "trg_chat_heartbeat_occurrences_insert_guard",
      "trg_chat_heartbeat_occurrences_no_delete",
      "trg_chat_heartbeat_occurrences_terminal_evidence_guard",
      "trg_chat_heartbeat_occurrences_transition_guard",
    ]);
    assert.match(
      triggers.find((trigger) => trigger.name.endsWith("insert_guard"))?.sql ?? "",
      /admission\.operation = 'chat_system_heartbeat'[\s\S]*prefs\.last_proactive_run_id = NEW\.occurrence_id/u,
    );
    assert.match(
      triggers.find((trigger) => trigger.name.endsWith("insert_guard"))?.sql ?? "",
      /NEW\.admission_material_sha256 <> NEW\.frozen_request_sha256/u,
    );
    assert.match(
      triggers.find((trigger) => trigger.name.endsWith("transition_guard"))?.sql ?? "",
      /NEW\.revision <> OLD\.revision \+ 1[\s\S]*NEW\.durable_run_id <> OLD\.expected_durable_run_id/u,
    );
    const terminalGuardSql = triggers.find((trigger) => trigger.name.endsWith("terminal_evidence_guard"))?.sql ?? "";
    assert.match(terminalGuardSql, /heartbeatDecisionReceipt[\s\S]*heartbeatDecisionRawOutput/u);
    assert.match(terminalGuardSql, /gc_sha256\(gc_canonical_json/u);
    assert.match(terminalGuardSql, /gc_js_trim/u);
    assert.match(terminalGuardSql, /gc_unicode_scalar_length/u);
    assert.match(terminalGuardSql, /heartbeat_input[\s\S]*trace\.user_message_id/u);
    assert.match(terminalGuardSql, /message\.actor_type = 'system'[\s\S]*message\.actor_id = 'system-heartbeat'/u);
    assert.match(terminalGuardSql, /heartbeatCleanup\.status'\) = 'not_required'/u);
    assert.match(terminalGuardSql, /generalChatPostCommit\.completedEffects'\) = 0/u);
    assert.match(
      triggers.find((trigger) => trigger.name.endsWith("no_delete"))?.sql ?? "",
      /BEFORE DELETE ON chat_heartbeat_occurrences/u,
    );
    const admissionGuardSql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_chat_session_mutation_admissions_update_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.match(admissionGuardSql, /heartbeat occurrence request-runtime reclaim/u);
    assert.match(
      admissionGuardSql,
      /julianday\(OLD\.runtime_lease_expires_at\) <= julianday\(NEW\.runtime_last_heartbeat_at\)[\s\S]*NEW\.runtime_lease_expires_at = strftime\([\s\S]*'\+60 seconds'[\s\S]*occurrence\.state = 'admitted'/u,
    );
    const reclaimStart = admissionGuardSql.indexOf("heartbeat occurrence request-runtime reclaim");
    const reclaimEnd = admissionGuardSql.indexOf(
      "OR (NEW.status = 'active' AND OLD.status = 'active'\n          AND OLD.runtime_lease_relinquished_at IS NULL\n          AND NEW.runtime_lease_relinquished_at IS NOT NULL",
      reclaimStart,
    );
    assert.ok(reclaimStart >= 0 && reclaimEnd > reclaimStart);
    assert.doesNotMatch(admissionGuardSql.slice(reclaimStart, reclaimEnd), /julianday\('now'\)/u);
    assert.match(admissionGuardSql, /heartbeat preemption terminal timestamp evidence/u);
    assert.match(
      admissionGuardSql,
      /occurrence\.frozen_request_sha256 = OLD\.material_sha256[\s\S]*occurrence\.aggregate_revision = OLD\.aggregate_revision[\s\S]*occurrence\.controller_generation = OLD\.controller_generation/u,
    );
    assert.match(
      admissionGuardSql,
      /julianday\(OLD\.runtime_lease_expires_at\) > julianday\('now'\)[\s\S]*NEW\.runtime_lease_revision = OLD\.runtime_lease_revision \+ 1/u,
    );
    const controlEventTableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_session_control_events'")
        .get() as { sql: string }
    ).sql;
    assert.match(controlEventTableSql, /reason_code[\s\S]*'heartbeat_preempted'/u);
    const preemptionEventGuard = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_chat_session_control_events_heartbeat_preempted_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.match(
      preemptionEventGuard,
      /NEW\.next_generation = NEW\.previous_generation \+ 1[\s\S]*NEW\.actor_kind = 'operator'/u,
    );
    assert.match(preemptionEventGuard, /prior\.lease_state = 'operator_active'[\s\S]*prior\.is_current = 1/u);
    assert.doesNotMatch(preemptionEventGuard, /julianday\('now'\)|strftime\([^)]*'now'/u);
    const preemptionGrantGuard = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_chat_session_control_grants_heartbeat_preempted_guard'",
        )
        .get() as { sql: string }
    ).sql;
    assert.match(
      preemptionGrantGuard,
      /event_row\.reason_code = 'heartbeat_preempted'[\s\S]*event_row\.created_at = NEW\.created_at/u,
    );
    db.close();
  });

  it("does not record 173 when its authority predecessors are missing", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx411-missing-predecessors-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const partial = new DatabaseSync(dbPath);
    partial.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const seedLedger = partial.prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, '2026-07-15T00:00:00.000Z')",
    );
    for (let version = 1; version <= 172; version += 1) {
      seedLedger.run(version, __sqliteInternals.getSchemaMigrationNameForTest(version));
    }
    partial.close();

    assert.throws(
      () => createDatabase({ dbPath }),
      /migration 173 requires chat_session_meta and chat_session_control_grants predecessors/iu,
    );
    const inspect = new DatabaseSync(dbPath);
    assert.equal(inspect.prepare("SELECT 1 FROM schema_migrations WHERE version = 173").get(), undefined);
    assert.equal(
      inspect
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_session_lifecycle_intents'")
        .get(),
      undefined,
    );
    inspect.close();
  });

  it("upgrades 172 to 173 once and permits only exact deletion binding for legacy metadata", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx411-173-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const before = createDatabase({ dbPath });
    new ChatSessionMetaRepository(before).ensure("legacy-session", "2026-07-14T00:00:00.000Z", "legacy-workspace");
    rewindSessionLifecycleMigration(before);
    seedLegacyCapabilityProfile(before, {
      profileId: "legacy-profile",
      turnId: "legacy-turn",
      sessionId: "legacy-session",
      workspaceId: "legacy-workspace",
      profileHash: "a".repeat(64),
    });
    seedLegacyRoutedContextSnapshot(before, {
      snapshotId: "legacy-snapshot",
      profileId: "legacy-profile",
      profileHash: "a".repeat(64),
      turnId: "legacy-turn",
      sessionId: "legacy-session",
      workspaceId: "legacy-workspace",
    });
    before.close();

    const migrated = createDatabase({ dbPath });
    assert.equal(
      (
        migrated
          .prepare("SELECT lifecycle_intent_id FROM chat_session_meta WHERE session_id = 'legacy-session'")
          .get() as { lifecycle_intent_id: string | null }
      ).lifecycle_intent_id,
      null,
    );
    assert.equal(
      (
        migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 173").get() as {
          count: number;
        }
      ).count,
      1,
    );
    assert.deepEqual(
      {
        ...(migrated
          .prepare(
            `SELECT binding.turn_id, profile_binding.profile_id, profile_binding.profile_hash,
                    binding.workspace_id, binding.session_id,
                    binding.session_incarnation_id, binding.admission_id
             FROM chat_turn_session_incarnation_bindings binding
             JOIN chat_turn_capability_profile_incarnation_bindings profile_binding
               ON profile_binding.turn_id = binding.turn_id
             WHERE binding.turn_id = 'legacy-turn'`,
          )
          .get() as Record<string, unknown>),
      },
      {
        turn_id: "legacy-turn",
        profile_id: "legacy-profile",
        profile_hash: "a".repeat(64),
        workspace_id: "legacy-workspace",
        session_id: "legacy-session",
        session_incarnation_id: "legacy-session-incarnation:legacy-session",
        admission_id: null,
      },
    );
    for (const table of [
      "chat_session_lifecycle_intents",
      "chat_session_mutation_admissions",
      "chat_session_mutation_admission_events",
    ]) {
      assert.equal(
        (
          migrated
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) as { count: number }
        ).count,
        1,
      );
    }
    assert.throws(
      () =>
        migrated
          .prepare("UPDATE chat_session_meta SET lifecycle_intent_id = 'forged' WHERE session_id = 'legacy-session'")
          .run(),
      /lifecycle intent/iu,
    );
    const lifecycle = new ChatSessionLifecycleRepository(migrated);
    migrated.transaction("immediate", () => {
      lifecycle.deleteTree(
        {
          workspaceId: "legacy-workspace",
          rootSessionId: "legacy-session",
          expectedRootRevision: 1,
          actorId: "operator-a",
          idempotencyKey: "lifecycle:delete:legacy-session",
          correlationId: "correlation:lifecycle:delete:legacy-session",
        },
        () => undefined,
      );
    });
    assert.equal(
      migrated.prepare("SELECT 1 FROM chat_session_meta WHERE session_id = 'legacy-session'").get(),
      undefined,
    );
    migrated.close();

    const replay = createDatabase({ dbPath });
    assert.equal(
      (replay.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 173").get() as { count: number })
        .count,
      1,
    );
    replay.close();
  });

  it("rolls back 173 for zero, duplicate, and orphan current-control corruption", () => {
    for (const variant of ["zero", "duplicate", "orphan"] as const) {
      const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx411-173-${variant}-${randomUUID()}.db`);
      createdFiles.push(dbPath);
      const before = createDatabase({ dbPath });
      new ChatSessionMetaRepository(before).ensure("corrupt-session", undefined, "workspace-a");
      rewindSessionLifecycleMigration(before);
      if (variant === "zero") {
        before.exec("DROP TRIGGER IF EXISTS trg_chat_session_control_grants_update_guard");
        before
          .prepare(
            `UPDATE chat_session_control_grants
           SET is_current = 0, lease_state = 'deleted', control_revision = control_revision + 1,
               updated_at = created_at, terminal_at = created_at
           WHERE session_id = 'corrupt-session'`,
          )
          .run();
      } else if (variant === "orphan") {
        before.prepare("DELETE FROM chat_session_meta WHERE session_id = 'corrupt-session'").run();
      } else {
        before.exec(`
          DROP TRIGGER IF EXISTS trg_chat_session_control_grants_insert_guard;
          DROP INDEX IF EXISTS idx_chat_session_control_grants_one_current;
        `);
        before
          .prepare(
            `INSERT INTO chat_session_control_grants (
             workspace_id, session_id, generation, is_current, owner_kind, lease_state,
             request_id, companion_session_id, device_grant_id, client_instance_id, principal_purpose,
             requested_capabilities_json, requested_capabilities_sha256,
             effective_capabilities_json, effective_capabilities_sha256,
             token_sha256, token_expires_at, last_heartbeat_at, lease_expires_at, reconnect_expires_at,
             control_revision, transition_idempotency_key, transition_request_sha256,
             created_at, updated_at, terminal_at
           )
           SELECT workspace_id, session_id, generation + 1, 1, owner_kind, lease_state,
             request_id, companion_session_id, device_grant_id, client_instance_id, principal_purpose,
             requested_capabilities_json, requested_capabilities_sha256,
             effective_capabilities_json, effective_capabilities_sha256,
             token_sha256, token_expires_at, last_heartbeat_at, lease_expires_at, reconnect_expires_at,
             control_revision, transition_idempotency_key || ':duplicate', transition_request_sha256,
             created_at, updated_at, terminal_at
           FROM chat_session_control_grants WHERE session_id = 'corrupt-session' AND generation = 1`,
          )
          .run();
      }
      before.close();

      assert.throws(() => createDatabase({ dbPath }), /CHECK constraint|preflight|constraint failed/iu);
      const inspect = new DatabaseSync(dbPath);
      assert.equal(inspect.prepare("SELECT 1 FROM schema_migrations WHERE version = 173").get(), undefined);
      assert.equal(
        inspect
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_session_lifecycle_intents'")
          .get(),
        undefined,
      );
      inspect.close();
    }
  });

  it("rolls back 173 instead of inventing authority for mismatched legacy snapshot/profile rows", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hx411-profile-mismatch-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const before = createDatabase({ dbPath });
    rewindSessionLifecycleMigration(before);
    seedLegacyCapabilityProfile(before, {
      profileId: "mismatched-profile",
      turnId: "mismatched-turn",
      sessionId: "mismatched-session",
      workspaceId: "workspace-a",
      profileHash: "a".repeat(64),
    });
    seedLegacyRoutedContextSnapshot(before, {
      snapshotId: "mismatched-snapshot",
      profileId: "mismatched-profile",
      profileHash: "b".repeat(64),
      turnId: "mismatched-turn",
      sessionId: "mismatched-session",
      workspaceId: "workspace-a",
    });
    before.close();

    assert.throws(() => createDatabase({ dbPath }), /CHECK constraint|preflight|constraint failed/iu);
    const inspect = new DatabaseSync(dbPath);
    assert.equal(inspect.prepare("SELECT 1 FROM schema_migrations WHERE version = 173").get(), undefined);
    assert.equal(
      inspect
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_turn_session_incarnation_bindings'")
        .get(),
      undefined,
    );
    inspect.close();
  });

  it("creates hot-path chat projection and index migrations", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hot-path-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const chatMessagesColumns = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    assert.ok(chatMessagesColumns.some((column) => column.name === "message_id"));

    const delegationStepColumns = db.prepare("PRAGMA table_info(chat_delegation_steps)").all() as Array<{
      name: string;
    }>;
    assert.ok(delegationStepColumns.some((column) => column.name === "parallelizable"));
    assert.ok(delegationStepColumns.some((column) => column.name === "depends_on_step_ids_json"));
    assert.ok(delegationStepColumns.some((column) => column.name === "dispatch_claim_token"));
    assert.ok(delegationStepColumns.some((column) => column.name === "dispatch_claim_expires_at"));

    const approvalsIndexes = db.prepare("PRAGMA index_list(approvals)").all() as Array<{ name: string }>;
    assert.ok(approvalsIndexes.some((index) => index.name === "idx_approvals_status_created"));
    assert.ok(approvalsIndexes.some((index) => index.name === "idx_approvals_status_expires_at"));

    const toolInvocationIndexes = db.prepare("PRAGMA index_list(tool_invocations)").all() as Array<{ name: string }>;
    assert.ok(toolInvocationIndexes.some((index) => index.name === "idx_tool_invocations_session_time"));

    const decisionTraceColumns = db.prepare("PRAGMA table_info(runtime_decision_traces)").all() as Array<{
      name: string;
    }>;
    assert.ok(decisionTraceColumns.some((column) => column.name === "payload_json"));

    const decisionTraceIndexes = db.prepare("PRAGMA index_list(runtime_decision_traces)").all() as Array<{
      name: string;
    }>;
    assert.ok(decisionTraceIndexes.some((index) => index.name === "idx_runtime_decision_traces_session_turn"));
    assert.ok(decisionTraceIndexes.some((index) => index.name === "idx_runtime_decision_traces_run"));

    const policyBlockIndexes = db.prepare("PRAGMA index_list(policy_blocks)").all() as Array<{ name: string }>;
    assert.ok(policyBlockIndexes.some((index) => index.name === "idx_policy_blocks_session_time"));

    const authDeviceRequestColumns = db.prepare("PRAGMA table_info(auth_device_requests)").all() as Array<{
      name: string;
    }>;
    assert.ok(authDeviceRequestColumns.some((column) => column.name === "approval_id"));

    const authDeviceGrantColumns = db.prepare("PRAGMA table_info(auth_device_grants)").all() as Array<{ name: string }>;
    assert.ok(authDeviceGrantColumns.some((column) => column.name === "token_hash"));

    db.close();
  });

  it("backfills pending mutation claim leases idempotently in the forward migration", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-mutation-lease-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const updatedAt = "2026-07-11T00:00:00.000Z";
    db.prepare(
      `
        INSERT INTO mutation_idempotency (
          method, route_path, idempotency_key, actor_scope, payload_hash, status,
          claim_token, claim_expires_at, created_at, updated_at
        ) VALUES ('POST', '/api/v1/chat/probe', 'legacy-pending', 'operator:probe',
          'payload-hash', 'pending', NULL, NULL, @updatedAt, @updatedAt)
      `,
    ).run({ updatedAt });
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(140);
    db.close();

    const migrated = createDatabase({ dbPath });
    const first = migrated
      .prepare(
        `SELECT claim_token, claim_expires_at
         FROM mutation_idempotency
         WHERE idempotency_key = 'legacy-pending'`,
      )
      .get() as { claim_token: string; claim_expires_at: string };
    assert.match(first.claim_token, /^legacy-[a-f0-9]{32}$/);
    assert.equal(first.claim_expires_at, updatedAt);
    migrated.prepare("DELETE FROM schema_migrations WHERE version = ?").run(140);
    migrated.close();

    const replayed = createDatabase({ dbPath });
    const second = replayed
      .prepare(
        `SELECT claim_token, claim_expires_at
         FROM mutation_idempotency
         WHERE idempotency_key = 'legacy-pending'`,
      )
      .get() as { claim_token: string; claim_expires_at: string };
    assert.deepEqual(second, first);
    replayed.close();
  });

  it("moves legacy delegation dispatch markers out of canonical child linkage idempotently", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-delegation-lease-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const expiresAtMs = Date.parse(expiresAt);
    const claimToken = `delegation-claim:v1:${expiresAtMs}:turn-claim:owner-a`;
    const dispatchToken = `delegation-dispatch:v1:${expiresAtMs}:turn-dispatch:owner-b`;
    db.prepare(
      `
        INSERT INTO chat_delegation_steps (
          step_id, run_id, role, step_index, status, child_session_id, child_turn_id, started_at
        ) VALUES (?, 'run-legacy', 'coder', ?, 'running', ?, ?, '2026-07-11T00:00:00.000Z')
      `,
    ).run("step-legacy-claim", 0, claimToken, null);
    db.prepare(
      `
        INSERT INTO chat_delegation_steps (
          step_id, run_id, role, step_index, status, child_session_id, child_turn_id, started_at
        ) VALUES (?, 'run-legacy', 'qa', ?, 'running', ?, ?, '2026-07-11T00:00:00.000Z')
      `,
    ).run("step-legacy-dispatch", 1, "canonical-child-session", dispatchToken);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(142);
    db.close();

    const migrated = createDatabase({ dbPath });
    const rows = migrated
      .prepare(
        `SELECT step_id, child_session_id, child_turn_id, dispatch_claim_token, dispatch_claim_expires_at
         FROM chat_delegation_steps WHERE run_id = 'run-legacy' ORDER BY step_index`,
      )
      .all() as Array<{
      step_id: string;
      child_session_id: string | null;
      child_turn_id: string | null;
      dispatch_claim_token: string | null;
      dispatch_claim_expires_at: string | null;
    }>;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          step_id: "step-legacy-claim",
          child_session_id: null,
          child_turn_id: null,
          dispatch_claim_token: claimToken,
          dispatch_claim_expires_at: expiresAt,
        },
        {
          step_id: "step-legacy-dispatch",
          child_session_id: "canonical-child-session",
          child_turn_id: null,
          dispatch_claim_token: dispatchToken,
          dispatch_claim_expires_at: expiresAt,
        },
      ],
    );
    migrated.prepare("DELETE FROM schema_migrations WHERE version = ?").run(142);
    migrated.close();

    const replayed = createDatabase({ dbPath });
    assert.equal(
      replayed
        .prepare("SELECT COUNT(*) AS count FROM chat_delegation_steps WHERE child_session_id LIKE 'delegation-%'")
        .get<{ count: number }>()?.count,
      0,
    );
    replayed.close();
  });

  it("creates Citadel parent records and parent-scope columns", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-citadels-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const citadels = db.prepare("SELECT citadel_id, kind, default_workspace_id FROM citadel_records").all() as Array<{
      citadel_id: string;
      kind: string;
      default_workspace_id: string | null;
    }>;
    assert.deepEqual(citadels.map((row) => [row.citadel_id, row.kind, row.default_workspace_id]).sort(), [
      ["company", "company", null],
      ["personal", "personal", "default"],
    ]);

    const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
    assert.ok(workspaceColumns.some((column) => column.name === "citadel_id"));

    const defaultWorkspace = db.prepare("SELECT citadel_id FROM workspaces WHERE workspace_id = 'default'").get() as {
      citadel_id: string;
    };
    assert.equal(defaultWorkspace.citadel_id, "personal");

    const decisionTraceColumns = db.prepare("PRAGMA table_info(runtime_decision_traces)").all() as Array<{
      name: string;
    }>;
    assert.ok(decisionTraceColumns.some((column) => column.name === "citadel_id"));

    db.close();
  });

  it("scrubs legacy device-token plaintext and revokes only undelivered grants", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-device-token-scrub-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const createdAt = "2026-06-20T00:00:00.000Z";
    const tokenExpiresAt = "2099-01-01T00:00:00.000Z";
    const insertRequest = db.prepare(`
      INSERT INTO auth_device_requests (
        request_id, approval_id, request_secret_hash, device_label, device_type,
        status, created_at, expires_at, resolved_at, resolved_by,
        approved_token_plaintext, approved_token_expires_at, delivered_at
      ) VALUES (?, ?, ?, ?, 'desktop', 'approved', ?, ?, ?, 'operator:legacy', ?, ?, ?)
    `);
    const insertGrant = db.prepare(`
      INSERT INTO auth_device_grants (
        grant_id, request_id, token_hash, device_label, device_type,
        granted_by, created_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, 'desktop', 'operator:legacy', ?, ?, '{}')
    `);

    insertRequest.run(
      "legacy-undelivered",
      "legacy-approval-undelivered",
      "request-secret-hash-undelivered",
      "Legacy undelivered",
      createdAt,
      "2026-06-20T00:10:00.000Z",
      "2026-06-20T00:01:00.000Z",
      "legacy-plaintext-undelivered",
      tokenExpiresAt,
      null,
    );
    insertGrant.run(
      "legacy-grant-undelivered",
      "legacy-undelivered",
      "legacy-token-hash-undelivered",
      "Legacy undelivered",
      createdAt,
      tokenExpiresAt,
    );
    insertRequest.run(
      "legacy-delivered",
      "legacy-approval-delivered",
      "request-secret-hash-delivered",
      "Legacy delivered",
      createdAt,
      "2026-06-20T00:10:00.000Z",
      "2026-06-20T00:01:00.000Z",
      "legacy-plaintext-delivered",
      tokenExpiresAt,
      "2026-06-20T00:02:00.000Z",
    );
    insertGrant.run(
      "legacy-grant-delivered",
      "legacy-delivered",
      "legacy-token-hash-delivered",
      "Legacy delivered",
      createdAt,
      tokenExpiresAt,
    );
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(137);
    db.close();

    const migrated = createDatabase({ dbPath });
    const undelivered = migrated
      .prepare(
        `SELECT status, approved_token_plaintext, approved_token_expires_at
         FROM auth_device_requests WHERE request_id = ?`,
      )
      .get("legacy-undelivered") as {
      status: string;
      approved_token_plaintext: string | null;
      approved_token_expires_at: string | null;
    };
    const delivered = migrated
      .prepare(
        `SELECT status, approved_token_plaintext
         FROM auth_device_requests WHERE request_id = ?`,
      )
      .get("legacy-delivered") as { status: string; approved_token_plaintext: string | null };
    const grants = migrated
      .prepare("SELECT grant_id, revoked_at FROM auth_device_grants ORDER BY grant_id")
      .all() as Array<{ grant_id: string; revoked_at: string | null }>;

    assert.deepEqual(
      { ...undelivered },
      {
        status: "expired",
        approved_token_plaintext: null,
        approved_token_expires_at: null,
      },
    );
    assert.deepEqual({ ...delivered }, { status: "approved", approved_token_plaintext: null });
    assert.equal(grants.find((grant) => grant.grant_id === "legacy-grant-undelivered")?.revoked_at !== null, true);
    assert.equal(grants.find((grant) => grant.grant_id === "legacy-grant-delivered")?.revoked_at, null);

    const firstRevokedAt = grants.find((grant) => grant.grant_id === "legacy-grant-undelivered")?.revoked_at;
    migrated.prepare("DELETE FROM schema_migrations WHERE version = ?").run(137);
    migrated.close();
    const rerun = createDatabase({ dbPath });
    const rerunGrant = rerun
      .prepare("SELECT revoked_at FROM auth_device_grants WHERE grant_id = ?")
      .get("legacy-grant-undelivered") as { revoked_at: string | null };
    assert.equal(rerunGrant.revoked_at, firstRevokedAt);
    rerun.close();
  });

  it("scrubs legacy remote approval bearers from durable and observability stores", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-remote-bearer-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const rawToken = `grat_${"m".repeat(42)}-`;
    const decoratedToken = `x${rawToken}y`;
    const now = "2026-07-10T00:00:00.000Z";
    const db = createDatabase({ dbPath });
    db.prepare(
      `
      INSERT INTO durable_runs (
        run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
        version, created_at, updated_at
      ) VALUES (?, 'connector.delivery', 'queued', 0, 3, ?, '{}', 1, ?, ?)
    `,
    ).run("legacy-remote-run", JSON.stringify({ payload: { token: decoratedToken } }), now, now);
    db.prepare(
      `UPDATE durable_runs
       SET lease_owner_id = ?, lease_expires_at = ?, lease_heartbeat_at = ?
       WHERE run_id = ?`,
    ).run("worker-legacy", "2099-07-10T00:05:00.000Z", now, "legacy-remote-run");
    db.prepare(
      `
      INSERT INTO durable_runs (
        run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
        version, created_at, updated_at
      ) VALUES (?, 'connector.delivery', 'queued', 0, 3, ?, '{}', 1, ?, ?)
    `,
    ).run(
      "benign-grateful-run",
      JSON.stringify({ message: "grateful operator note using grat_community_discount_code" }),
      now,
      now,
    );
    db.prepare(
      `
      INSERT INTO comms_deliveries (
        delivery_id, connection_id, channel_key, target, payload_hash, payload_json, status,
        attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 3, ?, ?)
    `,
    ).run(
      "legacy-remote-delivery",
      "connection-1",
      "discord",
      "channel-1",
      "legacy-payload-hash",
      JSON.stringify({ interactiveActions: { buttons: [{ callbackData: `gca:${rawToken}:a` }] } }),
      now,
      now,
    );
    db.prepare(
      `
      INSERT INTO comms_deliveries (
        delivery_id, connection_id, channel_key, target, payload_hash, payload_json, status,
        attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 3, ?, ?)
    `,
    ).run(
      "benign-gratis-delivery",
      "connection-1",
      "discord",
      "channel-1",
      "benign-payload-hash",
      JSON.stringify({ message: "gratis support is enabled" }),
      now,
      now,
    );
    db.prepare(
      `
      INSERT INTO approval_inbox_items (
        inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
        action_type, state, approval_kind, risk_level, approval_status, preview_json,
        created_at, updated_at, expires_at, delivery_count, last_delivered_at
      ) VALUES (?, ?, ?, 'mcp', ?, ?, ?, 'approval.resolve', 'pending', 'tool.invoke', 'danger',
        'pending', '{}', ?, ?, ?, 1, ?)
    `,
    ).run(
      "legacy-inbox",
      "legacy-approval",
      "mcp:server-1",
      "server-1",
      "legacy-token-id",
      `${rawToken}y`,
      now,
      now,
      "2026-07-10T00:15:00.000Z",
      now,
    );
    db.prepare(
      `
      INSERT INTO approval_inbox_items (
        rowid, inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
        action_type, state, approval_kind, risk_level, approval_status, preview_json,
        created_at, updated_at, expires_at, delivery_count, last_delivered_at
      ) VALUES (-2, ?, ?, ?, 'mcp', ?, ?, ?, 'approval.resolve', 'pending', 'tool.invoke', 'danger',
        'pending', '{}', ?, ?, ?, 1, ?)
    `,
    ).run(
      "legacy-negative-rowid-inbox",
      "legacy-negative-rowid-approval",
      "mcp:server-1",
      "server-1",
      "legacy-negative-rowid-token-id",
      `x${rawToken}`,
      now,
      now,
      "2026-07-10T00:15:00.000Z",
      now,
    );
    db.prepare(
      `
      INSERT INTO approval_inbox_items (
        inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
        action_type, state, approval_kind, risk_level, approval_status, preview_json,
        created_at, updated_at, expires_at, delivery_count, last_delivered_at
      ) VALUES (?, ?, ?, 'mcp', ?, ?, ?, 'approval.resolve', 'pending', 'tool.invoke', 'danger',
        'pending', '{}', ?, ?, ?, 1, ?)
    `,
    ).run(
      "benign-inbox",
      "benign-approval",
      "mcp:server-1",
      "server-1",
      "benign-token-id",
      "grateful-note",
      now,
      now,
      "2026-07-10T00:15:00.000Z",
      now,
    );
    const insertToolInvocation = db.prepare(
      `INSERT INTO tool_invocations (
         audit_event_id, timestamp, agent_id, session_id, tool_name, outcome, policy_reason, args_json
       ) VALUES (?, ?, 'operator', 'session-1', 'channel.send', 'executed', 'allowed', ?)`,
    );
    db.transaction("immediate", () => {
      for (let index = 0; index < 250; index += 1) {
        insertToolInvocation.run(
          `benign-batch-${index}`,
          now,
          JSON.stringify({ message: `grat_community_discount_code-${index}` }),
        );
      }
    });
    insertToolInvocation.run("legacy-tool-invocation", now, JSON.stringify({ callbackData: `gca:x${rawToken}:a` }));
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(139);
    db.close();

    const migrated = createDatabase({ dbPath });
    const durable = migrated
      .prepare(
        `SELECT status, payload_json, lease_owner_id, lease_expires_at, lease_heartbeat_at
         FROM durable_runs WHERE run_id = ?`,
      )
      .get("legacy-remote-run") as {
      status: string;
      payload_json: string;
      lease_owner_id: string | null;
      lease_expires_at: string | null;
      lease_heartbeat_at: string | null;
    };
    const delivery = migrated
      .prepare("SELECT status, delivery_status, payload_json FROM comms_deliveries WHERE delivery_id = ?")
      .get("legacy-remote-delivery") as { status: string; delivery_status: string; payload_json: string };
    const inbox = migrated
      .prepare("SELECT token FROM approval_inbox_items WHERE inbox_item_id = ?")
      .get("legacy-inbox") as { token: string };
    const negativeRowidInbox = migrated
      .prepare("SELECT token FROM approval_inbox_items WHERE inbox_item_id = ?")
      .get("legacy-negative-rowid-inbox") as { token: string };
    const invocation = migrated
      .prepare("SELECT args_json FROM tool_invocations WHERE audit_event_id = ?")
      .get("legacy-tool-invocation") as { args_json: string };
    const benignDurable = migrated
      .prepare("SELECT status, payload_json FROM durable_runs WHERE run_id = ?")
      .get("benign-grateful-run") as { status: string; payload_json: string };
    const benignDelivery = migrated
      .prepare("SELECT status, delivery_status, payload_json FROM comms_deliveries WHERE delivery_id = ?")
      .get("benign-gratis-delivery") as { status: string; delivery_status: string | null; payload_json: string };
    const benignInbox = migrated
      .prepare("SELECT token FROM approval_inbox_items WHERE inbox_item_id = ?")
      .get("benign-inbox") as { token: string };
    const benignBatch = migrated
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tool_invocations
         WHERE audit_event_id LIKE 'benign-batch-%'
           AND args_json LIKE '%grat_community_discount_code%'`,
      )
      .get() as { count: number };

    assert.equal(durable.status, "failed");
    assert.equal(durable.lease_owner_id, null);
    assert.equal(durable.lease_expires_at, null);
    assert.equal(durable.lease_heartbeat_at, null);
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.delivery_status, "manual_reconciliation_required");
    assert.equal(inbox.token, "redacted:legacy-token-id");
    assert.equal(negativeRowidInbox.token, "redacted:legacy-negative-rowid-token-id");
    assert.equal(JSON.stringify({ durable, delivery, inbox, invocation }).includes(rawToken), false);
    assert.match(durable.payload_json, /\[REDACTED\]/);
    assert.match(invocation.args_json, /\[REDACTED\]/);
    assert.deepEqual(
      { ...benignDurable },
      {
        status: "queued",
        payload_json: JSON.stringify({ message: "grateful operator note using grat_community_discount_code" }),
      },
    );
    assert.deepEqual(
      { ...benignDelivery },
      {
        status: "queued",
        delivery_status: null,
        payload_json: JSON.stringify({ message: "gratis support is enabled" }),
      },
    );
    assert.equal(benignInbox.token, "grateful-note");
    assert.equal(benignBatch.count, 250);
    migrated.close();
  });

  it("forward-scrubs remote approval bearers from approval effect result and legacy detail truth", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-effect-result-bearer-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const rawToken = `grat_${"r".repeat(43)}`;
    const benign = "grat_community_discount_code";
    const now = "2026-07-11T00:00:00.000Z";
    const db = createDatabase({ dbPath });
    const insertApproval = db.prepare(
      `INSERT INTO approvals (
         approval_id, kind, risk_level, status, payload_json, preview_json, explanation_status, created_at
       ) VALUES (?, 'tool.invoke', 'danger', 'approved', '{}', '{}', 'not_requested', ?)`,
    );
    const insertEffect = db.prepare(
      `INSERT INTO approval_effects (
         effect_id, approval_id, effect_kind, target_kind, target_id, idempotency_key, status,
         outcome, detail, details_json, attempt_count, payload_json, result_json, created_at, updated_at
       ) VALUES (?, ?, 'pending_action_execute', 'pending_action', ?, ?, 'completed', ?, ?, ?, 1, '{}', ?, ?, ?)`,
    );
    insertApproval.run("approval-effect-raw", now);
    insertApproval.run("approval-effect-benign", now);
    insertEffect.run(
      "effect-raw",
      "approval-effect-raw",
      "approval-effect-raw",
      "effect-key-raw",
      `sent:${rawToken}`,
      `detail:${rawToken}`,
      JSON.stringify({ token: rawToken }),
      JSON.stringify({ callbackData: `gca:${rawToken}:approve` }),
      now,
      now,
    );
    insertEffect.run(
      "effect-benign",
      "approval-effect-benign",
      "approval-effect-benign",
      "effect-key-benign",
      benign,
      benign,
      JSON.stringify({ note: benign }),
      JSON.stringify({ note: benign }),
      now,
      now,
    );
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(143);
    db.close();

    const migrated = createDatabase({ dbPath });
    const raw = migrated
      .prepare("SELECT outcome, detail, details_json, result_json FROM approval_effects WHERE effect_id = ?")
      .get("effect-raw") as Record<string, string>;
    const preserved = migrated
      .prepare("SELECT outcome, detail, details_json, result_json FROM approval_effects WHERE effect_id = ?")
      .get("effect-benign") as Record<string, string>;
    assert.equal(JSON.stringify(raw).includes(rawToken), false);
    assert.match(JSON.stringify(raw), /\[REDACTED\]/);
    assert.equal(JSON.stringify(preserved).includes(benign), true);
    assert.equal(JSON.stringify(preserved).includes("[REDACTED]"), false);
    migrated.close();
  });

  it("backfills legacy workspace-as-Citadel records during the parent-scope migration", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-legacy-citadel-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const now = "2026-06-20T00:00:00.000Z";

    db.prepare(
      `
      INSERT INTO workspaces (
        workspace_id, name, description, slug, lifecycle_status, archived_at, workspace_prefs_json, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'active', NULL, '{}', ?, ?)
      ON CONFLICT(workspace_id) DO NOTHING
    `,
    ).run("legacy-team", "Legacy Team", "legacy-team", now, now);
    db.prepare(
      `
      INSERT INTO citadel_charters (
        citadel_id, purpose, kind, goals_json, boundaries_json, success_definition_json,
        default_chamber_id, risk_posture, model_policy_default, created_at, updated_at
      ) VALUES (?, ?, ?, '[]', '[]', '[]', NULL, 'balanced', 'hybrid_guarded', ?, ?)
      ON CONFLICT(citadel_id) DO UPDATE SET updated_at = excluded.updated_at
    `,
    ).run("legacy-team", "Existing workspace Citadel", "team", now, now);
    db.prepare("DELETE FROM citadel_records WHERE citadel_id = ?").run("legacy-team");
    db.prepare("UPDATE workspaces SET citadel_id = 'personal' WHERE workspace_id = ?").run("legacy-team");
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(121);
    db.close();

    const migrated = createDatabase({ dbPath });
    const record = migrated
      .prepare("SELECT name, kind FROM citadel_records WHERE citadel_id = ?")
      .get("legacy-team") as { name: string; kind: string } | undefined;
    assert.deepEqual(record ? { ...record } : undefined, { name: "Legacy Team", kind: "team" });

    const workspace = migrated
      .prepare("SELECT citadel_id FROM workspaces WHERE workspace_id = ?")
      .get("legacy-team") as {
      citadel_id: string;
    };
    assert.equal(workspace.citadel_id, "legacy-team");
    migrated.close();
  });

  it("backfills generated artifact project scope from existing session assignments", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-artifact-project-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const now = "2026-05-24T00:00:00.000Z";
    db.prepare(
      `
      INSERT INTO chat_projects (project_id, name, workspace_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run("project-alpha", "Alpha", "F:\\code\\personal-ai", now, now);
    db.prepare(
      `
      INSERT INTO chat_session_projects (session_id, project_id, assigned_at)
      VALUES (?, ?, ?)
    `,
    ).run("session-alpha", "project-alpha", now);
    db.prepare(
      `
      INSERT INTO chat_generated_artifacts (
        artifact_id,
        session_id,
        workspace_id,
        project_id,
        turn_id,
        title,
        kind,
        content,
        source_surface,
        version,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "artifact-alpha",
      "session-alpha",
      "default",
      null,
      "turn-alpha",
      "Artifact",
      "markdown",
      "# Artifact",
      "code",
      1,
      now,
      now,
    );
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(98);
    db.close();

    const migrated = createDatabase({ dbPath });
    const row = migrated
      .prepare("SELECT project_id FROM chat_generated_artifacts WHERE artifact_id = ?")
      .get("artifact-alpha") as { project_id: string | null };
    assert.equal(row.project_id, "project-alpha");
    migrated.close();
  });

  it("clamps requested SQLite tuning pragmas to supported floors", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-tuning-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const requestedCacheSizeBelowFloorKb = 2_048;
    const cacheSizeFloorKb = 4_096;
    const requestedWalCheckpointBelowFloorPages = 500;
    const walCheckpointFloorPages = 1_000;
    const db = createDatabase({
      dbPath,
      tuning: {
        cacheSizeKb: requestedCacheSizeBelowFloorKb,
        tempStoreMemory: true,
        walAutoCheckpointPages: requestedWalCheckpointBelowFloorPages,
      },
    });

    const cacheSize = db.prepare("PRAGMA cache_size;").get() as { cache_size: number };
    const tempStore = db.prepare("PRAGMA temp_store;").get() as { temp_store: number };
    const walAutoCheckpoint = db.prepare("PRAGMA wal_autocheckpoint;").get() as { wal_autocheckpoint: number };

    assert.equal(cacheSize.cache_size, -cacheSizeFloorKb);
    assert.equal(tempStore.temp_store, 2);
    assert.equal(walAutoCheckpoint.wal_autocheckpoint, walCheckpointFloorPages);
    db.close();
  });

  it("creates the capability_scope_assignments table with unique + lookup indexes", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-capscope-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('capability_scope_assignments') ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    assert.deepEqual(names, [
      "assignment_id",
      "created_at",
      "enabled",
      "resource_ref",
      "resource_type",
      "scope_id",
      "scope_kind",
      "updated_at",
    ]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='capability_scope_assignments'")
      .all() as Array<{ name: string }>;
    const idxNames = indexes.map((i) => i.name);
    assert.ok(idxNames.includes("idx_capability_scope_assignments_unique"));
    assert.ok(idxNames.includes("idx_capability_scope_assignments_lookup"));
    db.close();
  });

  it("waits through a transient lock before switching to WAL mode", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-lock-${randomUUID()}.db`);
    createdFiles.push(dbPath);

    const lockHolder = spawn(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const db = new DatabaseSync(${JSON.stringify(dbPath)});
          db.exec("CREATE TABLE IF NOT EXISTS hold_lock (id INTEGER PRIMARY KEY, value TEXT);");
          db.exec("BEGIN EXCLUSIVE;");
          process.stdout.write("LOCKED\\n");
          setTimeout(() => {
            db.exec("COMMIT;");
            db.close();
            process.exit(0);
          }, 750);
        `,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const [readyChunk] = await once(lockHolder.stdout!, "data");
    assert.match(String(readyChunk), /LOCKED/);

    const startedAt = Date.now();
    const db = createDatabase({ dbPath });
    const elapsedMs = Date.now() - startedAt;

    const journalModeRow = db.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
    assert.equal(journalModeRow.journal_mode, "wal");
    assert.ok(elapsedMs >= 500, `expected createDatabase to wait for the lock to clear, observed ${elapsedMs}ms`);

    db.close();
    const [exitCode] = await once(lockHolder, "exit");
    assert.equal(exitCode, 0);
  });
});

function seedLegacyCapabilityProfile(
  db: ReturnType<typeof createDatabase>,
  input: {
    profileId: string;
    turnId: string;
    sessionId: string;
    workspaceId: string;
    profileHash: string;
  },
): void {
  db.prepare(
    `INSERT INTO chat_turn_capability_profiles (
       profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
       schema_version, profile_hash, catalog_snapshot_id, inspectable_hash, callable_hash,
       selection_hash, governance_hash, preflight_fingerprint, profile_json, created_at
     ) VALUES (
       @profileId, @turnId, @sessionId, @workspaceId, NULL, NULL, NULL,
       'chat.turn-capability-profile.v1', @profileHash, 'legacy-catalog', @digest, @digest,
       @digest, @digest, @digest, '{}', '2026-07-14T00:00:00.000Z'
     )`,
  ).run({ ...input, digest: "c".repeat(64) });
}

function seedLegacyRoutedContextSnapshot(
  db: ReturnType<typeof createDatabase>,
  input: {
    snapshotId: string;
    profileId: string;
    profileHash: string;
    turnId: string;
    sessionId: string;
    workspaceId: string;
  },
): void {
  db.prepare(
    `INSERT INTO chat_routed_context_snapshots (
       snapshot_id, schema_version, turn_id, session_id, workspace_id,
       capability_profile_id, capability_profile_hash, source_request_hash, content_hash, snapshot_hash,
       effective_provider_id, effective_model, context_window_tokens, prompt_reserved_tokens,
       output_reserved_tokens, hard_cap_tokens, effective_budget_tokens, used_tokens,
       source_count, included_count, truncated_count, omitted_count, already_attached_count,
       estimator_version, budget_policy_version, snapshot_json, created_at
     ) VALUES (
       @snapshotId, 'chat.routed-context-snapshot.v1', @turnId, @sessionId, @workspaceId,
       @profileId, @profileHash, @sourceHash, @contentHash, @snapshotHash,
       'provider-a', 'model-a', 1000, 100, 100, 800, 700, 0,
       0, 0, 0, 0, 0, 'gc-approx-tokens.v1', 'chat.routed-context-budget.v1', '{}',
       '2026-07-14T00:00:00.000Z'
     )`,
  ).run({
    ...input,
    sourceHash: "d".repeat(64),
    contentHash: "e".repeat(64),
    snapshotHash: "f".repeat(64),
  });
}

function rewindSessionLifecycleMigration(db: ReturnType<typeof createDatabase>): void {
  const triggers = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger'
         AND (
           name LIKE 'trg_chat_session_lifecycle_%'
           OR name LIKE 'trg_chat_session_meta_lifecycle_%'
           OR name = 'trg_chat_session_meta_workspace_and_intent_update_guard'
           OR name = 'trg_chat_session_control_operator_generation_lifecycle_guard'
           OR name LIKE 'trg_chat_session_mutation_%'
           OR name LIKE 'trg_chat_turn_session_incarnation_%'
           OR name LIKE 'trg_chat_turn_mutation_admission_durable_bindings_%'
           OR name LIKE 'trg_chat_turn_capability_profile_incarnation_bindings_%'
           OR name LIKE 'trg_chat_turn_user_input_continuation_seals_%'
           OR name LIKE 'trg_chat_heartbeat_occurrences_%'
           OR name = 'trg_chat_turn_capability_profiles_incarnation_insert_guard'
           OR name = 'trg_chat_routed_context_snapshots_incarnation_insert_guard'
         )
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.prepare("UPDATE chat_session_meta SET lifecycle_intent_id = NULL").run();
  db.exec(`
    DROP INDEX IF EXISTS idx_chat_session_meta_lifecycle_intent;
    DROP INDEX IF EXISTS idx_chat_session_meta_deletion_intent;
    DROP TABLE IF EXISTS chat_heartbeat_occurrences;
    DROP TABLE IF EXISTS chat_turn_user_input_continuation_seals;
    DROP TABLE IF EXISTS chat_turn_mutation_admission_durable_bindings;
    DROP TABLE IF EXISTS chat_turn_capability_profile_incarnation_bindings;
    DROP TABLE IF EXISTS chat_turn_session_incarnation_bindings;
    DROP TABLE IF EXISTS chat_session_mutation_admission_events;
    DROP TABLE IF EXISTS chat_session_mutation_admissions;
    DROP TABLE IF EXISTS chat_session_lifecycle_intents;
    DROP TABLE IF EXISTS chat_session_control_auth_revoke_operation_targets;
    DROP TABLE IF EXISTS chat_session_control_auth_revoke_operations;
  `);
  db.prepare("DELETE FROM schema_migrations WHERE version = 174").run();
  db.prepare("DELETE FROM schema_migrations WHERE version = 173").run();
}
