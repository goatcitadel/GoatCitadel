import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

describe("durable child watcher schema parity", () => {
  it("installs the sequence ledger and watcher cursor schema on SQLite", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-watcher-parity-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });

    const eventColumns = db.prepare("PRAGMA table_info(durable_run_events)").all<{ name: string }>();
    assert.ok(eventColumns.some((column) => column.name === "sequence"));
    const watcherColumns = db.prepare("PRAGMA table_info(durable_child_watchers)").all<{ name: string }>();
    assert.deepEqual(
      watcherColumns.map((column) => column.name),
      [
        "watcher_id",
        "parent_run_id",
        "child_run_id",
        "state",
        "next_sequence",
        "last_consumed_sequence",
        "projected_notice_count",
        "source",
        "metadata_json",
        "created_at",
        "updated_at",
        "detached_at",
        "reattached_at",
        "closed_at",
        "revision",
      ],
    );
    const eventIndexes = db.prepare("PRAGMA index_list(durable_run_events)").all<{ name: string; unique: number }>();
    assert.ok(eventIndexes.some((index) => index.name === "idx_durable_run_events_run_sequence" && index.unique === 1));
    const scanState = db
      .prepare("SELECT scan_key, last_watcher_id FROM durable_child_watcher_scan_state WHERE scan_key = 'global'")
      .get<{ scan_key: string; last_watcher_id: string }>();
    assert.deepEqual({ ...scanState }, { scan_key: "global", last_watcher_id: "" });
    db.close();
  });

  it("provides the equivalent forward Postgres migration", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 94);
    assert.equal(migration?.name, "durable_child_watchers");
    const sql = migration?.sql ?? "";
    for (const token of [
      "ADD COLUMN IF NOT EXISTS sequence BIGINT",
      "ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created_at ASC, event_id ASC)",
      "ALTER COLUMN sequence SET NOT NULL",
      "CREATE TABLE IF NOT EXISTS durable_run_event_sequences",
      "CREATE TABLE IF NOT EXISTS durable_child_watcher_scan_state",
      "ON CONFLICT(scan_key) DO NOTHING",
      "CREATE TABLE IF NOT EXISTS durable_child_watchers",
      "UNIQUE(parent_run_id, child_run_id)",
      "CHECK(next_sequence = last_consumed_sequence + 1)",
    ]) {
      assert.match(sql, new RegExp(escapeRegExp(token)));
    }

    const revisionMigration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 98);
    assert.equal(revisionMigration?.name, "durable_child_watcher_revision_cas");
    assert.match(revisionMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1/);
    assert.match(revisionMigration?.sql ?? "", /CHECK\(revision >= 1\)/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
