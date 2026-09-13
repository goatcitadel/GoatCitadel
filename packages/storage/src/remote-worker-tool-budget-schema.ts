import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS remote_worker_tool_budget_dispatches (
  usage_event_id TEXT PRIMARY KEY REFERENCES model_usage_events(event_id),
  registry_workspace_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL,
  intent_id TEXT NOT NULL,
  intent_sha256 TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES remote_worker_budget_grants(grant_id),
  authority_json TEXT NOT NULL,
  authority_sha256 TEXT NOT NULL,
  route_json TEXT NOT NULL,
  route_sha256 TEXT NOT NULL,
  reserved_cost_microusd BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  settled_cost_microusd BIGINT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, intent_id)
    REFERENCES remote_worker_effect_intents(registry_workspace_id, assignment_id, assignment_generation, intent_id)
);
CREATE INDEX IF NOT EXISTS idx_worker_tool_budget_grant ON remote_worker_tool_budget_dispatches(grant_id);
CREATE INDEX IF NOT EXISTS idx_worker_tool_budget_intent ON remote_worker_tool_budget_dispatches(
  registry_workspace_id, assignment_id, assignment_generation, intent_id);`;
const CHECK = `assignment_generation > 0
    AND length(intent_sha256) = 64 AND length(authority_sha256) = 64 AND length(route_sha256) = 64
    AND reserved_cost_microusd >= 0 AND (
      (status = 'held' AND settled_cost_microusd IS NULL AND closed_at IS NULL) OR
      (status = 'settled' AND settled_cost_microusd IS NOT NULL AND settled_cost_microusd >= 0 AND closed_at IS NOT NULL) OR
      (status = 'released' AND settled_cost_microusd IS NOT NULL AND settled_cost_microusd = 0 AND closed_at IS NOT NULL))`;
const IMMUTABLE = ["usage_event_id", "registry_workspace_id", "assignment_id", "assignment_generation",
  "intent_id", "intent_sha256", "grant_id", "authority_json", "authority_sha256", "route_json", "route_sha256",
  "reserved_cost_microusd", "created_at"];

/** Forward-only. Rollback disables tool model dispatch and retains all holds and
 * usage evidence; deleting this ledger would incorrectly refund provider calls. */
export function createRemoteWorkerToolBudgetSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(TABLE.replace("\n);", `,\n  CONSTRAINT gc_worker_tool_budget_state CHECK(${CHECK})\n);`));
  db.exec(`CREATE TRIGGER trg_worker_tool_budget_immutable BEFORE UPDATE ON remote_worker_tool_budget_dispatches
    WHEN OLD.status <> 'held' OR ${IMMUTABLE.map((key) => `NEW.${key} IS NOT OLD.${key}`).join(" OR ")}
    BEGIN SELECT RAISE(ABORT, 'worker tool budget evidence is immutable'); END;
    CREATE TRIGGER trg_worker_tool_budget_no_delete BEFORE DELETE ON remote_worker_tool_budget_dispatches
    BEGIN SELECT RAISE(ABORT, 'worker tool budget evidence cannot be deleted'); END;`);
}

export const REMOTE_WORKER_TOOL_BUDGET_POSTGRES_SQL = TABLE + `
ALTER TABLE remote_worker_tool_budget_dispatches ADD CONSTRAINT gc_worker_tool_budget_state CHECK(${CHECK});
CREATE FUNCTION remote_worker_tool_budget_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'worker tool budget evidence cannot be deleted'; END IF;
  IF OLD.status <> 'held' OR ${IMMUTABLE.map((key) => `NEW.${key} IS DISTINCT FROM OLD.${key}`).join(" OR ")}
    THEN RAISE EXCEPTION 'worker tool budget evidence is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_worker_tool_budget_immutable BEFORE UPDATE OR DELETE ON remote_worker_tool_budget_dispatches
FOR EACH ROW EXECUTE FUNCTION remote_worker_tool_budget_protect();`;
