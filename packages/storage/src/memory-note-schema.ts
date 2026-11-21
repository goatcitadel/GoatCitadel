import type { DatabaseSync } from "node:sqlite";

export const MEMORY_NOTE_ORIGINS_SQL = `
CREATE TABLE IF NOT EXISTS memory_item_origins (
  item_id TEXT PRIMARY KEY REFERENCES memory_items(item_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_created_at TEXT NOT NULL,
  source_lifecycle_id TEXT NOT NULL,
  source_incarnation TEXT NOT NULL,
  owner_session_id TEXT,
  trust_level TEXT NOT NULL CHECK (trust_level IN ('trusted_operator','trusted_workspace','mixed_untrusted','untrusted_external')),
  upsert_key TEXT NOT NULL,
  artifact_doc_id TEXT NOT NULL REFERENCES knowledge_documents(doc_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_item_origins_upsert ON memory_item_origins(workspace_id, upsert_key);
`;
export function upgradeMemoryNoteOrigins(db: DatabaseSync): void {
  db.exec(MEMORY_NOTE_ORIGINS_SQL);
}
