import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS remote_worker_chat_parent_recoveries (
  registry_workspace_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK(assignment_generation > 0),
  recovery_revision INTEGER NOT NULL CHECK(recovery_revision > 0),
  material_json TEXT NOT NULL,
  material_sha256 TEXT NOT NULL CHECK(length(material_sha256) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, recovery_revision),
  FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
    REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation)
);`;

const ORIGINAL_FALLBACK = "ELSE generation.dispatch_owner_id END";
function recoveredFallback(dialect: "sqlite" | "postgres") {
  const scope = `recovery.registry_workspace_id = generation.registry_workspace_id
    AND recovery.assignment_id = generation.assignment_id
    AND recovery.assignment_generation = generation.assignment_generation`;
  const owner = dialect === "sqlite"
    ? "json_extract(recovery.material_json, '$.dispatchAuthority.dispatchOwnerId')"
    : "recovery.material_json::jsonb -> 'dispatchAuthority' ->> 'dispatchOwnerId'";
  return `ELSE (CASE WHEN EXISTS (SELECT 1 FROM remote_worker_chat_parent_recoveries recovery WHERE ${scope})
    THEN (SELECT ${owner} FROM remote_worker_chat_parent_recoveries recovery WHERE ${scope}
      ORDER BY recovery.recovery_revision DESC LIMIT 1)
    ELSE generation.dispatch_owner_id END) END`;
}

/** Forward-only. Retain recovery history on rollback and disable its execution
 * owner. Approval wakes keep precedence over this pre-approval fallback. */
export function createRemoteWorkerChatParentRecoverySchema(db: Pick<DatabaseSync, "exec" | "prepare">): void {
  db.exec(TABLE);
  db.exec(`CREATE TRIGGER trg_remote_worker_chat_parent_recoveries_no_update
    BEFORE UPDATE ON remote_worker_chat_parent_recoveries
    BEGIN SELECT RAISE(ABORT, 'Worker Chat parent recovery evidence is immutable'); END;
    CREATE TRIGGER trg_remote_worker_chat_parent_recoveries_no_delete
    BEFORE DELETE ON remote_worker_chat_parent_recoveries
    BEGIN SELECT RAISE(ABORT, 'Worker Chat parent recovery evidence is immutable'); END;`);
  for (const name of ["trg_remote_worker_assignment_leases_live_authority",
    "trg_remote_worker_assignment_events_live_authority", "trg_remote_worker_assignment_settlements_live_authority"]) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.sql;
    if (typeof sql !== "string" || sql.split(ORIGINAL_FALLBACK).length !== 2)
      throw new Error(`Worker Chat parent recovery requires the expected authority guard: ${name}`);
    db.exec(`DROP TRIGGER ${name}`);
    db.exec(sql.replace(ORIGINAL_FALLBACK, recoveredFallback("sqlite")));
  }
}

export const REMOTE_WORKER_CHAT_PARENT_RECOVERY_POSTGRES_SQL = TABLE + `
CREATE TRIGGER trg_remote_worker_chat_parent_recoveries_immutable
BEFORE UPDATE OR DELETE ON remote_worker_chat_parent_recoveries
FOR EACH ROW EXECUTE FUNCTION remote_worker_chat_resume_protect();
DO $parent_recovery_guards$
DECLARE signature TEXT; guard_oid REGPROCEDURE; definition TEXT;
  needle TEXT := $needle$${ORIGINAL_FALLBACK}$needle$;
  replacement TEXT := $replacement$${recoveredFallback("postgres")}$replacement$;
BEGIN
  FOREACH signature IN ARRAY ARRAY['gc_remote_worker_assignment_has_live_authority(text,text,bigint)',
    'gc_remote_worker_assignment_lease_guard()'] LOOP
    guard_oid := to_regprocedure(signature);
    IF guard_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid = guard_oid AND n.nspname = current_schema()
    ) THEN RAISE EXCEPTION 'Worker Chat parent recovery requires the expected guard: %', signature; END IF;
    definition := pg_get_functiondef(guard_oid);
    IF cardinality(string_to_array(definition, needle)) <> 2 THEN
      RAISE EXCEPTION 'Worker Chat parent recovery found an unexpected guard: %', signature;
    END IF;
    EXECUTE replace(definition, needle, replacement);
  END LOOP;
END $parent_recovery_guards$;`;
