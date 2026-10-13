import type { DatabaseSync } from "node:sqlite";

const legacyOwner = `
  SELECT 1 FROM chat_turn_capability_profiles profile
  JOIN chat_turn_capability_profile_incarnation_bindings profile_binding
    ON profile_binding.profile_id = profile.profile_id AND profile_binding.turn_id = profile.turn_id
  JOIN chat_turn_session_incarnation_bindings binding ON binding.turn_id = profile.turn_id
  JOIN chat_session_mutation_admissions admission ON admission.admission_id = binding.admission_id
  WHERE profile.profile_id = NEW.capability_profile_id AND profile.profile_hash = NEW.capability_profile_hash
    AND profile.turn_id = NEW.turn_id AND profile.session_id = NEW.session_id AND profile.workspace_id = NEW.workspace_id
    AND profile_binding.profile_hash = NEW.capability_profile_hash
    AND binding.session_id = NEW.session_id AND binding.workspace_id = NEW.workspace_id
    AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
    AND admission.turn_id = NEW.turn_id AND admission.workspace_id = binding.workspace_id
    AND admission.session_id = binding.session_id AND admission.session_incarnation_id = binding.session_incarnation_id`;

const admissionOwner = `
  SELECT 1 FROM chat_turn_session_incarnation_bindings binding
  JOIN chat_session_mutation_admissions admission ON admission.admission_id = binding.admission_id
  WHERE binding.turn_id = NEW.turn_id AND binding.admission_id = NEW.admission_id
    AND binding.session_id = NEW.session_id AND binding.workspace_id = NEW.workspace_id
    AND binding.session_incarnation_id = NEW.session_incarnation_id
    AND admission.admission_id = NEW.admission_id AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
    AND admission.turn_id = NEW.turn_id AND admission.session_id = NEW.session_id AND admission.workspace_id = NEW.workspace_id
    AND admission.session_incarnation_id = NEW.session_incarnation_id
    AND admission.material_sha256 = NEW.admission_material_sha256
    AND admission.aggregate_revision = NEW.admission_aggregate_revision
    AND admission.controller_generation = NEW.admission_controller_generation`;

const authorityUnion = `
  (schema_version IN ('chat.routed-context-snapshot.v1', 'chat.routed-context-snapshot.v2')
    AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL
    AND admission_id IS NULL AND session_incarnation_id IS NULL AND admission_material_sha256 IS NULL
    AND admission_aggregate_revision IS NULL AND admission_controller_generation IS NULL)
  OR (schema_version = 'chat.routed-context-snapshot.v3'
    AND capability_profile_id IS NULL AND capability_profile_hash IS NULL
    AND admission_id IS NOT NULL AND session_incarnation_id IS NOT NULL AND admission_material_sha256 IS NOT NULL
    AND admission_aggregate_revision IS NOT NULL AND admission_controller_generation IS NOT NULL)`;

const columns = `snapshot_id, schema_version, turn_id, session_id, workspace_id, capability_profile_id,
  capability_profile_hash, source_request_hash, content_hash, snapshot_hash, effective_provider_id,
  effective_model, context_window_tokens, prompt_reserved_tokens, output_reserved_tokens, hard_cap_tokens,
  effective_budget_tokens, used_tokens, source_count, included_count, truncated_count, omitted_count,
  already_attached_count, estimator_version, budget_policy_version, snapshot_json, created_at`;

