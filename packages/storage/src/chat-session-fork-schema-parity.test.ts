import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

describe("chat session fork schema parity", () => {
  it("ships the immutable manifest owner in both SQLite and PostgreSQL", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const columns = db.prepare("PRAGMA table_info(chat_session_fork_manifests)").all() as Array<{ name: string }>;
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "fork_id",
        "source_session_id",
        "source_turn_id",
        "new_session_id",
        "workspace_id",
        "transcript_path_hash",
        "manifest_json",
        "created_at",
      ],
    );
    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 124);
    assert.equal(postgres?.name, "chat_session_fork_manifests");
    assert.match(postgres?.sql ?? "", /CREATE TABLE IF NOT EXISTS chat_session_fork_manifests/u);
    assert.doesNotMatch(postgres?.sql ?? "", /source_session_id[^,]*REFERENCES/u);
    db.close();
  });
});
