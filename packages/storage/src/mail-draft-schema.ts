import type { DatabaseClient } from "./db.js";

// Every column is TEXT, the only unique key is the primary key, and the index
// has no sort direction, so the PostgreSQL v2 live render of this SQLite table
// and the additive v212 table have the same canonical shape.
const MAIL_DRAFT_COLUMNS = `
  draft_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  account_id TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  bcc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  approval_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','approval_required','sent','failed','send_unavailable')),
  failure_reason TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`;

const MAIL_DRAFT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mail_drafts (${MAIL_DRAFT_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_mail_drafts_approval ON mail_drafts(approval_id);
`;

/** PostgreSQL v212: additive table for installs whose v2 render predates mail drafts. */
export const MAIL_DRAFTS_POSTGRES_SQL = MAIL_DRAFT_SCHEMA_SQL;

/**
 * PostgreSQL v213: frozen, idempotent, forward-only convergence. Fresh installs
 * get the v2-rendered table (no CHECK); upgraded installs get v212's inline
 * CHECK. Both end with the same TEXT columns, index, and one named CHECK.
 * Rollback is restoration of the pre-migration backup.
 */
export const MAIL_DRAFTS_SCHEMA_CONVERGENCE_POSTGRES_SQL = `
ALTER TABLE mail_drafts ALTER COLUMN draft_id TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN workspace_id TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN account_id TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN to_json TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN cc_json TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN bcc_json TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN subject TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN body_text TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN approval_id TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN status TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN failure_reason TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN sent_at TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN created_at TYPE TEXT;
ALTER TABLE mail_drafts ALTER COLUMN updated_at TYPE TEXT;
DROP INDEX IF EXISTS idx_mail_drafts_approval;
CREATE INDEX idx_mail_drafts_approval ON mail_drafts(approval_id);
ALTER TABLE mail_drafts DROP CONSTRAINT IF EXISTS mail_drafts_status_check;
ALTER TABLE mail_drafts ADD CONSTRAINT mail_drafts_status_check
  CHECK(status IN ('draft','approval_required','sent','failed','send_unavailable'));
`;

export function createMailDraftSchema(db: Pick<DatabaseClient, "exec">): void {
  db.exec(MAIL_DRAFT_SCHEMA_SQL);
}
