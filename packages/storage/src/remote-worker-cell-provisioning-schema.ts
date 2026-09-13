import type { DatabaseSync } from "node:sqlite";

const PLAN_SHAPE = `length(profile_sha256) = 64 AND length(plan_sha256) = 64 AND
  length(plan_json) BETWEEN 1 AND 4096 AND length(provisioning_owner) BETWEEN 1 AND 256 AND
  length(provisioning_lease_expires_at) = 24 AND capacity_revision >= 0`;
const CHECKPOINT_SHAPE = `sequence BETWEEN 1 AND 5 AND length(record_hex) = 2048 AND
  length(record_sha256) = 64 AND length(previous_record_sha256) = 64 AND
  phase = CASE sequence WHEN 1 THEN 'prepared' WHEN 2 THEN 'workspace_started'
    WHEN 3 THEN 'workspace_recorded' WHEN 4 THEN 'disk_started' WHEN 5 THEN 'disk_recorded' END`;
const TABLES = `
  CREATE TABLE IF NOT EXISTS remote_worker_cell_provisioning (
    registry_workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL,
    profile_sha256 TEXT NOT NULL,
    plan_sha256 TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    provisioning_owner TEXT NOT NULL,
    provisioning_lease_expires_at TEXT NOT NULL,
    capacity_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (registry_workspace_id, assignment_id, assignment_generation),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation)
      REFERENCES remote_worker_cells(registry_workspace_id, assignment_id, assignment_generation),
    CHECK (${PLAN_SHAPE})
  );
  CREATE TABLE IF NOT EXISTS remote_worker_cell_provisioning_checkpoints (
    registry_workspace_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    phase TEXT NOT NULL,
    record_hex TEXT NOT NULL,
    record_sha256 TEXT NOT NULL,
    previous_record_sha256 TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (registry_workspace_id, assignment_id, assignment_generation, sequence),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation)
      REFERENCES remote_worker_cell_provisioning(registry_workspace_id, assignment_id, assignment_generation),
    CHECK (${CHECKPOINT_SHAPE})
  );
`;
const KEY = (alias: string) => `${alias}.registry_workspace_id = NEW.registry_workspace_id AND
  ${alias}.assignment_id = NEW.assignment_id AND ${alias}.assignment_generation = NEW.assignment_generation`;
const CELL_AUTHORITY = (clock: string) => `c.execution_state = 'provisioning' AND c.backend = 'windows_native' AND
  c.cleanup_state = 'not_started' AND c.provisioning_lease_expires_at > ${clock}`;
const PLAN_AUTHORITY = (clock: string) => `EXISTS (SELECT 1 FROM remote_worker_cells c WHERE ${KEY("c")} AND
  ${CELL_AUTHORITY(clock)} AND c.profile_sha256 = NEW.profile_sha256 AND c.provisioning_owner = NEW.provisioning_owner AND
  c.provisioning_lease_expires_at = NEW.provisioning_lease_expires_at AND c.capacity_revision = NEW.capacity_revision)`;
const CHECKPOINT_AUTHORITY = (clock: string) => `EXISTS (SELECT 1 FROM remote_worker_cell_provisioning p
  JOIN remote_worker_cells c ON c.registry_workspace_id = p.registry_workspace_id AND c.assignment_id = p.assignment_id AND
    c.assignment_generation = p.assignment_generation
  WHERE ${KEY("p")} AND ${CELL_AUTHORITY(clock)} AND c.profile_sha256 = p.profile_sha256 AND
    c.provisioning_owner = p.provisioning_owner AND c.provisioning_lease_expires_at = p.provisioning_lease_expires_at)`;
const CHECKPOINT_ORDER = `NEW.sequence = COALESCE((SELECT MAX(q.sequence) + 1
  FROM remote_worker_cell_provisioning_checkpoints q WHERE ${KEY("q")}), 1) AND
  NEW.previous_record_sha256 = COALESCE((SELECT q.record_sha256 FROM remote_worker_cell_provisioning_checkpoints q
    WHERE ${KEY("q")} ORDER BY q.sequence DESC LIMIT 1), '${"0".repeat(64)}')`;
const SQLITE_CLOCK = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const POSTGRES_CLOCK = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const REMOTE_WORKER_CELL_PROVISIONING_SQLITE_SQL = `${TABLES}
  CREATE TRIGGER trg_cell_provisioning_insert BEFORE INSERT ON remote_worker_cell_provisioning
  WHEN NOT (${PLAN_AUTHORITY(SQLITE_CLOCK)})
  BEGIN SELECT RAISE(ABORT, 'cell provisioning authority changed'); END;
  CREATE TRIGGER trg_cell_checkpoint_insert BEFORE INSERT ON remote_worker_cell_provisioning_checkpoints
  WHEN NOT (${CHECKPOINT_AUTHORITY(SQLITE_CLOCK)}) OR NOT (${CHECKPOINT_ORDER})
  BEGIN SELECT RAISE(ABORT, 'cell provisioning checkpoint authority or order changed'); END;
  ${["remote_worker_cell_provisioning", "remote_worker_cell_provisioning_checkpoints"].map((table) => `
    CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'cell provisioning evidence is immutable'); END;
    CREATE TRIGGER trg_${table}_retained BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'cell provisioning evidence must be retained'); END;
  `).join("\n")}
`;
export function createRemoteWorkerCellProvisioningSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(REMOTE_WORKER_CELL_PROVISIONING_SQLITE_SQL);
}

export const REMOTE_WORKER_CELL_PROVISIONING_POSTGRES_SQL = `${TABLES}
  ALTER TABLE remote_worker_cell_provisioning ADD CONSTRAINT gc_cell_provisioning_shape CHECK (${PLAN_SHAPE});
  ALTER TABLE remote_worker_cell_provisioning_checkpoints ADD CONSTRAINT gc_cell_checkpoint_shape CHECK (${CHECKPOINT_SHAPE});
  CREATE OR REPLACE FUNCTION gc_cell_provisioning_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'cell provisioning evidence is immutable and must be retained' USING ERRCODE = '23514'; END IF;
    IF TG_TABLE_NAME = 'remote_worker_cell_provisioning' THEN
      IF NOT (${PLAN_AUTHORITY(POSTGRES_CLOCK)}) THEN
        RAISE EXCEPTION 'cell provisioning authority changed' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NOT (${CHECKPOINT_AUTHORITY(POSTGRES_CLOCK)}) OR NOT (${CHECKPOINT_ORDER}) THEN
        RAISE EXCEPTION 'cell provisioning checkpoint authority or order changed' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  ${["remote_worker_cell_provisioning", "remote_worker_cell_provisioning_checkpoints"].map((table) => `
    CREATE TRIGGER trg_${table}_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION gc_cell_provisioning_guard();
  `).join("\n")}
`;