/** Append-only migration: the old JSON and hashes are copied without decoding or resealing. */
export function upgradeChatRoutedContextAdmissionSchema(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_chat_routed_context_snapshots_no_update;
    DROP TRIGGER IF EXISTS trg_chat_routed_context_snapshots_no_delete;
    DROP TRIGGER IF EXISTS trg_chat_routed_context_snapshots_incarnation_insert_guard;
    CREATE TABLE chat_routed_context_snapshots_v3 (
      snapshot_id TEXT PRIMARY KEY CHECK(length(TRIM(snapshot_id)) BETWEEN 1 AND 256),
      schema_version TEXT NOT NULL,
      turn_id TEXT NOT NULL UNIQUE CHECK(length(TRIM(turn_id)) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(TRIM(session_id)) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 80),
      capability_profile_id TEXT UNIQUE CHECK(length(TRIM(capability_profile_id)) BETWEEN 1 AND 256),
      capability_profile_hash TEXT CHECK(length(capability_profile_hash) = 64 AND capability_profile_hash NOT GLOB '*[^0-9a-f]*'),
      source_request_hash TEXT NOT NULL CHECK(length(source_request_hash) = 64 AND source_request_hash NOT GLOB '*[^0-9a-f]*'),
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
      snapshot_hash TEXT NOT NULL UNIQUE CHECK(length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
      effective_provider_id TEXT NOT NULL CHECK(length(TRIM(effective_provider_id)) BETWEEN 1 AND 128),
      effective_model TEXT NOT NULL CHECK(length(TRIM(effective_model)) BETWEEN 1 AND 256),
      context_window_tokens INTEGER NOT NULL CHECK(context_window_tokens > 0),
      prompt_reserved_tokens INTEGER NOT NULL CHECK(prompt_reserved_tokens >= 0),
      output_reserved_tokens INTEGER NOT NULL CHECK(output_reserved_tokens > 0),
      hard_cap_tokens INTEGER NOT NULL CHECK(hard_cap_tokens > 0),
      effective_budget_tokens INTEGER NOT NULL CHECK(effective_budget_tokens >= 0 AND effective_budget_tokens <= hard_cap_tokens),
      used_tokens INTEGER NOT NULL CHECK(used_tokens >= 0 AND used_tokens <= effective_budget_tokens),
      source_count INTEGER NOT NULL CHECK(source_count BETWEEN 0 AND 16),
      included_count INTEGER NOT NULL CHECK(included_count >= 0),
      truncated_count INTEGER NOT NULL CHECK(truncated_count >= 0),
      omitted_count INTEGER NOT NULL CHECK(omitted_count >= 0),
      already_attached_count INTEGER NOT NULL CHECK(already_attached_count >= 0),
      estimator_version TEXT NOT NULL CHECK(estimator_version = 'gc-approx-tokens.v1'),
      budget_policy_version TEXT NOT NULL CHECK(budget_policy_version = 'chat.routed-context-budget.v1'),
      snapshot_json TEXT NOT NULL CHECK(length(CAST(snapshot_json AS BLOB)) <= 1048576),
      created_at TEXT NOT NULL,
      admission_id TEXT UNIQUE CHECK(length(TRIM(admission_id)) BETWEEN 1 AND 256),
      session_incarnation_id TEXT CHECK(length(TRIM(session_incarnation_id)) BETWEEN 1 AND 256),
      admission_material_sha256 TEXT CHECK(length(admission_material_sha256) = 64 AND admission_material_sha256 NOT GLOB '*[^0-9a-f]*'),
      admission_aggregate_revision INTEGER CHECK(typeof(admission_aggregate_revision) = 'integer' AND admission_aggregate_revision > 0 OR admission_aggregate_revision IS NULL),
      admission_controller_generation INTEGER CHECK(typeof(admission_controller_generation) = 'integer' AND admission_controller_generation > 0 OR admission_controller_generation IS NULL),
      CHECK(${authorityUnion}),
      CHECK(prompt_reserved_tokens + output_reserved_tokens <= context_window_tokens),
      CHECK(used_tokens + prompt_reserved_tokens + output_reserved_tokens <= context_window_tokens),
      CHECK(included_count + truncated_count + omitted_count + already_attached_count = source_count)
    );
    INSERT INTO chat_routed_context_snapshots_v3 (${columns}) SELECT ${columns} FROM chat_routed_context_snapshots;
    DROP TABLE chat_routed_context_snapshots;
    ALTER TABLE chat_routed_context_snapshots_v3 RENAME TO chat_routed_context_snapshots;
    CREATE INDEX idx_chat_routed_context_snapshots_session_created ON chat_routed_context_snapshots(session_id, created_at, snapshot_id);
    CREATE INDEX idx_chat_routed_context_snapshots_workspace_created ON chat_routed_context_snapshots(workspace_id, created_at, snapshot_id);
    CREATE TRIGGER trg_chat_routed_context_snapshots_no_update BEFORE UPDATE ON chat_routed_context_snapshots
      BEGIN SELECT RAISE(ABORT, 'chat routed context snapshots are immutable'); END;
    CREATE TRIGGER trg_chat_routed_context_snapshots_no_delete BEFORE DELETE ON chat_routed_context_snapshots
      BEGIN SELECT RAISE(ABORT, 'chat routed context snapshots are immutable'); END;
    CREATE TRIGGER trg_chat_routed_context_snapshots_incarnation_insert_guard BEFORE INSERT ON chat_routed_context_snapshots
      WHEN (NEW.schema_version = 'chat.routed-context-snapshot.v3' AND NOT EXISTS (${admissionOwner}))
        OR (NEW.schema_version <> 'chat.routed-context-snapshot.v3' AND NOT EXISTS (${legacyOwner}))
      BEGIN SELECT RAISE(ABORT, 'chat routed context snapshot requires exact incarnation-bound authority'); END;
  `);
}

export const CHAT_ROUTED_CONTEXT_ADMISSION_POSTGRES_SQL = `
  ALTER TABLE chat_routed_context_snapshots
    ALTER COLUMN capability_profile_id DROP NOT NULL,
    ALTER COLUMN capability_profile_hash DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS admission_id TEXT UNIQUE CHECK(length(TRIM(admission_id)) BETWEEN 1 AND 256),
    ADD COLUMN IF NOT EXISTS session_incarnation_id TEXT CHECK(length(TRIM(session_incarnation_id)) BETWEEN 1 AND 256),
    ADD COLUMN IF NOT EXISTS admission_material_sha256 TEXT CHECK(admission_material_sha256 ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS admission_aggregate_revision BIGINT CHECK(admission_aggregate_revision > 0),
    ADD COLUMN IF NOT EXISTS admission_controller_generation BIGINT CHECK(admission_controller_generation > 0);
  DO $context_admission$
  DECLARE constraint_name TEXT;
  BEGIN
    FOR constraint_name IN SELECT conname FROM pg_constraint
      WHERE conrelid = 'chat_routed_context_snapshots'::regclass
        AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%schema_version%'
    LOOP
      EXECUTE format('ALTER TABLE chat_routed_context_snapshots DROP CONSTRAINT %I', constraint_name);
    END LOOP;
  END
  $context_admission$;
  ALTER TABLE chat_routed_context_snapshots ADD CONSTRAINT chat_routed_context_snapshot_authority_v3 CHECK(${authorityUnion});
  CREATE OR REPLACE FUNCTION gc_chat_routed_context_snapshot_incarnation_guard() RETURNS trigger AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.session_id, 411));
    IF (NEW.schema_version = 'chat.routed-context-snapshot.v3' AND NOT EXISTS (${admissionOwner}))
      OR (NEW.schema_version <> 'chat.routed-context-snapshot.v3' AND NOT EXISTS (${legacyOwner})) THEN
      RAISE EXCEPTION 'chat routed context snapshot requires exact incarnation-bound authority' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;
