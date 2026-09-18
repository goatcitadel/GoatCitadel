import type { DatabaseSync } from "node:sqlite";

/** Bounded incomplete transport data; never execution evidence. Rollback
 * disables page delivery and retains the table for operator-managed recovery. */
function schema(postgres: boolean): string {
  const key = "registry_workspace_id, assignment_id, assignment_generation";
  return `CREATE TABLE IF NOT EXISTS remote_worker_runtime_result_staging (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL, request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    result_sha256 TEXT NOT NULL CHECK (length(result_sha256) = 64),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 256 AND 1000608),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    execution_revision INTEGER NOT NULL CHECK (execution_revision BETWEEN 1 AND 2147483647),
    cleanup_revision INTEGER NOT NULL CHECK (cleanup_revision BETWEEN 1 AND 2147483647),
    prefix_hex TEXT NOT NULL CHECK (length(prefix_hex) BETWEEN 65536 AND 1966080 AND length(prefix_hex) % 65536 = 0 AND
      ${postgres ? "prefix_hex !~ '[^0-9a-f]'" : "prefix_hex NOT GLOB '*[^0-9a-f]*'"}),
    PRIMARY KEY (${key}, nonce),
    FOREIGN KEY (${key}, nonce) REFERENCES remote_worker_runtime_expectations(${key}, nonce),
    FOREIGN KEY (${key}, lease_revision) REFERENCES remote_worker_assignment_leases(${key}, lease_revision)
  );`;
}
export const REMOTE_WORKER_RUNTIME_RESULT_PAGES_POSTGRES_SQL = schema(true);
export function createRemoteWorkerRuntimeResultPagesSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(schema(false)); }
