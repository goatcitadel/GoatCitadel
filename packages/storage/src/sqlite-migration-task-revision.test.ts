import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { __sqliteInternals } from "./sqlite.js";

describe("SQLite task resource revision migration", () => {
  it("backfills legacy tasks at revision one idempotently", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks (task_id, title, status, updated_at)
      VALUES ('legacy-task', 'Legacy Task', 'inbox', '2026-07-13T00:00:00.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(148, db);
    __sqliteInternals.applySchemaMigrationForTest(148, db);

    const revisionColumn = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .find((column) => (column as { name?: unknown }).name === "revision") as
      | { name: string; notnull: number; dflt_value: string | null }
      | undefined;
    assert.deepEqual(
      revisionColumn
        ? {
            name: revisionColumn.name,
            notnull: revisionColumn.notnull,
            dflt_value: revisionColumn.dflt_value,
          }
        : undefined,
      { name: "revision", notnull: 1, dflt_value: "1" },
    );
    assert.equal(
      (db.prepare("SELECT revision FROM tasks WHERE task_id = 'legacy-task'").get() as { revision: number }).revision,
      1,
    );
    db.close();
  });
});
