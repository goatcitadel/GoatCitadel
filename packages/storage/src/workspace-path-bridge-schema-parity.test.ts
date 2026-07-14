import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createSqliteSchemaBlueprint } from "./sqlite.js";

describe("workspace path bridge schema parity", () => {
  it("pairs forward-only SQLite 162 with PostgreSQL 104 and immutable callable-state evidence", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const table = sqlite.tables.find((candidate) => candidate.name === "workspace_path_bridge_snapshots");
    assert.ok(table);
    for (const column of [
      "snapshot_id",
      "schema_version",
      "request_hash",
      "workspace_id",
      "input_flavor",
      "target_flavor",
      "git_identity_required",
      "input_path_hash",
      "allowed_roots_hash",
      "canonical_host_path",
      "canonical_target_path",
      "distro",
      "round_trip_json",
      "git_identity_json",
      "status",
      "reason_code",
      "callable",
      "snapshot_json",
      "snapshot_sha256",
      "created_at",
    ]) {
      assert.ok(
        table.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }

    const postgres = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 104);
    assert.equal(postgres?.name, "workspace_path_bridge_snapshots");
    const sql = postgres?.sql ?? "";
    assert.match(sql, /CREATE TABLE IF NOT EXISTS workspace_path_bridge_snapshots/u);
    assert.match(sql, /git_identity_required BOOLEAN NOT NULL/u);
    assert.match(sql, /status = 'verified' AND reason_code IS NULL AND callable/u);
    assert.match(sql, /status <> 'verified' AND reason_code IS NOT NULL AND NOT callable/u);
    assert.match(sql, /BEFORE UPDATE ON workspace_path_bridge_snapshots/u);
    assert.match(sql, /BEFORE DELETE ON workspace_path_bridge_snapshots/u);
    assert.doesNotMatch(sql, /UPDATE workspace_path_bridge_snapshots|INSERT INTO workspace_path_bridge_snapshots/u);
  });
});
