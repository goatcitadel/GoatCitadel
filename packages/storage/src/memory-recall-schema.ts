import type { DatabaseSync } from "node:sqlite";

const BASE = `
CREATE TABLE IF NOT EXISTS memory_recall_documents (
  source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, search_text TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_ref)
);
CREATE TABLE IF NOT EXISTS memory_recall_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation BIGINT NOT NULL);
INSERT INTO memory_recall_state(singleton, generation) VALUES (1, 0) ON CONFLICT(singleton) DO NOTHING;
`;

const SOURCES = [
  { table: "memory_items", kind: "memory_item", id: "item_id", text: "COALESCE(NEW.title, '') || ' ' || NEW.content" },
  {
    table: "memory_learnings",
    kind: "memory_learning",
    id: "learning_id",
    text: "NEW.learning_key || ' ' || NEW.insight",
  },
  { table: "knowledge_chunks", kind: "knowledge_chunk", id: "chunk_id", text: "NEW.content" },
] as const;

/** Only the projection is populated by triggers; every read joins current canonical scope/status. */
export function upgradeMemoryRecallSchema(db: DatabaseSync): void {
  for (const name of ["workspace_id", "session_id"]) {
    const columns = db.prepare("PRAGMA table_info(knowledge_documents)").all() as { name: string }[];
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE knowledge_documents ADD COLUMN ${name} TEXT`);
  }
  db.exec(
    BASE +
      `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_fts USING fts5(search_text, content='memory_recall_documents', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS memory_recall_fts_insert AFTER INSERT ON memory_recall_documents BEGIN
      INSERT INTO memory_recall_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_recall_fts_delete AFTER DELETE ON memory_recall_documents BEGIN
      INSERT INTO memory_recall_fts(memory_recall_fts, rowid, search_text) VALUES ('delete', OLD.rowid, OLD.search_text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_recall_fts_update AFTER UPDATE ON memory_recall_documents BEGIN
      INSERT INTO memory_recall_fts(memory_recall_fts, rowid, search_text) VALUES ('delete', OLD.rowid, OLD.search_text);
      INSERT INTO memory_recall_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text);
    END;
  `,
  );
  for (const source of SOURCES) {
    for (const event of ["INSERT", "UPDATE"])
      db.exec(`
      CREATE TRIGGER IF NOT EXISTS recall_${source.kind}_${event.toLowerCase()} AFTER ${event} ON ${source.table} BEGIN
        INSERT INTO memory_recall_documents(source_kind, source_ref, search_text) VALUES ('${source.kind}', NEW.${source.id}, ${source.text})
          ON CONFLICT(source_kind, source_ref) DO UPDATE SET search_text = excluded.search_text;
        UPDATE memory_recall_state SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    db.exec(`CREATE TRIGGER IF NOT EXISTS recall_${source.kind}_delete AFTER DELETE ON ${source.table} BEGIN
      DELETE FROM memory_recall_documents WHERE source_kind = '${source.kind}' AND source_ref = OLD.${source.id};
      UPDATE memory_recall_state SET generation = generation + 1 WHERE singleton = 1;
    END;`);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_knowledge_documents_memory_scope ON knowledge_documents(workspace_id, session_id, source_type, doc_id)",
  );
  for (const event of ["INSERT", "UPDATE", "DELETE"])
    db.exec(`CREATE TRIGGER IF NOT EXISTS recall_knowledge_document_${event.toLowerCase()}
    AFTER ${event} ON knowledge_documents BEGIN UPDATE memory_recall_state SET generation = generation + 1 WHERE singleton = 1; END;`);
}

export const MEMORY_RECALL_POSTGRES_SQL =
  BASE +
  `
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_memory_scope ON knowledge_documents(workspace_id, session_id, source_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_memory_recall_lexical ON memory_recall_documents USING GIN(to_tsvector('simple'::regconfig, search_text));
CREATE OR REPLACE FUNCTION gc_recall_knowledge_document() RETURNS trigger AS $$
BEGIN
  UPDATE memory_recall_state SET generation = generation + 1 WHERE singleton = 1;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS recall_knowledge_document_change ON knowledge_documents;
CREATE TRIGGER recall_knowledge_document_change AFTER INSERT OR UPDATE OR DELETE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION gc_recall_knowledge_document();
` +
  SOURCES.map(
    (source) => `
CREATE OR REPLACE FUNCTION gc_recall_${source.kind}() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM memory_recall_documents WHERE source_kind = '${source.kind}' AND source_ref = OLD.${source.id};
  ELSE
    INSERT INTO memory_recall_documents(source_kind, source_ref, search_text) VALUES ('${source.kind}', NEW.${source.id}, ${source.text})
      ON CONFLICT(source_kind, source_ref) DO UPDATE SET search_text = EXCLUDED.search_text;
  END IF;
  UPDATE memory_recall_state SET generation = generation + 1 WHERE singleton = 1;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS recall_${source.kind}_change ON ${source.table};
CREATE TRIGGER recall_${source.kind}_change AFTER INSERT OR UPDATE OR DELETE ON ${source.table}
  FOR EACH ROW EXECUTE FUNCTION gc_recall_${source.kind}();
`,
  ).join("\n");
