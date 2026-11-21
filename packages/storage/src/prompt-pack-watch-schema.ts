import type { DatabaseSync } from "node:sqlite";
export const PROMPT_PACK_WATCH_BINDINGS_POSTGRES_SQL = `
ALTER TABLE prompt_pack_runs ADD COLUMN IF NOT EXISTS improvement_watch_bindings_json TEXT;
CREATE OR REPLACE FUNCTION gc_prompt_pack_watch_binding_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.improvement_watch_bindings_json IS DISTINCT FROM OLD.improvement_watch_bindings_json THEN
    RAISE EXCEPTION 'Prompt pack pre-work watch binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prompt_pack_watch_binding_immutable ON prompt_pack_runs;
CREATE TRIGGER trg_prompt_pack_watch_binding_immutable BEFORE UPDATE OF improvement_watch_bindings_json ON prompt_pack_runs
  FOR EACH ROW EXECUTE FUNCTION gc_prompt_pack_watch_binding_immutable();
`;
export function upgradePromptPackWatchBindings(db: DatabaseSync): void {
  if (
    !(db.prepare("PRAGMA table_info(prompt_pack_runs)").all() as { name: string }[]).some(
      (column) => column.name === "improvement_watch_bindings_json",
    )
  )
    db.exec("ALTER TABLE prompt_pack_runs ADD COLUMN improvement_watch_bindings_json TEXT");
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_prompt_pack_watch_binding_immutable BEFORE UPDATE OF improvement_watch_bindings_json ON prompt_pack_runs
    WHEN NEW.improvement_watch_bindings_json IS NOT OLD.improvement_watch_bindings_json BEGIN SELECT RAISE(ABORT,'Prompt pack pre-work watch binding is immutable'); END;`);
}
