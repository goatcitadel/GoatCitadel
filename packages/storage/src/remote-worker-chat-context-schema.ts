import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS remote_worker_chat_contexts (
  durable_run_id TEXT PRIMARY KEY REFERENCES durable_runs(run_id),
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  capability_profile_id TEXT NOT NULL,
  capability_profile_sha256 TEXT NOT NULL,
  context_sha256 TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_worker_chat_context_turn ON remote_worker_chat_contexts(workspace_id, session_id, turn_id);`;

/** Additive and forward-only. Runtime rollback leaves the immutable snapshots
 * in place; it never edits or removes historical context as a rollback action. */
export function createRemoteWorkerChatContextSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(TABLE);
  db.exec(`CREATE TRIGGER trg_remote_worker_chat_context_no_update BEFORE UPDATE ON remote_worker_chat_contexts
    BEGIN SELECT RAISE(ABORT, 'remote Chat context is immutable'); END;
    CREATE TRIGGER trg_remote_worker_chat_context_no_delete BEFORE DELETE ON remote_worker_chat_contexts
    BEGIN SELECT RAISE(ABORT, 'remote Chat context is immutable'); END;`);
}

export const REMOTE_WORKER_CHAT_CONTEXT_POSTGRES_SQL =
  TABLE +
  `
CREATE FUNCTION remote_worker_chat_context_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'remote Chat context is immutable';
END $$;
CREATE TRIGGER trg_remote_worker_chat_context_immutable BEFORE UPDATE OR DELETE ON remote_worker_chat_contexts
FOR EACH ROW EXECUTE FUNCTION remote_worker_chat_context_protect();`;
