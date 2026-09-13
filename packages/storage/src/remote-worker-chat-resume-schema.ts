import type { DatabaseSync } from "node:sqlite";

const TABLES = `CREATE TABLE IF NOT EXISTS remote_worker_chat_resume_wakes (
  resume_id TEXT PRIMARY KEY,
  registry_workspace_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK(assignment_generation > 0),
  prior_lease_revision INTEGER NOT NULL CHECK(prior_lease_revision > 0),
  durable_run_id TEXT NOT NULL REFERENCES durable_runs(run_id),
  waiting_checkpoint_id TEXT NOT NULL,
  material_json TEXT NOT NULL,
  material_sha256 TEXT NOT NULL CHECK(length(material_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE(registry_workspace_id, assignment_id, assignment_generation, prior_lease_revision),
  UNIQUE(durable_run_id, waiting_checkpoint_id),
  FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
    REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation)
);
CREATE TABLE IF NOT EXISTS remote_worker_chat_resume_bindings (
  resume_id TEXT PRIMARY KEY REFERENCES remote_worker_chat_resume_wakes(resume_id),
  dispatch_authority_json TEXT NOT NULL,
  dispatch_authority_sha256 TEXT NOT NULL CHECK(length(dispatch_authority_sha256) = 64),
  created_at TEXT NOT NULL
);`;

const RESUME_SCOPE = `wake.registry_workspace_id = generation.registry_workspace_id
  AND wake.assignment_id = generation.assignment_id
  AND wake.assignment_generation = generation.assignment_generation`;

const SQLITE_RESUME_OWNER = `CASE WHEN EXISTS (
  SELECT 1 FROM remote_worker_chat_resume_wakes wake WHERE ${RESUME_SCOPE}
) THEN (
  SELECT json_extract(binding.dispatch_authority_json, '$.dispatchOwnerId')
  FROM remote_worker_chat_resume_wakes wake
  LEFT JOIN remote_worker_chat_resume_bindings binding ON binding.resume_id = wake.resume_id
  WHERE ${RESUME_SCOPE}
  ORDER BY wake.prior_lease_revision DESC LIMIT 1
) ELSE generation.dispatch_owner_id END`;

const POSTGRES_RESUME_OWNER = `CASE WHEN EXISTS (
  SELECT 1 FROM remote_worker_chat_resume_wakes wake WHERE ${RESUME_SCOPE}
) THEN (
  SELECT binding.dispatch_authority_json::jsonb ->> 'dispatchOwnerId'
  FROM remote_worker_chat_resume_wakes wake
  LEFT JOIN remote_worker_chat_resume_bindings binding ON binding.resume_id = wake.resume_id
  WHERE ${RESUME_SCOPE}
  ORDER BY wake.prior_lease_revision DESC LIMIT 1
) ELSE generation.dispatch_owner_id END`;

/** Rollback disables the resume owner and retains these immutable rows and
 * guards; deleting wake/dispatch evidence is not a supported downgrade. */
