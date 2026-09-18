import type { DatabaseSync } from "node:sqlite";
import { REMOTE_WORKER_CELL_CAPACITY_OBSERVATION_SQLITE_SQL, REMOTE_WORKER_CELL_CAPACITY_OBSERVATION_POSTGRES_SQL } from "./remote-worker-cell-capacity-observation-schema.js";

/** Separate immutable partial-tree evidence with the existing assignment/cell
 * fences. The decoder validates every native batch before writes and on reads.
 * Rollback disables the producer and retains this additive schema and history. */
function inventorySql(postgres: boolean): string {
  const source = postgres ? REMOTE_WORKER_CELL_CAPACITY_OBSERVATION_POSTGRES_SQL : REMOTE_WORKER_CELL_CAPACITY_OBSERVATION_SQLITE_SQL;
  const jsonCheck = postgres
    ? "jsonb_typeof(chunk_hex_json::jsonb) = 'array' AND jsonb_array_length(chunk_hex_json::jsonb) BETWEEN 1 AND 1000"
    : "json_valid(chunk_hex_json) AND json_type(chunk_hex_json) = 'array' AND json_array_length(chunk_hex_json) BETWEEN 1 AND 1000";
  return source.replaceAll("cell_capacity_observation", "cell_object_inventory_observation")
    .replace("recorded_at TEXT NOT NULL", `chunk_hex_json TEXT NOT NULL CHECK (length(chunk_hex_json) BETWEEN 2004 AND 2003001 AND ${jsonCheck}),
    recorded_at TEXT NOT NULL`);
}
export const REMOTE_WORKER_CELL_OBJECT_INVENTORY_SQLITE_SQL = inventorySql(false);
export const REMOTE_WORKER_CELL_OBJECT_INVENTORY_POSTGRES_SQL = inventorySql(true);
export function createRemoteWorkerCellObjectInventorySchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(REMOTE_WORKER_CELL_OBJECT_INVENTORY_SQLITE_SQL);
}
