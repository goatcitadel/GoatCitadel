// Frozen forward migration. Preserve rows and all existing constraints.
// Rollback is restoration of the pre-migration backup; no narrowing conversion is supplied.
//
// v198 created the channel guided-setup tables on installs whose v2 runtime
// schema predates them. Fresh installs get the v2-rendered shape instead
// (BIGINT columns, BIGSERIAL sequence, named unique indexes), so the canonical
// schema-shape gate rejected upgraded installs. Converge both lineages here.
export const POSTGRES_SCHEMA_CONVERGENCE_V200_SQL = `
-- Forward-only convergence of additive INTEGER columns to canonical BIGINT.
ALTER TABLE "channel_setup_evidence" ALTER COLUMN "draft_revision" TYPE BIGINT;
ALTER TABLE "channel_oauth_attempts" ALTER COLUMN "revision" TYPE BIGINT;
ALTER TABLE "channel_oauth_attempts" ALTER COLUMN "draft_revision" TYPE BIGINT;
ALTER TABLE "channel_oauth_attempts" ALTER COLUMN "adopted_draft_revision" TYPE BIGINT;

-- The additive lineage used an identity column; canonical is a sequence default.
DO $channel_setup_evidence_sequence$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'channel_setup_evidence'::regclass
      AND attname = 'sequence'
      AND attidentity <> ''
  ) THEN
    ALTER TABLE "channel_setup_evidence" ALTER COLUMN "sequence" DROP IDENTITY;
    CREATE SEQUENCE "channel_setup_evidence_sequence_seq" OWNED BY "channel_setup_evidence"."sequence";
    ALTER TABLE "channel_setup_evidence" ALTER COLUMN "sequence" SET DEFAULT nextval('channel_setup_evidence_sequence_seq'::regclass);
    PERFORM setval(
      'channel_setup_evidence_sequence_seq',
      COALESCE((SELECT max("sequence") FROM "channel_setup_evidence"), 0) + 1,
      false
    );
  END IF;
END
$channel_setup_evidence_sequence$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_channel_setup_evidence_evidence_id_unique" ON "channel_setup_evidence" ("evidence_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_channel_oauth_attempts_state_hash_unique" ON "channel_oauth_attempts" ("state_hash");

-- Preserve the intended descending pagination/time access paths across lineages.
DROP INDEX IF EXISTS idx_channel_setup_evidence_draft;
CREATE INDEX idx_channel_setup_evidence_draft ON channel_setup_evidence(draft_id, sequence DESC);
DROP INDEX IF EXISTS idx_channel_setup_evidence_connection;
CREATE INDEX idx_channel_setup_evidence_connection ON channel_setup_evidence(connection_id, sequence DESC);
DROP INDEX IF EXISTS idx_channel_oauth_attempts_draft;
CREATE INDEX idx_channel_oauth_attempts_draft ON channel_oauth_attempts(draft_id, created_at DESC);
`;
