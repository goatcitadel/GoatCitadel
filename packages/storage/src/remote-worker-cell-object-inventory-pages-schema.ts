import type { DatabaseSync } from "node:sqlite";

/** One bounded, replaceable staging capture per assignment generation. Complete
 * observations remain in the separate immutable history. Rollback disables the
 * page producer; no destructive down migration is required. */
function pageSchema(postgres: boolean): string {
  const json = postgres ? "jsonb_typeof(chunk_hex_json::jsonb) = 'array' AND jsonb_array_length(chunk_hex_json::jsonb) BETWEEN 1 AND 960"
    : "json_valid(chunk_hex_json) AND json_type(chunk_hex_json) = 'array' AND json_array_length(chunk_hex_json) BETWEEN 1 AND 960";
  const hex = (column: string, length: number) => `length(${column}) = ${length} AND ${postgres ? `${column} !~ '[^0-9a-f]'` : `${column} NOT GLOB '*[^0-9a-f]*'`}`;
  return `CREATE TABLE IF NOT EXISTS remote_worker_cell_object_inventory_staging (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483646),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    execution_revision INTEGER NOT NULL CHECK (execution_revision >= 1),
    cleanup_revision INTEGER NOT NULL CHECK (cleanup_revision >= 1),
    observation_hex TEXT NOT NULL CHECK (${hex("observation_hex", 704)}),
    native_receipt_hex TEXT NOT NULL CHECK (native_receipt_hex = '00000000050000000000000015000000'),
    chunk_hex_json TEXT NOT NULL CHECK (length(chunk_hex_json) BETWEEN 2004 AND 1922881 AND ${json}),
    PRIMARY KEY (registry_workspace_id, assignment_id, assignment_generation),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation)
      REFERENCES remote_worker_cell_provisioning(registry_workspace_id, assignment_id, assignment_generation),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation, lease_revision)
      REFERENCES remote_worker_assignment_leases(registry_workspace_id, assignment_id, assignment_generation, lease_revision)
  );`;
}
export const REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGES_POSTGRES_SQL = pageSchema(true);
export function createRemoteWorkerCellObjectInventoryPagesSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(pageSchema(false)); }
