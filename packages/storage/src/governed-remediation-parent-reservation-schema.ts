import type { DatabaseSync } from "node:sqlite";

const TABLE = "governed_remediation_parent_reservations";

function tableSql(postgres: boolean): string {
  const integer = postgres ? "BIGINT" : "INTEGER";
  const hash = (column: string) => postgres
    ? `${column} ~ '^[0-9a-f]{64}$'`
    : `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (
    reservation_id TEXT NOT NULL PRIMARY KEY CHECK (length(reservation_id) BETWEEN 1 AND 256),
    remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id),
    durable_run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
    blocked_checkpoint_id TEXT NOT NULL REFERENCES durable_checkpoints(checkpoint_id),
    requester_actor_id TEXT NOT NULL CHECK (length(requester_actor_id) BETWEEN 1 AND 256),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 256),
    state_revision ${integer} NOT NULL CHECK (state_revision BETWEEN 1 AND 9007199254740990),
    waiting_run_version ${integer} NOT NULL CHECK (waiting_run_version BETWEEN 1 AND 9007199254740990),
    reserved_run_version ${integer} NOT NULL CHECK (reserved_run_version = waiting_run_version + 1),
    recipe_sha256 TEXT NOT NULL CHECK (${hash("recipe_sha256")}),
    effect_id TEXT NOT NULL CHECK (length(effect_id) BETWEEN 1 AND 256),
    expected_owner_revision TEXT NOT NULL CHECK (length(expected_owner_revision) BETWEEN 1 AND 512),
    pre_effect_approval_id TEXT CHECK (pre_effect_approval_id IS NULL OR length(pre_effect_approval_id) BETWEEN 1 AND 256),
    prompt_id TEXT CHECK (prompt_id IS NULL OR length(prompt_id) BETWEEN 1 AND 256),
    operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
    request_sha256 TEXT NOT NULL CHECK (${hash("request_sha256")}),
    reserved_at TEXT NOT NULL CHECK (length(reserved_at) = 24),
    UNIQUE (remediation_id),
    UNIQUE (idempotency_key),
    UNIQUE (durable_run_id, waiting_run_version)
  );`;
}

/** Immutable reservation evidence survives run recovery and receipt replay.
 * Rollback disables its producer and retains records; it does not drop them.
 * Admission/policy and the run-version CAS remain the transaction owner's job. */
export const GOVERNED_REMEDIATION_PARENT_RESERVATION_SQLITE_SQL = `${tableSql(false)}
  CREATE TRIGGER trg_remediation_parent_reservation_integer_versions
    BEFORE INSERT ON ${TABLE}
    WHEN typeof(NEW.state_revision) <> 'integer'
      OR typeof(NEW.waiting_run_version) <> 'integer'
      OR typeof(NEW.reserved_run_version) <> 'integer'
    BEGIN SELECT RAISE(ABORT, 'remediation parent reservation versions must be integers'); END;
  CREATE TRIGGER trg_remediation_parent_reservation_no_update
    BEFORE UPDATE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT, 'remediation parent reservation is immutable'); END;
  CREATE TRIGGER trg_remediation_parent_reservation_no_delete
    BEFORE DELETE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT, 'remediation parent reservation cannot be deleted'); END;
`;

export const GOVERNED_REMEDIATION_PARENT_RESERVATION_POSTGRES_SQL = `${tableSql(true)}
  CREATE FUNCTION gc_reject_remediation_parent_reservation_mutation() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'remediation parent reservation is immutable' USING ERRCODE = '23514';
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_remediation_parent_reservation_no_update
    BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION gc_reject_remediation_parent_reservation_mutation();
  CREATE TRIGGER trg_remediation_parent_reservation_no_delete
    BEFORE DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION gc_reject_remediation_parent_reservation_mutation();
`;

export function createGovernedRemediationParentReservationSchema(db: DatabaseSync): void {
  db.exec(GOVERNED_REMEDIATION_PARENT_RESERVATION_SQLITE_SQL);
}
