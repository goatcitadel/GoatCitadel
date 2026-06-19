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
