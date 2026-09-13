import type { DatabaseSync } from "node:sqlite";

const TABLES = `
CREATE TABLE IF NOT EXISTS remote_worker_budget_grants (
  grant_id TEXT PRIMARY KEY,
  registry_workspace_id TEXT NOT NULL,
  execution_workspace_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  worker_generation BIGINT NOT NULL,
  operator_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  max_requests BIGINT NOT NULL,
  max_cost_microusd BIGINT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revision BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS remote_worker_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES remote_worker_budget_grants(grant_id),
  operation_id TEXT NOT NULL,
  dispatch_generation TEXT NOT NULL,
  operation_sha256 TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  reserved_requests BIGINT NOT NULL,
  reserved_cost_microusd BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  settled_requests BIGINT,
  settled_cost_microusd BIGINT,
  usage_event_ids_sha256 TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_worker_budget_operation ON remote_worker_budget_reservations(operation_id, dispatch_generation);
CREATE INDEX IF NOT EXISTS idx_remote_worker_budget_grant_reservations ON remote_worker_budget_reservations(grant_id);
CREATE INDEX IF NOT EXISTS idx_remote_worker_budget_scope ON remote_worker_budget_grants(registry_workspace_id, execution_workspace_id, worker_id, worker_generation);
`;

const CHECKS = [
  [
    "remote_worker_budget_grants",
    "gc_worker_budget_limits",
    "worker_generation > 0 AND max_requests BETWEEN 1 AND 100000 AND max_cost_microusd BETWEEN 0 AND 1000000000000 AND revision > 0",
  ],
  [
    "remote_worker_budget_grants",
    "gc_worker_budget_revision",
    "(revoked_at IS NULL AND revision = 1) OR (revoked_at IS NOT NULL AND revision = 2)",
  ],
  [
    "remote_worker_budget_reservations",
    "gc_worker_budget_reservation_limits",
    "reserved_requests = 2 AND reserved_cost_microusd >= 0 AND length(operation_sha256) = 64",
  ],
  [
    "remote_worker_budget_reservations",
    "gc_worker_budget_settlement",
    "(status = 'held' AND settled_requests IS NULL AND settled_cost_microusd IS NULL AND usage_event_ids_sha256 IS NULL AND closed_at IS NULL) OR (status = 'settled' AND settled_requests BETWEEN 1 AND 2 AND settled_cost_microusd >= 0 AND usage_event_ids_sha256 IS NOT NULL AND length(usage_event_ids_sha256) = 64 AND closed_at IS NOT NULL) OR (status = 'released' AND settled_requests = 0 AND settled_cost_microusd = 0 AND usage_event_ids_sha256 IS NULL AND closed_at IS NOT NULL)",
  ],
] as const;

const IMMUTABLE = {
  remote_worker_budget_grants: [
    "grant_id",
    "registry_workspace_id",
    "execution_workspace_id",
    "worker_id",
    "worker_generation",
    "operator_id",
    "identity_json",
    "max_requests",
    "max_cost_microusd",
    "expires_at",
    "created_at",
  ],
  remote_worker_budget_reservations: [
    "reservation_id",
    "grant_id",
    "operation_id",
    "dispatch_generation",
    "operation_sha256",
    "receipt_json",
    "reserved_requests",
    "reserved_cost_microusd",
    "created_at",
  ],
} as const;

/** Additive, forward-only migration. Existing budget history is never rewritten or deleted. */
export function createRemoteWorkerBudgetSchema(db: Pick<DatabaseSync, "exec">): void {
  let tables = TABLES;
  for (const [table, name, check] of CHECKS) {
    tables = tables.replace(
      new RegExp(`(CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?)(\\n\\);)`, "u"),
      `$1,\n  CONSTRAINT ${name} CHECK(${check})$2`,
    );
  }
  db.exec(tables);
  for (const [table, columns] of Object.entries(IMMUTABLE)) {
    const terminal = table.endsWith("grants") ? "OLD.revoked_at IS NOT NULL" : "OLD.status <> 'held'";
    db.exec(`CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE ON ${table}
      WHEN ${columns.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(" OR ")} OR ${terminal}
      BEGIN SELECT RAISE(ABORT, 'worker budget authority is immutable'); END;
      CREATE TRIGGER trg_${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'worker budget history cannot be deleted'); END;`);
  }
}

// The dynamic PostgreSQL bootstrap contains the new tables but omits CHECKs/triggers.
// Install the same constraints on both fresh bootstrap and an existing database.
export const REMOTE_WORKER_BUDGET_POSTGRES_SQL =
  TABLES +
  CHECKS.map(([table, name, check]) => `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK(${check});`).join("\n") +
  Object.entries(IMMUTABLE)
    .map(([table, columns]) => {
      const terminal = table.endsWith("grants") ? "OLD.revoked_at IS NOT NULL" : "OLD.status <> 'held'";
      return `
  CREATE FUNCTION ${table}_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'worker budget history cannot be deleted'; END IF;
    IF ${columns.map((column) => `NEW.${column} IS DISTINCT FROM OLD.${column}`).join(" OR ")} OR ${terminal}
      THEN RAISE EXCEPTION 'worker budget authority is immutable'; END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${table}_protect();`;
    })
    .join("\n");
