import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());

it("fresh SQLite registers the canonical comparison execution claim table", () => {
  const db = files.open({ dbPath: ":memory:" });
  try {
    assert.deepEqual(db.prepare("PRAGMA table_info(model_comparison_execution_claims)").all().map((row) => {
      const column = row as { name: string; type: string; notnull: number; pk: number };
      return [column.name, column.type, column.notnull, column.pk];
    }), [["comparison_id", "TEXT", 1, 1], ["claim_id", "TEXT", 0, 0]]);
    assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version = 277").get<{ name: string }>()?.name, "model_comparison_execution_claims");
  } finally { db.close(); }
});

it("upgrades populated SQLite v276 without changing comparisons and is restart-safe", () => {
  const dbPath = files.path("comparison-claims-upgrade");
  const initial = files.open({ dbPath });
  initial.close();
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec("DROP TABLE IF EXISTS model_comparison_execution_claims; DELETE FROM schema_migrations WHERE version = 277;");
    // Comparison tables were owned lazily before this additive migration.
    legacy.exec("CREATE TABLE model_comparison_runs (comparison_id TEXT PRIMARY KEY, results_json TEXT NOT NULL); INSERT INTO model_comparison_runs VALUES ('legacy-comparison', '[{\"responseText\":\"retained\"}]');");
  } finally { legacy.close(); }
  for (let restart = 0; restart < 2; restart += 1) {
    const db = files.open({ dbPath });
    try {
      assert.deepEqual(db.prepare("SELECT * FROM model_comparison_runs").all().map((row) => ({ ...row as object })), [
        { comparison_id: "legacy-comparison", results_json: '[{"responseText":"retained"}]' },
      ]);
      assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version = 277").get<{ name: string }>()?.name, "model_comparison_execution_claims");
      assert.doesNotThrow(() => db.prepare("SELECT comparison_id, claim_id FROM model_comparison_execution_claims").all());
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  }
});
