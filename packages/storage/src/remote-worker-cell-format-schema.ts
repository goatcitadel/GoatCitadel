import type { DatabaseSync } from "node:sqlite";

const TABLE = "remote_worker_cell_format_checkpoints";
const SHAPE = `sequence BETWEEN 1 AND 2 AND length(record_hex) = 2048 AND
  length(record_sha256) = 64 AND length(previous_record_sha256) = 64 AND length(volume_recorded_sha256) = 64 AND
  phase = CASE sequence WHEN 1 THEN 'intent' WHEN 2 THEN 'formatted' END`;
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  registry_workspace_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  phase TEXT NOT NULL,
  record_hex TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,
  previous_record_sha256 TEXT NOT NULL,
  volume_recorded_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (registry_workspace_id, assignment_id, assignment_generation, sequence),
  FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation)
    REFERENCES remote_worker_cell_provisioning(registry_workspace_id, assignment_id, assignment_generation),
  CHECK (${SHAPE})
);`;
const KEY = (alias: string) => `${alias}.registry_workspace_id = NEW.registry_workspace_id AND
  ${alias}.assignment_id = NEW.assignment_id AND ${alias}.assignment_generation = NEW.assignment_generation`;
const AUTHORITY = (clock: string) => `EXISTS (SELECT 1 FROM remote_worker_cell_provisioning p
  JOIN remote_worker_cells c ON c.registry_workspace_id = p.registry_workspace_id AND c.assignment_id = p.assignment_id AND
    c.assignment_generation = p.assignment_generation
  JOIN remote_worker_cell_volume_checkpoints q ON q.registry_workspace_id = p.registry_workspace_id AND
    q.assignment_id = p.assignment_id AND q.assignment_generation = p.assignment_generation AND q.sequence = 6
  WHERE ${KEY("p")} AND c.execution_state = 'provisioning' AND c.backend = 'windows_native' AND
    c.cleanup_state = 'not_started' AND c.provisioning_lease_expires_at > ${clock} AND
    c.profile_sha256 = p.profile_sha256 AND c.provisioning_owner = p.provisioning_owner AND
    c.provisioning_lease_expires_at = p.provisioning_lease_expires_at AND q.record_sha256 = NEW.volume_recorded_sha256)`;
const ORDER = `NEW.sequence = COALESCE((SELECT MAX(f.sequence) + 1 FROM ${TABLE} f WHERE ${KEY("f")}), 1) AND
  NEW.previous_record_sha256 = COALESCE((SELECT f.record_sha256 FROM ${TABLE} f WHERE ${KEY("f")}
    ORDER BY f.sequence DESC LIMIT 1), NEW.volume_recorded_sha256)`;
const SQLITE_CLOCK = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const POSTGRES_CLOCK = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const REMOTE_WORKER_CELL_FORMAT_SQLITE_SQL = `${TABLE_SQL}
  CREATE TRIGGER trg_cell_format_insert BEFORE INSERT ON ${TABLE}
  WHEN NOT (${AUTHORITY(SQLITE_CLOCK)}) OR NOT (${ORDER})
  BEGIN SELECT RAISE(ABORT, 'cell format checkpoint authority or order changed'); END;
  CREATE TRIGGER trg_cell_format_immutable BEFORE UPDATE ON ${TABLE}
  BEGIN SELECT RAISE(ABORT, 'cell format evidence is immutable'); END;
  CREATE TRIGGER trg_cell_format_retained BEFORE DELETE ON ${TABLE}
  BEGIN SELECT RAISE(ABORT, 'cell format evidence must be retained'); END;
`;
export function createRemoteWorkerCellFormatSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(REMOTE_WORKER_CELL_FORMAT_SQLITE_SQL);
}
export const REMOTE_WORKER_CELL_FORMAT_POSTGRES_SQL = `${TABLE_SQL}
  ALTER TABLE ${TABLE} ADD CONSTRAINT gc_cell_format_shape CHECK (${SHAPE});
  CREATE OR REPLACE FUNCTION gc_cell_format_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'cell format evidence is immutable and must be retained' USING ERRCODE = '23514'; END IF;
    IF NOT (${AUTHORITY(POSTGRES_CLOCK)}) OR NOT (${ORDER}) THEN
      RAISE EXCEPTION 'cell format checkpoint authority or order changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_cell_format_guard BEFORE INSERT OR UPDATE OR DELETE ON ${TABLE}
    FOR EACH ROW EXECUTE FUNCTION gc_cell_format_guard();
`;
