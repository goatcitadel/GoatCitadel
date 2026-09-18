import type { DatabaseSync } from "node:sqlite";
import { REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK, REMOTE_WORKER_CAPACITY_SQLITE_CLOCK } from "./remote-worker-cell-capacity-observation-schema.js";

const TABLE = "remote_worker_cell_capacity_inventories";
function tableSql(postgres: boolean): string {
  const hash = (name: string) => `length(${name}) = 64 AND ${name} ${postgres ? "!~ '[^0-9a-f]'" : "NOT GLOB '*[^0-9a-f]*'"}`;
  const integer = (name: string, minimum: number) => `${name} INTEGER NOT NULL CHECK (${name} BETWEEN ${minimum} AND 2147483647${postgres ? "" : ` AND typeof(${name}) = 'integer'`})`;
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
    ${integer("assignment_generation", 1)}, ${integer("capacity_revision", 1)}, ${integer("lease_revision", 1)},
    ${integer("execution_revision", 0)}, ${integer("cleanup_revision", 0)}, ${integer("backup_revision", 0)},
    peak_logical_bytes ${postgres ? "BIGINT" : "INTEGER"} NOT NULL CHECK (peak_logical_bytes BETWEEN 0 AND 9007199254740991${postgres ? "" : " AND typeof(peak_logical_bytes) = 'integer'"}),
    ${integer("peak_inode_count", 0)},
    inventory_sha256 TEXT NOT NULL CHECK (${hash("inventory_sha256")}),
    profile_sha256 TEXT NOT NULL CHECK (${hash("profile_sha256")}),
    capture_sha256 TEXT NOT NULL CHECK (${hash("capture_sha256")}),
    inventory_json TEXT NOT NULL CHECK (length(inventory_json) BETWEEN 1 AND 12582912),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    PRIMARY KEY (registry_workspace_id, assignment_id, assignment_generation, capacity_revision),
    UNIQUE (registry_workspace_id, assignment_id, assignment_generation, capture_sha256),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation)
      REFERENCES remote_worker_cells(registry_workspace_id, assignment_id, assignment_generation),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation, lease_revision)
      REFERENCES remote_worker_assignment_leases(registry_workspace_id, assignment_id, assignment_generation, lease_revision),
    CHECK (${postgres ? "jsonb_typeof(inventory_json::jsonb) = 'object'" : "json_valid(inventory_json)"}),
    CHECK (COALESCE(${postgres ? "inventory_json::jsonb ->> 'schemaVersion'" : "json_extract(inventory_json, '$.schemaVersion')"} = 'goatcitadel.remote-worker-cell-capacity-inventory.v1', FALSE)),
    CHECK (COALESCE(${postgres ? "inventory_json::jsonb ->> 'profileSha256'" : "json_extract(inventory_json, '$.profileSha256')"} = profile_sha256, FALSE)),
    CHECK (COALESCE(${postgres ? "inventory_json::jsonb ->> 'captureSha256'" : "json_extract(inventory_json, '$.captureSha256')"} = capture_sha256, FALSE))
  );`;
}
const AUTHORITY = (clock: string) => `EXISTS (SELECT 1 FROM remote_worker_cells c
  JOIN remote_worker_assignment_leases l ON l.registry_workspace_id = c.registry_workspace_id
    AND l.assignment_id = c.assignment_id AND l.assignment_generation = c.assignment_generation
  WHERE c.registry_workspace_id = NEW.registry_workspace_id AND c.assignment_id = NEW.assignment_id
    AND c.assignment_generation = NEW.assignment_generation AND c.profile_sha256 = NEW.profile_sha256
    AND c.capacity_revision = NEW.capacity_revision AND c.execution_revision = NEW.execution_revision
    AND c.cleanup_revision = NEW.cleanup_revision AND c.backup_revision = NEW.backup_revision
    AND l.lease_revision = NEW.lease_revision AND l.expires_at > ${clock}
    AND l.lease_revision = (SELECT MAX(a.lease_revision) FROM remote_worker_assignment_leases a
      WHERE a.registry_workspace_id = NEW.registry_workspace_id AND a.assignment_id = NEW.assignment_id
        AND a.assignment_generation = NEW.assignment_generation))`;
const PRIOR = `FROM ${TABLE} p WHERE p.registry_workspace_id = NEW.registry_workspace_id
  AND p.assignment_id = NEW.assignment_id AND p.assignment_generation = NEW.assignment_generation
  ORDER BY p.capacity_revision DESC LIMIT 1`;
const MONOTONIC = `NEW.capacity_revision > COALESCE((SELECT capacity_revision ${PRIOR}), 0)
  AND NEW.peak_logical_bytes >= COALESCE((SELECT peak_logical_bytes ${PRIOR}), 0)
  AND NEW.peak_inode_count >= COALESCE((SELECT peak_inode_count ${PRIOR}), 0)`;

/** Additive retained accounting input. Rollback disables its producer and leaves
 * the records intact; no data backfill or destructive down migration exists. */
export const REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SQLITE_SQL = `${tableSql(false)}
  CREATE TRIGGER trg_cell_capacity_inventory_insert BEFORE INSERT ON ${TABLE}
  WHEN NOT (${AUTHORITY(REMOTE_WORKER_CAPACITY_SQLITE_CLOCK)}) OR NOT (${MONOTONIC})
  BEGIN SELECT RAISE(ABORT, 'cell capacity inventory authority or revisions changed'); END;
  CREATE TRIGGER trg_cell_capacity_inventory_immutable BEFORE UPDATE ON ${TABLE}
  BEGIN SELECT RAISE(ABORT, 'cell capacity inventory is immutable'); END;
  CREATE TRIGGER trg_cell_capacity_inventory_retained BEFORE DELETE ON ${TABLE}
  BEGIN SELECT RAISE(ABORT, 'cell capacity inventory must be retained'); END;
`;
export function createRemoteWorkerCellCapacityInventorySchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(REMOTE_WORKER_CELL_CAPACITY_INVENTORY_SQLITE_SQL);
}
export const REMOTE_WORKER_CELL_CAPACITY_INVENTORY_POSTGRES_SQL = `${tableSql(true)}
  CREATE OR REPLACE FUNCTION gc_cell_capacity_inventory_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'cell capacity inventory is immutable and must be retained' USING ERRCODE = '23514'; END IF;
    IF NOT (${AUTHORITY(REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK)}) OR NOT (${MONOTONIC}) THEN
      RAISE EXCEPTION 'cell capacity inventory authority or revisions changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_cell_capacity_inventory_guard BEFORE INSERT OR UPDATE OR DELETE ON ${TABLE}
    FOR EACH ROW EXECUTE FUNCTION gc_cell_capacity_inventory_guard();
`;
