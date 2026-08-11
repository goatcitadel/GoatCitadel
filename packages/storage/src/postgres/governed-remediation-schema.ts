/**
 * PostgreSQL 134, paired with SQLite 191. This string is migration-owned and
 * immutable after release; later corrections must use a new forward pair.
 */
export const GOVERNED_REMEDIATION_POSTGRES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS governed_remediation_states (
    schema_version TEXT NOT NULL,
    remediation_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    durable_run_id TEXT NOT NULL,
    blocked_checkpoint_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL,
    recipe_version BIGINT NOT NULL,
    deployment_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    state TEXT NOT NULL,
    revision BIGINT NOT NULL,
    expected_waiting_run_version BIGINT NOT NULL,
    expected_owner_revision TEXT,
    prompt_id TEXT,
    prompt_expires_at TEXT,
    approval_id TEXT,
    effect_id TEXT,
    latest_receipt_id TEXT,
    failure_id TEXT,
    reconciliation_id TEXT,
    create_idempotency_key TEXT NOT NULL,
    create_request_sha256 TEXT NOT NULL,
    last_transition_idempotency_key TEXT,
    last_transition_request_sha256 TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_governed_remediation_states_owner_scope
    ON governed_remediation_states(
      owner_id, deployment_id, scope_kind, scope_id, target_id, updated_at, remediation_id
    );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_states_workspace_session
    ON governed_remediation_states(workspace_id, session_id, updated_at, remediation_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_states_recovery
    ON governed_remediation_states(state, updated_at, remediation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_states_create_idempotency_key_unique
    ON governed_remediation_states(create_idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_receipts (
    schema_version TEXT NOT NULL,
    receipt_id TEXT PRIMARY KEY,
    remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
    recipe_id TEXT NOT NULL,
    recipe_version BIGINT NOT NULL,
    deployment_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    application_owner_id TEXT,
    effect_id TEXT,
    owner_revision_before TEXT,
    owner_revision_after TEXT,
    application_receipt_id TEXT REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,
    probe_id TEXT,
    probe_result TEXT,
    owner_revision_observed TEXT,
    rollback_strategy TEXT,
    rollback_outcome TEXT,
    verification_receipt_id TEXT REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,
    durable_run_id TEXT,
    blocked_checkpoint_id TEXT,
    resumed_run_version BIGINT,
    reconciliation_id TEXT,
    failure_id TEXT,
    resolution TEXT,
    idempotency_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_governed_remediation_receipts_remediation
    ON governed_remediation_receipts(remediation_id, recorded_at, receipt_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_receipts_scope
    ON governed_remediation_receipts(deployment_id, scope_kind, scope_id, target_id, recorded_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_receipts_idempotency_key_unique
    ON governed_remediation_receipts(idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_failures (
    schema_version TEXT NOT NULL,
    failure_id TEXT PRIMARY KEY,
    remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
    recipe_id TEXT NOT NULL,
    recipe_version BIGINT NOT NULL,
    deployment_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    reason TEXT NOT NULL,
    effect_boundary TEXT NOT NULL,
    disposition TEXT NOT NULL,
    owner_revision_observed TEXT,
    idempotency_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_governed_remediation_failures_remediation
    ON governed_remediation_failures(remediation_id, occurred_at, failure_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_failures_scope
    ON governed_remediation_failures(deployment_id, scope_kind, scope_id, target_id, occurred_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_failures_idempotency_key_unique
    ON governed_remediation_failures(idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_reconciliations (
    schema_version TEXT NOT NULL,
    reconciliation_id TEXT PRIMARY KEY,
    remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
    failure_id TEXT NOT NULL REFERENCES governed_remediation_failures(failure_id) ON DELETE RESTRICT,
    recipe_id TEXT NOT NULL,
    recipe_version BIGINT NOT NULL,
    deployment_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    observation TEXT NOT NULL,
    state TEXT NOT NULL,
    owner_revision_observed TEXT,
    resolution_receipt_id TEXT,
    revision BIGINT NOT NULL,
    create_idempotency_key TEXT NOT NULL,
    create_request_sha256 TEXT NOT NULL,
    last_transition_idempotency_key TEXT,
    last_transition_request_sha256 TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_remediation
    ON governed_remediation_reconciliations(remediation_id, updated_at, reconciliation_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_scope_state
    ON governed_remediation_reconciliations(
      deployment_id, scope_kind, scope_id, target_id, state, updated_at, reconciliation_id
    );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_recovery
    ON governed_remediation_reconciliations(state, updated_at, reconciliation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_create_id_7f8736b32182
    ON governed_remediation_reconciliations(create_idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_cas_transitions (
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    expected_revision BIGINT NOT NULL,
    resulting_revision BIGINT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY(aggregate_kind, aggregate_id, resulting_revision)
  );

  CREATE INDEX IF NOT EXISTS idx_governed_remediation_cas_transitions_aggregate
    ON governed_remediation_cas_transitions(aggregate_kind, aggregate_id, resulting_revision);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_cas_transitions_aggregate_ea4ba9085bb1
    ON governed_remediation_cas_transitions(aggregate_kind, idempotency_key);

  ALTER TABLE governed_remediation_states
    DROP CONSTRAINT IF EXISTS governed_remediation_states_contract_check,
    DROP CONSTRAINT IF EXISTS governed_remediation_states_lifecycle_check,
    DROP CONSTRAINT IF EXISTS governed_remediation_states_transition_marker_check;
  ALTER TABLE governed_remediation_states
    ADD CONSTRAINT governed_remediation_states_contract_check CHECK(
      schema_version = 'goatcitadel.governed-remediation-state.v1'
      AND length(btrim(remediation_id)) BETWEEN 1 AND 256
      AND length(btrim(owner_id)) BETWEEN 1 AND 256
      AND length(btrim(workspace_id)) BETWEEN 1 AND 256
      AND length(btrim(session_id)) BETWEEN 1 AND 256
      AND length(btrim(source_turn_id)) BETWEEN 1 AND 256
      AND length(btrim(durable_run_id)) BETWEEN 1 AND 256
      AND length(btrim(blocked_checkpoint_id)) BETWEEN 1 AND 256
      AND length(btrim(recipe_id)) BETWEEN 1 AND 256
      AND recipe_version >= 1
      AND length(btrim(deployment_id)) BETWEEN 1 AND 256
      AND scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')
      AND length(btrim(scope_id)) BETWEEN 1 AND 256
      AND length(btrim(target_id)) BETWEEN 1 AND 256
      AND state IN (
        'blocked', 'offered', 'awaiting_preapproval', 'awaiting_secure_input', 'applying', 'verifying',
        'credential_verified', 'awaiting_activation_approval', 'activating', 'verified', 'resuming',
        'completed', 'declined', 'expired', 'manual_required', 'failed', 'rolling_back', 'rolled_back',
        'rollback_failed'
      )
      AND revision >= 1
      AND expected_waiting_run_version >= 1
      AND (expected_owner_revision IS NULL OR length(btrim(expected_owner_revision)) BETWEEN 1 AND 512)
      AND (prompt_id IS NULL OR length(btrim(prompt_id)) BETWEEN 1 AND 256)
      AND (prompt_expires_at IS NULL OR gc_try_parse_timestamptz(prompt_expires_at) IS NOT NULL)
      AND (approval_id IS NULL OR length(btrim(approval_id)) BETWEEN 1 AND 256)
      AND (effect_id IS NULL OR length(btrim(effect_id)) BETWEEN 1 AND 256)
      AND (latest_receipt_id IS NULL OR length(btrim(latest_receipt_id)) BETWEEN 1 AND 256)
      AND (failure_id IS NULL OR length(btrim(failure_id)) BETWEEN 1 AND 256)
      AND (reconciliation_id IS NULL OR length(btrim(reconciliation_id)) BETWEEN 1 AND 256)
      AND length(btrim(create_idempotency_key)) BETWEEN 1 AND 512
      AND create_request_sha256 ~ '^[0-9a-f]{64}$'
      AND gc_try_parse_timestamptz(created_at) IS NOT NULL
      AND gc_try_parse_timestamptz(updated_at) IS NOT NULL
      AND gc_try_parse_timestamptz(updated_at) >= gc_try_parse_timestamptz(created_at)
    ),
    ADD CONSTRAINT governed_remediation_states_lifecycle_check CHECK(
      (prompt_id IS NULL) = (prompt_expires_at IS NULL)
      AND (state <> 'awaiting_secure_input' OR prompt_id IS NOT NULL)
      AND (state NOT IN ('failed', 'rollback_failed') OR failure_id IS NOT NULL)
      AND (state <> 'rollback_failed' OR reconciliation_id IS NOT NULL)
      AND (state NOT IN ('completed', 'rolled_back') OR latest_receipt_id IS NOT NULL)
    ),
    ADD CONSTRAINT governed_remediation_states_transition_marker_check CHECK(
      (last_transition_idempotency_key IS NULL AND last_transition_request_sha256 IS NULL AND revision = 1)
      OR (
        last_transition_idempotency_key IS NOT NULL
        AND length(btrim(last_transition_idempotency_key)) BETWEEN 1 AND 512
        AND last_transition_request_sha256 IS NOT NULL
        AND last_transition_request_sha256 ~ '^[0-9a-f]{64}$'
        AND revision > 1
      )
    );

  ALTER TABLE governed_remediation_receipts
    DROP CONSTRAINT IF EXISTS governed_remediation_receipts_contract_check,
    DROP CONSTRAINT IF EXISTS governed_remediation_receipts_variant_check;
  ALTER TABLE governed_remediation_receipts
    ADD CONSTRAINT governed_remediation_receipts_contract_check CHECK(
      schema_version = 'goatcitadel.governed-remediation-receipt.v1'
      AND length(btrim(receipt_id)) BETWEEN 1 AND 256
      AND length(btrim(remediation_id)) BETWEEN 1 AND 256
      AND length(btrim(recipe_id)) BETWEEN 1 AND 256
      AND recipe_version >= 1
      AND length(btrim(deployment_id)) BETWEEN 1 AND 256
      AND scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')
      AND length(btrim(scope_id)) BETWEEN 1 AND 256
      AND length(btrim(target_id)) BETWEEN 1 AND 256
      AND kind IN ('application', 'verification', 'rollback', 'resume', 'reconciliation')
      AND (application_owner_id IS NULL OR length(btrim(application_owner_id)) BETWEEN 1 AND 256)
      AND (effect_id IS NULL OR length(btrim(effect_id)) BETWEEN 1 AND 256)
      AND (owner_revision_before IS NULL OR length(btrim(owner_revision_before)) BETWEEN 1 AND 512)
      AND (owner_revision_after IS NULL OR length(btrim(owner_revision_after)) BETWEEN 1 AND 512)
      AND (application_receipt_id IS NULL OR length(btrim(application_receipt_id)) BETWEEN 1 AND 256)
      AND (probe_id IS NULL OR length(btrim(probe_id)) BETWEEN 1 AND 256)
      AND (owner_revision_observed IS NULL OR length(btrim(owner_revision_observed)) BETWEEN 1 AND 512)
      AND (verification_receipt_id IS NULL OR length(btrim(verification_receipt_id)) BETWEEN 1 AND 256)
      AND (durable_run_id IS NULL OR length(btrim(durable_run_id)) BETWEEN 1 AND 256)
      AND (blocked_checkpoint_id IS NULL OR length(btrim(blocked_checkpoint_id)) BETWEEN 1 AND 256)
      AND (reconciliation_id IS NULL OR length(btrim(reconciliation_id)) BETWEEN 1 AND 256)
      AND (failure_id IS NULL OR length(btrim(failure_id)) BETWEEN 1 AND 256)
      AND length(btrim(idempotency_key)) BETWEEN 1 AND 512
      AND request_sha256 ~ '^[0-9a-f]{64}$'
      AND gc_try_parse_timestamptz(recorded_at) IS NOT NULL
    ),
    ADD CONSTRAINT governed_remediation_receipts_variant_check CHECK(
      (kind = 'application'
        AND application_owner_id IS NOT NULL AND effect_id IS NOT NULL AND owner_revision_after IS NOT NULL
        AND application_receipt_id IS NULL AND probe_id IS NULL AND probe_result IS NULL
        AND owner_revision_observed IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
        AND verification_receipt_id IS NULL AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL
        AND resumed_run_version IS NULL AND reconciliation_id IS NULL AND failure_id IS NULL AND resolution IS NULL)
      OR
      (kind = 'verification'
        AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL
        AND owner_revision_after IS NULL AND application_receipt_id IS NOT NULL AND probe_id IS NOT NULL
        AND probe_result = 'accepted' AND owner_revision_observed IS NOT NULL AND rollback_strategy IS NULL
        AND rollback_outcome IS NULL AND verification_receipt_id IS NULL AND durable_run_id IS NULL
        AND blocked_checkpoint_id IS NULL AND resumed_run_version IS NULL AND reconciliation_id IS NULL
        AND failure_id IS NULL AND resolution IS NULL)
      OR
      (kind = 'rollback'
        AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL
        AND owner_revision_after IS NOT NULL AND application_receipt_id IS NOT NULL AND probe_id IS NULL
        AND probe_result IS NULL AND owner_revision_observed IS NULL
        AND rollback_strategy IN ('restore_previous', 'remove_candidate', 'transactional', 'safe_stop')
        AND rollback_outcome = 'rolled_back' AND verification_receipt_id IS NULL AND durable_run_id IS NULL
        AND blocked_checkpoint_id IS NULL AND resumed_run_version IS NULL AND reconciliation_id IS NULL
        AND failure_id IS NULL AND resolution IS NULL)
      OR
      (kind = 'resume'
        AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL
        AND owner_revision_after IS NULL AND application_receipt_id IS NULL AND probe_id IS NULL
        AND probe_result IS NULL AND owner_revision_observed IS NULL AND rollback_strategy IS NULL
        AND rollback_outcome IS NULL AND verification_receipt_id IS NOT NULL AND durable_run_id IS NOT NULL
        AND blocked_checkpoint_id IS NOT NULL AND resumed_run_version >= 1
        AND reconciliation_id IS NULL AND failure_id IS NULL AND resolution IS NULL)
      OR
      (kind = 'reconciliation'
        AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL
        AND owner_revision_after IS NULL AND application_receipt_id IS NULL AND probe_id IS NULL
        AND probe_result IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
        AND verification_receipt_id IS NULL AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL
        AND resumed_run_version IS NULL AND reconciliation_id IS NOT NULL AND failure_id IS NOT NULL
        AND resolution IN ('confirmed_no_effect', 'confirmed_rolled_back', 'confirmed_verified'))
    );

  ALTER TABLE governed_remediation_failures
    DROP CONSTRAINT IF EXISTS governed_remediation_failures_contract_check,
    DROP CONSTRAINT IF EXISTS governed_remediation_failures_semantics_check;
  ALTER TABLE governed_remediation_failures
    ADD CONSTRAINT governed_remediation_failures_contract_check CHECK(
      schema_version = 'goatcitadel.governed-remediation-failure.v1'
      AND length(btrim(failure_id)) BETWEEN 1 AND 256
      AND length(btrim(remediation_id)) BETWEEN 1 AND 256
      AND length(btrim(recipe_id)) BETWEEN 1 AND 256
      AND recipe_version >= 1
      AND length(btrim(deployment_id)) BETWEEN 1 AND 256
      AND scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')
      AND length(btrim(scope_id)) BETWEEN 1 AND 256
      AND length(btrim(target_id)) BETWEEN 1 AND 256
      AND phase IN (
        'classification', 'offer', 'preapproval', 'secure_input', 'preflight', 'apply', 'verify',
        'activation', 'rollback', 'resume', 'recovery'
      )
      AND reason IN (
        'precondition_drift', 'policy_denied', 'approval_missing_or_expired', 'prompt_expired',
        'secure_store_unavailable', 'credential_rejected', 'insufficient_scope', 'rate_limited',
        'owner_unavailable', 'invalid_candidate', 'provenance_invalid', 'owner_revision_conflict',
        'unsupported_profile', 'unowned_target', 'verification_failed', 'rollback_failed', 'resume_failed',
        'internal_error'
      )
      AND effect_boundary IN ('not_crossed', 'crossed', 'unknown')
      AND disposition IN (
        'retry_with_fresh_authority', 'rollback_required', 'manual_required', 'terminal_no_effect'
      )
      AND (owner_revision_observed IS NULL OR length(btrim(owner_revision_observed)) BETWEEN 1 AND 512)
      AND length(btrim(idempotency_key)) BETWEEN 1 AND 512
      AND request_sha256 ~ '^[0-9a-f]{64}$'
      AND gc_try_parse_timestamptz(occurred_at) IS NOT NULL
    ),
    ADD CONSTRAINT governed_remediation_failures_semantics_check CHECK(
      (effect_boundary = 'not_crossed'
        OR disposition NOT IN ('retry_with_fresh_authority', 'terminal_no_effect'))
      AND (disposition <> 'rollback_required' OR effect_boundary <> 'not_crossed')
      AND (reason <> 'rollback_failed' OR (effect_boundary <> 'not_crossed' AND disposition = 'manual_required'))
      AND (reason NOT IN ('unsupported_profile', 'unowned_target')
        OR (effect_boundary = 'not_crossed' AND disposition = 'manual_required'))
    );

  ALTER TABLE governed_remediation_reconciliations
    DROP CONSTRAINT IF EXISTS governed_remediation_reconciliations_contract_check,
    DROP CONSTRAINT IF EXISTS governed_remediation_reconciliations_lifecycle_check,
    DROP CONSTRAINT IF EXISTS governed_remediation_reconciliations_transition_marker_check;
  ALTER TABLE governed_remediation_reconciliations
    ADD CONSTRAINT governed_remediation_reconciliations_contract_check CHECK(
      schema_version = 'goatcitadel.governed-remediation-reconciliation.v1'
      AND length(btrim(reconciliation_id)) BETWEEN 1 AND 256
      AND length(btrim(remediation_id)) BETWEEN 1 AND 256
      AND length(btrim(failure_id)) BETWEEN 1 AND 256
      AND length(btrim(recipe_id)) BETWEEN 1 AND 256
      AND recipe_version >= 1
      AND length(btrim(deployment_id)) BETWEEN 1 AND 256
      AND scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')
      AND length(btrim(scope_id)) BETWEEN 1 AND 256
      AND length(btrim(target_id)) BETWEEN 1 AND 256
      AND reason IN (
        'rollback_failed', 'effect_state_unknown', 'owner_revision_drift', 'verification_receipt_missing',
        'resume_receipt_missing'
      )
      AND observation IN ('effect_absent', 'effect_present_unverified', 'effect_verified', 'rolled_back', 'unknown')
      AND state IN (
        'open', 'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'
      )
      AND (owner_revision_observed IS NULL OR length(btrim(owner_revision_observed)) BETWEEN 1 AND 512)
      AND (resolution_receipt_id IS NULL OR length(btrim(resolution_receipt_id)) BETWEEN 1 AND 256)
      AND revision >= 1
      AND length(btrim(create_idempotency_key)) BETWEEN 1 AND 512
      AND create_request_sha256 ~ '^[0-9a-f]{64}$'
      AND gc_try_parse_timestamptz(created_at) IS NOT NULL
      AND gc_try_parse_timestamptz(updated_at) IS NOT NULL
      AND gc_try_parse_timestamptz(updated_at) >= gc_try_parse_timestamptz(created_at)
    ),
    ADD CONSTRAINT governed_remediation_reconciliations_lifecycle_check CHECK(
      ((state IN ('open', 'quarantined', 'manual_required') AND resolution_receipt_id IS NULL)
        OR (state IN ('resolved_no_effect', 'resolved_rolled_back', 'resolved_verified')
          AND resolution_receipt_id IS NOT NULL))
      AND (state <> 'resolved_no_effect' OR observation = 'effect_absent')
      AND (state <> 'resolved_rolled_back' OR observation = 'rolled_back')
      AND (state <> 'resolved_verified' OR observation = 'effect_verified')
    ),
    ADD CONSTRAINT governed_remediation_reconciliations_transition_marker_check CHECK(
      (last_transition_idempotency_key IS NULL AND last_transition_request_sha256 IS NULL AND revision = 1)
      OR (
        last_transition_idempotency_key IS NOT NULL
        AND length(btrim(last_transition_idempotency_key)) BETWEEN 1 AND 512
        AND last_transition_request_sha256 IS NOT NULL
        AND last_transition_request_sha256 ~ '^[0-9a-f]{64}$'
        AND revision > 1
      )
    );

  ALTER TABLE governed_remediation_cas_transitions
    DROP CONSTRAINT IF EXISTS governed_remediation_cas_transitions_contract_check;
  ALTER TABLE governed_remediation_cas_transitions
    ADD CONSTRAINT governed_remediation_cas_transitions_contract_check CHECK(
      aggregate_kind IN ('state', 'reconciliation')
      AND length(btrim(aggregate_id)) BETWEEN 1 AND 256
      AND length(btrim(idempotency_key)) BETWEEN 1 AND 512
      AND request_sha256 ~ '^[0-9a-f]{64}$'
      AND expected_revision >= 1
      AND resulting_revision = expected_revision + 1
      AND length(btrim(from_state)) BETWEEN 1 AND 64
      AND length(btrim(to_state)) BETWEEN 1 AND 64
      AND gc_try_parse_timestamptz(recorded_at) IS NOT NULL
    );

  CREATE OR REPLACE FUNCTION gc_governed_remediation_state_transition_allowed(from_state TEXT, to_state TEXT)
  RETURNS BOOLEAN AS $$
  BEGIN
    RETURN
      (from_state = 'blocked' AND to_state IN ('offered', 'manual_required', 'failed'))
      OR (from_state = 'offered' AND to_state IN (
        'awaiting_preapproval', 'awaiting_secure_input', 'applying', 'declined', 'expired', 'manual_required', 'failed'
      ))
      OR (from_state = 'awaiting_preapproval' AND to_state IN (
        'awaiting_secure_input', 'applying', 'declined', 'expired', 'failed'
      ))
      OR (from_state = 'awaiting_secure_input' AND to_state IN ('applying', 'declined', 'expired', 'failed'))
      OR (from_state = 'applying' AND to_state IN ('verifying', 'rolling_back', 'failed'))
      OR (from_state = 'verifying' AND to_state IN ('credential_verified', 'verified', 'rolling_back'))
      OR (from_state = 'credential_verified' AND to_state IN (
        'awaiting_activation_approval', 'activating', 'verified'
      ))
      OR (from_state = 'awaiting_activation_approval' AND to_state IN (
        'activating', 'declined', 'expired', 'failed'
      ))
      OR (from_state = 'activating' AND to_state IN ('verified', 'rolling_back'))
      OR (from_state = 'verified' AND to_state = 'resuming')
      OR (from_state = 'resuming' AND to_state IN ('completed', 'failed'))
      OR (from_state = 'rolling_back' AND to_state IN ('rolled_back', 'rollback_failed'));
  END;
  $$ LANGUAGE plpgsql IMMUTABLE;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_reconciliation_transition_allowed(
    from_state TEXT,
    to_state TEXT
  ) RETURNS BOOLEAN AS $$
  BEGIN
    RETURN
      (from_state = 'open' AND to_state IN (
        'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'
      ))
      OR (from_state = 'quarantined' AND to_state IN (
        'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'
      ));
  END;
  $$ LANGUAGE plpgsql IMMUTABLE;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_cas_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.aggregate_kind = 'state' THEN
      IF NOT EXISTS (
        SELECT 1 FROM governed_remediation_states current
        WHERE current.remediation_id = NEW.aggregate_id
          AND current.revision = NEW.expected_revision
          AND current.state = NEW.from_state
      ) OR NOT gc_governed_remediation_state_transition_allowed(NEW.from_state, NEW.to_state) THEN
        RAISE EXCEPTION 'governed remediation state CAS admission violated' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.aggregate_kind = 'reconciliation' THEN
      IF NOT EXISTS (
        SELECT 1 FROM governed_remediation_reconciliations current
        WHERE current.reconciliation_id = NEW.aggregate_id
          AND current.revision = NEW.expected_revision
          AND current.state = NEW.from_state
      ) OR NOT gc_governed_remediation_reconciliation_transition_allowed(NEW.from_state, NEW.to_state) THEN
        RAISE EXCEPTION 'governed remediation reconciliation CAS admission violated' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'governed remediation CAS aggregate kind is unsupported' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_state_update_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.remediation_id IS DISTINCT FROM OLD.remediation_id
      OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.session_id IS DISTINCT FROM OLD.session_id
      OR NEW.source_turn_id IS DISTINCT FROM OLD.source_turn_id
      OR NEW.durable_run_id IS DISTINCT FROM OLD.durable_run_id
      OR NEW.blocked_checkpoint_id IS DISTINCT FROM OLD.blocked_checkpoint_id
      OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id
      OR NEW.recipe_version IS DISTINCT FROM OLD.recipe_version
      OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
      OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
      OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
      OR NEW.target_id IS DISTINCT FROM OLD.target_id
      OR NEW.expected_waiting_run_version IS DISTINCT FROM OLD.expected_waiting_run_version
      OR NEW.expected_owner_revision IS DISTINCT FROM OLD.expected_owner_revision
      OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
      OR NEW.create_request_sha256 IS DISTINCT FROM OLD.create_request_sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR gc_try_parse_timestamptz(NEW.updated_at) < gc_try_parse_timestamptz(OLD.updated_at)
      OR NEW.revision <> OLD.revision + 1
      OR NEW.last_transition_idempotency_key IS NULL
      OR NEW.last_transition_request_sha256 IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM governed_remediation_cas_transitions transition_record
        WHERE transition_record.aggregate_kind = 'state'
          AND transition_record.aggregate_id = OLD.remediation_id
          AND transition_record.idempotency_key = NEW.last_transition_idempotency_key
          AND transition_record.request_sha256 = NEW.last_transition_request_sha256
          AND transition_record.expected_revision = OLD.revision
          AND transition_record.resulting_revision = NEW.revision
          AND transition_record.from_state = OLD.state
          AND transition_record.to_state = NEW.state
      ) THEN
      RAISE EXCEPTION 'governed remediation state CAS or immutable binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.latest_receipt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.latest_receipt_id AND receipt.remediation_id = OLD.remediation_id
    ) THEN
      RAISE EXCEPTION 'governed remediation state receipt binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.failure_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_failures failure
      WHERE failure.failure_id = NEW.failure_id AND failure.remediation_id = OLD.remediation_id
    ) THEN
      RAISE EXCEPTION 'governed remediation state failure binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.reconciliation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_reconciliations reconciliation
      WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
        AND reconciliation.remediation_id = OLD.remediation_id
    ) THEN
      RAISE EXCEPTION 'governed remediation state reconciliation binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_state_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.revision <> 1
      OR NEW.last_transition_idempotency_key IS NOT NULL
      OR NEW.last_transition_request_sha256 IS NOT NULL
      OR NEW.latest_receipt_id IS NOT NULL
      OR NEW.failure_id IS NOT NULL
      OR NEW.reconciliation_id IS NOT NULL THEN
      RAISE EXCEPTION 'governed remediation state creation invariant violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_reconciliation_update_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
      OR NEW.remediation_id IS DISTINCT FROM OLD.remediation_id
      OR NEW.failure_id IS DISTINCT FROM OLD.failure_id
      OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id
      OR NEW.recipe_version IS DISTINCT FROM OLD.recipe_version
      OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
      OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
      OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
      OR NEW.target_id IS DISTINCT FROM OLD.target_id
      OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
      OR NEW.create_request_sha256 IS DISTINCT FROM OLD.create_request_sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR gc_try_parse_timestamptz(NEW.updated_at) < gc_try_parse_timestamptz(OLD.updated_at)
      OR NEW.revision <> OLD.revision + 1
      OR NEW.last_transition_idempotency_key IS NULL
      OR NEW.last_transition_request_sha256 IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM governed_remediation_cas_transitions transition_record
        WHERE transition_record.aggregate_kind = 'reconciliation'
          AND transition_record.aggregate_id = OLD.reconciliation_id
          AND transition_record.idempotency_key = NEW.last_transition_idempotency_key
          AND transition_record.request_sha256 = NEW.last_transition_request_sha256
          AND transition_record.expected_revision = OLD.revision
          AND transition_record.resulting_revision = NEW.revision
          AND transition_record.from_state = OLD.state
          AND transition_record.to_state = NEW.state
      ) THEN
      RAISE EXCEPTION 'governed remediation reconciliation CAS or immutable binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.resolution_receipt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.resolution_receipt_id
        AND receipt.remediation_id = OLD.remediation_id
        AND receipt.kind = 'reconciliation'
        AND receipt.reconciliation_id = OLD.reconciliation_id
    ) THEN
      RAISE EXCEPTION 'governed remediation reconciliation receipt binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_receipt_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM governed_remediation_states current
      WHERE current.remediation_id = NEW.remediation_id
        AND current.recipe_id = NEW.recipe_id
        AND current.recipe_version = NEW.recipe_version
        AND current.deployment_id = NEW.deployment_id
        AND current.scope_kind = NEW.scope_kind
        AND current.scope_id = NEW.scope_id
        AND current.target_id = NEW.target_id
        AND (NEW.kind <> 'application' OR current.owner_id = NEW.application_owner_id)
    ) THEN
      RAISE EXCEPTION 'governed remediation receipt owner or scope binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'reconciliation' AND NOT EXISTS (
      SELECT 1
      FROM governed_remediation_reconciliations reconciliation
      JOIN governed_remediation_failures failure ON failure.failure_id = NEW.failure_id
      WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
        AND reconciliation.remediation_id = NEW.remediation_id
        AND reconciliation.failure_id = NEW.failure_id
        AND failure.remediation_id = NEW.remediation_id
    ) THEN
      RAISE EXCEPTION 'governed remediation reconciliation receipt binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_failure_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM governed_remediation_states current
      WHERE current.remediation_id = NEW.remediation_id
        AND current.recipe_id = NEW.recipe_id
        AND current.recipe_version = NEW.recipe_version
        AND current.deployment_id = NEW.deployment_id
        AND current.scope_kind = NEW.scope_kind
        AND current.scope_id = NEW.scope_id
        AND current.target_id = NEW.target_id
    ) THEN
      RAISE EXCEPTION 'governed remediation failure scope binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_reconciliation_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.revision <> 1
      OR NEW.last_transition_idempotency_key IS NOT NULL
      OR NEW.last_transition_request_sha256 IS NOT NULL
      OR NEW.resolution_receipt_id IS NOT NULL
      OR NOT EXISTS (
      SELECT 1
      FROM governed_remediation_states current
      JOIN governed_remediation_failures failure ON failure.failure_id = NEW.failure_id
      WHERE current.remediation_id = NEW.remediation_id
        AND current.recipe_id = NEW.recipe_id
        AND current.recipe_version = NEW.recipe_version
        AND current.deployment_id = NEW.deployment_id
        AND current.scope_kind = NEW.scope_kind
        AND current.scope_id = NEW.scope_id
        AND current.target_id = NEW.target_id
        AND failure.remediation_id = NEW.remediation_id
        AND failure.recipe_id = NEW.recipe_id
        AND failure.recipe_version = NEW.recipe_version
        AND failure.deployment_id = NEW.deployment_id
        AND failure.scope_kind = NEW.scope_kind
        AND failure.scope_id = NEW.scope_id
        AND failure.target_id = NEW.target_id
    ) THEN
      RAISE EXCEPTION 'governed remediation reconciliation failure or scope binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_reject_governed_remediation_mutation() RETURNS TRIGGER AS $$
  BEGIN
    RAISE EXCEPTION 'governed remediation record is immutable' USING ERRCODE = '23514';
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS trg_governed_remediation_cas_transition_insert_guard
    ON governed_remediation_cas_transitions;
  CREATE TRIGGER trg_governed_remediation_cas_transition_insert_guard
    BEFORE INSERT ON governed_remediation_cas_transitions
    FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_cas_insert_guard();
  DROP TRIGGER IF EXISTS trg_governed_remediation_states_update_guard ON governed_remediation_states;
  CREATE TRIGGER trg_governed_remediation_states_update_guard
    BEFORE UPDATE ON governed_remediation_states
    FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_state_update_guard();
  DROP TRIGGER IF EXISTS trg_governed_remediation_states_insert_guard ON governed_remediation_states;
  CREATE TRIGGER trg_governed_remediation_states_insert_guard
    BEFORE INSERT ON governed_remediation_states
    FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_state_insert_guard();
  DROP TRIGGER IF EXISTS trg_governed_remediation_reconciliations_update_guard
    ON governed_remediation_reconciliations;
  CREATE TRIGGER trg_governed_remediation_reconciliations_update_guard
    BEFORE UPDATE ON governed_remediation_reconciliations
    FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_reconciliation_update_guard();
  DROP TRIGGER IF EXISTS trg_governed_remediation_receipts_insert_guard ON governed_remediation_receipts;
  CREATE TRIGGER trg_governed_remediation_receipts_insert_guard
    BEFORE INSERT ON governed_remediation_receipts
    FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_receipt_insert_guard();
  DROP TRIGGER IF EXISTS trg_governed_remediation_failures_insert_guard ON governed_remediation_failures;
  CREATE TRIGGER trg_governed_remediation_failures_insert_guard
    BEFORE INSERT ON governed_remediation_failures
    FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_failure_insert_guard();
  DROP TRIGGER IF EXISTS trg_governed_remediation_reconciliations_insert_guard
    ON governed_remediation_reconciliations;
  CREATE TRIGGER trg_governed_remediation_reconciliations_insert_guard
    BEFORE INSERT ON governed_remediation_reconciliations
    FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_reconciliation_insert_guard();

  DROP TRIGGER IF EXISTS trg_governed_remediation_states_no_delete ON governed_remediation_states;
  CREATE TRIGGER trg_governed_remediation_states_no_delete
    BEFORE DELETE ON governed_remediation_states
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  DROP TRIGGER IF EXISTS trg_governed_remediation_receipts_no_update ON governed_remediation_receipts;
  CREATE TRIGGER trg_governed_remediation_receipts_no_update
    BEFORE UPDATE ON governed_remediation_receipts
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  DROP TRIGGER IF EXISTS trg_governed_remediation_receipts_no_delete ON governed_remediation_receipts;
  CREATE TRIGGER trg_governed_remediation_receipts_no_delete
    BEFORE DELETE ON governed_remediation_receipts
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  DROP TRIGGER IF EXISTS trg_governed_remediation_failures_no_update ON governed_remediation_failures;
  CREATE TRIGGER trg_governed_remediation_failures_no_update
    BEFORE UPDATE ON governed_remediation_failures
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  DROP TRIGGER IF EXISTS trg_governed_remediation_failures_no_delete ON governed_remediation_failures;
  CREATE TRIGGER trg_governed_remediation_failures_no_delete
    BEFORE DELETE ON governed_remediation_failures
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  DROP TRIGGER IF EXISTS trg_governed_remediation_reconciliations_no_delete
    ON governed_remediation_reconciliations;
  CREATE TRIGGER trg_governed_remediation_reconciliations_no_delete
    BEFORE DELETE ON governed_remediation_reconciliations
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  DROP TRIGGER IF EXISTS trg_governed_remediation_cas_transitions_no_update
    ON governed_remediation_cas_transitions;
  CREATE TRIGGER trg_governed_remediation_cas_transitions_no_update
    BEFORE UPDATE ON governed_remediation_cas_transitions
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  DROP TRIGGER IF EXISTS trg_governed_remediation_cas_transitions_no_delete
    ON governed_remediation_cas_transitions;
  CREATE TRIGGER trg_governed_remediation_cas_transitions_no_delete
    BEFORE DELETE ON governed_remediation_cas_transitions
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
`;
