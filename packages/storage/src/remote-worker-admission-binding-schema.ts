import type { DatabaseSync } from "node:sqlite";

const owners = ["remote_worker_chat_contexts", "remote_worker_inference_requests", "remote_worker_cells"] as const;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const xor = `(capability_profile_sha256 IS NOT NULL AND admission_reference_json IS NULL)
  OR (capability_profile_sha256 IS NULL AND admission_reference_json IS NOT NULL)`;
const contextPair = `(capability_profile_id IS NULL) = (capability_profile_sha256 IS NULL)`;

/** Rebuild only the three owners and their FK dependents, preserving all retained bytes and guards. */
export function upgradeRemoteWorkerAdmissionBindingSchema(db: Pick<DatabaseSync, "exec" | "prepare">): void {
  const objects = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const tables = objects.filter((row) => row.type === "table");
  if (owners.every((owner) => !tables.some((table) => table.name === owner))) return;
  if (owners.some((owner) => !tables.some((table) => table.name === owner)))
    throw new Error("Remote admission migration requires all three canonical owners.");
  const dependencies = new Map(
    tables.map((table) => [
      table.name,
      new Set(
        (db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all() as unknown as Array<{ table: string }>)
          .map((row) => row.table)
          .filter((name) => name !== table.name),
      ),
    ]),
  );
  const closure = new Set<string>(owners);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [table, parents] of dependencies)
      if (!closure.has(table) && [...parents].some((parent) => closure.has(parent))) {
        closure.add(table);
        changed = true;
      }
  }
  const ordered: string[] = [];
  const pending = new Set(closure);
  while (pending.size) {
    const ready = [...pending].filter((name) => ![...dependencies.get(name)!].some((parent) => pending.has(parent)));
    if (!ready.length) throw new Error("Remote admission migration found a cyclic dependency.");
    for (const name of ready) {
      ordered.push(name);
      pending.delete(name);
    }
  }
  const copies = new Map(ordered.map((name, index) => [name, `remote_admission_copy_${index}`]));
  const columns = new Map(
    ordered.map((name) => [
      name,
      (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as unknown as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ]),
  );
  for (const name of ordered) db.exec(`CREATE TEMP TABLE ${quote(copies.get(name)!)} AS SELECT * FROM ${quote(name)};`);
  for (const name of [...ordered].reverse()) db.exec(`DROP TABLE ${quote(name)};`);
  for (const name of ordered) {
    let sql = tables.find((table) => table.name === name)!.sql;
    if ((owners as readonly string[]).includes(name)) {
      const pattern = /\bcapability_profile_sha256\s+TEXT\s+NOT NULL/u;
      if (!pattern.test(sql))
        throw new Error(`Remote admission migration lost the historical capability column on ${name}.`);
      sql = sql.replace(
        pattern,
        `admission_reference_json TEXT CHECK(admission_reference_json IS NULL OR
          (json_valid(admission_reference_json) AND json_type(admission_reference_json) = 'object'
            AND length(CAST(admission_reference_json AS BLOB)) <= 16384
            AND COALESCE(json_extract(admission_reference_json, '$.version'), '') = 'goatcitadel.remote-worker-admission-reference.v1')),
        capability_profile_sha256 TEXT`,
      );
      if (name === "remote_worker_chat_contexts")
        sql = sql.replace(/\bcapability_profile_id\s+TEXT\s+NOT NULL/u, "capability_profile_id TEXT");
      sql = sql.replace(
        /\)\s*;?$/u,
        `, CHECK(${xor})${name === "remote_worker_chat_contexts" ? `, CHECK(${contextPair})` : ""})`,
      );
    }
    db.exec(sql);
  }
  for (const name of ordered) {
    const names = columns.get(name)!.map(quote).join(", ");
    db.exec(`INSERT INTO ${quote(name)} (${names}) SELECT ${names} FROM ${quote(copies.get(name)!)};`);
  }
  for (const object of objects.filter((row) => row.type !== "table" && closure.has(row.tbl_name))) db.exec(object.sql);
  for (const owner of owners)
    db.exec(`CREATE TRIGGER ${quote(`${owner}_admission_reference_immutable`)}
    BEFORE UPDATE OF admission_reference_json ON ${quote(owner)}
    WHEN NEW.admission_reference_json IS NOT OLD.admission_reference_json
    BEGIN SELECT RAISE(ABORT, 'Remote worker admission reference is immutable'); END;`);
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Remote admission migration found foreign-key drift.");
  for (const name of ordered) db.exec(`DROP TABLE ${quote(copies.get(name)!)};`);
}

export const REMOTE_WORKER_ADMISSION_BINDING_POSTGRES_SQL = owners
  .map(
    (owner) => `
  ALTER TABLE ${owner} ALTER COLUMN capability_profile_sha256 DROP NOT NULL;
  ${owner === "remote_worker_chat_contexts" ? `ALTER TABLE ${owner} ALTER COLUMN capability_profile_id DROP NOT NULL;` : ""}
  ALTER TABLE ${owner} ADD COLUMN IF NOT EXISTS admission_reference_json TEXT;
  ALTER TABLE ${owner} DROP CONSTRAINT IF EXISTS ${owner}_admission_shape;
  ALTER TABLE ${owner} ADD CONSTRAINT ${owner}_admission_shape CHECK(
    (${xor}) AND (admission_reference_json IS NULL OR
      (jsonb_typeof(admission_reference_json::jsonb) = 'object' AND octet_length(admission_reference_json) <= 16384
        AND COALESCE(admission_reference_json::jsonb ->> 'version', '') = 'goatcitadel.remote-worker-admission-reference.v1'))
    ${owner === "remote_worker_chat_contexts" ? `AND (${contextPair})` : ""});
  CREATE OR REPLACE FUNCTION ${owner}_admission_immutable() RETURNS trigger AS $$
  BEGIN
    IF NEW.admission_reference_json IS DISTINCT FROM OLD.admission_reference_json THEN
      RAISE EXCEPTION 'Remote worker admission reference is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS ${owner}_admission_reference_immutable ON ${owner};
  CREATE TRIGGER ${owner}_admission_reference_immutable BEFORE UPDATE OF admission_reference_json ON ${owner}
    FOR EACH ROW EXECUTE FUNCTION ${owner}_admission_immutable();
`,
  )
  .join("\n");
