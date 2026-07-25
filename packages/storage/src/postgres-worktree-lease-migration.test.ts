import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("Postgres orchestration worktree lease parity", () => {
  it("keeps the canonical schema and forward migration aligned", () => {
    const canonicalSql = buildPostgresRuntimeSchemaSql();
    for (const fragment of [
      "CREATE TABLE IF NOT EXISTS orchestration_worktree_leases",
      "worktree_lease_owner_id TEXT",
      "worktree_lease_generation BIGINT",
      "worktree_lease_expires_at TEXT",
      "idx_orchestration_worktree_leases_run",
      "idx_orchestration_worktree_leases_expiry",
    ]) {
      assert.match(canonicalSql, new RegExp(fragment));
    }

    const migration = POSTGRES_MIGRATIONS.find(
      (candidate) => candidate.name === "orchestration_worktree_generation_leases",
    );
    assert.equal(migration?.version, 86);
    for (const fragment of [
      "CREATE TABLE IF NOT EXISTS orchestration_worktree_leases",
      "ADD COLUMN IF NOT EXISTS worktree_lease_owner_id TEXT",
      "ADD COLUMN IF NOT EXISTS worktree_lease_generation BIGINT",
      "ADD COLUMN IF NOT EXISTS worktree_lease_expires_at TEXT",
      "idx_orchestration_worktree_leases_run",
      "idx_orchestration_worktree_leases_expiry",
    ]) {
      assert.match(migration?.sql ?? "", new RegExp(fragment));
    }
  });
});
