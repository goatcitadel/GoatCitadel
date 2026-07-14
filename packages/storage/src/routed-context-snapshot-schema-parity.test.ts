import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { createSqliteSchemaBlueprint } from "./sqlite.js";

describe("routed context snapshot schema parity", () => {
  it("pairs forward-only SQLite 159 with PostgreSQL 101 and freezes immutable budget evidence", () => {
    const sqlite = createSqliteSchemaBlueprint();
    const table = sqlite.tables.find((candidate) => candidate.name === "chat_routed_context_snapshots");
    assert.ok(table);
    for (const column of [
      "snapshot_id",
      "turn_id",
      "session_id",
      "workspace_id",
      "capability_profile_id",
      "capability_profile_hash",
      "source_request_hash",
      "content_hash",
      "snapshot_hash",
      "context_window_tokens",
      "prompt_reserved_tokens",
      "output_reserved_tokens",
      "effective_budget_tokens",
      "used_tokens",
      "already_attached_count",
      "snapshot_json",
    ]) {
      assert.ok(
        table.columns.some((candidate) => candidate.name === column),
        `missing SQLite ${column}`,
      );
    }

    const postgres = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 101);
    assert.equal(postgres?.name, "chat_routed_context_snapshots");
    const sql = postgres?.sql ?? "";
    assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_routed_context_snapshots/u);
    assert.match(sql, /prompt_reserved_tokens \+ output_reserved_tokens <= context_window_tokens/u);
    assert.match(sql, /used_tokens \+ prompt_reserved_tokens \+ output_reserved_tokens <= context_window_tokens/u);
    assert.match(sql, /included_count \+ truncated_count \+ omitted_count \+ already_attached_count = source_count/u);
    assert.match(sql, /source_count BETWEEN 0 AND 16/u);
    assert.match(sql, /BEFORE UPDATE ON chat_routed_context_snapshots/u);
    assert.match(sql, /BEFORE DELETE ON chat_routed_context_snapshots/u);
    assert.doesNotMatch(sql, /UPDATE chat_routed_context_snapshots|INSERT INTO chat_routed_context_snapshots/u);
  });
});
