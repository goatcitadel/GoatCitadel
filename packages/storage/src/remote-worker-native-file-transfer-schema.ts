import type { DatabaseSync } from "node:sqlite";
/** Additive bounded staging. Declarations are immutable metadata, not verified
 * receipts. Raw pages may be purged only after the matching receipt is retained;
 * repository cleanup additionally requires the canonical verified manifest.
 * Rollback disables transfer producers and retains existing evidence. */
function schema(postgres: boolean): string {
  const key = "registry_workspace_id, assignment_id, assignment_generation, nonce";
  const hex = (name: string, length: number) => `length(${name}) = ${length} AND ${postgres ? `${name} !~ '[^0-9a-f]'` : `${name} NOT GLOB '*[^0-9a-f]*'`}`;
  const transfer = "remote_worker_native_file_transfers", pages = "remote_worker_native_file_transfer_pages";
  const matchedReceipt = `EXISTS (SELECT 1 FROM remote_worker_native_file_receipts r JOIN ${transfer} t ON
    r.registry_workspace_id = t.registry_workspace_id AND r.assignment_id = t.assignment_id AND
    r.assignment_generation = t.assignment_generation AND r.nonce = t.nonce AND r.receipt_sha256 = t.declaration_sha256
    WHERE r.registry_workspace_id = OLD.registry_workspace_id AND r.assignment_id = OLD.assignment_id AND
    r.assignment_generation = OLD.assignment_generation AND r.nonce = OLD.nonce)`;
  return `CREATE TABLE IF NOT EXISTS ${transfer} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce", 64)}),
    declaration_json TEXT NOT NULL CHECK (length(declaration_json) BETWEEN 100 AND 131072),
    declaration_sha256 TEXT NOT NULL CHECK (${hex("declaration_sha256", 64)}),
    request_sha256 TEXT NOT NULL CHECK (${hex("request_sha256", 64)}),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    PRIMARY KEY (${key}), FOREIGN KEY (${key}) REFERENCES remote_worker_runtime_results(${key}),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation, lease_revision)
      REFERENCES remote_worker_assignment_leases(registry_workspace_id, assignment_id, assignment_generation, lease_revision)
  );
  CREATE TABLE IF NOT EXISTS ${pages} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL CHECK (${hex("nonce", 64)}), file_index INTEGER NOT NULL CHECK (file_index BETWEEN 0 AND 63),
    page_index INTEGER NOT NULL CHECK (page_index BETWEEN 0 AND 32),
    bytes_hex TEXT NOT NULL CHECK (length(bytes_hex) BETWEEN 2 AND 65536 AND length(bytes_hex) % 2 = 0 AND
      ${postgres ? "bytes_hex !~ '[^0-9a-f]'" : "bytes_hex NOT GLOB '*[^0-9a-f]*'"}),
    page_sha256 TEXT NOT NULL CHECK (${hex("page_sha256", 64)}),
    lease_revision INTEGER NOT NULL CHECK (lease_revision BETWEEN 1 AND 2147483647),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) = 24),
    PRIMARY KEY (${key}, file_index, page_index), FOREIGN KEY (${key}) REFERENCES ${transfer}(${key}),
    FOREIGN KEY (registry_workspace_id, assignment_id, assignment_generation, lease_revision)
      REFERENCES remote_worker_assignment_leases(registry_workspace_id, assignment_id, assignment_generation, lease_revision)
  );` + (postgres ? `
  CREATE OR REPLACE FUNCTION gc_${transfer}_immutable() RETURNS trigger AS $$
  BEGIN RAISE EXCEPTION 'native file transfer declaration is immutable and retained' USING ERRCODE = '23514'; END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_${transfer}_immutable BEFORE UPDATE OR DELETE ON ${transfer}
    FOR EACH ROW EXECUTE FUNCTION gc_${transfer}_immutable();
  CREATE OR REPLACE FUNCTION gc_${pages}_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND ${matchedReceipt} THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'native file transfer page is immutable until receipt retention' USING ERRCODE = '23514';
  END; $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_${pages}_guard BEFORE UPDATE OR DELETE ON ${pages}
    FOR EACH ROW EXECUTE FUNCTION gc_${pages}_guard();
  ` : `
  CREATE TRIGGER trg_${transfer}_immutable BEFORE UPDATE ON ${transfer}
    BEGIN SELECT RAISE(ABORT, 'native file transfer declaration is immutable'); END;
  CREATE TRIGGER trg_${transfer}_retained BEFORE DELETE ON ${transfer}
    BEGIN SELECT RAISE(ABORT, 'native file transfer declaration must be retained'); END;
  CREATE TRIGGER trg_${pages}_immutable BEFORE UPDATE ON ${pages}
    BEGIN SELECT RAISE(ABORT, 'native file transfer page is immutable'); END;
  CREATE TRIGGER trg_${pages}_retained BEFORE DELETE ON ${pages} WHEN NOT ${matchedReceipt}
    BEGIN SELECT RAISE(ABORT, 'native file transfer page requires receipt retention'); END;
  `);
}
export const REMOTE_WORKER_NATIVE_FILE_TRANSFER_POSTGRES_SQL = schema(true);
export function createRemoteWorkerNativeFileTransferSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(schema(false)); }
