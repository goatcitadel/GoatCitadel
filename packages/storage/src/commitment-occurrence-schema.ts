import type { DatabaseSync } from "node:sqlite";

const columns = [
  "revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)",
  "creator_receipt_json TEXT",
  "creator_receipt_sha256 TEXT",
  "scheduled_job_id TEXT",
  "scheduled_run_id TEXT",
  "scheduled_material_sha256 TEXT",
];
const frozenFields = [
  "commitment_id",
  "session_id",
  "workspace_id",
  "kind",
  "due_at",
  "dedupe_key",
  "suggested_text",
  "revision",
  "creator_receipt_json",
  "creator_receipt_sha256",
  "scheduled_job_id",
  "scheduled_run_id",
  "scheduled_material_sha256",
];
const shape = `revision > 0
  AND ((creator_receipt_json IS NULL AND creator_receipt_sha256 IS NULL)
    OR (creator_receipt_json IS NOT NULL AND creator_receipt_sha256 IS NOT NULL AND length(creator_receipt_sha256) = 64))
  AND ((scheduled_run_id IS NULL AND scheduled_job_id IS NULL AND scheduled_material_sha256 IS NULL)
    OR (scheduled_run_id IS NOT NULL AND scheduled_job_id IS NOT NULL AND scheduled_material_sha256 IS NOT NULL
      AND length(scheduled_material_sha256) = 64))`;

export function upgradeCommitmentOccurrenceSchema(db: DatabaseSync): void {
  for (const column of columns) db.exec(`ALTER TABLE agent_commitments ADD COLUMN ${column};`);
  db.exec(`
    CREATE UNIQUE INDEX idx_commitment_scheduled_run ON agent_commitments(scheduled_run_id);
    CREATE TRIGGER agent_commitment_shape_insert BEFORE INSERT ON agent_commitments
    WHEN NOT (${shape.replace(/\b(revision|creator_receipt_json|creator_receipt_sha256|scheduled_run_id|scheduled_job_id|scheduled_material_sha256)\b/gu, "NEW.$1")})
    BEGIN SELECT RAISE(ABORT, 'Invalid commitment authority shape'); END;
    CREATE TRIGGER agent_commitment_shape_update BEFORE UPDATE ON agent_commitments
    WHEN NOT (${shape.replace(/\b(revision|creator_receipt_json|creator_receipt_sha256|scheduled_run_id|scheduled_job_id|scheduled_material_sha256)\b/gu, "NEW.$1")})
    BEGIN SELECT RAISE(ABORT, 'Invalid commitment authority shape'); END;
    CREATE TRIGGER agent_commitment_occurrence_bind BEFORE UPDATE ON agent_commitments
    WHEN OLD.scheduled_run_id IS NULL AND NEW.scheduled_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cron_runs r WHERE r.run_id = NEW.scheduled_run_id AND r.job_id = NEW.scheduled_job_id
        AND r.action = 'agent_turn' AND r.status = 'admitting' AND r.scheduled_for = NEW.due_at
        AND json_extract(r.action_snapshot_json, '$.actionConfig.agentTurn.commitment.commitmentId') = NEW.commitment_id
        AND json_extract(r.action_snapshot_json, '$.actionConfig.agentTurn.commitment.revision') = NEW.revision
        AND json_extract(r.action_snapshot_json, '$.actionConfig.agentTurn.commitment.materialSha256') = NEW.scheduled_material_sha256)
    BEGIN SELECT RAISE(ABORT, 'Commitment requires exact canonical occurrence'); END;
    CREATE TRIGGER agent_commitment_frozen BEFORE UPDATE ON agent_commitments
    WHEN OLD.scheduled_run_id IS NOT NULL AND (${frozenFields.map((field) => `NEW.${field} IS NOT OLD.${field}`).join(" OR ")})
    BEGIN SELECT RAISE(ABORT, 'Scheduled commitment material is immutable'); END;
    CREATE TRIGGER agent_commitment_frozen_delete BEFORE DELETE ON agent_commitments
    WHEN OLD.scheduled_run_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Scheduled commitment cannot be deleted'); END;
  `);
}

export const COMMITMENT_OCCURRENCE_POSTGRES_SQL = `
  ${columns.map((column) => `ALTER TABLE agent_commitments ADD COLUMN IF NOT EXISTS ${column};`).join("\n")}
  CREATE UNIQUE INDEX IF NOT EXISTS idx_commitment_scheduled_run ON agent_commitments(scheduled_run_id);
  ALTER TABLE agent_commitments DROP CONSTRAINT IF EXISTS gc_commitment_authority_shape;
  ALTER TABLE agent_commitments ADD CONSTRAINT gc_commitment_authority_shape CHECK (${shape});
  CREATE OR REPLACE FUNCTION gc_commitment_frozen() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'UPDATE' AND OLD.scheduled_run_id IS NULL AND NEW.scheduled_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cron_runs r WHERE r.run_id = NEW.scheduled_run_id AND r.job_id = NEW.scheduled_job_id
        AND r.action = 'agent_turn' AND r.status = 'admitting' AND r.scheduled_for = NEW.due_at
        AND r.action_snapshot_json::jsonb #>> '{actionConfig,agentTurn,commitment,commitmentId}' = NEW.commitment_id
        AND (r.action_snapshot_json::jsonb #>> '{actionConfig,agentTurn,commitment,revision}')::bigint = NEW.revision
        AND r.action_snapshot_json::jsonb #>> '{actionConfig,agentTurn,commitment,materialSha256}' = NEW.scheduled_material_sha256) THEN
      RAISE EXCEPTION 'Commitment requires exact canonical occurrence' USING ERRCODE = '23514';
    END IF;
    IF OLD.scheduled_run_id IS NOT NULL THEN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Scheduled commitment cannot be deleted' USING ERRCODE = '23514'; END IF;
      IF ${frozenFields.map((field) => `NEW.${field} IS DISTINCT FROM OLD.${field}`).join(" OR ")} THEN
        RAISE EXCEPTION 'Scheduled commitment material is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS agent_commitment_frozen ON agent_commitments;
  CREATE TRIGGER agent_commitment_frozen BEFORE UPDATE OR DELETE ON agent_commitments
    FOR EACH ROW EXECUTE FUNCTION gc_commitment_frozen();
`;
