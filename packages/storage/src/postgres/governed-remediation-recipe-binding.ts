/**
 * PostgreSQL 135, paired with SQLite 192. The v134 owner is unreleased and
 * cannot truthfully backfill its missing authority, so non-empty v1 tables are
 * refused before this isolated slice is rebuilt.
 */
export const GOVERNED_REMEDIATION_RECIPE_BINDING_POSTGRES_SQL = `
  DO $governed_remediation_v2$
  BEGIN
    IF EXISTS (SELECT 1 FROM governed_remediation_states LIMIT 1)
      OR EXISTS (SELECT 1 FROM governed_remediation_receipts LIMIT 1)
      OR EXISTS (SELECT 1 FROM governed_remediation_failures LIMIT 1)
      OR EXISTS (SELECT 1 FROM governed_remediation_reconciliations LIMIT 1)
      OR EXISTS (SELECT 1 FROM governed_remediation_cas_transitions LIMIT 1) THEN
      RAISE EXCEPTION
        'PostgreSQL migration 135 refuses non-empty governed-remediation v1 rows because requester, recipe, approval, and rollback authority cannot be reconstructed.'
        USING ERRCODE = '55000';
    END IF;
  END;
  $governed_remediation_v2$;

  ALTER TABLE governed_remediation_states RENAME COLUMN approval_id TO pre_effect_approval_id;
  DROP TABLE governed_remediation_cas_transitions CASCADE;
  DROP TABLE governed_remediation_reconciliations CASCADE;
  DROP TABLE governed_remediation_failures CASCADE;
  DROP TABLE governed_remediation_receipts CASCADE;
  DROP TABLE governed_remediation_states CASCADE;

  CREATE TABLE IF NOT EXISTS governed_remediation_states (
    schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-state.v1'),
    remediation_id TEXT PRIMARY KEY CHECK(length(btrim(remediation_id)) BETWEEN 1 AND 256),
    owner_id TEXT NOT NULL CHECK(length(btrim(owner_id)) BETWEEN 1 AND 256),
    workspace_id TEXT NOT NULL CHECK(length(btrim(workspace_id)) BETWEEN 1 AND 256),
    session_id TEXT NOT NULL CHECK(length(btrim(session_id)) BETWEEN 1 AND 256),
    source_turn_id TEXT NOT NULL CHECK(length(btrim(source_turn_id)) BETWEEN 1 AND 256),
    durable_run_id TEXT NOT NULL CHECK(length(btrim(durable_run_id)) BETWEEN 1 AND 256),
    blocked_checkpoint_id TEXT NOT NULL CHECK(length(btrim(blocked_checkpoint_id)) BETWEEN 1 AND 256),
    requester_actor_id TEXT NOT NULL CHECK(length(btrim(requester_actor_id)) BETWEEN 1 AND 256),
    recipe_id TEXT NOT NULL CHECK(length(btrim(recipe_id)) BETWEEN 1 AND 256),
    recipe_version BIGINT NOT NULL CHECK(recipe_version >= 1),
    recipe_sha256 TEXT NOT NULL CHECK(recipe_sha256 ~ '^[0-9a-f]{64}$'),
    deployment_id TEXT NOT NULL CHECK(length(btrim(deployment_id)) BETWEEN 1 AND 256),
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')),
    scope_id TEXT NOT NULL CHECK(length(btrim(scope_id)) BETWEEN 1 AND 256),
    target_id TEXT NOT NULL CHECK(length(btrim(target_id)) BETWEEN 1 AND 256),
    state TEXT NOT NULL CHECK(state IN (
      'blocked', 'offered', 'awaiting_preapproval', 'awaiting_secure_input', 'applying', 'verifying',
      'credential_verified', 'awaiting_activation_approval', 'activating', 'verified', 'resuming',
      'reconciling_resume', 'completed', 'declined', 'expired', 'manual_required', 'failed',
      'rolling_back', 'rolled_back', 'rollback_failed'
    )),
    revision BIGINT NOT NULL CHECK(revision >= 1),
    expected_waiting_run_version BIGINT NOT NULL CHECK(expected_waiting_run_version >= 1),
    expected_owner_revision TEXT CHECK(
      expected_owner_revision IS NULL OR length(btrim(expected_owner_revision)) BETWEEN 1 AND 512
    ),
    parent_reservation_id TEXT CHECK(
      parent_reservation_id IS NULL OR length(btrim(parent_reservation_id)) BETWEEN 1 AND 256
    ),
    prompt_id TEXT CHECK(prompt_id IS NULL OR length(btrim(prompt_id)) BETWEEN 1 AND 256),
    prompt_expires_at TEXT,
    pre_effect_approval_id TEXT CHECK(
      pre_effect_approval_id IS NULL OR length(btrim(pre_effect_approval_id)) BETWEEN 1 AND 256
    ),
    activation_approval_id TEXT CHECK(
      activation_approval_id IS NULL OR length(btrim(activation_approval_id)) BETWEEN 1 AND 256
    ),
    effect_id TEXT CHECK(effect_id IS NULL OR length(btrim(effect_id)) BETWEEN 1 AND 256),
    latest_receipt_id TEXT CHECK(latest_receipt_id IS NULL OR length(btrim(latest_receipt_id)) BETWEEN 1 AND 256),
    failure_id TEXT CHECK(failure_id IS NULL OR length(btrim(failure_id)) BETWEEN 1 AND 256),
    reconciliation_id TEXT CHECK(reconciliation_id IS NULL OR length(btrim(reconciliation_id)) BETWEEN 1 AND 256),
    create_idempotency_key TEXT NOT NULL CHECK(length(btrim(create_idempotency_key)) BETWEEN 1 AND 512),
    create_request_sha256 TEXT NOT NULL CHECK(create_request_sha256 ~ '^[0-9a-f]{64}$'),
    last_transition_idempotency_key TEXT,
    last_transition_request_sha256 TEXT,
    created_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(updated_at) IS NOT NULL),
    CHECK(gc_try_parse_timestamptz(updated_at) >= gc_try_parse_timestamptz(created_at)),
    CHECK((prompt_id IS NULL) = (prompt_expires_at IS NULL)),
    CHECK(state <> 'awaiting_secure_input' OR prompt_id IS NOT NULL),
    CHECK(state NOT IN ('failed', 'rollback_failed') OR failure_id IS NOT NULL),
    CHECK(state <> 'rollback_failed' OR reconciliation_id IS NOT NULL),
    CHECK(state <> 'reconciling_resume' OR (failure_id IS NOT NULL AND reconciliation_id IS NOT NULL)),
    CHECK(state NOT IN ('completed', 'rolled_back') OR latest_receipt_id IS NOT NULL),
    CHECK((revision = 1 AND last_transition_idempotency_key IS NULL AND last_transition_request_sha256 IS NULL)
      OR (revision > 1 AND length(btrim(last_transition_idempotency_key)) BETWEEN 1 AND 512
        AND last_transition_request_sha256 ~ '^[0-9a-f]{64}$')),
    CHECK(prompt_expires_at IS NULL OR gc_try_parse_timestamptz(prompt_expires_at) IS NOT NULL),
    CONSTRAINT idx_governed_remediation_states_create_idempotency_key_unique UNIQUE(create_idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_states_owner_scope ON governed_remediation_states(
    owner_id, deployment_id, scope_kind, scope_id, target_id, updated_at, remediation_id
  );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_states_workspace_session
    ON governed_remediation_states(workspace_id, session_id, updated_at, remediation_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_states_recovery
    ON governed_remediation_states(state, updated_at, remediation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_states_create_idempotency_key_unique
    ON governed_remediation_states(create_idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_receipts (
    schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-receipt.v1'),
    receipt_id TEXT PRIMARY KEY CHECK(length(btrim(receipt_id)) BETWEEN 1 AND 256),
    remediation_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL CHECK(length(btrim(recipe_id)) BETWEEN 1 AND 256),
    recipe_version BIGINT NOT NULL CHECK(recipe_version >= 1),
    deployment_id TEXT NOT NULL CHECK(length(btrim(deployment_id)) BETWEEN 1 AND 256),
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')),
    scope_id TEXT NOT NULL CHECK(length(btrim(scope_id)) BETWEEN 1 AND 256),
    target_id TEXT NOT NULL CHECK(length(btrim(target_id)) BETWEEN 1 AND 256),
    kind TEXT NOT NULL CHECK(kind IN ('application', 'verification', 'activation', 'rollback', 'resume', 'reconciliation')),
    application_owner_id TEXT,
    effect_id TEXT,
    owner_revision_before TEXT,
    owner_revision_after TEXT,
    application_receipt_id TEXT,
    activation_receipt_id TEXT,
    probe_id TEXT,
    probe_result TEXT,
    owner_revision_observed TEXT,
    rollback_strategy TEXT,
    rollback_outcome TEXT,
    verification_receipt_id TEXT,
    durable_run_id TEXT,
    blocked_checkpoint_id TEXT,
    resumed_run_version BIGINT,
    reconciliation_id TEXT,
    failure_id TEXT,
    resolution TEXT,
    resume_receipt_id TEXT,
    idempotency_key TEXT NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 512),
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(recorded_at) IS NOT NULL),
    CHECK(application_owner_id IS NULL OR length(btrim(application_owner_id)) BETWEEN 1 AND 256),
    CHECK(effect_id IS NULL OR length(btrim(effect_id)) BETWEEN 1 AND 256),
    CHECK(owner_revision_before IS NULL OR length(btrim(owner_revision_before)) BETWEEN 1 AND 512),
    CHECK(owner_revision_after IS NULL OR length(btrim(owner_revision_after)) BETWEEN 1 AND 512),
    CHECK(application_receipt_id IS NULL OR length(btrim(application_receipt_id)) BETWEEN 1 AND 256),
    CHECK(activation_receipt_id IS NULL OR length(btrim(activation_receipt_id)) BETWEEN 1 AND 256),
    CHECK(probe_id IS NULL OR length(btrim(probe_id)) BETWEEN 1 AND 256),
    CHECK(owner_revision_observed IS NULL OR length(btrim(owner_revision_observed)) BETWEEN 1 AND 512),
    CHECK(verification_receipt_id IS NULL OR length(btrim(verification_receipt_id)) BETWEEN 1 AND 256),
    CHECK(durable_run_id IS NULL OR length(btrim(durable_run_id)) BETWEEN 1 AND 256),
    CHECK(blocked_checkpoint_id IS NULL OR length(btrim(blocked_checkpoint_id)) BETWEEN 1 AND 256),
    CHECK(resumed_run_version IS NULL OR resumed_run_version >= 1),
    CHECK(reconciliation_id IS NULL OR length(btrim(reconciliation_id)) BETWEEN 1 AND 256),
    CHECK(failure_id IS NULL OR length(btrim(failure_id)) BETWEEN 1 AND 256),
    CHECK(resume_receipt_id IS NULL OR length(btrim(resume_receipt_id)) BETWEEN 1 AND 256),
    CHECK(kind = 'verification' OR activation_receipt_id IS NULL),
    CHECK(kind = 'reconciliation' OR resume_receipt_id IS NULL),
    CHECK(
      (kind = 'application' AND application_owner_id IS NOT NULL AND effect_id IS NOT NULL
        AND owner_revision_after IS NOT NULL AND application_receipt_id IS NULL AND activation_receipt_id IS NULL
        AND probe_id IS NULL AND probe_result IS NULL AND owner_revision_observed IS NULL
        AND rollback_strategy IS NULL AND rollback_outcome IS NULL AND verification_receipt_id IS NULL
        AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL AND resumed_run_version IS NULL
        AND reconciliation_id IS NULL AND failure_id IS NULL AND resolution IS NULL AND resume_receipt_id IS NULL)
      OR (kind = 'verification' AND application_owner_id IS NULL AND effect_id IS NULL
        AND owner_revision_before IS NULL AND owner_revision_after IS NULL
        AND application_receipt_id IS NOT NULL AND probe_id IS NOT NULL AND probe_result = 'accepted'
        AND owner_revision_observed IS NOT NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
        AND verification_receipt_id IS NULL AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL
        AND resumed_run_version IS NULL AND reconciliation_id IS NULL AND failure_id IS NULL
        AND resolution IS NULL AND resume_receipt_id IS NULL)
      OR (kind = 'activation' AND application_owner_id IS NULL AND effect_id IS NULL
        AND owner_revision_before IS NOT NULL AND owner_revision_after IS NOT NULL
        AND application_receipt_id IS NOT NULL AND activation_receipt_id IS NULL
        AND verification_receipt_id IS NOT NULL AND probe_id IS NULL AND probe_result IS NULL
        AND owner_revision_observed IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
        AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL AND resumed_run_version IS NULL
        AND reconciliation_id IS NULL AND failure_id IS NULL AND resolution IS NULL AND resume_receipt_id IS NULL)
      OR (kind = 'rollback' AND application_owner_id IS NULL AND effect_id IS NULL
        AND owner_revision_before IS NOT NULL AND owner_revision_after IS NOT NULL
        AND application_receipt_id IS NOT NULL AND activation_receipt_id IS NULL
        AND probe_id IS NULL AND probe_result IS NULL AND owner_revision_observed IS NULL
        AND rollback_strategy IN ('restore_previous', 'remove_candidate', 'transactional', 'safe_stop')
        AND rollback_outcome = 'rolled_back' AND verification_receipt_id IS NULL
        AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL AND resumed_run_version IS NULL
        AND reconciliation_id IS NULL AND failure_id IS NULL AND resolution IS NULL AND resume_receipt_id IS NULL)
      OR (kind = 'resume' AND application_owner_id IS NULL AND effect_id IS NULL
        AND owner_revision_before IS NULL AND owner_revision_after IS NULL AND application_receipt_id IS NULL
        AND activation_receipt_id IS NULL AND probe_id IS NULL AND probe_result IS NULL
        AND owner_revision_observed IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
        AND verification_receipt_id IS NOT NULL AND durable_run_id IS NOT NULL
        AND blocked_checkpoint_id IS NOT NULL AND resumed_run_version >= 1
        AND reconciliation_id IS NULL AND failure_id IS NULL AND resolution IS NULL AND resume_receipt_id IS NULL)
      OR (kind = 'reconciliation' AND application_owner_id IS NULL AND effect_id IS NULL
        AND owner_revision_before IS NULL AND owner_revision_after IS NULL AND activation_receipt_id IS NULL
        AND probe_id IS NULL AND probe_result IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
        AND verification_receipt_id IS NULL
        AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL AND resumed_run_version IS NULL
        AND reconciliation_id IS NOT NULL AND failure_id IS NOT NULL
        AND resolution IN ('confirmed_no_effect', 'confirmed_rolled_back', 'confirmed_verified',
          'confirmed_resumed', 'confirmed_not_resumed')
        AND ((resolution IN ('confirmed_verified', 'confirmed_rolled_back')
            AND application_receipt_id IS NOT NULL AND resume_receipt_id IS NULL)
          OR (resolution = 'confirmed_resumed'
            AND application_receipt_id IS NULL AND resume_receipt_id IS NOT NULL)
          OR (resolution IN ('confirmed_no_effect', 'confirmed_not_resumed')
            AND application_receipt_id IS NULL AND resume_receipt_id IS NULL)))
    ),
    CONSTRAINT idx_governed_remediation_receipts_idempotency_key_unique UNIQUE(idempotency_key),
    FOREIGN KEY(resume_receipt_id) REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,
    FOREIGN KEY(verification_receipt_id) REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,
    FOREIGN KEY(activation_receipt_id) REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,
    FOREIGN KEY(application_receipt_id) REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,
    FOREIGN KEY(remediation_id) REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_receipts_remediation
    ON governed_remediation_receipts(remediation_id, recorded_at, receipt_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_receipts_scope
    ON governed_remediation_receipts(deployment_id, scope_kind, scope_id, target_id, recorded_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_receipts_idempotency_key_unique
    ON governed_remediation_receipts(idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_failures (
    schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-failure.v1'),
    failure_id TEXT PRIMARY KEY CHECK(length(btrim(failure_id)) BETWEEN 1 AND 256),
    remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
    recipe_id TEXT NOT NULL, recipe_version BIGINT NOT NULL CHECK(recipe_version >= 1),
    deployment_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, target_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN (
      'classification', 'offer', 'preapproval', 'secure_input', 'preflight', 'apply', 'verify',
      'activation', 'rollback', 'resume', 'recovery'
    )),
    reason TEXT NOT NULL CHECK(reason IN (
      'precondition_drift', 'policy_denied', 'approval_missing_or_expired', 'prompt_expired',
      'secure_store_unavailable', 'credential_rejected', 'insufficient_scope', 'rate_limited',
      'owner_unavailable', 'invalid_candidate', 'provenance_invalid', 'owner_revision_conflict',
      'unsupported_profile', 'unowned_target', 'verification_failed', 'rollback_failed', 'resume_failed',
      'internal_error'
    )),
    effect_boundary TEXT NOT NULL CHECK(effect_boundary IN ('not_crossed', 'crossed', 'unknown')),
    disposition TEXT NOT NULL CHECK(disposition IN (
      'retry_with_fresh_authority', 'rollback_required', 'manual_required', 'terminal_no_effect'
    )),
    owner_revision_observed TEXT,
    idempotency_key TEXT NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 1 AND 512),
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    occurred_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(occurred_at) IS NOT NULL),
    CHECK(effect_boundary = 'not_crossed' OR disposition NOT IN ('retry_with_fresh_authority', 'terminal_no_effect')),
    CHECK(disposition <> 'rollback_required' OR effect_boundary <> 'not_crossed'),
    CHECK(reason <> 'rollback_failed' OR (effect_boundary <> 'not_crossed' AND disposition = 'manual_required')),
    CONSTRAINT idx_governed_remediation_failures_idempotency_key_unique UNIQUE(idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_failures_remediation
    ON governed_remediation_failures(remediation_id, occurred_at, failure_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_failures_scope
    ON governed_remediation_failures(deployment_id, scope_kind, scope_id, target_id, occurred_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_failures_idempotency_key_unique
    ON governed_remediation_failures(idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_reconciliations (
    schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-reconciliation.v1'),
    reconciliation_id TEXT PRIMARY KEY CHECK(length(btrim(reconciliation_id)) BETWEEN 1 AND 256),
    remediation_id TEXT NOT NULL,
    failure_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL, recipe_version BIGINT NOT NULL CHECK(recipe_version >= 1),
    deployment_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, target_id TEXT NOT NULL,
    domain TEXT NOT NULL CHECK(domain IN ('effect', 'resume')),
    reason TEXT NOT NULL CHECK(reason IN (
      'rollback_failed', 'effect_state_unknown', 'owner_revision_drift', 'verification_receipt_missing',
      'resume_receipt_missing'
    )),
    observation TEXT NOT NULL CHECK(observation IN (
      'effect_absent', 'effect_present_unverified', 'effect_verified', 'rolled_back',
      'resume_pending', 'resume_completed', 'resume_not_completed', 'unknown'
    )),
    state TEXT NOT NULL CHECK(state IN (
      'open', 'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified',
      'resolved_resumed', 'resolved_not_resumed', 'manual_required'
    )),
    owner_revision_observed TEXT,
    resolution_receipt_id TEXT,
    revision BIGINT NOT NULL CHECK(revision >= 1),
    create_idempotency_key TEXT NOT NULL,
    create_request_sha256 TEXT NOT NULL CHECK(create_request_sha256 ~ '^[0-9a-f]{64}$'),
    last_transition_idempotency_key TEXT,
    last_transition_request_sha256 TEXT,
    created_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(updated_at) IS NOT NULL),
    CHECK((domain = 'resume') = (reason = 'resume_receipt_missing')),
    CHECK(domain = 'resume' OR observation NOT IN ('resume_pending', 'resume_completed', 'resume_not_completed')),
    CHECK(domain = 'effect' OR observation IN ('resume_pending', 'resume_completed', 'resume_not_completed', 'unknown')),
    CHECK(domain = 'resume' OR state NOT IN ('resolved_resumed', 'resolved_not_resumed')),
    CHECK(domain = 'effect' OR state NOT IN ('resolved_no_effect', 'resolved_rolled_back', 'resolved_verified')),
    CHECK((state IN ('open', 'quarantined', 'manual_required') AND resolution_receipt_id IS NULL)
      OR (state LIKE 'resolved_%' AND resolution_receipt_id IS NOT NULL)),
    CHECK(state <> 'resolved_no_effect' OR observation = 'effect_absent'),
    CHECK(state <> 'resolved_rolled_back' OR observation = 'rolled_back'),
    CHECK(state <> 'resolved_verified' OR observation = 'effect_verified'),
    CHECK(state <> 'resolved_resumed' OR observation = 'resume_completed'),
    CHECK(state <> 'resolved_not_resumed' OR observation = 'resume_not_completed'),
    CHECK((revision = 1 AND last_transition_idempotency_key IS NULL AND last_transition_request_sha256 IS NULL)
      OR (revision > 1 AND last_transition_idempotency_key IS NOT NULL
        AND last_transition_request_sha256 ~ '^[0-9a-f]{64}$')),
    CONSTRAINT idx_governed_remediation_reconciliations_create_id_7f8736b32182
      UNIQUE(create_idempotency_key),
    FOREIGN KEY(failure_id) REFERENCES governed_remediation_failures(failure_id) ON DELETE RESTRICT,
    FOREIGN KEY(remediation_id) REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_remediation
    ON governed_remediation_reconciliations(remediation_id, updated_at, reconciliation_id);
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_scope_state
    ON governed_remediation_reconciliations(
      deployment_id, scope_kind, scope_id, target_id, state, updated_at, reconciliation_id
    );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_recovery
    ON governed_remediation_reconciliations(domain, state, updated_at, reconciliation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_reconciliations_create_id_7f8736b32182
    ON governed_remediation_reconciliations(create_idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_cas_transitions (
    aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('state', 'reconciliation')),
    aggregate_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    expected_revision BIGINT NOT NULL CHECK(expected_revision >= 1),
    resulting_revision BIGINT NOT NULL CHECK(resulting_revision = expected_revision + 1),
    from_state TEXT NOT NULL, to_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(recorded_at) IS NOT NULL),
    PRIMARY KEY(aggregate_kind, aggregate_id, resulting_revision),
    CONSTRAINT idx_governed_remediation_cas_transitions_aggregate_ea4ba9085bb1
      UNIQUE(aggregate_kind, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_cas_transitions_aggregate
    ON governed_remediation_cas_transitions(aggregate_kind, aggregate_id, resulting_revision);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_cas_transitions_aggregate_ea4ba9085bb1
    ON governed_remediation_cas_transitions(aggregate_kind, idempotency_key);

  CREATE TABLE IF NOT EXISTS governed_remediation_phase_claims (
    schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-phase-claim.v1'),
    claim_id TEXT PRIMARY KEY CHECK(length(btrim(claim_id)) BETWEEN 1 AND 256),
    aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('state', 'reconciliation')),
    aggregate_id TEXT NOT NULL, remediation_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN (
      'parent_reserve', 'apply', 'verify', 'activate_and_verify', 'rollback', 'resume',
      'effect_reconcile', 'resume_reconcile'
    )),
    claim_revision BIGINT NOT NULL CHECK(claim_revision >= 1),
    claimant_id TEXT NOT NULL, expected_aggregate_revision BIGINT NOT NULL CHECK(expected_aggregate_revision >= 1),
    operation_id TEXT NOT NULL, effect_id TEXT, expected_owner_revision TEXT,
    lease_token_sha256 TEXT NOT NULL CHECK(lease_token_sha256 ~ '^[0-9a-f]{64}$'),
    lease_expires_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(lease_expires_at) IS NOT NULL),
    status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    outcome_sha256 TEXT CHECK(outcome_sha256 IS NULL OR outcome_sha256 ~ '^[0-9a-f]{64}$'),
    outcome_idempotency_key TEXT,
    created_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(updated_at) IS NOT NULL),
    CHECK((status = 'active' AND outcome_sha256 IS NULL AND outcome_idempotency_key IS NULL)
      OR (status = 'completed' AND outcome_sha256 IS NOT NULL AND outcome_idempotency_key IS NOT NULL)),
    CHECK((aggregate_kind = 'state' AND aggregate_id = remediation_id AND phase <> 'effect_reconcile')
      OR (aggregate_kind = 'reconciliation' AND phase IN ('effect_reconcile', 'resume_reconcile'))),
    CHECK((phase IN ('parent_reserve', 'apply', 'verify', 'activate_and_verify', 'rollback',
      'resume', 'effect_reconcile', 'resume_reconcile')) = (effect_id IS NOT NULL)),
    CONSTRAINT idx_governed_remediation_phase_claims_aggregate_ki_b035a0092ca0
      UNIQUE(aggregate_kind, aggregate_id, phase, expected_aggregate_revision, operation_id),
    FOREIGN KEY(remediation_id) REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_phase_claims_active
    ON governed_remediation_phase_claims(aggregate_kind, aggregate_id, phase, expected_aggregate_revision)
    WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_governed_remediation_phase_claims_recovery
    ON governed_remediation_phase_claims(status, lease_expires_at, aggregate_kind, aggregate_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_governed_remediation_phase_claims_aggregate_ki_b035a0092ca0
    ON governed_remediation_phase_claims(
      aggregate_kind, aggregate_id, phase, expected_aggregate_revision, operation_id
    );

  CREATE TABLE IF NOT EXISTS governed_remediation_phase_claim_acquisitions (
    acquisition_idempotency_key TEXT PRIMARY KEY,
    request_sha256 TEXT NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
    claim_id TEXT REFERENCES governed_remediation_phase_claims(claim_id) ON DELETE RESTRICT,
    observed_claim_revision BIGINT,
    disposition TEXT NOT NULL CHECK(disposition IN ('acquired', 'busy', 'stale', 'completed')),
    recorded_at TEXT NOT NULL CHECK(gc_try_parse_timestamptz(recorded_at) IS NOT NULL),
    CHECK((claim_id IS NULL) = (observed_claim_revision IS NULL))
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
      OR (from_state = 'verifying' AND to_state IN ('credential_verified', 'verified', 'rolling_back', 'failed'))
      OR (from_state = 'credential_verified' AND to_state IN (
        'awaiting_activation_approval', 'activating', 'verified', 'declined', 'expired', 'failed'
      ))
      OR (from_state = 'awaiting_activation_approval' AND to_state IN (
        'activating', 'declined', 'expired', 'failed'
      ))
      OR (from_state = 'activating' AND to_state IN ('verified', 'rolling_back', 'failed'))
      OR (from_state = 'verified' AND to_state IN ('resuming', 'failed'))
      OR (from_state = 'resuming' AND to_state IN ('completed', 'failed', 'reconciling_resume'))
      OR (from_state = 'reconciling_resume' AND to_state IN ('completed', 'failed'))
      OR (from_state = 'rolling_back' AND to_state IN ('rolled_back', 'rollback_failed'));
  END;
  $$ LANGUAGE plpgsql IMMUTABLE;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_reconciliation_transition_allowed(
    from_state TEXT, to_state TEXT
  ) RETURNS BOOLEAN AS $$
  BEGIN
    RETURN (from_state = 'open' AND to_state IN (
      'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified',
      'resolved_resumed', 'resolved_not_resumed', 'manual_required'
    )) OR (from_state = 'quarantined' AND to_state IN (
      'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified',
      'resolved_resumed', 'resolved_not_resumed', 'manual_required'
    ));
  END;
  $$ LANGUAGE plpgsql IMMUTABLE;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_cas_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.aggregate_kind = 'state' THEN
      IF NOT EXISTS (SELECT 1 FROM governed_remediation_states s
        WHERE s.remediation_id = NEW.aggregate_id AND s.revision = NEW.expected_revision
          AND s.state = NEW.from_state)
        OR NOT gc_governed_remediation_state_transition_allowed(NEW.from_state, NEW.to_state) THEN
        RAISE EXCEPTION 'governed remediation state CAS admission violated' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.aggregate_kind = 'reconciliation' THEN
      IF NOT EXISTS (SELECT 1 FROM governed_remediation_reconciliations r
        WHERE r.reconciliation_id = NEW.aggregate_id AND r.revision = NEW.expected_revision
          AND r.state = NEW.from_state)
        OR NOT gc_governed_remediation_reconciliation_transition_allowed(NEW.from_state, NEW.to_state) THEN
        RAISE EXCEPTION 'governed remediation reconciliation CAS admission violated' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_state_update_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.remediation_id IS DISTINCT FROM OLD.remediation_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
      OR NEW.source_turn_id IS DISTINCT FROM OLD.source_turn_id OR NEW.durable_run_id IS DISTINCT FROM OLD.durable_run_id
      OR NEW.blocked_checkpoint_id IS DISTINCT FROM OLD.blocked_checkpoint_id
      OR NEW.requester_actor_id IS DISTINCT FROM OLD.requester_actor_id
      OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id OR NEW.recipe_version IS DISTINCT FROM OLD.recipe_version
      OR NEW.recipe_sha256 IS DISTINCT FROM OLD.recipe_sha256 OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
      OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
      OR NEW.target_id IS DISTINCT FROM OLD.target_id
      OR NEW.expected_waiting_run_version IS DISTINCT FROM OLD.expected_waiting_run_version
      OR NEW.expected_owner_revision IS DISTINCT FROM OLD.expected_owner_revision
      OR (OLD.parent_reservation_id IS NOT NULL AND NEW.parent_reservation_id IS DISTINCT FROM OLD.parent_reservation_id)
      OR (OLD.pre_effect_approval_id IS NOT NULL AND NEW.pre_effect_approval_id IS DISTINCT FROM OLD.pre_effect_approval_id)
      OR (OLD.activation_approval_id IS NOT NULL AND NEW.activation_approval_id IS DISTINCT FROM OLD.activation_approval_id)
      OR (OLD.effect_id IS NOT NULL AND NEW.effect_id IS DISTINCT FROM OLD.effect_id)
      OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
      OR NEW.create_request_sha256 IS DISTINCT FROM OLD.create_request_sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1
      OR NEW.last_transition_idempotency_key IS NULL OR NEW.last_transition_request_sha256 IS NULL
      OR NOT EXISTS (SELECT 1 FROM governed_remediation_cas_transitions c
        WHERE c.aggregate_kind = 'state' AND c.aggregate_id = OLD.remediation_id
          AND c.idempotency_key = NEW.last_transition_idempotency_key
          AND c.request_sha256 = NEW.last_transition_request_sha256
          AND c.expected_revision = OLD.revision AND c.resulting_revision = NEW.revision
          AND c.from_state = OLD.state AND c.to_state = NEW.state) THEN
      RAISE EXCEPTION 'governed remediation state CAS or immutable binding violated' USING ERRCODE = '23514';
    END IF;
    IF ((OLD.parent_reservation_id IS NULL AND NEW.parent_reservation_id IS NOT NULL)
        OR (OLD.effect_id IS NULL AND NEW.effect_id IS NOT NULL))
      AND (NEW.state <> 'applying' OR NEW.parent_reservation_id IS NULL OR NEW.effect_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM governed_remediation_phase_claims claim
          WHERE claim.aggregate_kind = 'state' AND claim.aggregate_id = OLD.remediation_id
            AND claim.phase = 'parent_reserve' AND claim.expected_aggregate_revision = OLD.revision
            AND claim.effect_id = NEW.effect_id AND claim.status = 'active'
            AND gc_try_parse_timestamptz(claim.lease_expires_at) > clock_timestamp()
        )) THEN
      RAISE EXCEPTION 'governed remediation parent reservation claim binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.latest_receipt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.latest_receipt_id AND receipt.remediation_id = OLD.remediation_id
    ) THEN RAISE EXCEPTION 'governed remediation state receipt binding violated' USING ERRCODE = '23514'; END IF;
    IF NEW.failure_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_failures failure
      WHERE failure.failure_id = NEW.failure_id AND failure.remediation_id = OLD.remediation_id
    ) THEN RAISE EXCEPTION 'governed remediation state failure binding violated' USING ERRCODE = '23514'; END IF;
    IF NEW.reconciliation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_reconciliations reconciliation
      WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
        AND reconciliation.remediation_id = OLD.remediation_id
    ) THEN RAISE EXCEPTION 'governed remediation state reconciliation binding violated' USING ERRCODE = '23514'; END IF;
    IF NEW.state = 'completed' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.latest_receipt_id AND receipt.kind = 'resume'
        AND receipt.remediation_id = OLD.remediation_id AND receipt.durable_run_id = OLD.durable_run_id
        AND receipt.blocked_checkpoint_id = OLD.blocked_checkpoint_id
        AND receipt.resumed_run_version = OLD.expected_waiting_run_version + 1
    ) THEN
      RAISE EXCEPTION 'governed remediation completed-state receipt lineage violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'rolled_back' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.latest_receipt_id AND receipt.kind = 'rollback'
        AND receipt.remediation_id = OLD.remediation_id
    ) THEN
      RAISE EXCEPTION 'governed remediation rolled-back receipt lineage violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'reconciling_resume' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_reconciliations reconciliation
      WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
        AND reconciliation.remediation_id = OLD.remediation_id AND reconciliation.domain = 'resume'
    ) THEN
      RAISE EXCEPTION 'governed remediation resume-reconciliation lineage violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_state_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.revision <> 1 OR NEW.state <> 'blocked' OR NEW.parent_reservation_id IS NOT NULL
      OR NEW.prompt_id IS NOT NULL OR NEW.prompt_expires_at IS NOT NULL
      OR NEW.pre_effect_approval_id IS NOT NULL OR NEW.activation_approval_id IS NOT NULL
      OR NEW.effect_id IS NOT NULL OR NEW.last_transition_idempotency_key IS NOT NULL
      OR NEW.last_transition_request_sha256 IS NOT NULL OR NEW.latest_receipt_id IS NOT NULL
      OR NEW.failure_id IS NOT NULL OR NEW.reconciliation_id IS NOT NULL THEN
      RAISE EXCEPTION 'governed remediation state creation invariant violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_child_binding_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM governed_remediation_states state
      WHERE state.remediation_id = NEW.remediation_id AND state.recipe_id = NEW.recipe_id
        AND state.recipe_version = NEW.recipe_version AND state.deployment_id = NEW.deployment_id
        AND state.scope_kind = NEW.scope_kind AND state.scope_id = NEW.scope_id
        AND state.target_id = NEW.target_id) THEN
      RAISE EXCEPTION 'governed remediation child scope binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_receipt_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM governed_remediation_states state
      WHERE state.remediation_id = NEW.remediation_id AND state.recipe_id = NEW.recipe_id
        AND state.recipe_version = NEW.recipe_version AND state.deployment_id = NEW.deployment_id
        AND state.scope_kind = NEW.scope_kind AND state.scope_id = NEW.scope_id
        AND state.target_id = NEW.target_id) THEN
      RAISE EXCEPTION 'governed remediation receipt scope binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'verification' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts application
      JOIN governed_remediation_states state ON state.remediation_id = NEW.remediation_id
      WHERE application.receipt_id = NEW.application_receipt_id AND application.kind = 'application'
        AND application.remediation_id = NEW.remediation_id AND application.recipe_id = NEW.recipe_id
        AND application.recipe_version = NEW.recipe_version AND application.deployment_id = NEW.deployment_id
        AND application.scope_kind = NEW.scope_kind AND application.scope_id = NEW.scope_id
        AND application.target_id = NEW.target_id AND application.effect_id = state.effect_id
        AND ((NEW.activation_receipt_id IS NULL
            AND application.owner_revision_after = NEW.owner_revision_observed)
          OR EXISTS (SELECT 1 FROM governed_remediation_receipts activation
            WHERE activation.receipt_id = NEW.activation_receipt_id AND activation.kind = 'activation'
              AND activation.remediation_id = NEW.remediation_id
              AND activation.application_receipt_id = application.receipt_id
              AND activation.owner_revision_after = NEW.owner_revision_observed))
    ) THEN
      RAISE EXCEPTION 'governed remediation verification receipt lineage violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'activation' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts application
      JOIN governed_remediation_receipts verification
        ON verification.receipt_id = NEW.verification_receipt_id
      WHERE application.receipt_id = NEW.application_receipt_id AND application.kind = 'application'
        AND application.remediation_id = NEW.remediation_id
        AND application.recipe_id = NEW.recipe_id AND application.recipe_version = NEW.recipe_version
        AND application.deployment_id = NEW.deployment_id AND application.scope_kind = NEW.scope_kind
        AND application.scope_id = NEW.scope_id AND application.target_id = NEW.target_id
        AND verification.kind = 'verification' AND verification.remediation_id = NEW.remediation_id
        AND verification.application_receipt_id = application.receipt_id
        AND verification.activation_receipt_id IS NULL
        AND verification.owner_revision_observed = NEW.owner_revision_before
    ) THEN
      RAISE EXCEPTION 'governed remediation activation receipt lineage violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'rollback' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts application
      JOIN governed_remediation_states state ON state.remediation_id = NEW.remediation_id
      JOIN governed_remediation_receipts latest ON latest.receipt_id = state.latest_receipt_id
      WHERE application.receipt_id = NEW.application_receipt_id AND application.kind = 'application'
        AND application.remediation_id = NEW.remediation_id AND application.recipe_id = NEW.recipe_id
        AND application.recipe_version = NEW.recipe_version AND application.deployment_id = NEW.deployment_id
        AND application.scope_kind = NEW.scope_kind AND application.scope_id = NEW.scope_id
        AND application.target_id = NEW.target_id
        AND NEW.owner_revision_before = CASE latest.kind
          WHEN 'application' THEN latest.owner_revision_after
          WHEN 'activation' THEN latest.owner_revision_after
          WHEN 'verification' THEN latest.owner_revision_observed
          ELSE NULL
        END
    ) THEN
      RAISE EXCEPTION 'governed remediation rollback receipt lineage violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'resume' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts verification
      JOIN governed_remediation_states state ON state.remediation_id = NEW.remediation_id
      WHERE verification.receipt_id = NEW.verification_receipt_id AND verification.kind = 'verification'
        AND verification.remediation_id = NEW.remediation_id AND verification.recipe_id = NEW.recipe_id
        AND verification.recipe_version = NEW.recipe_version AND verification.deployment_id = NEW.deployment_id
        AND verification.scope_kind = NEW.scope_kind AND verification.scope_id = NEW.scope_id
        AND verification.target_id = NEW.target_id AND NEW.durable_run_id = state.durable_run_id
        AND NEW.blocked_checkpoint_id = state.blocked_checkpoint_id
        AND NEW.resumed_run_version = state.expected_waiting_run_version + 1
    ) THEN
      RAISE EXCEPTION 'governed remediation resume receipt lineage violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'reconciliation' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_reconciliations reconciliation
      JOIN governed_remediation_failures failure ON failure.failure_id = NEW.failure_id
      WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
        AND reconciliation.remediation_id = NEW.remediation_id AND reconciliation.failure_id = NEW.failure_id
        AND failure.remediation_id = NEW.remediation_id AND failure.recipe_id = NEW.recipe_id
        AND failure.recipe_version = NEW.recipe_version AND failure.deployment_id = NEW.deployment_id
        AND failure.scope_kind = NEW.scope_kind AND failure.scope_id = NEW.scope_id
        AND failure.target_id = NEW.target_id
        AND ((reconciliation.domain = 'effect' AND NEW.resolution IN (
              'confirmed_no_effect', 'confirmed_rolled_back', 'confirmed_verified'))
          OR (reconciliation.domain = 'resume' AND NEW.resolution IN (
              'confirmed_resumed', 'confirmed_not_resumed')))
        AND (NEW.application_receipt_id IS NULL OR EXISTS (
          SELECT 1 FROM governed_remediation_receipts application
          WHERE application.receipt_id = NEW.application_receipt_id AND application.kind = 'application'
            AND application.remediation_id = NEW.remediation_id AND application.recipe_id = NEW.recipe_id
            AND application.recipe_version = NEW.recipe_version AND application.deployment_id = NEW.deployment_id
            AND application.scope_kind = NEW.scope_kind AND application.scope_id = NEW.scope_id
            AND application.target_id = NEW.target_id))
        AND (NEW.resume_receipt_id IS NULL OR EXISTS (
          SELECT 1 FROM governed_remediation_receipts resume
          WHERE resume.receipt_id = NEW.resume_receipt_id AND resume.kind = 'resume'
            AND resume.remediation_id = NEW.remediation_id AND resume.recipe_id = NEW.recipe_id
            AND resume.recipe_version = NEW.recipe_version AND resume.deployment_id = NEW.deployment_id
            AND resume.scope_kind = NEW.scope_kind AND resume.scope_id = NEW.scope_id
            AND resume.target_id = NEW.target_id))
    ) THEN
      RAISE EXCEPTION 'governed remediation reconciliation receipt lineage violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_reconciliation_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.revision <> 1 OR NEW.last_transition_idempotency_key IS NOT NULL
      OR NEW.last_transition_request_sha256 IS NOT NULL OR NEW.resolution_receipt_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM governed_remediation_failures failure
        WHERE failure.failure_id = NEW.failure_id AND failure.remediation_id = NEW.remediation_id
          AND failure.recipe_id = NEW.recipe_id AND failure.recipe_version = NEW.recipe_version
          AND failure.deployment_id = NEW.deployment_id AND failure.scope_kind = NEW.scope_kind
          AND failure.scope_id = NEW.scope_id AND failure.target_id = NEW.target_id) THEN
      RAISE EXCEPTION 'governed remediation reconciliation failure binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_reconciliation_update_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
      OR NEW.remediation_id IS DISTINCT FROM OLD.remediation_id OR NEW.failure_id IS DISTINCT FROM OLD.failure_id
      OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id OR NEW.recipe_version IS DISTINCT FROM OLD.recipe_version
      OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
      OR NEW.scope_id IS DISTINCT FROM OLD.scope_id OR NEW.target_id IS DISTINCT FROM OLD.target_id
      OR NEW.domain IS DISTINCT FROM OLD.domain OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.create_idempotency_key IS DISTINCT FROM OLD.create_idempotency_key
      OR NEW.create_request_sha256 IS DISTINCT FROM OLD.create_request_sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1
      OR NOT EXISTS (SELECT 1 FROM governed_remediation_cas_transitions c
        WHERE c.aggregate_kind = 'reconciliation' AND c.aggregate_id = OLD.reconciliation_id
          AND c.idempotency_key = NEW.last_transition_idempotency_key
          AND c.request_sha256 = NEW.last_transition_request_sha256
          AND c.expected_revision = OLD.revision AND c.resulting_revision = NEW.revision
          AND c.from_state = OLD.state AND c.to_state = NEW.state) THEN
      RAISE EXCEPTION 'governed remediation reconciliation CAS or immutable binding violated' USING ERRCODE = '23514';
    END IF;
    IF NEW.resolution_receipt_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.resolution_receipt_id AND receipt.kind = 'reconciliation'
        AND receipt.reconciliation_id = OLD.reconciliation_id AND receipt.remediation_id = OLD.remediation_id
    ) THEN RAISE EXCEPTION 'governed remediation reconciliation receipt binding violated' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_phase_claim_insert_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.claim_revision <> 1 OR NEW.status <> 'active'
      OR gc_try_parse_timestamptz(NEW.lease_expires_at) <= clock_timestamp()
      OR gc_try_parse_timestamptz(NEW.lease_expires_at) > clock_timestamp() + INTERVAL '900 seconds'
      OR (NEW.aggregate_kind = 'state' AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_states state
        WHERE state.remediation_id = NEW.aggregate_id AND state.revision = NEW.expected_aggregate_revision
          AND ((NEW.phase = 'parent_reserve' AND state.state IN (
                'blocked', 'offered', 'awaiting_preapproval', 'awaiting_secure_input'))
            OR (NEW.phase = 'apply' AND state.state = 'applying')
            OR (NEW.phase = 'verify' AND state.state = 'verifying')
            OR (NEW.phase = 'activate_and_verify' AND state.state = 'activating')
            OR (NEW.phase = 'rollback' AND state.state IN (
                'rolling_back', 'credential_verified', 'awaiting_activation_approval', 'verified'))
            OR (NEW.phase = 'resume' AND state.state IN ('verified', 'resuming'))
            OR (NEW.phase = 'resume_reconcile' AND state.state = 'reconciling_resume'))
          AND (NEW.phase = 'parent_reserve' OR state.effect_id = NEW.effect_id)))
      OR (NEW.aggregate_kind = 'reconciliation' AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_reconciliations reconciliation
        JOIN governed_remediation_states state ON state.remediation_id = reconciliation.remediation_id
        WHERE reconciliation.reconciliation_id = NEW.aggregate_id
          AND reconciliation.remediation_id = NEW.remediation_id
          AND reconciliation.revision = NEW.expected_aggregate_revision
          AND reconciliation.state IN ('open', 'quarantined')
          AND state.effect_id = NEW.effect_id
          AND ((NEW.phase = 'effect_reconcile' AND reconciliation.domain = 'effect')
            OR (NEW.phase = 'resume_reconcile' AND reconciliation.domain = 'resume')))) THEN
      RAISE EXCEPTION 'governed remediation phase claim aggregate binding violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_governed_remediation_phase_claim_update_guard() RETURNS TRIGGER AS $$
  BEGIN
    IF NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
      OR NEW.aggregate_kind IS DISTINCT FROM OLD.aggregate_kind OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
      OR NEW.remediation_id IS DISTINCT FROM OLD.remediation_id OR NEW.phase IS DISTINCT FROM OLD.phase
      OR NEW.expected_aggregate_revision IS DISTINCT FROM OLD.expected_aggregate_revision
      OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.effect_id IS DISTINCT FROM OLD.effect_id
      OR NEW.expected_owner_revision IS DISTINCT FROM OLD.expected_owner_revision
      OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NOT (
        (OLD.status = 'active' AND gc_try_parse_timestamptz(OLD.lease_expires_at) <= clock_timestamp()
          AND NEW.status = 'active' AND NEW.claim_revision = OLD.claim_revision + 1
          AND NEW.outcome_sha256 IS NULL AND NEW.outcome_idempotency_key IS NULL
          AND gc_try_parse_timestamptz(NEW.lease_expires_at) > clock_timestamp()
          AND gc_try_parse_timestamptz(NEW.lease_expires_at) <= clock_timestamp() + INTERVAL '900 seconds')
        OR (OLD.status = 'active' AND NEW.status = 'completed' AND NEW.claim_revision = OLD.claim_revision
          AND NEW.claimant_id = OLD.claimant_id AND NEW.lease_token_sha256 = OLD.lease_token_sha256
          AND NEW.lease_expires_at = OLD.lease_expires_at
          AND gc_try_parse_timestamptz(OLD.lease_expires_at) > clock_timestamp()
          AND gc_try_parse_timestamptz(NEW.updated_at) < gc_try_parse_timestamptz(NEW.lease_expires_at)
          AND NEW.outcome_sha256 IS NOT NULL AND NEW.outcome_idempotency_key IS NOT NULL)
      ) THEN
      RAISE EXCEPTION 'governed remediation phase claim lifecycle violated' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE FUNCTION gc_reject_governed_remediation_mutation() RETURNS TRIGGER AS $$
  BEGIN
    RAISE EXCEPTION 'governed remediation record is immutable' USING ERRCODE = '23514';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER trg_governed_remediation_cas_transition_insert_guard BEFORE INSERT
    ON governed_remediation_cas_transitions FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_cas_insert_guard();
  CREATE TRIGGER trg_governed_remediation_states_insert_guard BEFORE INSERT
    ON governed_remediation_states FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_state_insert_guard();
  CREATE TRIGGER trg_governed_remediation_states_update_guard BEFORE UPDATE
    ON governed_remediation_states FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_state_update_guard();
  CREATE TRIGGER trg_governed_remediation_receipts_insert_guard BEFORE INSERT
    ON governed_remediation_receipts FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_receipt_insert_guard();
  CREATE TRIGGER trg_governed_remediation_failures_insert_guard BEFORE INSERT
    ON governed_remediation_failures FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_child_binding_guard();
  CREATE TRIGGER trg_governed_remediation_reconciliations_insert_guard BEFORE INSERT
    ON governed_remediation_reconciliations FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_reconciliation_insert_guard();
  CREATE TRIGGER trg_governed_remediation_reconciliations_update_guard BEFORE UPDATE
    ON governed_remediation_reconciliations FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_reconciliation_update_guard();
  CREATE TRIGGER trg_governed_remediation_phase_claims_insert_guard BEFORE INSERT
    ON governed_remediation_phase_claims FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_phase_claim_insert_guard();
  CREATE TRIGGER trg_governed_remediation_phase_claims_update_guard BEFORE UPDATE
    ON governed_remediation_phase_claims FOR EACH ROW EXECUTE FUNCTION gc_governed_remediation_phase_claim_update_guard();

  CREATE TRIGGER trg_governed_remediation_states_no_delete BEFORE DELETE ON governed_remediation_states
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_receipts_no_update BEFORE UPDATE ON governed_remediation_receipts
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_receipts_no_delete BEFORE DELETE ON governed_remediation_receipts
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_failures_no_update BEFORE UPDATE ON governed_remediation_failures
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_failures_no_delete BEFORE DELETE ON governed_remediation_failures
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_reconciliations_no_delete BEFORE DELETE ON governed_remediation_reconciliations
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_cas_transitions_no_update BEFORE UPDATE ON governed_remediation_cas_transitions
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_cas_transitions_no_delete BEFORE DELETE ON governed_remediation_cas_transitions
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_phase_claims_no_delete BEFORE DELETE ON governed_remediation_phase_claims
    FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_phase_claim_acquisitions_no_update BEFORE UPDATE
    ON governed_remediation_phase_claim_acquisitions FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
  CREATE TRIGGER trg_governed_remediation_phase_claim_acquisitions_no_delete BEFORE DELETE
    ON governed_remediation_phase_claim_acquisitions FOR EACH ROW EXECUTE FUNCTION gc_reject_governed_remediation_mutation();
`;
