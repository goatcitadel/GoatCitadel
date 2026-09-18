import type { DatabaseSync } from "node:sqlite";
const CAPTURES = "remote_worker_native_capacity_captures", PAGES = "remote_worker_native_capacity_pages";
const KEY = "registry_workspace_id, assignment_id, assignment_generation";
function schema(postgres: boolean): string {
  const hash = (column: string) => `length(${column}) = 64 AND ${column} ${postgres ? "!~ '[^0-9a-f]'" : "NOT GLOB '*[^0-9a-f]*'"}`;
  const captureChecks = `assignment_generation BETWEEN 1 AND 2147483647 AND byte_length BETWEEN 2 AND 16777216
    AND ${hash("nonce")} AND ${hash("bundle_sha256")} AND ${hash("delivery_sha256")} AND ${hash("specification_sha256")}
    AND ${postgres ? "octet_length(specification_json)" : "length(CAST(specification_json AS BLOB))"} BETWEEN 1 AND 131072
    AND ${postgres ? "jsonb_typeof(specification_json::jsonb) = 'object'" : "json_valid(specification_json)"}
    AND length(recorded_at) = 24`;
  const pageChecks = `assignment_generation BETWEEN 1 AND 2147483647 AND lease_revision BETWEEN 1 AND 2147483647
    AND page_offset BETWEEN 0 AND 16744448 AND page_offset % 32768 = 0 AND ${hash("nonce")} AND ${hash("page_sha256")}
    AND length(bytes_hex) BETWEEN 2 AND 65536 AND length(bytes_hex) % 2 = 0
    AND bytes_hex ${postgres ? "!~ '[^0-9a-f]'" : "NOT GLOB '*[^0-9a-f]*'"} AND length(recorded_at) = 24`;
  return `CREATE TABLE IF NOT EXISTS ${CAPTURES} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL, bundle_sha256 TEXT NOT NULL, delivery_sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL,
    specification_sha256 TEXT NOT NULL, specification_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
    PRIMARY KEY (${KEY}, nonce), UNIQUE (${KEY}, bundle_sha256),
    FOREIGN KEY (${KEY}) REFERENCES remote_worker_cells(${KEY}), CHECK (${captureChecks})
  );
  CREATE TABLE IF NOT EXISTS ${PAGES} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
    nonce TEXT NOT NULL, page_offset INTEGER NOT NULL, bytes_hex TEXT NOT NULL, page_sha256 TEXT NOT NULL,
    lease_revision INTEGER NOT NULL, recorded_at TEXT NOT NULL,
    PRIMARY KEY (${KEY}, nonce, page_offset), FOREIGN KEY (${KEY}, nonce) REFERENCES ${CAPTURES}(${KEY}, nonce),
    FOREIGN KEY (${KEY}, lease_revision) REFERENCES remote_worker_assignment_leases(${KEY}, lease_revision), CHECK (${pageChecks})
  );
  ${postgres ? `ALTER TABLE ${CAPTURES} ADD CONSTRAINT gc_native_capture_bounds CHECK (${captureChecks});
    ALTER TABLE ${PAGES} ADD CONSTRAINT gc_native_capture_page_bounds CHECK (${pageChecks});` : ""}
  `;
}
const NEXT = `COALESCE((SELECT MAX(p.page_offset + length(p.bytes_hex) / 2) FROM ${PAGES} p WHERE
  p.registry_workspace_id = NEW.registry_workspace_id AND p.assignment_id = NEW.assignment_id
  AND p.assignment_generation = NEW.assignment_generation AND p.nonce = NEW.nonce), 0)`;
function insertGuard(postgres: boolean): string {
  const clock = postgres ? "to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  return `NEW.page_offset = ${NEXT} AND EXISTS (SELECT 1 FROM ${CAPTURES} e JOIN remote_worker_assignment_leases l
    ON l.registry_workspace_id = e.registry_workspace_id AND l.assignment_id = e.assignment_id AND l.assignment_generation = e.assignment_generation
    WHERE e.registry_workspace_id = NEW.registry_workspace_id AND e.assignment_id = NEW.assignment_id
    AND e.assignment_generation = NEW.assignment_generation AND e.nonce = NEW.nonce
    AND NEW.page_offset < e.byte_length AND length(NEW.bytes_hex) = 2 * ${postgres ? "LEAST" : "MIN"}(32768, e.byte_length - NEW.page_offset)
    AND l.lease_revision = NEW.lease_revision AND l.expires_at > ${clock}
    AND l.lease_revision = (SELECT MAX(a.lease_revision) FROM remote_worker_assignment_leases a
      WHERE a.registry_workspace_id = e.registry_workspace_id AND a.assignment_id = e.assignment_id AND a.assignment_generation = e.assignment_generation))`;
}
/** Additive immutable expectations and pages. No automatic cleanup or destructive rollback. */
export const REMOTE_WORKER_NATIVE_CAPACITY_PAGES_SQLITE_SQL = `${schema(false)}
  CREATE TRIGGER trg_native_capture_page_insert BEFORE INSERT ON ${PAGES} WHEN NOT (${insertGuard(false)})
    BEGIN SELECT RAISE(ABORT, 'native capacity page sequence or lease changed'); END;
  ${[CAPTURES, PAGES].map((table, index) => `CREATE TRIGGER trg_native_capture_${index}_immutable BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native capacity staging is immutable'); END;
    CREATE TRIGGER trg_native_capture_${index}_retained BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'native capacity staging must be retained'); END;`).join("\n")}
`;
export function createRemoteWorkerNativeCapacityPagesSchema(db: Pick<DatabaseSync, "exec">): void { db.exec(REMOTE_WORKER_NATIVE_CAPACITY_PAGES_SQLITE_SQL); }
export const REMOTE_WORKER_NATIVE_CAPACITY_PAGES_POSTGRES_SQL = `${schema(true)}
  CREATE FUNCTION gc_native_capture_immutable() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'native capacity staging is immutable and must be retained' USING ERRCODE = '23514'; END;
  $$ LANGUAGE plpgsql;
  ${[CAPTURES, PAGES].map((table, index) => `CREATE TRIGGER trg_native_capture_${index}_immutable BEFORE UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION gc_native_capture_immutable();`).join("\n")}
  CREATE FUNCTION gc_native_capture_page_insert() RETURNS trigger AS $$
    BEGIN IF NOT (${insertGuard(true)}) THEN RAISE EXCEPTION 'native capacity page sequence or lease changed' USING ERRCODE = '23514'; END IF;
      RETURN NEW; END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_native_capture_page_insert BEFORE INSERT ON ${PAGES} FOR EACH ROW EXECUTE FUNCTION gc_native_capture_page_insert();
`;
