import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { __sqliteInternals } from "./sqlite.js";

describe("SQLite Chat session aggregate revision migration", () => {
  it("backfills legacy session meta at revision one idempotently", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE chat_session_meta (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO chat_session_meta (session_id, created_at, updated_at)
      VALUES ('legacy-session', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(146, db);
    __sqliteInternals.applySchemaMigrationForTest(146, db);

    const revisionColumn = db
      .prepare("PRAGMA table_info(chat_session_meta)")
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
      (
        db.prepare("SELECT revision FROM chat_session_meta WHERE session_id = 'legacy-session'").get() as {
          revision: number;
        }
      ).revision,
      1,
    );
    db.close();
  });
});
