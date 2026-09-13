import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS chat_execution_placements (
  durable_run_id TEXT PRIMARY KEY REFERENCES durable_runs(run_id),
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  execution_kind TEXT NOT NULL CHECK(execution_kind IN ('local', 'remote_worker')),
  registry_workspace_id TEXT,
  assignment_id TEXT,
  created_at TEXT NOT NULL,
  CHECK((execution_kind = 'local' AND registry_workspace_id IS NULL AND assignment_id IS NULL)
     OR (execution_kind = 'remote_worker' AND registry_workspace_id IS NOT NULL AND assignment_id IS NOT NULL)),
  FOREIGN KEY(registry_workspace_id, assignment_id)
    REFERENCES remote_worker_assignments(registry_workspace_id, assignment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_execution_placement_turn
  ON chat_execution_placements(workspace_id, session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_remote_worker_budget_grants_execution_operator
  ON remote_worker_budget_grants(execution_workspace_id, operator_id, expires_at);`;

/** Additive ownership ledger. Runtime rollback retains the dispatch decision. */
export function createRemoteWorkerChatPlacementSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(TABLE);
  db.exec(`CREATE TRIGGER trg_chat_execution_placement_no_update BEFORE UPDATE ON chat_execution_placements
    BEGIN SELECT RAISE(ABORT, 'Chat execution placement is immutable'); END;
    CREATE TRIGGER trg_chat_execution_placement_no_delete BEFORE DELETE ON chat_execution_placements
    BEGIN SELECT RAISE(ABORT, 'Chat execution placement is immutable'); END;`);
}

export const REMOTE_WORKER_CHAT_PLACEMENT_POSTGRES_SQL =
  TABLE +
  `
CREATE FUNCTION chat_execution_placement_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Chat execution placement is immutable';
END $$;
CREATE TRIGGER trg_chat_execution_placement_immutable BEFORE UPDATE OR DELETE ON chat_execution_placements
FOR EACH ROW EXECUTE FUNCTION chat_execution_placement_protect();`;
