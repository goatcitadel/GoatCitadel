export const CHAT_APPROVAL_MODE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS chat_session_approval_modes (
  session_id TEXT PRIMARY KEY REFERENCES chat_session_meta(session_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('standard', 'auto')),
  mode_revision TEXT NOT NULL,
  last_change_aggregate_revision INTEGER NOT NULL CHECK (last_change_aggregate_revision > 1),
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  project_revision INTEGER,
  CHECK (mode = 'standard' OR (project_id IS NOT NULL AND project_revision IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS chat_turn_approval_admissions (
  admission_id TEXT PRIMARY KEY REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE CASCADE,
  authority_json TEXT NOT NULL
);`;
