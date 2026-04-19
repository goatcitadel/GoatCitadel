import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("Postgres runtime schema generation", () => {
  it("preserves SQLite inline UNIQUE constraints as Postgres unique indexes", () => {
    const sql = buildPostgresRuntimeSchemaSql();

    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id_unique ON chat_messages\(message_id\);/,
    );
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key_unique ON sessions\(session_key\);/);
    assert.doesNotMatch(sql, /sqlite_autoindex_/);
  });

  it("repairs stale runtime schemas that applied the canonical migration before inline unique indexes were preserved", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 6);

    assert.equal(repairMigration?.name, "runtime_inline_unique_indexes");
    assert.match(
      repairMigration?.sql ?? "",
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_message_id_unique ON chat_messages\(message_id\);/,
    );
  });

  it("replays the current canonical schema as a repair migration for older Postgres runtimes", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 7);

    assert.equal(repairMigration?.name, "canonical_runtime_schema_repairs");
    assert.match(repairMigration?.sql ?? "", /CREATE TABLE IF NOT EXISTS approval_effects \(/);
  });

  it("repairs benchmark lease columns for older Postgres prompt-pack runtime tables", () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 8);

    assert.equal(repairMigration?.name, "prompt_pack_benchmark_claim_repairs");
    assert.match(repairMigration?.sql ?? "", /ALTER TABLE prompt_pack_benchmark_runs/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS claimed_by_worker_id TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS claim_heartbeat_at TEXT/);
    assert.match(repairMigration?.sql ?? "", /ADD COLUMN IF NOT EXISTS claim_expires_at TEXT/);
    assert.match(repairMigration?.sql ?? "", /CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_claim/);
  });
});
