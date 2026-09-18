import type { DatabaseSync } from "node:sqlite";

/** Reservation and resume each consume one canonical run version. Existing
 * evidence is retained; only future receipt/state writes use the corrected rule. */
export function upgradeGovernedRemediationResumeVersion(db: DatabaseSync): void {
  for (const [name, before] of [
    ["trg_governed_remediation_receipts_lineage_guard", "NEW.resumed_run_version = state.expected_waiting_run_version + 1"],
    ["trg_governed_remediation_states_authority_lineage_guard", "receipt.resumed_run_version = OLD.expected_waiting_run_version + 1"],
  ]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name!) as { sql: string } | undefined;
    if (!row || row.sql.split(before!).length !== 2) throw new Error(`Unexpected remediation resume lineage trigger: ${name}`);
    const next = row.sql.replace(before!, before!.replace("+ 1", "+ 2"));
    db.exec(`DROP TRIGGER "${name}"`);
    db.exec(next);
  }
}

export const GOVERNED_REMEDIATION_RESUME_VERSION_POSTGRES_SQL = `
DO $remediation_resume_version$
DECLARE
  binding RECORD;
  definition TEXT;
  function_count INTEGER;
BEGIN
  FOR binding IN SELECT * FROM (VALUES
    ('gc_governed_remediation_receipt_insert_guard', 'NEW.resumed_run_version = state.expected_waiting_run_version + 1'),
    ('gc_governed_remediation_state_update_guard', 'receipt.resumed_run_version = OLD.expected_waiting_run_version + 1')
  ) AS expected(name, fragment)
  LOOP
    SELECT count(*), min(pg_get_functiondef(proc.oid)) INTO function_count, definition
    FROM pg_proc proc JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = current_schema() AND proc.proname = binding.name AND proc.pronargs = 0;
    IF function_count <> 1 OR definition IS NULL
      OR (length(definition) - length(replace(definition, binding.fragment, ''))) <> length(binding.fragment) THEN
      RAISE EXCEPTION 'Unexpected remediation resume lineage function: %', binding.name;
    END IF;
    EXECUTE replace(definition, binding.fragment, replace(binding.fragment, '+ 1', '+ 2'));
  END LOOP;
END;
$remediation_resume_version$;
`;
