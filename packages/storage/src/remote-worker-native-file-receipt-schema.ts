import type { DatabaseSync } from "node:sqlite";

/** Additive metadata-only receipt. Rollback disables producers and retains
 * evidence; no existing rows are changed and no native file content is stored. */
function schema(postgres: boolean): string {
  const key = "registry_workspace_id, assignment_id, assignment_generation";
  const hex = (name: string) => `length(${name}) = 64 AND ${postgres ? `${name} !~ '[^0-9a-f]'` : `${name} NOT GLOB '*[^0-9a-f]*'`}`;
  const table = "remote_worker_native_file_receipts";
  return `CREATE TABLE IF NOT EXISTS ${table} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce")}),
    receipt_json TEXT NOT NULL CHECK (length(receipt_json) BETWEEN 100 AND 131072),
    receipt_sha256 TEXT NOT NULL CHECK (${hex("receipt_sha256")}),
    result_sha256 TEXT NOT NULL CHECK (${hex("result_sha256")}),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    PRIMARY KEY (${key}, nonce),
    FOREIGN KEY (${key}, nonce) REFERENCES remote_worker_runtime_results(${key}, nonce),
    FOREIGN KEY (${key}, lease_revision) REFERENCES remote_worker_assignment_leases(${key}, lease_revision)
  );` + (postgres ? `
  CREATE OR REPLACE FUNCTION gc_${table}_immutable() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'native file receipt is immutable and must be retained' USING ERRCODE = '23514'; END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION gc_${table}_immutable();
  ` : `
  CREATE TRIGGER trg_${table}_immutable BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native file receipt is immutable'); END;
  CREATE TRIGGER trg_${table}_retained BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native file receipt must be retained'); END;
  `);
}
export const REMOTE_WORKER_NATIVE_FILE_RECEIPT_POSTGRES_SQL = schema(true);
export function createRemoteWorkerNativeFileReceiptSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(schema(false)); }
