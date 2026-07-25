import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { __sqliteInternals } from "./sqlite.js";

describe("SQLite channel and cron durability migration", () => {
  it("adds migrations 149 and 150 to a legacy cron schema idempotently", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE cron_jobs (
        job_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO cron_jobs (job_id, name, schedule, updated_at)
      VALUES ('legacy-job', 'Legacy', '* * * * *', '2026-07-13T00:00:00.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(149, db);
    __sqliteInternals.applySchemaMigrationForTest(149, db);
    __sqliteInternals.applySchemaMigrationForTest(150, db);
    __sqliteInternals.applySchemaMigrationForTest(150, db);

    const cronColumns = new Map(
      (db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string; dflt_value: string | null }>).map(
        (column) => [column.name, column.dflt_value],
      ),
    );
    assert.equal(cronColumns.get("execution_generation"), "0");
    assert.equal(cronColumns.get("active_run_id"), null);
    assert.equal(
      (
        db.prepare("SELECT execution_generation FROM cron_jobs WHERE job_id = 'legacy-job'").get() as {
          execution_generation: number;
        }
      ).execution_generation,
      0,
    );
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_channel_events'").get(),
    );
    const inboundColumns = new Set(
      (db.prepare("PRAGMA table_info(inbound_channel_events)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    assert.equal(inboundColumns.has("bot_loop_decision"), true);
    assert.equal(inboundColumns.has("bot_loop_reason"), true);
    assert.equal(inboundColumns.has("command_operation_key"), true);
    assert.equal(inboundColumns.has("command_result_text"), true);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cron_runs'").get());
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cron_runs_admission'").get(),
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list(cron_runs)").all(), []);
    db.close();
  });
});
