import type { DatabaseSync } from "node:sqlite";

/**
 * SQLite 191, paired with PostgreSQL 134.
 *
 * This is an additive, secret-free durable owner for generic governed
 * remediation. Every persisted field is a bounded contract field or a
 * storage-owned idempotency/CAS digest. There are deliberately no command,
 * arbitrary payload, provider-error, or secret-value columns.
 */
export function createGovernedRemediationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE governed_remediation_states (
      schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-state.v1'),
      remediation_id TEXT PRIMARY KEY CHECK(length(TRIM(remediation_id)) BETWEEN 1 AND 256),
      owner_id TEXT NOT NULL CHECK(length(TRIM(owner_id)) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(TRIM(session_id)) BETWEEN 1 AND 256),
      source_turn_id TEXT NOT NULL CHECK(length(TRIM(source_turn_id)) BETWEEN 1 AND 256),
      durable_run_id TEXT NOT NULL CHECK(length(TRIM(durable_run_id)) BETWEEN 1 AND 256),
      blocked_checkpoint_id TEXT NOT NULL CHECK(length(TRIM(blocked_checkpoint_id)) BETWEEN 1 AND 256),
      recipe_id TEXT NOT NULL CHECK(length(TRIM(recipe_id)) BETWEEN 1 AND 256),
      recipe_version INTEGER NOT NULL CHECK(typeof(recipe_version) = 'integer' AND recipe_version >= 1),
      deployment_id TEXT NOT NULL CHECK(length(TRIM(deployment_id)) BETWEEN 1 AND 256),
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')),
      scope_id TEXT NOT NULL CHECK(length(TRIM(scope_id)) BETWEEN 1 AND 256),
      target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
      state TEXT NOT NULL CHECK(state IN (
        'blocked', 'offered', 'awaiting_preapproval', 'awaiting_secure_input', 'applying', 'verifying',
        'credential_verified', 'awaiting_activation_approval', 'activating', 'verified', 'resuming',
        'completed', 'declined', 'expired', 'manual_required', 'failed', 'rolling_back', 'rolled_back',
        'rollback_failed'
      )),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
      expected_waiting_run_version INTEGER NOT NULL
        CHECK(typeof(expected_waiting_run_version) = 'integer' AND expected_waiting_run_version >= 1),
      expected_owner_revision TEXT CHECK(
        expected_owner_revision IS NULL OR length(TRIM(expected_owner_revision)) BETWEEN 1 AND 512
      ),
      prompt_id TEXT CHECK(prompt_id IS NULL OR length(TRIM(prompt_id)) BETWEEN 1 AND 256),
      prompt_expires_at TEXT CHECK(
        prompt_expires_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', prompt_expires_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', prompt_expires_at, '+0 days') = prompt_expires_at
        )
      ),
      approval_id TEXT CHECK(approval_id IS NULL OR length(TRIM(approval_id)) BETWEEN 1 AND 256),
      effect_id TEXT CHECK(effect_id IS NULL OR length(TRIM(effect_id)) BETWEEN 1 AND 256),
      latest_receipt_id TEXT CHECK(
        latest_receipt_id IS NULL OR length(TRIM(latest_receipt_id)) BETWEEN 1 AND 256
      ),
      failure_id TEXT CHECK(failure_id IS NULL OR length(TRIM(failure_id)) BETWEEN 1 AND 256),
      reconciliation_id TEXT CHECK(
        reconciliation_id IS NULL OR length(TRIM(reconciliation_id)) BETWEEN 1 AND 256
      ),
      create_idempotency_key TEXT NOT NULL UNIQUE
        CHECK(length(TRIM(create_idempotency_key)) BETWEEN 1 AND 512),
      create_request_sha256 TEXT NOT NULL CHECK(
        length(create_request_sha256) = 64 AND create_request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      last_transition_idempotency_key TEXT,
      last_transition_request_sha256 TEXT,
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      updated_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') = updated_at
      ),
      CHECK(updated_at >= created_at),
      CHECK((prompt_id IS NULL) = (prompt_expires_at IS NULL)),
      CHECK(state <> 'awaiting_secure_input' OR prompt_id IS NOT NULL),
      CHECK(state NOT IN ('failed', 'rollback_failed') OR failure_id IS NOT NULL),
      CHECK(state <> 'rollback_failed' OR reconciliation_id IS NOT NULL),
      CHECK(state NOT IN ('completed', 'rolled_back') OR latest_receipt_id IS NOT NULL),
      CHECK(
        (last_transition_idempotency_key IS NULL AND last_transition_request_sha256 IS NULL AND revision = 1)
        OR (
          last_transition_idempotency_key IS NOT NULL
          AND length(TRIM(last_transition_idempotency_key)) BETWEEN 1 AND 512
          AND last_transition_request_sha256 IS NOT NULL
          AND length(last_transition_request_sha256) = 64
          AND last_transition_request_sha256 NOT GLOB '*[^0-9a-f]*'
          AND revision > 1
        )
      )
    );

    CREATE INDEX idx_governed_remediation_states_owner_scope
      ON governed_remediation_states(
        owner_id, deployment_id, scope_kind, scope_id, target_id, updated_at DESC, remediation_id DESC
      );
    CREATE INDEX idx_governed_remediation_states_workspace_session
      ON governed_remediation_states(workspace_id, session_id, updated_at DESC, remediation_id DESC);
    CREATE INDEX idx_governed_remediation_states_recovery
      ON governed_remediation_states(state, updated_at, remediation_id);

    CREATE TRIGGER trg_governed_remediation_states_insert_guard
    BEFORE INSERT ON governed_remediation_states
    WHEN NEW.revision <> 1
      OR NEW.last_transition_idempotency_key IS NOT NULL
      OR NEW.last_transition_request_sha256 IS NOT NULL
      OR NEW.latest_receipt_id IS NOT NULL
      OR NEW.failure_id IS NOT NULL
      OR NEW.reconciliation_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'governed remediation state creation invariant violated');
    END;

    CREATE TABLE governed_remediation_receipts (
      schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-receipt.v1'),
      receipt_id TEXT PRIMARY KEY CHECK(length(TRIM(receipt_id)) BETWEEN 1 AND 256),
      remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
      recipe_id TEXT NOT NULL CHECK(length(TRIM(recipe_id)) BETWEEN 1 AND 256),
      recipe_version INTEGER NOT NULL CHECK(typeof(recipe_version) = 'integer' AND recipe_version >= 1),
      deployment_id TEXT NOT NULL CHECK(length(TRIM(deployment_id)) BETWEEN 1 AND 256),
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')),
      scope_id TEXT NOT NULL CHECK(length(TRIM(scope_id)) BETWEEN 1 AND 256),
      target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
      kind TEXT NOT NULL CHECK(kind IN ('application', 'verification', 'rollback', 'resume', 'reconciliation')),
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
      resumed_run_version INTEGER,
      reconciliation_id TEXT,
      failure_id TEXT,
      resolution TEXT,
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      recorded_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 days') = recorded_at
      ),
      CHECK(application_owner_id IS NULL OR length(TRIM(application_owner_id)) BETWEEN 1 AND 256),
      CHECK(effect_id IS NULL OR length(TRIM(effect_id)) BETWEEN 1 AND 256),
      CHECK(owner_revision_before IS NULL OR length(TRIM(owner_revision_before)) BETWEEN 1 AND 512),
      CHECK(owner_revision_after IS NULL OR length(TRIM(owner_revision_after)) BETWEEN 1 AND 512),
      CHECK(application_receipt_id IS NULL OR length(TRIM(application_receipt_id)) BETWEEN 1 AND 256),
      CHECK(probe_id IS NULL OR length(TRIM(probe_id)) BETWEEN 1 AND 256),
      CHECK(owner_revision_observed IS NULL OR length(TRIM(owner_revision_observed)) BETWEEN 1 AND 512),
      CHECK(verification_receipt_id IS NULL OR length(TRIM(verification_receipt_id)) BETWEEN 1 AND 256),
      CHECK(durable_run_id IS NULL OR length(TRIM(durable_run_id)) BETWEEN 1 AND 256),
      CHECK(blocked_checkpoint_id IS NULL OR length(TRIM(blocked_checkpoint_id)) BETWEEN 1 AND 256),
      CHECK(reconciliation_id IS NULL OR length(TRIM(reconciliation_id)) BETWEEN 1 AND 256),
      CHECK(failure_id IS NULL OR length(TRIM(failure_id)) BETWEEN 1 AND 256),
      CHECK(
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
          AND blocked_checkpoint_id IS NOT NULL AND typeof(resumed_run_version) = 'integer'
          AND resumed_run_version >= 1 AND reconciliation_id IS NULL AND failure_id IS NULL AND resolution IS NULL)
        OR
        (kind = 'reconciliation'
          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL
          AND owner_revision_after IS NULL AND application_receipt_id IS NULL AND probe_id IS NULL
          AND probe_result IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
          AND verification_receipt_id IS NULL AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL
          AND resumed_run_version IS NULL AND reconciliation_id IS NOT NULL AND failure_id IS NOT NULL
          AND resolution IN ('confirmed_no_effect', 'confirmed_rolled_back', 'confirmed_verified'))
      )
    );

    CREATE INDEX idx_governed_remediation_receipts_remediation
      ON governed_remediation_receipts(remediation_id, recorded_at, receipt_id);
    CREATE INDEX idx_governed_remediation_receipts_scope
      ON governed_remediation_receipts(deployment_id, scope_kind, scope_id, target_id, recorded_at DESC);

    CREATE TABLE governed_remediation_failures (
      schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-failure.v1'),
      failure_id TEXT PRIMARY KEY CHECK(length(TRIM(failure_id)) BETWEEN 1 AND 256),
      remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
      recipe_id TEXT NOT NULL CHECK(length(TRIM(recipe_id)) BETWEEN 1 AND 256),
      recipe_version INTEGER NOT NULL CHECK(typeof(recipe_version) = 'integer' AND recipe_version >= 1),
      deployment_id TEXT NOT NULL CHECK(length(TRIM(deployment_id)) BETWEEN 1 AND 256),
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')),
      scope_id TEXT NOT NULL CHECK(length(TRIM(scope_id)) BETWEEN 1 AND 256),
      target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
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
      owner_revision_observed TEXT CHECK(
        owner_revision_observed IS NULL OR length(TRIM(owner_revision_observed)) BETWEEN 1 AND 512
      ),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      occurred_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') = occurred_at
      ),
      CHECK(
        effect_boundary = 'not_crossed'
        OR disposition NOT IN ('retry_with_fresh_authority', 'terminal_no_effect')
      ),
      CHECK(disposition <> 'rollback_required' OR effect_boundary <> 'not_crossed'),
      CHECK(reason <> 'rollback_failed' OR (effect_boundary <> 'not_crossed' AND disposition = 'manual_required')),
      CHECK(
        reason NOT IN ('unsupported_profile', 'unowned_target')
        OR (effect_boundary = 'not_crossed' AND disposition = 'manual_required')
      )
    );

    CREATE INDEX idx_governed_remediation_failures_remediation
      ON governed_remediation_failures(remediation_id, occurred_at, failure_id);
    CREATE INDEX idx_governed_remediation_failures_scope
      ON governed_remediation_failures(deployment_id, scope_kind, scope_id, target_id, occurred_at DESC);

    CREATE TABLE governed_remediation_reconciliations (
      schema_version TEXT NOT NULL CHECK(
        schema_version = 'goatcitadel.governed-remediation-reconciliation.v1'
      ),
      reconciliation_id TEXT PRIMARY KEY CHECK(length(TRIM(reconciliation_id)) BETWEEN 1 AND 256),
      remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
      failure_id TEXT NOT NULL REFERENCES governed_remediation_failures(failure_id) ON DELETE RESTRICT,
      recipe_id TEXT NOT NULL CHECK(length(TRIM(recipe_id)) BETWEEN 1 AND 256),
      recipe_version INTEGER NOT NULL CHECK(typeof(recipe_version) = 'integer' AND recipe_version >= 1),
      deployment_id TEXT NOT NULL CHECK(length(TRIM(deployment_id)) BETWEEN 1 AND 256),
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('installation', 'workspace', 'citadel', 'actor', 'connection')),
      scope_id TEXT NOT NULL CHECK(length(TRIM(scope_id)) BETWEEN 1 AND 256),
      target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
      reason TEXT NOT NULL CHECK(reason IN (
        'rollback_failed', 'effect_state_unknown', 'owner_revision_drift', 'verification_receipt_missing',
        'resume_receipt_missing'
      )),
      observation TEXT NOT NULL CHECK(observation IN (
        'effect_absent', 'effect_present_unverified', 'effect_verified', 'rolled_back', 'unknown'
      )),
      state TEXT NOT NULL CHECK(state IN (
        'open', 'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'
      )),
      owner_revision_observed TEXT CHECK(
        owner_revision_observed IS NULL OR length(TRIM(owner_revision_observed)) BETWEEN 1 AND 512
      ),
      resolution_receipt_id TEXT CHECK(
        resolution_receipt_id IS NULL OR length(TRIM(resolution_receipt_id)) BETWEEN 1 AND 256
      ),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
      create_idempotency_key TEXT NOT NULL UNIQUE
        CHECK(length(TRIM(create_idempotency_key)) BETWEEN 1 AND 512),
      create_request_sha256 TEXT NOT NULL CHECK(
        length(create_request_sha256) = 64 AND create_request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      last_transition_idempotency_key TEXT,
      last_transition_request_sha256 TEXT,
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      updated_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') = updated_at
      ),
      CHECK(updated_at >= created_at),
      CHECK(
        (state IN ('open', 'quarantined', 'manual_required') AND resolution_receipt_id IS NULL)
        OR (state IN ('resolved_no_effect', 'resolved_rolled_back', 'resolved_verified')
          AND resolution_receipt_id IS NOT NULL)
      ),
      CHECK(state <> 'resolved_no_effect' OR observation = 'effect_absent'),
      CHECK(state <> 'resolved_rolled_back' OR observation = 'rolled_back'),
      CHECK(state <> 'resolved_verified' OR observation = 'effect_verified'),
      CHECK(
        (last_transition_idempotency_key IS NULL AND last_transition_request_sha256 IS NULL AND revision = 1)
        OR (
          last_transition_idempotency_key IS NOT NULL
          AND length(TRIM(last_transition_idempotency_key)) BETWEEN 1 AND 512
          AND last_transition_request_sha256 IS NOT NULL
          AND length(last_transition_request_sha256) = 64
          AND last_transition_request_sha256 NOT GLOB '*[^0-9a-f]*'
          AND revision > 1
        )
      )
    );

    CREATE INDEX idx_governed_remediation_reconciliations_remediation
      ON governed_remediation_reconciliations(remediation_id, updated_at DESC, reconciliation_id DESC);
    CREATE INDEX idx_governed_remediation_reconciliations_scope_state
      ON governed_remediation_reconciliations(
        deployment_id, scope_kind, scope_id, target_id, state, updated_at, reconciliation_id
      );
    CREATE INDEX idx_governed_remediation_reconciliations_recovery
      ON governed_remediation_reconciliations(state, updated_at, reconciliation_id);

    CREATE TABLE governed_remediation_cas_transitions (
      aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('state', 'reconciliation')),
      aggregate_id TEXT NOT NULL CHECK(length(TRIM(aggregate_id)) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision) = 'integer' AND expected_revision >= 1),
      resulting_revision INTEGER NOT NULL CHECK(
        typeof(resulting_revision) = 'integer' AND resulting_revision = expected_revision + 1
      ),
      from_state TEXT NOT NULL CHECK(length(TRIM(from_state)) BETWEEN 1 AND 64),
      to_state TEXT NOT NULL CHECK(length(TRIM(to_state)) BETWEEN 1 AND 64),
      recorded_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 days') = recorded_at
      ),
      PRIMARY KEY(aggregate_kind, aggregate_id, resulting_revision),
      UNIQUE(aggregate_kind, idempotency_key)
    );

    CREATE INDEX idx_governed_remediation_cas_transitions_aggregate
      ON governed_remediation_cas_transitions(aggregate_kind, aggregate_id, resulting_revision DESC);

    CREATE TRIGGER trg_governed_remediation_cas_transition_insert_guard
    BEFORE INSERT ON governed_remediation_cas_transitions
    WHEN (
      NEW.aggregate_kind = 'state' AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_states current
        WHERE current.remediation_id = NEW.aggregate_id
          AND current.revision = NEW.expected_revision
          AND current.state = NEW.from_state
      )
    ) OR (
      NEW.aggregate_kind = 'reconciliation' AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_reconciliations current
        WHERE current.reconciliation_id = NEW.aggregate_id
          AND current.revision = NEW.expected_revision
          AND current.state = NEW.from_state
      )
    ) OR (
      NEW.aggregate_kind = 'state' AND NOT (
        (NEW.from_state = 'blocked' AND NEW.to_state IN ('offered', 'manual_required', 'failed'))
        OR (NEW.from_state = 'offered' AND NEW.to_state IN (
          'awaiting_preapproval', 'awaiting_secure_input', 'applying', 'declined', 'expired', 'manual_required', 'failed'
        ))
        OR (NEW.from_state = 'awaiting_preapproval' AND NEW.to_state IN (
          'awaiting_secure_input', 'applying', 'declined', 'expired', 'failed'
        ))
        OR (NEW.from_state = 'awaiting_secure_input' AND NEW.to_state IN ('applying', 'declined', 'expired', 'failed'))
        OR (NEW.from_state = 'applying' AND NEW.to_state IN ('verifying', 'rolling_back', 'failed'))
        OR (NEW.from_state = 'verifying' AND NEW.to_state IN ('credential_verified', 'verified', 'rolling_back'))
        OR (NEW.from_state = 'credential_verified' AND NEW.to_state IN (
          'awaiting_activation_approval', 'activating', 'verified'
        ))
        OR (NEW.from_state = 'awaiting_activation_approval' AND NEW.to_state IN (
          'activating', 'declined', 'expired', 'failed'
        ))
        OR (NEW.from_state = 'activating' AND NEW.to_state IN ('verified', 'rolling_back'))
        OR (NEW.from_state = 'verified' AND NEW.to_state = 'resuming')
        OR (NEW.from_state = 'resuming' AND NEW.to_state IN ('completed', 'failed'))
        OR (NEW.from_state = 'rolling_back' AND NEW.to_state IN ('rolled_back', 'rollback_failed'))
      )
    ) OR (
      NEW.aggregate_kind = 'reconciliation' AND NOT (
        (NEW.from_state = 'open' AND NEW.to_state IN (
          'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'
        ))
        OR (NEW.from_state = 'quarantined' AND NEW.to_state IN (
          'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'
        ))
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed remediation CAS admission or transition invariant violated');
    END;

    CREATE TRIGGER trg_governed_remediation_states_update_guard
    BEFORE UPDATE ON governed_remediation_states
    WHEN NEW.schema_version <> OLD.schema_version
      OR NEW.remediation_id <> OLD.remediation_id
      OR NEW.owner_id <> OLD.owner_id
      OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.session_id <> OLD.session_id
      OR NEW.source_turn_id <> OLD.source_turn_id
      OR NEW.durable_run_id <> OLD.durable_run_id
      OR NEW.blocked_checkpoint_id <> OLD.blocked_checkpoint_id
      OR NEW.recipe_id <> OLD.recipe_id
      OR NEW.recipe_version <> OLD.recipe_version
      OR NEW.deployment_id <> OLD.deployment_id
      OR NEW.scope_kind <> OLD.scope_kind
      OR NEW.scope_id <> OLD.scope_id
      OR NEW.target_id <> OLD.target_id
      OR NEW.expected_waiting_run_version <> OLD.expected_waiting_run_version
      OR NEW.expected_owner_revision IS NOT OLD.expected_owner_revision
      OR NEW.create_idempotency_key <> OLD.create_idempotency_key
      OR NEW.create_request_sha256 <> OLD.create_request_sha256
      OR NEW.created_at <> OLD.created_at
      OR NEW.updated_at < OLD.updated_at
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
      )
      OR (NEW.latest_receipt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_receipts receipt
        WHERE receipt.receipt_id = NEW.latest_receipt_id AND receipt.remediation_id = OLD.remediation_id
      ))
      OR (NEW.failure_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_failures failure
        WHERE failure.failure_id = NEW.failure_id AND failure.remediation_id = OLD.remediation_id
      ))
      OR (NEW.reconciliation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_reconciliations reconciliation
        WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
          AND reconciliation.remediation_id = OLD.remediation_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'governed remediation state CAS or immutable binding violated');
    END;

    CREATE TRIGGER trg_governed_remediation_reconciliations_update_guard
    BEFORE UPDATE ON governed_remediation_reconciliations
    WHEN NEW.schema_version <> OLD.schema_version
      OR NEW.reconciliation_id <> OLD.reconciliation_id
      OR NEW.remediation_id <> OLD.remediation_id
      OR NEW.failure_id <> OLD.failure_id
      OR NEW.recipe_id <> OLD.recipe_id
      OR NEW.recipe_version <> OLD.recipe_version
      OR NEW.deployment_id <> OLD.deployment_id
      OR NEW.scope_kind <> OLD.scope_kind
      OR NEW.scope_id <> OLD.scope_id
      OR NEW.target_id <> OLD.target_id
      OR NEW.reason <> OLD.reason
      OR NEW.create_idempotency_key <> OLD.create_idempotency_key
      OR NEW.create_request_sha256 <> OLD.create_request_sha256
      OR NEW.created_at <> OLD.created_at
      OR NEW.updated_at < OLD.updated_at
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
      )
      OR (NEW.resolution_receipt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_remediation_receipts receipt
        WHERE receipt.receipt_id = NEW.resolution_receipt_id
          AND receipt.remediation_id = OLD.remediation_id
          AND receipt.kind = 'reconciliation'
          AND receipt.reconciliation_id = OLD.reconciliation_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'governed remediation reconciliation CAS or immutable binding violated');
    END;

    CREATE TRIGGER trg_governed_remediation_receipts_insert_guard
    BEFORE INSERT ON governed_remediation_receipts
    WHEN NOT EXISTS (
      SELECT 1 FROM governed_remediation_states current
      WHERE current.remediation_id = NEW.remediation_id
        AND current.recipe_id = NEW.recipe_id
        AND current.recipe_version = NEW.recipe_version
        AND current.deployment_id = NEW.deployment_id
        AND current.scope_kind = NEW.scope_kind
        AND current.scope_id = NEW.scope_id
        AND current.target_id = NEW.target_id
        AND (NEW.kind <> 'application' OR current.owner_id = NEW.application_owner_id)
    ) OR (
      NEW.kind = 'reconciliation' AND NOT EXISTS (
        SELECT 1
        FROM governed_remediation_reconciliations reconciliation
        JOIN governed_remediation_failures failure ON failure.failure_id = NEW.failure_id
        WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
          AND reconciliation.remediation_id = NEW.remediation_id
          AND reconciliation.failure_id = NEW.failure_id
          AND failure.remediation_id = NEW.remediation_id
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed remediation receipt owner or scope binding violated');
    END;

    CREATE TRIGGER trg_governed_remediation_failures_insert_guard
    BEFORE INSERT ON governed_remediation_failures
    WHEN NOT EXISTS (
      SELECT 1 FROM governed_remediation_states current
      WHERE current.remediation_id = NEW.remediation_id
        AND current.recipe_id = NEW.recipe_id
        AND current.recipe_version = NEW.recipe_version
        AND current.deployment_id = NEW.deployment_id
        AND current.scope_kind = NEW.scope_kind
        AND current.scope_id = NEW.scope_id
        AND current.target_id = NEW.target_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed remediation failure scope binding violated');
    END;

    CREATE TRIGGER trg_governed_remediation_reconciliations_insert_guard
    BEFORE INSERT ON governed_remediation_reconciliations
    WHEN NEW.revision <> 1
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
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed remediation reconciliation failure or scope binding violated');
    END;

    CREATE TRIGGER trg_governed_remediation_states_no_delete
    BEFORE DELETE ON governed_remediation_states
    BEGIN SELECT RAISE(ABORT, 'governed remediation states cannot be deleted'); END;
    CREATE TRIGGER trg_governed_remediation_receipts_no_update
    BEFORE UPDATE ON governed_remediation_receipts
    BEGIN SELECT RAISE(ABORT, 'governed remediation receipts are immutable'); END;
    CREATE TRIGGER trg_governed_remediation_receipts_no_delete
    BEFORE DELETE ON governed_remediation_receipts
    BEGIN SELECT RAISE(ABORT, 'governed remediation receipts are immutable'); END;
    CREATE TRIGGER trg_governed_remediation_failures_no_update
    BEFORE UPDATE ON governed_remediation_failures
    BEGIN SELECT RAISE(ABORT, 'governed remediation failures are immutable'); END;
    CREATE TRIGGER trg_governed_remediation_failures_no_delete
    BEFORE DELETE ON governed_remediation_failures
    BEGIN SELECT RAISE(ABORT, 'governed remediation failures are immutable'); END;
    CREATE TRIGGER trg_governed_remediation_reconciliations_no_delete
    BEFORE DELETE ON governed_remediation_reconciliations
    BEGIN SELECT RAISE(ABORT, 'governed remediation reconciliations cannot be deleted'); END;
    CREATE TRIGGER trg_governed_remediation_cas_transitions_no_update
    BEFORE UPDATE ON governed_remediation_cas_transitions
    BEGIN SELECT RAISE(ABORT, 'governed remediation CAS transitions are immutable'); END;
    CREATE TRIGGER trg_governed_remediation_cas_transitions_no_delete
    BEFORE DELETE ON governed_remediation_cas_transitions
    BEGIN SELECT RAISE(ABORT, 'governed remediation CAS transitions are immutable'); END;
  `);
}
