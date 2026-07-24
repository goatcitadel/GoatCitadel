import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals } from "./sqlite.js";

describe("SQLite orchestration worktree lease migration", () => {
  it("upgrades legacy run rows without inventing ownership and creates the lease ledger idempotently", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE orchestration_runs (
        run_id TEXT PRIMARY KEY,
        worktree_path TEXT
      );
      INSERT INTO orchestration_runs (run_id, worktree_path)
      VALUES ('legacy-run', 'F:/code/personal-ai/.worktrees/orchestration/legacy-run');
    `);

    __sqliteInternals.applySchemaMigrationForTest(144, db);
    __sqliteInternals.applySchemaMigrationForTest(144, db);

    const runColumns = db.prepare("PRAGMA table_info(orchestration_runs)").all() as Array<{ name: string }>;
    const runColumnNames = new Set(runColumns.map((column) => column.name));
    assert.equal(runColumnNames.has("worktree_lease_owner_id"), true);
    assert.equal(runColumnNames.has("worktree_lease_generation"), true);
    assert.equal(runColumnNames.has("worktree_lease_expires_at"), true);
    const legacy = db
      .prepare(
        `SELECT worktree_lease_owner_id, worktree_lease_generation, worktree_lease_expires_at
         FROM orchestration_runs WHERE run_id = 'legacy-run'`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...legacy },
      {
        worktree_lease_owner_id: null,
        worktree_lease_generation: null,
        worktree_lease_expires_at: null,
      },
    );

    const leaseColumns = db.prepare("PRAGMA table_info(orchestration_worktree_leases)").all() as Array<{
      name: string;
    }>;
    assert.deepEqual(
      leaseColumns.map((column) => column.name),
      [
        "worktree_path",
        "run_id",
        "owner_id",
        "generation",
        "lease_expires_at",
        "released_at",
        "created_at",
        "updated_at",
      ],
    );
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orchestration_worktree_leases'")
      .all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((index) => index.name));
    assert.equal(indexNames.has("idx_orchestration_worktree_leases_run"), true);
    assert.equal(indexNames.has("idx_orchestration_worktree_leases_expiry"), true);
    db.close();
  });
});
