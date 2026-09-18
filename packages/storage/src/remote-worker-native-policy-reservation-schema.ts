import type { DatabaseSync } from "node:sqlite";

/** Additive, immutable admission evidence. Rollback disables the producer and
 * retains this table; existing expectations are never backfilled as authorized. */
function schema(postgres: boolean): string {
  const table = "remote_worker_native_policy_reservations";
  const key = "registry_workspace_id, assignment_id, assignment_generation";
  const hex = (name: string) => `length(${name}) = 64 AND ${postgres ? `${name} !~ '[^0-9a-f]'` : `${name} NOT GLOB '*[^0-9a-f]*'`}`;
  return `CREATE TABLE IF NOT EXISTS ${table} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce")}),
    request_sha256 TEXT NOT NULL CHECK (${hex("request_sha256")}),
    policy_request_sha256 TEXT NOT NULL CHECK (${hex("policy_request_sha256")}),
    approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
    decision_id TEXT NOT NULL UNIQUE REFERENCES tool_access_decisions(decision_id),
    grant_sha256 TEXT CHECK (grant_sha256 IS NULL OR (${hex("grant_sha256")})),
    PRIMARY KEY (${key}, nonce),
    FOREIGN KEY (${key}, nonce) REFERENCES remote_worker_runtime_expectations(${key}, nonce)
  );` + (postgres ? `
    CREATE OR REPLACE FUNCTION gc_${table}_immutable() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'native policy reservation must remain immutable' USING ERRCODE = '23514'; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION gc_${table}_immutable();
  ` : `
    CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'native policy reservation is immutable'); END;
    CREATE TRIGGER trg_${table}_retained BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'native policy reservation must be retained'); END;
  `);
}
export const REMOTE_WORKER_NATIVE_POLICY_RESERVATION_POSTGRES_SQL = schema(true);
export function createRemoteWorkerNativePolicyReservationSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(schema(false)); }
