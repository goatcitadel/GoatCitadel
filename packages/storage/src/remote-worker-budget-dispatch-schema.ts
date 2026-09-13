import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS remote_worker_budget_dispatches (
  usage_event_id TEXT PRIMARY KEY REFERENCES model_usage_events(event_id),
  parent_reservation_id TEXT NOT NULL REFERENCES remote_worker_budget_reservations(reservation_id),
  grant_id TEXT NOT NULL REFERENCES remote_worker_budget_grants(grant_id),
  route_sha256 TEXT NOT NULL,
  route_json TEXT NOT NULL,
  reserved_cost_microusd BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  settled_cost_microusd BIGINT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_remote_worker_budget_dispatch_parent ON remote_worker_budget_dispatches(parent_reservation_id);
CREATE INDEX IF NOT EXISTS idx_remote_worker_budget_dispatch_grant ON remote_worker_budget_dispatches(grant_id);`;

const CHECK = `reserved_cost_microusd >= 0 AND length(route_sha256) = 64 AND (
  (status = 'held' AND settled_cost_microusd IS NULL AND closed_at IS NULL) OR
  (status = 'settled' AND settled_cost_microusd >= 0 AND closed_at IS NOT NULL) OR
  (status = 'released' AND settled_cost_microusd = 0 AND closed_at IS NOT NULL))`;
const IMMUTABLE = [
  "usage_event_id",
  "parent_reservation_id",
  "grant_id",
  "route_sha256",
  "route_json",
  "reserved_cost_microusd",
  "created_at",
];

/** Forward-only addition. Rollback retains both reservations and canonical usage;
 * it never refunds a dispatch by removing its history. */
export function createRemoteWorkerBudgetDispatchSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(TABLE.replace("\n);", `,\n  CONSTRAINT gc_worker_budget_dispatch_state CHECK(${CHECK})\n);`));
  db.exec(`CREATE TRIGGER trg_remote_worker_budget_dispatch_immutable BEFORE UPDATE ON remote_worker_budget_dispatches
    WHEN OLD.status <> 'held' OR ${IMMUTABLE.map((field) => `NEW.${field} IS NOT OLD.${field}`).join(" OR ")}
    BEGIN SELECT RAISE(ABORT, 'worker dispatch budget is immutable'); END;
    CREATE TRIGGER trg_remote_worker_budget_dispatch_no_delete BEFORE DELETE ON remote_worker_budget_dispatches
    BEGIN SELECT RAISE(ABORT, 'worker dispatch budget history cannot be deleted'); END;`);
}

export const REMOTE_WORKER_BUDGET_DISPATCH_POSTGRES_SQL =
  TABLE +
  `
ALTER TABLE remote_worker_budget_dispatches ADD CONSTRAINT gc_worker_budget_dispatch_state CHECK(${CHECK});
CREATE FUNCTION remote_worker_budget_dispatch_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'worker dispatch budget history cannot be deleted'; END IF;
  IF OLD.status <> 'held' OR ${IMMUTABLE.map((field) => `NEW.${field} IS DISTINCT FROM OLD.${field}`).join(" OR ")}
    THEN RAISE EXCEPTION 'worker dispatch budget is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_remote_worker_budget_dispatch_immutable BEFORE UPDATE OR DELETE ON remote_worker_budget_dispatches
FOR EACH ROW EXECUTE FUNCTION remote_worker_budget_dispatch_protect();`;
