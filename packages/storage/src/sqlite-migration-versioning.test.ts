import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createDatabase } from "./sqlite.js";

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
    db.close();
  });

  it("creates hot-path chat projection and index migrations", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-migrations-hot-path-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const chatMessagesColumns = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    assert.ok(chatMessagesColumns.some((column) => column.name === "message_id"));

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
