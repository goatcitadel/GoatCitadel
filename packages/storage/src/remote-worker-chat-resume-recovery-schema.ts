import type { DatabaseSync } from "node:sqlite";

const TABLE = `CREATE TABLE IF NOT EXISTS remote_worker_chat_resume_recoveries (
  resume_id TEXT NOT NULL REFERENCES remote_worker_chat_resume_bindings(resume_id),
  recovery_revision INTEGER NOT NULL CHECK(recovery_revision >= 1),
  material_json TEXT NOT NULL,
  material_sha256 TEXT NOT NULL CHECK(length(material_sha256) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(resume_id, recovery_revision)
);`;

const SQLITE_OLD_OWNER = "json_extract(binding.dispatch_authority_json, '$.dispatchOwnerId')";
const POSTGRES_OLD_OWNER = "binding.dispatch_authority_json::jsonb ->> 'dispatchOwnerId'";
function ownerWithRecovery(dialect: "sqlite" | "postgres") {
  const owner = dialect === "sqlite"
    ? "json_extract(recovery.material_json, '$.dispatchAuthority.dispatchOwnerId')"
    : "recovery.material_json::jsonb -> 'dispatchAuthority' ->> 'dispatchOwnerId'";
  return `(CASE WHEN EXISTS (SELECT 1 FROM remote_worker_chat_resume_recoveries recovery
    WHERE recovery.resume_id = wake.resume_id) THEN (
    SELECT ${owner} FROM remote_worker_chat_resume_recoveries recovery
    WHERE recovery.resume_id = wake.resume_id ORDER BY recovery.recovery_revision DESC LIMIT 1
  ) ELSE ${dialect === "sqlite" ? SQLITE_OLD_OWNER : POSTGRES_OLD_OWNER} END)`;
}

/** Forward-only: retain every prior binding and recovery. Rollback disables
 * recovery execution; deleting its evidence is not a supported downgrade. */
export function createRemoteWorkerChatResumeRecoverySchema(db: Pick<DatabaseSync, "exec" | "prepare">): void {
  db.exec(TABLE);
  db.exec(`CREATE TRIGGER trg_remote_worker_chat_resume_recoveries_no_update
    BEFORE UPDATE ON remote_worker_chat_resume_recoveries
    BEGIN SELECT RAISE(ABORT, 'Worker Chat recovery evidence is immutable'); END;
    CREATE TRIGGER trg_remote_worker_chat_resume_recoveries_no_delete
    BEFORE DELETE ON remote_worker_chat_resume_recoveries
    BEGIN SELECT RAISE(ABORT, 'Worker Chat recovery evidence is immutable'); END;`);
  for (const name of ["trg_remote_worker_assignment_leases_live_authority",
    "trg_remote_worker_assignment_events_live_authority", "trg_remote_worker_assignment_settlements_live_authority"]) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name)?.sql;
    if (typeof sql !== "string" || sql.split(SQLITE_OLD_OWNER).length !== 2)
      throw new Error(`Worker Chat recovery requires the expected authority guard: ${name}`);
    db.exec(`DROP TRIGGER ${name}`);
    db.exec(sql.replace(SQLITE_OLD_OWNER, ownerWithRecovery("sqlite")));
  }
}

export const REMOTE_WORKER_CHAT_RESUME_RECOVERY_POSTGRES_SQL = TABLE + `
CREATE TRIGGER trg_remote_worker_chat_resume_recoveries_immutable
BEFORE UPDATE OR DELETE ON remote_worker_chat_resume_recoveries
FOR EACH ROW EXECUTE FUNCTION remote_worker_chat_resume_protect();
DO $recovery_guards$
DECLARE
  signature TEXT;
  guard_oid REGPROCEDURE;
  definition TEXT;
  needle TEXT := $needle$${POSTGRES_OLD_OWNER}$needle$;
  replacement TEXT := $replacement$${ownerWithRecovery("postgres")}$replacement$;
BEGIN
  FOREACH signature IN ARRAY ARRAY['gc_remote_worker_assignment_has_live_authority(text,text,bigint)',
    'gc_remote_worker_assignment_lease_guard()'] LOOP
    guard_oid := to_regprocedure(signature);
    IF guard_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid = guard_oid AND n.nspname = current_schema()
    ) THEN RAISE EXCEPTION 'Worker Chat recovery requires the expected authority guard: %', signature; END IF;
    definition := pg_get_functiondef(guard_oid);
    IF cardinality(string_to_array(definition, needle)) <> 2 THEN
      RAISE EXCEPTION 'Worker Chat recovery found an unexpected authority guard: %', signature;
    END IF;
    EXECUTE replace(definition, needle, replacement);
  END LOOP;
END $recovery_guards$;`;
