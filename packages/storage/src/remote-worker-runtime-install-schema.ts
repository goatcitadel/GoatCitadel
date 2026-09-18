import type { DatabaseSync } from "node:sqlite";

/** Additive immutable evidence. Rollback disables producers and retains both
 * tables; no destructive down migration or legacy admission backfill. */
function schema(postgres: boolean): string {
  const key = "registry_workspace_id, assignment_id, assignment_generation";
  const hex = (column: string, length: number) => `length(${column}) = ${length} AND ${postgres ? `${column} !~ '[^0-9a-f]'` : `${column} NOT GLOB '*[^0-9a-f]*'`}`;
  return `CREATE TABLE IF NOT EXISTS remote_worker_runtime_install_requests (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce", 64)}),
    request_sha256 TEXT NOT NULL CHECK (${hex("request_sha256", 64)}),
    request_json TEXT NOT NULL CHECK (length(request_json) BETWEEN 500 AND 4096),
    plan_sha256 TEXT NOT NULL CHECK (${hex("plan_sha256", 64)}),
    approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
    execution_revision INTEGER NOT NULL CHECK (execution_revision BETWEEN 1 AND 2147483647),
    cleanup_revision INTEGER NOT NULL CHECK (cleanup_revision BETWEEN 1 AND 2147483647),
    capacity_revision INTEGER NOT NULL CHECK (capacity_revision BETWEEN 0 AND 2147483647),
    backup_revision INTEGER NOT NULL CHECK (backup_revision BETWEEN 1 AND 2147483647),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    PRIMARY KEY (${key}), UNIQUE (${key}, nonce),
    FOREIGN KEY (${key}) REFERENCES remote_worker_cell_provisioning(${key}),
    FOREIGN KEY (${key}, lease_revision) REFERENCES remote_worker_assignment_leases(${key}, lease_revision)
  );
  CREATE TABLE IF NOT EXISTS remote_worker_runtime_install_outcomes (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce", 64)}),
    outcome_hex TEXT NOT NULL CHECK (${hex("outcome_hex", 704)}),
    outcome_sha256 TEXT NOT NULL CHECK (${hex("outcome_sha256", 64)}),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    CHECK (nonce = substr(outcome_hex, 17, 64)),
    CHECK (outcome_sha256 = substr(outcome_hex, 641, 64)),
    PRIMARY KEY (${key}, nonce),
    FOREIGN KEY (${key}, nonce) REFERENCES remote_worker_runtime_install_requests(${key}, nonce),
    FOREIGN KEY (${key}, lease_revision) REFERENCES remote_worker_assignment_leases(${key}, lease_revision)
  );` + ["remote_worker_runtime_install_requests", "remote_worker_runtime_install_outcomes"].map(table => postgres ? `
  CREATE OR REPLACE FUNCTION gc_${table}_immutable() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'native installation evidence is immutable and must be retained' USING ERRCODE = '23514'; END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION gc_${table}_immutable();
  ` : `
  CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native installation evidence is immutable'); END;
  CREATE TRIGGER trg_${table}_retained BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native installation evidence must be retained'); END;
  `).join("");
}
export const REMOTE_WORKER_RUNTIME_INSTALL_POSTGRES_SQL = schema(true);
export function createRemoteWorkerRuntimeInstallSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(schema(false)); }
