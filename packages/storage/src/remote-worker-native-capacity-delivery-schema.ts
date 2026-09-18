import type { DatabaseSync } from "node:sqlite";

const TABLE = "remote_worker_native_capacity_deliveries";
function tableSql(postgres: boolean): string {
  const hash = (name: string) => `${name} TEXT NOT NULL CHECK(length(${name}) = 64 AND ${name} ${postgres ? "!~ '[^0-9a-f]'" : "NOT GLOB '*[^0-9a-f]*'"})`;
  const field = (path: string) => postgres ? `delivery_json::jsonb #>> '{${path.replaceAll(".", ",")}}'` : `json_extract(delivery_json, '$.${path}')`;
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (
    registry_workspace_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK(assignment_generation BETWEEN 1 AND 2147483647),
    capacity_revision INTEGER NOT NULL CHECK(capacity_revision BETWEEN 1 AND 2147483647),
    ${hash("bundle_sha256")}, ${hash("capture_nonce")}, ${hash("inventory_sha256")}, ${hash("capture_sha256")},
    decision TEXT NOT NULL CHECK(decision IN ('accept', 'quarantine')),
    delivery_json TEXT NOT NULL CHECK(${postgres ? "octet_length(delivery_json)" : "length(CAST(delivery_json AS BLOB))"} BETWEEN 1 AND 16777216),
    recorded_at TEXT NOT NULL CHECK(length(recorded_at) = 24),
    PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, bundle_sha256),
    UNIQUE(registry_workspace_id, assignment_id, assignment_generation, capture_nonce),
    UNIQUE(registry_workspace_id, assignment_id, assignment_generation, capacity_revision),
    FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation, capacity_revision)
      REFERENCES remote_worker_cell_capacity_inventories(registry_workspace_id, assignment_id, assignment_generation, capacity_revision),
    CHECK(${postgres ? "jsonb_typeof(delivery_json::jsonb) = 'object'" : "json_valid(delivery_json)"}),
    CHECK(COALESCE(${field("bundleSha256")} = bundle_sha256, FALSE)),
    CHECK(COALESCE(${field("window.nonce")} = capture_nonce, FALSE)),
    CHECK(COALESCE(${field("inventoryBinding.inventorySha256")} = inventory_sha256, FALSE)),
    CHECK(COALESCE(${field("inventoryBinding.captureSha256")} = capture_sha256, FALSE))
  );`;
}
const MATCH = `EXISTS (SELECT 1 FROM remote_worker_cell_capacity_inventories i JOIN remote_worker_cells c
  ON c.registry_workspace_id = i.registry_workspace_id AND c.assignment_id = i.assignment_id AND c.assignment_generation = i.assignment_generation
  WHERE i.registry_workspace_id = NEW.registry_workspace_id AND i.assignment_id = NEW.assignment_id
    AND i.assignment_generation = NEW.assignment_generation AND i.capacity_revision = NEW.capacity_revision
    AND i.inventory_sha256 = NEW.inventory_sha256 AND i.capture_sha256 = NEW.capture_sha256
    AND i.recorded_at = NEW.recorded_at AND c.capacity_revision = i.capacity_revision AND c.backend = 'windows_native')`;
/** Additive, no backfill. Rollback disables producers and retains source evidence. */
export const REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_SQLITE_SQL = `${tableSql(false)}
  CREATE TRIGGER trg_native_capacity_delivery_insert BEFORE INSERT ON ${TABLE} WHEN NOT (${MATCH})
    BEGIN SELECT RAISE(ABORT, 'native capacity delivery requires its current canonical inventory'); END;
  CREATE TRIGGER trg_native_capacity_delivery_immutable BEFORE UPDATE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT, 'native capacity delivery is immutable'); END;
  CREATE TRIGGER trg_native_capacity_delivery_retained BEFORE DELETE ON ${TABLE}
    BEGIN SELECT RAISE(ABORT, 'native capacity delivery must be retained'); END;
`;
export function createRemoteWorkerNativeCapacityDeliverySchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_SQLITE_SQL);
}
export const REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_POSTGRES_SQL = `${tableSql(true)}
  -- The fresh runtime bootstrap imports columns, keys and foreign keys from
  -- SQLite, but omits CHECKs. Enforce the same envelope on that path as upgrades.
  ALTER TABLE ${TABLE} ADD CONSTRAINT gc_native_capacity_delivery_envelope CHECK (
    assignment_generation BETWEEN 1 AND 2147483647 AND capacity_revision BETWEEN 1 AND 2147483647
    AND bundle_sha256 ~ '^[0-9a-f]{64}$' AND capture_nonce ~ '^[0-9a-f]{64}$'
    AND inventory_sha256 ~ '^[0-9a-f]{64}$' AND capture_sha256 ~ '^[0-9a-f]{64}$'
    AND decision IN ('accept', 'quarantine') AND octet_length(delivery_json) BETWEEN 1 AND 16777216
    AND length(recorded_at) = 24 AND jsonb_typeof(delivery_json::jsonb) = 'object'
    AND COALESCE(delivery_json::jsonb ->> 'bundleSha256' = bundle_sha256, FALSE)
    AND COALESCE(delivery_json::jsonb #>> '{window,nonce}' = capture_nonce, FALSE)
    AND COALESCE(delivery_json::jsonb #>> '{inventoryBinding,inventorySha256}' = inventory_sha256, FALSE)
    AND COALESCE(delivery_json::jsonb #>> '{inventoryBinding,captureSha256}' = capture_sha256, FALSE)
  );
  CREATE FUNCTION gc_native_capacity_delivery_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'native capacity delivery is immutable and must be retained' USING ERRCODE = '23514'; END IF;
    IF NOT (${MATCH}) THEN RAISE EXCEPTION 'native capacity delivery requires its current canonical inventory' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_native_capacity_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON ${TABLE}
    FOR EACH ROW EXECUTE FUNCTION gc_native_capacity_delivery_guard();
`;
