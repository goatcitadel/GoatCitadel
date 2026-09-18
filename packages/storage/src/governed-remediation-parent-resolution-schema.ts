import type { DatabaseSync } from "node:sqlite";

const TABLE = "governed_remediation_parent_resolutions";

function tableSql(postgres: boolean): string {
  const integer = postgres ? "BIGINT" : "INTEGER";
  const hash = postgres ? "request_sha256 ~ '^[0-9a-f]{64}$'"
    : "length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'";
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (
    resolution_id TEXT NOT NULL PRIMARY KEY CHECK (length(resolution_id) BETWEEN 1 AND 256),
    reservation_id TEXT NOT NULL REFERENCES governed_remediation_parent_reservations(reservation_id),
    resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('resumed', 'released')),
    receipt_id TEXT REFERENCES governed_remediation_receipts(receipt_id),
    failure_id TEXT REFERENCES governed_remediation_failures(failure_id),
    previous_run_version ${integer} NOT NULL CHECK (previous_run_version BETWEEN 1 AND 9007199254740990),
    resulting_run_version ${integer} NOT NULL CHECK (resulting_run_version = previous_run_version + 1),
    operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
    request_sha256 TEXT NOT NULL CHECK (${hash}),
    resolved_at TEXT NOT NULL CHECK (length(resolved_at) = 24),
    CHECK ((receipt_id IS NOT NULL AND failure_id IS NULL)
      OR (resolution_kind = 'released' AND receipt_id IS NULL AND failure_id IS NOT NULL)),
    UNIQUE (reservation_id),
    UNIQUE (idempotency_key)
  );`;
}

/** Immutable results are written with the run CAS. This schema alone never
 * releases a fence: the transaction owner must validate the evidence lineage. */
export const GOVERNED_REMEDIATION_PARENT_RESOLUTION_SQLITE_SQL = `${tableSql(false)}
  CREATE TRIGGER trg_remediation_parent_resolution_integer_versions
    BEFORE INSERT ON ${TABLE}
    WHEN typeof(NEW.previous_run_version) <> 'integer' OR typeof(NEW.resulting_run_version) <> 'integer'
    BEGIN SELECT RAISE(ABORT, 'remediation parent resolution versions must be integers'); END;
  CREATE TRIGGER trg_remediation_parent_resolution_no_update BEFORE UPDATE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT, 'remediation parent resolution is immutable'); END;
  CREATE TRIGGER trg_remediation_parent_resolution_no_delete BEFORE DELETE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT, 'remediation parent resolution cannot be deleted'); END;
`;

export const GOVERNED_REMEDIATION_PARENT_RESOLUTION_POSTGRES_SQL = `${tableSql(true)}
  CREATE FUNCTION gc_reject_remediation_parent_resolution_mutation() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'remediation parent resolution is immutable' USING ERRCODE = '23514'; END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_remediation_parent_resolution_no_update BEFORE UPDATE ON ${TABLE}
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remediation_parent_resolution_mutation();
  CREATE TRIGGER trg_remediation_parent_resolution_no_delete BEFORE DELETE ON ${TABLE}
    FOR EACH ROW EXECUTE FUNCTION gc_reject_remediation_parent_resolution_mutation();
`;

export function createGovernedRemediationParentResolutionSchema(db: DatabaseSync): void {
  db.exec(GOVERNED_REMEDIATION_PARENT_RESOLUTION_SQLITE_SQL);
}
