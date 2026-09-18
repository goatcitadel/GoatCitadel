import type { DatabaseSync } from "node:sqlite";

const TABLE = "remote_worker_cell_capacity_observations";
const KEY = (alias: string) => `${alias}.registry_workspace_id = NEW.registry_workspace_id AND
  ${alias}.assignment_id = NEW.assignment_id AND ${alias}.assignment_generation = NEW.assignment_generation`;
export const REMOTE_WORKER_CAPACITY_SQLITE_CLOCK = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function tableSql(postgres: boolean): string {
  const hex = (column: string, length: number) => `length(${column}) = ${length} AND ${postgres
    ? `${column} !~ '[^0-9a-f]'` : `${column} NOT GLOB '*[^0-9a-f]*'`}`;
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647${postgres ? "" : " AND typeof(revision) = 'integer'"}),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647${postgres ? "" : " AND typeof(lease_revision) = 'integer'"}),
    observation_hex TEXT NOT NULL CHECK (${hex("observation_hex", 704)}),
    native_receipt_hex TEXT NOT NULL CHECK (native_receipt_hex = '00000000050000000000000015000000'),
    connection_nonce_hex TEXT NOT NULL CHECK (${hex("connection_nonce_hex", 64)} AND connection_nonce_hex <> '${"0".repeat(64)}'),
    plan_sha256 TEXT NOT NULL CHECK (${hex("plan_sha256", 64)}),
    profile_sha256 TEXT NOT NULL CHECK (${hex("profile_sha256", 64)}),
    checkpoint_sha256 TEXT NOT NULL CHECK (${hex("checkpoint_sha256", 64)}),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    PRIMARY KEY (registry_workspace_id, assignment_id, assignment_generation, revision),
    UNIQUE (registry_workspace_id, assignment_id, assignment_generation, connection_nonce_hex),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation)
      REFERENCES remote_worker_cell_provisioning(registry_workspace_id, assignment_id, assignment_generation),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation, lease_revision)
      REFERENCES remote_worker_assignment_leases(registry_workspace_id, assignment_id, assignment_generation, lease_revision),
    CHECK (connection_nonce_hex = substr(observation_hex, 1, 64) AND profile_sha256 = substr(observation_hex, 241, 64)
      AND checkpoint_sha256 = substr(observation_hex, 305, 64))
  );`;
}
const AUTHORITY = (clock: string) => `EXISTS (SELECT 1 FROM remote_worker_cell_provisioning p
  JOIN remote_worker_cells c ON c.registry_workspace_id = p.registry_workspace_id AND c.assignment_id = p.assignment_id AND c.assignment_generation = p.assignment_generation
  JOIN remote_worker_cell_mounted_workspace_checkpoints q ON q.registry_workspace_id = p.registry_workspace_id AND q.assignment_id = p.assignment_id AND q.assignment_generation = p.assignment_generation AND q.sequence = 2
  JOIN remote_worker_assignment_leases l ON l.registry_workspace_id = p.registry_workspace_id AND l.assignment_id = p.assignment_id AND l.assignment_generation = p.assignment_generation
  WHERE ${KEY("p")} AND c.backend = 'windows_native' AND c.execution_state <> 'profiled' AND c.cleanup_state = 'not_started'
    AND c.profile_sha256 = p.profile_sha256 AND p.profile_sha256 = NEW.profile_sha256 AND p.plan_sha256 = NEW.plan_sha256
    AND c.provisioning_owner = p.provisioning_owner AND c.provisioning_lease_expires_at = p.provisioning_lease_expires_at
    AND q.record_sha256 = NEW.checkpoint_sha256 AND l.lease_revision = NEW.lease_revision AND l.expires_at > ${clock}
    AND l.lease_revision = (SELECT MAX(a.lease_revision) FROM remote_worker_assignment_leases a WHERE ${KEY("a")}))`;
const ORDER = `NEW.revision = COALESCE((SELECT MAX(o.revision) + 1 FROM ${TABLE} o WHERE ${KEY("o")}), 1)`;

/** Additive retained evidence only. Rollback disables the producer and preserves
 * this table; deleting history is deliberately not a supported down migration. */
export const REMOTE_WORKER_CELL_CAPACITY_OBSERVATION_SQLITE_SQL = `${tableSql(false)}
  CREATE TRIGGER trg_cell_capacity_observation_insert BEFORE INSERT ON ${TABLE}
  WHEN NOT (${AUTHORITY(REMOTE_WORKER_CAPACITY_SQLITE_CLOCK)}) OR NOT (${ORDER})
  BEGIN SELECT RAISE(ABORT, 'cell capacity observation authority or revision changed'); END;
  CREATE TRIGGER trg_cell_capacity_observation_immutable BEFORE UPDATE ON ${TABLE}
  BEGIN SELECT RAISE(ABORT, 'cell capacity observation is immutable'); END;
  CREATE TRIGGER trg_cell_capacity_observation_retained BEFORE DELETE ON ${TABLE}
  BEGIN SELECT RAISE(ABORT, 'cell capacity observation must be retained'); END;
`;
export function createRemoteWorkerCellCapacityObservationSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(REMOTE_WORKER_CELL_CAPACITY_OBSERVATION_SQLITE_SQL);
}
export const REMOTE_WORKER_CELL_CAPACITY_OBSERVATION_POSTGRES_SQL = `${tableSql(true)}
  CREATE OR REPLACE FUNCTION gc_cell_capacity_observation_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'cell capacity observation is immutable and must be retained' USING ERRCODE = '23514'; END IF;
    IF NOT (${AUTHORITY(REMOTE_WORKER_CAPACITY_POSTGRES_CLOCK)}) OR NOT (${ORDER}) THEN
      RAISE EXCEPTION 'cell capacity observation authority or revision changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_cell_capacity_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON ${TABLE}
    FOR EACH ROW EXECUTE FUNCTION gc_cell_capacity_observation_guard();
`;
