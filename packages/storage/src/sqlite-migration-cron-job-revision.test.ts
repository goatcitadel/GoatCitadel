import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { __sqliteInternals } from "./sqlite.js";

describe("SQLite cron job spec revision migration", () => {
  it("backfills legacy cron jobs at revision one idempotently", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE cron_jobs (
        job_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO cron_jobs (job_id, name, schedule, updated_at)
      VALUES ('legacy-cron', 'Legacy Cron', '0 8 * * *', '2026-07-12T00:00:00.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(147, db);
    __sqliteInternals.applySchemaMigrationForTest(147, db);

    const revisionColumn = db
      .prepare("PRAGMA table_info(cron_jobs)")
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
      (db.prepare("SELECT revision FROM cron_jobs WHERE job_id = 'legacy-cron'").get() as { revision: number })
        .revision,
      1,
    );
    db.close();
  });
});
