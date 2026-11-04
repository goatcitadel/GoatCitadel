import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
const columns = ["artifact_id", "artifact_version", "session_id", "workspace_id", "content_hash", "renderer_version",
  "viewport", "width", "height", "attachment_id", "attachment_sha256", "created_at"];

it("fresh SQLite creates canonical renderer-owned receipts with artifact and attachment cleanup", () => {
  const db = files.open({ dbPath: ":memory:" });
  try {
    assert.deepEqual(db.prepare("PRAGMA table_info(chat_artifact_render_receipts)").all<{ name: string }>().map((row) => row.name), columns);
    assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version = 278").get<{ name: string }>()?.name, "chat_artifact_render_receipts");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list(chat_artifact_render_receipts)").all<{ table: string; on_delete: string }>()
      .map((row) => [row.table, row.on_delete]).sort(), [["chat_attachments", "CASCADE"], ["chat_generated_artifacts", "CASCADE"]]);
  } finally { db.close(); }
});

it("upgrades SQLite v277 without granting old uploaded filenames renderer provenance and remains restart-safe", () => {
  const dbPath = files.path("artifact-render-upgrade");
  const initial = files.open({ dbPath });
  initial.prepare(`INSERT INTO chat_attachments (attachment_id, session_id, workspace_id, file_name, mime_type, media_type,
    size_bytes, sha256, storage_rel_path, extract_status, created_at) VALUES
    ('ordinary', 'session', 'default', 'render-aaaaaaaaaaaaaaaa-desktop.png', 'image/png', 'image', 8, ?, 'old.png', 'unsupported', '2026-11-02')`).run("a".repeat(64));
  const retained = initial.prepare("SELECT * FROM chat_attachments WHERE attachment_id = 'ordinary'").all();
  initial.close();
  const legacy = new DatabaseSync(dbPath);
  try { legacy.exec("DROP TABLE IF EXISTS chat_artifact_render_receipts; DELETE FROM schema_migrations WHERE version = 278;"); }
  finally { legacy.close(); }
  for (let restart = 0; restart < 2; restart += 1) {
    const db = files.open({ dbPath });
    try {
      assert.deepEqual(db.prepare("PRAGMA table_info(chat_artifact_render_receipts)").all<{ name: string }>().map((row) => row.name), columns);
      assert.deepEqual(db.prepare("SELECT * FROM chat_attachments WHERE attachment_id = 'ordinary'").all(), retained);
      assert.deepEqual(db.prepare("SELECT * FROM chat_artifact_render_receipts").all(), []);
      assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version = 278").get<{ name: string }>()?.name, "chat_artifact_render_receipts");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  }
});