import type { DatabaseSync } from "node:sqlite";

/** Forward-only rebuild; preserve every cell, event, index, and trigger from the old schema. */
export function upgradeNativeWorkerCells(db: Pick<DatabaseSync, "exec" | "prepare">): void {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('remote_worker_cells', 'remote_worker_cell_evidence') AND sql IS NOT NULL",
    )
    .all() as unknown as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const cells = objects.find((item) => item.type === "table" && item.name === "remote_worker_cells");
  const evidence = objects.find((item) => item.type === "table" && item.name === "remote_worker_cell_evidence");
  // Repair-only sparse migration histories may lack both owners. Do not invent them;
  // application boot still requires the complete canonical schema-shape gate.
  if (!cells && !evidence) return;
  if (!cells || !evidence || !cells.sql.includes("CHECK(backend = 'container')"))
    throw new Error("Native worker migration requires the canonical container cell schema.");
  let sql = cells.sql.replace("CHECK(backend = 'container')", "CHECK(backend IN ('container', 'windows_native'))");
  for (const column of ["container_name", "image_digest", "network_name"]) {
    const old = `CHECK((platform_identity_sha256 IS NULL) = (${column} IS NULL))`;
    if (!sql.includes(old)) throw new Error(`Native worker migration is missing the ${column} authority constraint.`);
    sql = sql.replace(
      old,
      `CHECK((backend = 'container' AND (platform_identity_sha256 IS NULL) = (${column} IS NULL)) OR (backend = 'windows_native' AND ${column} IS NULL))`,
    );
  }
  sql = sql.replace(
    "PRIMARY KEY(",
    "native_platform_json TEXT CHECK(native_platform_json IS NULL OR (json_valid(native_platform_json) AND json_type(native_platform_json) = 'object' AND length(native_platform_json) <= 4096)), PRIMARY KEY(",
  );
  sql = sql.replace(
    /\)\s*;?$/u,
    `, CHECK((backend = 'container' AND native_platform_json IS NULL) OR (backend = 'windows_native' AND (platform_identity_sha256 IS NULL) = (native_platform_json IS NULL))) )`,
  );
  db.exec(
    "CREATE TEMP TABLE native_cell_copy AS SELECT * FROM remote_worker_cells; CREATE TEMP TABLE native_cell_evidence_copy AS SELECT * FROM remote_worker_cell_evidence;",
  );
  db.exec("DROP TABLE remote_worker_cell_evidence; DROP TABLE remote_worker_cells;");
  db.exec(sql);
  db.exec(evidence.sql);
  db.exec(
    "INSERT INTO remote_worker_cells SELECT *, NULL FROM native_cell_copy; INSERT INTO remote_worker_cell_evidence SELECT * FROM native_cell_evidence_copy;",
  );
  for (const object of objects.filter((item) => item.type !== "table")) db.exec(object.sql);
  db.exec("DROP TABLE native_cell_copy; DROP TABLE native_cell_evidence_copy;");
  db.exec(`CREATE TRIGGER trg_remote_worker_native_platform_immutable BEFORE UPDATE OF native_platform_json ON remote_worker_cells
    WHEN OLD.native_platform_json IS NOT NULL AND NEW.native_platform_json IS NOT OLD.native_platform_json
    BEGIN SELECT RAISE(ABORT, 'native cell platform is immutable'); END;`);
}

export const NATIVE_WORKER_CELL_POSTGRES_SQL = `
  -- The dynamic bootstrap already has the nullable column but omits CHECKs.
  -- Upgrade both that shape and the historical container-only owner in place.
  ALTER TABLE remote_worker_cells ADD CONSTRAINT gc_native_backend_before CHECK(backend = 'container') NOT VALID;
  DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint old_check
      JOIN pg_constraint probe ON probe.conrelid = old_check.conrelid AND probe.conname = 'gc_native_backend_before'
      WHERE old_check.conrelid = 'remote_worker_cells'::regclass AND old_check.conname = 'remote_worker_cells_backend_check'
        AND (old_check.contype <> 'c' OR pg_get_expr(old_check.conbin, old_check.conrelid) IS DISTINCT FROM pg_get_expr(probe.conbin, probe.conrelid))
    ) THEN RAISE EXCEPTION 'Native worker migration found a drifted backend constraint'; END IF;
  END $$;
  ALTER TABLE remote_worker_cells DROP CONSTRAINT gc_native_backend_before;
  ALTER TABLE remote_worker_cells DROP CONSTRAINT IF EXISTS remote_worker_cells_backend_check;
  ALTER TABLE remote_worker_cells ADD CONSTRAINT remote_worker_cells_backend_check CHECK(backend IN ('container', 'windows_native'));
  ALTER TABLE remote_worker_cells ADD COLUMN IF NOT EXISTS native_platform_json TEXT;
  ALTER TABLE remote_worker_cells ADD CONSTRAINT remote_worker_cells_native_platform_check CHECK(native_platform_json IS NULL OR (jsonb_typeof(native_platform_json::jsonb) = 'object' AND octet_length(native_platform_json) <= 4096));
  DO $$
  DECLARE item RECORD;
  BEGIN
    FOR item IN SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'remote_worker_cells'::regclass AND contype = 'c'
    LOOP
      IF regexp_replace(item.definition, '[[:space:]()]', '', 'g') IN (
        'CHECKplatform_identity_sha256ISNULL=container_nameISNULL',
        'CHECKplatform_identity_sha256ISNULL=image_digestISNULL',
        'CHECKplatform_identity_sha256ISNULL=network_nameISNULL'
      ) THEN
        EXECUTE format('ALTER TABLE remote_worker_cells DROP CONSTRAINT %I', item.conname);
      END IF;
    END LOOP;
  END $$;
  ALTER TABLE remote_worker_cells ADD CONSTRAINT remote_worker_cells_platform_backend_check CHECK(
    (backend = 'container' AND native_platform_json IS NULL AND
      (platform_identity_sha256 IS NULL) = (container_name IS NULL) AND
      (platform_identity_sha256 IS NULL) = (image_digest IS NULL) AND
      (platform_identity_sha256 IS NULL) = (network_name IS NULL)) OR
    (backend = 'windows_native' AND container_name IS NULL AND image_digest IS NULL AND network_name IS NULL AND
      (platform_identity_sha256 IS NULL) = (native_platform_json IS NULL))
  );
  CREATE OR REPLACE FUNCTION gc_remote_worker_native_platform_guard() RETURNS trigger AS $$
  BEGIN
    IF OLD.native_platform_json IS NOT NULL AND NEW.native_platform_json IS DISTINCT FROM OLD.native_platform_json THEN
      RAISE EXCEPTION 'native cell platform is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_remote_worker_native_platform_immutable BEFORE UPDATE OF native_platform_json ON remote_worker_cells
    FOR EACH ROW EXECUTE FUNCTION gc_remote_worker_native_platform_guard();
`;
