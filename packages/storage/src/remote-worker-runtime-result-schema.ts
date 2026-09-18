import type { DatabaseSync } from "node:sqlite";

/** Additive evidence tables. Rollback disables the producer and retains these
 * records; no destructive down migration or existing-data rewrite is needed. */
function schema(postgres: boolean): string {
  const hex = (name: string, length: number) => `length(${name}) = ${length} AND ${postgres ? `${name} !~ '[^0-9a-f]'` : `${name} NOT GLOB '*[^0-9a-f]*'`}`;
  const key = "registry_workspace_id, assignment_id, assignment_generation";
  return `CREATE TABLE IF NOT EXISTS remote_worker_runtime_expectations (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce", 64)}),
    expectation_json TEXT NOT NULL CHECK (length(expectation_json) BETWEEN 300 AND 1024),
    plan_sha256 TEXT NOT NULL CHECK (${hex("plan_sha256", 64)}),
    execution_revision INTEGER NOT NULL CHECK (execution_revision BETWEEN 1 AND 2147483647),
    cleanup_revision INTEGER NOT NULL CHECK (cleanup_revision BETWEEN 1 AND 2147483647),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    PRIMARY KEY (${key}, nonce), UNIQUE (${key}, execution_revision),
    FOREIGN KEY (${key}) REFERENCES remote_worker_cell_provisioning(${key}),
    FOREIGN KEY (${key}, lease_revision) REFERENCES remote_worker_assignment_leases(${key}, lease_revision)
  );
  CREATE TABLE IF NOT EXISTS remote_worker_runtime_results (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce", 64)}),
    result_hex TEXT NOT NULL CHECK (length(result_hex) BETWEEN 512 AND 2001216 AND length(result_hex) % 2 = 0 AND
      ${postgres ? "result_hex !~ '[^0-9a-f]'" : "result_hex NOT GLOB '*[^0-9a-f]*'"}),
    result_sha256 TEXT NOT NULL CHECK (${hex("result_sha256", 64)}),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    CHECK (nonce = substr(result_hex, 17, 64)),
    PRIMARY KEY (${key}, nonce),
    FOREIGN KEY (${key}, nonce) REFERENCES remote_worker_runtime_expectations(${key}, nonce),
    FOREIGN KEY (${key}, lease_revision) REFERENCES remote_worker_assignment_leases(${key}, lease_revision)
  );` + ["remote_worker_runtime_expectations", "remote_worker_runtime_results"].map(table => postgres ? `
  CREATE OR REPLACE FUNCTION gc_${table}_immutable() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'native runtime evidence is immutable and must be retained' USING ERRCODE = '23514'; END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION gc_${table}_immutable();
  ` : `
  CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native runtime evidence is immutable'); END;
  CREATE TRIGGER trg_${table}_retained BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native runtime evidence must be retained'); END;
  `).join("");
}
export const REMOTE_WORKER_RUNTIME_RESULT_POSTGRES_SQL = schema(true);
export function createRemoteWorkerRuntimeResultSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(schema(false)); }
