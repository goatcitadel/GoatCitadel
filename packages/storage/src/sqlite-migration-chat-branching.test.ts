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

describe("sqlite chat branching migration", () => {
  it("creates chat_session_prefs before branching migration touches it", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-missing-chat-prefs-${randomUUID()}.db`);
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
    // predecessor tables, so build the genuine v24 schema before reshaping it to the legacy premise.
    for (let version = 1; version <= 24; version += 1) {
      __sqliteInternals.applySchemaMigrationForTest(version, legacy);
    }
    legacy.exec(`
      DROP TABLE IF EXISTS chat_turn_traces;
      DROP TABLE IF EXISTS chat_session_prefs;

      CREATE TABLE chat_turn_traces (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);

    const insertMigration = legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, '2026-03-07T00:00:00.000Z')
    `);
    for (let version = 1; version <= 24; version += 1) {
      insertMigration.run(version, `legacy-${version}`);
    }
    legacy.close();

    const db = createDatabase({ dbPath });
    const prefTable = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'chat_session_prefs'
    `,
      )
      .get() as { name: string } | undefined;
    assert.equal(prefTable?.name, "chat_session_prefs");

    const prefColumns = db.prepare("PRAGMA table_info(chat_session_prefs)").all() as Array<{ name: string }>;
    assert.ok(prefColumns.some((row) => row.name === "planning_mode"));
    assert.ok(prefColumns.some((row) => row.name === "orchestration_enabled"));

    db.close();
  });

  it("backfills planning mode, parent turn ids, and branch state without loading rows in JS", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-legacy-chat-branch-${randomUUID()}.db`);
    createdFiles.push(dbPath);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Same as above: real v24 schema first, then reshape to the pre-branching legacy shapes.
    for (let version = 1; version <= 24; version += 1) {
      __sqliteInternals.applySchemaMigrationForTest(version, legacy);
    }
    legacy.exec(`
      DROP TABLE IF EXISTS chat_turn_traces;
      DROP TABLE IF EXISTS chat_session_prefs;

      CREATE TABLE chat_session_prefs (
        session_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        web_mode TEXT NOT NULL,
        memory_mode TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        tool_autonomy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

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
        retrieval_json TEXT,
        reflection_json TEXT,
        proactive_json TEXT,
        guidance_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);

    const insertMigration = legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, '2026-03-07T00:00:00.000Z')
    `);
    for (let version = 1; version <= 24; version += 1) {
      insertMigration.run(version, `legacy-${version}`);
    }

    legacy.exec(`
      INSERT INTO chat_session_prefs (
        session_id, mode, provider_id, model, web_mode, memory_mode, thinking_level, tool_autonomy, created_at, updated_at
      ) VALUES (
        'sess-1', 'chat', 'glm', 'glm-5', 'auto', 'auto', 'standard', 'safe_auto',
        '2026-03-07T00:00:00.000Z', '2026-03-07T00:00:00.000Z'
      );

      INSERT INTO chat_turn_traces (
        turn_id, session_id, user_message_id, assistant_message_id, status, mode, model,
        web_mode, memory_mode, thinking_level, routing_json, retrieval_json, reflection_json,
        proactive_json, guidance_json, started_at, finished_at
      ) VALUES
      (
        'turn-1', 'sess-1', 'user-1', 'assistant-1', 'completed', 'chat', 'glm-5',
        'auto', 'auto', 'standard', '{}', NULL, NULL, NULL, NULL,
        '2026-03-07T00:00:01.000Z', '2026-03-07T00:00:02.000Z'
      ),
      (
        'turn-2', 'sess-1', 'user-2', 'assistant-2', 'completed', 'chat', 'glm-5',
        'auto', 'auto', 'standard', '{}', NULL, NULL, NULL, NULL,
        '2026-03-07T00:00:03.000Z', '2026-03-07T00:00:04.000Z'
      ),
      (
        'turn-3', 'sess-1', 'user-3', 'assistant-3', 'completed', 'chat', 'glm-5',
        'auto', 'auto', 'standard', '{}', NULL, NULL, NULL, NULL,
        '2026-03-07T00:00:05.000Z', '2026-03-07T00:00:06.000Z'
      );
    `);
    legacy.close();

    const db = createDatabase({ dbPath });

    const prefRow = db
      .prepare(
        `
      SELECT planning_mode AS planningMode
      FROM chat_session_prefs
      WHERE session_id = 'sess-1'
    `,
      )
      .get() as { planningMode: string } | undefined;
    assert.equal(prefRow?.planningMode, "off");

    const traceRows = db
      .prepare(
        `
      SELECT turn_id AS turnId, parent_turn_id AS parentTurnId, branch_kind AS branchKind
      FROM chat_turn_traces
      WHERE session_id = 'sess-1'
      ORDER BY started_at ASC
    `,
      )
      .all() as Array<{ turnId: string; parentTurnId: string | null; branchKind: string }>;
    assert.deepEqual(
      traceRows.map((row) => ({
        turnId: row.turnId,
        parentTurnId: row.parentTurnId,
        branchKind: row.branchKind,
      })),
      [
        { turnId: "turn-1", parentTurnId: null, branchKind: "append" },
        { turnId: "turn-2", parentTurnId: "turn-1", branchKind: "append" },
        { turnId: "turn-3", parentTurnId: "turn-2", branchKind: "append" },
      ],
    );

    const branchState = db
      .prepare(
        `
      SELECT active_leaf_turn_id AS activeLeafTurnId
      FROM chat_session_branch_state
      WHERE session_id = 'sess-1'
    `,
      )
      .get() as { activeLeafTurnId: string } | undefined;
    assert.equal(branchState?.activeLeafTurnId, "turn-3");

    db.close();
  });
});
