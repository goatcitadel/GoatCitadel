import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS remote_worker_chat_tasks (
  durable_run_id TEXT PRIMARY KEY REFERENCES durable_runs(run_id),
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  parent_context_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_chat_task_turn
  ON remote_worker_chat_tasks(workspace_id, session_id, turn_id);`;
const CHECK = "length(payload_sha256) = 64 AND length(parent_context_sha256) = 64";

/** Additive, forward-only binding. Rollback disables placement and retains the
 * task and its original admission; existing user-created tasks are untouched. */
export function createRemoteWorkerChatTaskSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(TABLE.replace("\n);", `,\n  CONSTRAINT gc_worker_chat_task_hashes CHECK(${CHECK})\n);`));
  db.exec(`CREATE TRIGGER trg_worker_chat_task_no_update BEFORE UPDATE ON remote_worker_chat_tasks
    BEGIN SELECT RAISE(ABORT, 'worker Chat task binding is immutable'); END;
    CREATE TRIGGER trg_worker_chat_task_no_delete BEFORE DELETE ON remote_worker_chat_tasks
    BEGIN SELECT RAISE(ABORT, 'worker Chat task binding is immutable'); END;`);
}

export const REMOTE_WORKER_CHAT_TASK_POSTGRES_SQL = TABLE + `
ALTER TABLE remote_worker_chat_tasks ADD CONSTRAINT gc_worker_chat_task_hashes CHECK(${CHECK});
CREATE FUNCTION remote_worker_chat_task_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'worker Chat task binding is immutable';
END $$;
CREATE TRIGGER trg_worker_chat_task_immutable BEFORE UPDATE OR DELETE ON remote_worker_chat_tasks
FOR EACH ROW EXECUTE FUNCTION remote_worker_chat_task_protect();`;
