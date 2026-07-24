import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals, createDatabase } from "./sqlite.js";

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

describe("sqlite chat turn trace repair migration", () => {
  it("repairs stale chat_turn_traces schemas that already recorded older migration versions", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-trace-repair-${randomUUID()}.db`);
    createdFiles.push(dbPath);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Migrations 172+ fail closed on databases that claim applied history without the real
    // predecessor tables, so build the genuine v28 schema before installing the stale trace shape.
    for (let version = 1; version <= 28; version += 1) {
      __sqliteInternals.applySchemaMigrationForTest(version, legacy);
    }
    legacy.exec(`
      DROP TABLE IF EXISTS chat_turn_traces;

      CREATE TABLE chat_turn_traces (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT,
        web_mode TEXT NOT NULL,
        memory_mode TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        routing_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);

    const insertMigration = legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, '2026-03-10T00:00:00.000Z')
    `);
    for (let version = 1; version <= 28; version += 1) {
      insertMigration.run(version, __sqliteInternals.getSchemaMigrationNameForTest(version));
    }
    legacy.close();

    const db = createDatabase({ dbPath });

    const columns = new Set(
      (db.prepare("PRAGMA table_info(chat_turn_traces)").all() as Array<{ name: string }>).map((column) => column.name),
    );

    for (const column of [
      "retrieval_json",
      "reflection_json",
      "proactive_json",
      "orchestration_json",
      "guidance_json",
      "loop_guard_json",
      "pending_user_input_json",
      "citations_json",
      "failure_json",
      "completion_json",
      "durable_json",
      "capability_upgrade_suggestions_json",
      "specialist_candidate_suggestions_json",
      "parent_turn_id",
      "branch_kind",
      "source_turn_id",
    ]) {
      assert.ok(columns.has(column), `expected repaired chat_turn_traces column: ${column}`);
    }

    const createdTables = new Set(
      (
        db
          .prepare(
            `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
        `,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    assert.ok(createdTables.has("chat_stream_events"));
    assert.ok(createdTables.has("chat_tool_artifacts"));

    db.prepare(
      `
      INSERT INTO chat_turn_traces (
        turn_id, session_id, user_message_id, assistant_message_id, status, mode, model,
        web_mode, memory_mode, thinking_level, routing_json, retrieval_json, reflection_json,
        proactive_json, orchestration_json, guidance_json, loop_guard_json, pending_user_input_json, citations_json, failure_json,
        completion_json, durable_json, capability_upgrade_suggestions_json,
        specialist_candidate_suggestions_json, started_at, finished_at
      ) VALUES (
        'turn-repair-1', 'sess-repair-1', 'user-repair-1', 'assistant-repair-1', 'completed', 'chat', 'glm-5',
        'auto', 'auto', 'standard', '{}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        '2026-03-10T00:00:01.000Z', '2026-03-10T00:00:02.000Z'
      )
    `,
    ).run();

    const repairedRow = db
      .prepare(
        `
      SELECT branch_kind AS branchKind
      FROM chat_turn_traces
      WHERE turn_id = 'turn-repair-1'
    `,
      )
      .get() as { branchKind: string } | undefined;
    assert.equal(repairedRow?.branchKind, "append");

    db.close();
  });
});
