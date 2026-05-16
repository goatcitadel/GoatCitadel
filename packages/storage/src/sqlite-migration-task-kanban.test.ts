import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals } from "./sqlite.js";

describe("task_kanban_columns migration", () => {
  it("adds distress_signals_json, retry_budget_json, artifact_verification_json", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assigned_agent_id TEXT,
        created_by TEXT,
        due_at TEXT,
        metadata_json TEXT,
        deleted_at TEXT,
        deleted_by TEXT,
        delete_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    __sqliteInternals.applySchemaMigrationForTest(79, db);

    const columns = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.ok(columns.has("distress_signals_json"));
    assert.ok(columns.has("retry_budget_json"));
    assert.ok(columns.has("artifact_verification_json"));
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY);");
    __sqliteInternals.applySchemaMigrationForTest(79, db);
    __sqliteInternals.applySchemaMigrationForTest(79, db); // must not throw
    const columns = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.ok(columns.has("distress_signals_json"));
    assert.ok(columns.has("retry_budget_json"));
    assert.ok(columns.has("artifact_verification_json"));
  });
});