export function createRemoteWorkerChatResumeSchema(db: Pick<DatabaseSync, "exec" | "prepare">): void {
  db.exec(TABLES);
  db.exec(`CREATE TRIGGER trg_remote_worker_chat_resume_wakes_no_update BEFORE UPDATE ON remote_worker_chat_resume_wakes
    BEGIN SELECT RAISE(ABORT, 'Worker Chat resume evidence is immutable'); END;
    CREATE TRIGGER trg_remote_worker_chat_resume_wakes_no_delete BEFORE DELETE ON remote_worker_chat_resume_wakes
    BEGIN SELECT RAISE(ABORT, 'Worker Chat resume evidence is immutable'); END;
    CREATE TRIGGER trg_remote_worker_chat_resume_bindings_no_update BEFORE UPDATE ON remote_worker_chat_resume_bindings
    BEGIN SELECT RAISE(ABORT, 'Worker Chat resume evidence is immutable'); END;
    CREATE TRIGGER trg_remote_worker_chat_resume_bindings_no_delete BEFORE DELETE ON remote_worker_chat_resume_bindings
    BEGIN SELECT RAISE(ABORT, 'Worker Chat resume evidence is immutable'); END;`);

  // Amend only the original-owner checks. A newer wake without a binding must
  // yield NULL, never fall back to the generation's original dispatch owner.
  const ownerCheck = "run.lease_owner_id = generation.dispatch_owner_id";
  const leaseOwnerCheck = "json_extract(NEW.parent_dispatch_authority_json, '$.dispatchOwnerId') = generation.dispatch_owner_id";
  for (const name of [
    "trg_remote_worker_assignment_leases_live_authority",
    "trg_remote_worker_assignment_events_live_authority",
    "trg_remote_worker_assignment_settlements_live_authority",
  ]) {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name);
    const sql = row?.sql;
    const isLease = name === "trg_remote_worker_assignment_leases_live_authority";
    if (typeof sql !== "string" || sql.split(ownerCheck).length !== 2 ||
      sql.split(leaseOwnerCheck).length !== (isLease ? 2 : 1)) {
      throw new Error(`Worker Chat resume migration requires the expected authority guard: ${name}`);
    }
    const amended = sql.replace(ownerCheck, `run.lease_owner_id = ${SQLITE_RESUME_OWNER}`)
      .replace(leaseOwnerCheck, "json_extract(NEW.parent_dispatch_authority_json, '$.dispatchOwnerId') = run.lease_owner_id");
    db.exec(`DROP TRIGGER ${name}`);
    db.exec(amended);
  }
}

export const REMOTE_WORKER_CHAT_RESUME_POSTGRES_SQL = TABLES + `
CREATE FUNCTION remote_worker_chat_resume_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Worker Chat resume evidence is immutable';
END $$;
CREATE TRIGGER trg_remote_worker_chat_resume_wakes_immutable
BEFORE UPDATE OR DELETE ON remote_worker_chat_resume_wakes
FOR EACH ROW EXECUTE FUNCTION remote_worker_chat_resume_protect();
CREATE TRIGGER trg_remote_worker_chat_resume_bindings_immutable
BEFORE UPDATE OR DELETE ON remote_worker_chat_resume_bindings
FOR EACH ROW EXECUTE FUNCTION remote_worker_chat_resume_protect();

DO $resume_guards$
DECLARE
  signature TEXT;
  guard_oid REGPROCEDURE;
  definition TEXT;
  owner_check TEXT := 'run.lease_owner_id = generation.dispatch_owner_id';
  lease_owner_check TEXT := $needle$NEW.parent_dispatch_authority_json::jsonb ->> 'dispatchOwnerId' = generation.dispatch_owner_id$needle$;
  resume_owner TEXT := $owner$${POSTGRES_RESUME_OWNER}$owner$;
  is_lease BOOLEAN;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'gc_remote_worker_assignment_has_live_authority(text,text,bigint)',
    'gc_remote_worker_assignment_lease_guard()'
  ] LOOP
    guard_oid := to_regprocedure(signature);
    IF guard_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.oid = guard_oid AND n.nspname = current_schema()
    ) THEN
      RAISE EXCEPTION 'Worker Chat resume migration requires the expected authority guard: %', signature;
    END IF;
    definition := pg_get_functiondef(guard_oid);
    is_lease := signature = 'gc_remote_worker_assignment_lease_guard()';
    IF cardinality(string_to_array(definition, owner_check)) <> 2
      OR cardinality(string_to_array(definition, lease_owner_check)) <> (CASE WHEN is_lease THEN 2 ELSE 1 END)
    THEN
      RAISE EXCEPTION 'Worker Chat resume migration found an unexpected authority guard: %', signature;
    END IF;
    definition := replace(definition, owner_check, 'run.lease_owner_id = ' || resume_owner);
    definition := replace(definition, lease_owner_check,
      $replacement$NEW.parent_dispatch_authority_json::jsonb ->> 'dispatchOwnerId' = run.lease_owner_id$replacement$);
    EXECUTE definition;
  END LOOP;
END $resume_guards$;`;
