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
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key_unique ON sessions\(session_key\);/,
    );
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
});
