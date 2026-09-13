import type { DatabaseSync } from "node:sqlite";

const stateSql = `
CREATE TABLE IF NOT EXISTS memory_item_enumeration_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  generation BIGINT NOT NULL CHECK (generation >= 0)
);
INSERT INTO memory_item_enumeration_state (singleton_id, generation) VALUES (1, 0)
  ON CONFLICT (singleton_id) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_memory_items_enumeration ON memory_items(updated_at DESC, item_id DESC);
`;

export const MEMORY_ITEM_ENUMERATION_SQLITE_SQL = `${stateSql}
${["INSERT", "UPDATE", "DELETE"].map(operation => `
CREATE TRIGGER IF NOT EXISTS trg_memory_items_enumeration_${operation.toLowerCase()}
AFTER ${operation} ON memory_items BEGIN
  UPDATE memory_item_enumeration_state SET generation = generation + 1 WHERE singleton_id = 1;
END;`).join("\n")}
CREATE TRIGGER IF NOT EXISTS trg_memory_items_enumeration_state_no_delete
BEFORE DELETE ON memory_item_enumeration_state BEGIN
  SELECT RAISE(ABORT, 'memory enumeration state cannot be deleted');
END;
CREATE TRIGGER IF NOT EXISTS trg_memory_items_enumeration_state_monotonic
BEFORE UPDATE ON memory_item_enumeration_state
WHEN NEW.singleton_id <> OLD.singleton_id OR NEW.generation <> OLD.generation + 1 BEGIN
  SELECT RAISE(ABORT, 'memory enumeration generation must advance once');
END;
`;

export const MEMORY_ITEM_ENUMERATION_POSTGRES_SQL = `${stateSql}
CREATE OR REPLACE FUNCTION gc_memory_items_enumeration_changed() RETURNS trigger AS $$
BEGIN
  UPDATE memory_item_enumeration_state SET generation = generation + 1 WHERE singleton_id = 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_memory_items_enumeration_changed ON memory_items;
CREATE TRIGGER trg_memory_items_enumeration_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON memory_items FOR EACH STATEMENT EXECUTE FUNCTION gc_memory_items_enumeration_changed();
CREATE OR REPLACE FUNCTION gc_memory_items_enumeration_state_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memory enumeration state cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.singleton_id <> OLD.singleton_id OR NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'memory enumeration generation must advance once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_memory_items_enumeration_state_guard ON memory_item_enumeration_state;
CREATE TRIGGER trg_memory_items_enumeration_state_guard BEFORE UPDATE OR DELETE
  ON memory_item_enumeration_state FOR EACH ROW EXECUTE FUNCTION gc_memory_items_enumeration_state_guard();
`;

export function createMemoryItemEnumerationSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(MEMORY_ITEM_ENUMERATION_SQLITE_SQL);
}
