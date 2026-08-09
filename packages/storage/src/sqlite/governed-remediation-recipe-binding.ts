import type { DatabaseSync } from "node:sqlite";

/**
 * SQLite 192, paired with PostgreSQL 135.
 *
 * The v191 owner is unreleased and lacks authority that cannot be reconstructed
 * (requester, recipe digest, approval lineage, and rollback input revision).
 * Refuse non-empty v1 owners, then rebuild that isolated empty slice with the
 * complete v2 authority. Frozen migration 191 remains byte-for-byte intact.
 */
export function upgradeGovernedRemediationRecipeBinding(db: DatabaseSync): void {
  assertGovernedRemediationOwnerIsEmpty(db);

  const tables = {
    states: rewriteStateTable(readSql(db, "table", "governed_remediation_states")),
    receipts: rewriteReceiptTable(readSql(db, "table", "governed_remediation_receipts")),
    failures: readSql(db, "table", "governed_remediation_failures"),
    reconciliations: rewriteReconciliationTable(
      readSql(db, "table", "governed_remediation_reconciliations"),
    ),
    transitions: readSql(db, "table", "governed_remediation_cas_transitions"),
  };
  const triggers = readGovernedTriggers(db).map(({ name, sql }) => ({ name, sql: rewriteTrigger(name, sql) }));

  db.exec(`
    DROP TABLE governed_remediation_cas_transitions;
    DROP TABLE governed_remediation_reconciliations;
    DROP TABLE governed_remediation_failures;
    DROP TABLE governed_remediation_receipts;
    DROP TABLE governed_remediation_states;

    ${tables.states};
    ${tables.receipts};
    ${tables.failures};
    ${tables.reconciliations};
    ${tables.transitions};

    CREATE INDEX idx_governed_remediation_states_owner_scope
      ON governed_remediation_states(
        owner_id, deployment_id, scope_kind, scope_id, target_id, updated_at DESC, remediation_id DESC
      );
    CREATE INDEX idx_governed_remediation_states_workspace_session
      ON governed_remediation_states(workspace_id, session_id, updated_at DESC, remediation_id DESC);
    CREATE INDEX idx_governed_remediation_states_recovery
      ON governed_remediation_states(state, updated_at, remediation_id);
    CREATE INDEX idx_governed_remediation_receipts_remediation
      ON governed_remediation_receipts(remediation_id, recorded_at, receipt_id);
    CREATE INDEX idx_governed_remediation_receipts_scope
      ON governed_remediation_receipts(deployment_id, scope_kind, scope_id, target_id, recorded_at DESC);
    CREATE INDEX idx_governed_remediation_failures_remediation
      ON governed_remediation_failures(remediation_id, occurred_at, failure_id);
    CREATE INDEX idx_governed_remediation_failures_scope
      ON governed_remediation_failures(deployment_id, scope_kind, scope_id, target_id, occurred_at DESC);
    CREATE INDEX idx_governed_remediation_reconciliations_remediation
      ON governed_remediation_reconciliations(remediation_id, updated_at DESC, reconciliation_id DESC);
    CREATE INDEX idx_governed_remediation_reconciliations_scope_state
      ON governed_remediation_reconciliations(
        deployment_id, scope_kind, scope_id, target_id, state, updated_at, reconciliation_id
      );
    CREATE INDEX idx_governed_remediation_reconciliations_recovery
      ON governed_remediation_reconciliations(domain, state, updated_at, reconciliation_id);
    CREATE INDEX idx_governed_remediation_cas_transitions_aggregate
      ON governed_remediation_cas_transitions(aggregate_kind, aggregate_id, resulting_revision DESC);
  `);
  for (const trigger of triggers) db.exec(`${trigger.sql};`);
  db.exec(PHASE_AUTHORITY_SQLITE_SQL);
  db.exec(LINEAGE_GUARDS_SQLITE_SQL);
}

function rewriteStateTable(sql: string): string {
  let next = replaceRequired(
    sql,
    "      recipe_id TEXT NOT NULL",
    "      requester_actor_id TEXT NOT NULL CHECK(length(TRIM(requester_actor_id)) BETWEEN 1 AND 256),\n      recipe_id TEXT NOT NULL",
    "requester actor",
  );
  next = replaceRequired(
    next,
    "      deployment_id TEXT NOT NULL",
    "      recipe_sha256 TEXT NOT NULL CHECK(length(recipe_sha256) = 64 AND recipe_sha256 NOT GLOB '*[^0-9a-f]*'),\n      deployment_id TEXT NOT NULL",
    "recipe digest",
  );
  next = replaceRequired(
    next,
    "      prompt_id TEXT CHECK",
    "      parent_reservation_id TEXT CHECK(parent_reservation_id IS NULL OR length(TRIM(parent_reservation_id)) BETWEEN 1 AND 256),\n      prompt_id TEXT CHECK",
    "parent reservation",
  );
  next = replaceRequired(
    next,
    "      approval_id TEXT CHECK(approval_id IS NULL OR length(TRIM(approval_id)) BETWEEN 1 AND 256),",
    "      pre_effect_approval_id TEXT CHECK(pre_effect_approval_id IS NULL OR length(TRIM(pre_effect_approval_id)) BETWEEN 1 AND 256),\n      activation_approval_id TEXT CHECK(activation_approval_id IS NULL OR length(TRIM(activation_approval_id)) BETWEEN 1 AND 256),",
    "approval bindings",
  );
  next = replaceRequired(
    next,
    "'credential_verified', 'awaiting_activation_approval', 'activating', 'verified', 'resuming',\n        'completed'",
    "'credential_verified', 'awaiting_activation_approval', 'activating', 'verified', 'resuming',\n        'reconciling_resume', 'completed'",
    "resume reconciliation state",
  );
  return replaceRequired(
    next,
    "      CHECK(state <> 'rollback_failed' OR reconciliation_id IS NOT NULL),",
    "      CHECK(state <> 'rollback_failed' OR reconciliation_id IS NOT NULL),\n      CHECK(state <> 'reconciling_resume' OR (failure_id IS NOT NULL AND reconciliation_id IS NOT NULL)),",
    "resume reconciliation lifecycle",
  );
}

function rewriteReceiptTable(sql: string): string {
  let next = replaceRequired(
    sql,
    "      application_receipt_id TEXT REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,",
    "      application_receipt_id TEXT REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,\n      activation_receipt_id TEXT REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,",
    "activation receipt reference",
  );
  next = replaceRequired(
    next,
    "      resolution TEXT,",
    "      resolution TEXT,\n      resume_receipt_id TEXT REFERENCES governed_remediation_receipts(receipt_id) ON DELETE RESTRICT,",
    "resume receipt reference",
  );
  next = replaceRequired(
    next,
    "      kind TEXT NOT NULL CHECK(kind IN ('application', 'verification', 'rollback', 'resume', 'reconciliation')),",
    "      kind TEXT NOT NULL CHECK(kind IN ('application', 'verification', 'activation', 'rollback', 'resume', 'reconciliation')),",
    "activation receipt kind",
  );
  next = replaceRequired(
    next,
    "      CHECK(failure_id IS NULL OR length(TRIM(failure_id)) BETWEEN 1 AND 256),",
    "      CHECK(failure_id IS NULL OR length(TRIM(failure_id)) BETWEEN 1 AND 256),\n      CHECK(activation_receipt_id IS NULL OR length(TRIM(activation_receipt_id)) BETWEEN 1 AND 256),\n      CHECK(resume_receipt_id IS NULL OR length(TRIM(resume_receipt_id)) BETWEEN 1 AND 256),\n      CHECK(kind = 'verification' OR activation_receipt_id IS NULL),\n      CHECK(kind = 'reconciliation' OR resume_receipt_id IS NULL),",
    "resume receipt contract",
  );
  const rollbackStart =
    "(kind = 'rollback'\n" +
    "          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL";
  const activationAndRollback =
    "(kind = 'activation'\n" +
    "          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NOT NULL\n" +
    "          AND owner_revision_after IS NOT NULL AND application_receipt_id IS NOT NULL\n" +
    "          AND activation_receipt_id IS NULL AND probe_id IS NULL AND probe_result IS NULL\n" +
    "          AND owner_revision_observed IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL\n" +
    "          AND verification_receipt_id IS NOT NULL AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL\n" +
    "          AND resumed_run_version IS NULL AND reconciliation_id IS NULL AND failure_id IS NULL\n" +
    "          AND resolution IS NULL)\n" +
    "        OR\n" +
    "        (kind = 'rollback'\n" +
    "          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL";
  next = replaceRequired(next, rollbackStart, activationAndRollback, "activation receipt variant");
  next = replaceRequired(
    next,
    "(kind = 'rollback'\n          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL",
    "(kind = 'rollback'\n          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NOT NULL",
    "rollback input revision",
  );
  const oldReconciliation = `(kind = 'reconciliation'
          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL
          AND owner_revision_after IS NULL AND application_receipt_id IS NULL AND probe_id IS NULL
          AND probe_result IS NULL AND rollback_strategy IS NULL AND rollback_outcome IS NULL
          AND verification_receipt_id IS NULL AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL
          AND resumed_run_version IS NULL AND reconciliation_id IS NOT NULL AND failure_id IS NOT NULL
          AND resolution IN ('confirmed_no_effect', 'confirmed_rolled_back', 'confirmed_verified'))`;
  const newReconciliation = `(kind = 'reconciliation'
          AND application_owner_id IS NULL AND effect_id IS NULL AND owner_revision_before IS NULL
          AND owner_revision_after IS NULL AND probe_id IS NULL AND probe_result IS NULL
          AND rollback_strategy IS NULL AND rollback_outcome IS NULL AND verification_receipt_id IS NULL
          AND durable_run_id IS NULL AND blocked_checkpoint_id IS NULL AND resumed_run_version IS NULL
          AND reconciliation_id IS NOT NULL AND failure_id IS NOT NULL
          AND resolution IN ('confirmed_no_effect', 'confirmed_rolled_back', 'confirmed_verified',
            'confirmed_resumed', 'confirmed_not_resumed')
          AND ((resolution IN ('confirmed_verified', 'confirmed_rolled_back')
              AND application_receipt_id IS NOT NULL AND resume_receipt_id IS NULL)
            OR (resolution = 'confirmed_resumed'
              AND application_receipt_id IS NULL AND resume_receipt_id IS NOT NULL)
            OR (resolution IN ('confirmed_no_effect', 'confirmed_not_resumed')
              AND application_receipt_id IS NULL AND resume_receipt_id IS NULL)))`;
  return replaceRequired(next, oldReconciliation, newReconciliation, "reconciliation receipt variants");
}

function rewriteReconciliationTable(sql: string): string {
  let next = replaceRequired(
    sql,
    "      reason TEXT NOT NULL CHECK",
    "      domain TEXT NOT NULL CHECK(domain IN ('effect', 'resume')),\n      reason TEXT NOT NULL CHECK",
    "reconciliation domain",
  );
  next = replaceRequired(
    next,
    "'effect_absent', 'effect_present_unverified', 'effect_verified', 'rolled_back', 'unknown'",
    "'effect_absent', 'effect_present_unverified', 'effect_verified', 'rolled_back',\n        'resume_pending', 'resume_completed', 'resume_not_completed', 'unknown'",
    "reconciliation observations",
  );
  next = replaceRequired(
    next,
    "'open', 'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'",
    "'open', 'quarantined', 'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified',\n        'resolved_resumed', 'resolved_not_resumed', 'manual_required'",
    "reconciliation states",
  );
  next = replaceRequired(
    next,
    "OR (state IN ('resolved_no_effect', 'resolved_rolled_back', 'resolved_verified')\n          AND resolution_receipt_id IS NOT NULL)",
    "OR (state IN ('resolved_no_effect', 'resolved_rolled_back', 'resolved_verified',\n          'resolved_resumed', 'resolved_not_resumed') AND resolution_receipt_id IS NOT NULL)",
    "reconciliation resolved lifecycle",
  );
  next = replaceRequired(
    next,
    "      CHECK(state <> 'resolved_verified' OR observation = 'effect_verified'),",
    `      CHECK(state <> 'resolved_verified' OR observation = 'effect_verified'),
      CHECK(state <> 'resolved_resumed' OR observation = 'resume_completed'),
      CHECK(state <> 'resolved_not_resumed' OR observation = 'resume_not_completed'),
      CHECK((domain = 'resume') = (reason = 'resume_receipt_missing')),
      CHECK(domain = 'resume' OR observation NOT IN ('resume_pending', 'resume_completed', 'resume_not_completed')),
      CHECK(domain = 'effect' OR observation IN ('resume_pending', 'resume_completed', 'resume_not_completed', 'unknown')),
      CHECK(domain = 'resume' OR state NOT IN ('resolved_resumed', 'resolved_not_resumed')),
      CHECK(domain = 'effect' OR state NOT IN ('resolved_no_effect', 'resolved_rolled_back', 'resolved_verified')),`,
    "reconciliation domain lifecycle",
  );
  return next;
}

function rewriteTrigger(name: string, sql: string): string {
  let next = sql;
  if (name === "trg_governed_remediation_cas_transition_insert_guard") {
    next = next
      .replace("'credential_verified', 'verified', 'rolling_back'", "'credential_verified', 'verified', 'rolling_back', 'failed'")
      .replace(
        "'awaiting_activation_approval', 'activating', 'verified'",
        "'awaiting_activation_approval', 'activating', 'verified', 'declined', 'expired', 'failed'",
      )
      .replace("'verified', 'rolling_back'", "'verified', 'rolling_back', 'failed'")
      .replace(
        "NEW.from_state = 'verified' AND NEW.to_state = 'resuming'",
        "NEW.from_state = 'verified' AND NEW.to_state IN ('resuming', 'failed')",
      )
      .replace(
        "NEW.from_state = 'resuming' AND NEW.to_state IN ('completed', 'failed')",
        "NEW.from_state = 'resuming' AND NEW.to_state IN ('completed', 'failed', 'reconciling_resume')\n        OR (NEW.from_state = 'reconciling_resume' AND NEW.to_state IN ('completed', 'failed'))",
      )
      .replaceAll(
        "'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'manual_required'",
        "'resolved_no_effect', 'resolved_rolled_back', 'resolved_verified', 'resolved_resumed', 'resolved_not_resumed', 'manual_required'",
      );
  }
  if (name === "trg_governed_remediation_states_update_guard") {
    next = next
      .replace(
        "      OR NEW.recipe_id <> OLD.recipe_id",
        "      OR NEW.requester_actor_id <> OLD.requester_actor_id\n      OR NEW.recipe_id <> OLD.recipe_id",
      )
      .replace(
        "      OR NEW.deployment_id <> OLD.deployment_id",
        "      OR NEW.recipe_sha256 <> OLD.recipe_sha256\n      OR NEW.deployment_id <> OLD.deployment_id",
      )
      .replace(
        "      OR NEW.create_idempotency_key <> OLD.create_idempotency_key",
        `      OR (OLD.parent_reservation_id IS NOT NULL AND NEW.parent_reservation_id IS NOT OLD.parent_reservation_id)
      OR (OLD.pre_effect_approval_id IS NOT NULL AND NEW.pre_effect_approval_id IS NOT OLD.pre_effect_approval_id)
      OR (OLD.activation_approval_id IS NOT NULL AND NEW.activation_approval_id IS NOT OLD.activation_approval_id)
      OR (OLD.effect_id IS NOT NULL AND NEW.effect_id IS NOT OLD.effect_id)
      OR NEW.create_idempotency_key <> OLD.create_idempotency_key`,
      );
  }
  if (name === "trg_governed_remediation_reconciliations_update_guard") {
    next = next.replace("      OR NEW.reason <> OLD.reason", "      OR NEW.domain <> OLD.domain\n      OR NEW.reason <> OLD.reason");
  }
  return next;
}

const PHASE_AUTHORITY_SQLITE_SQL = `
  CREATE TABLE governed_remediation_phase_claims (
    schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-remediation-phase-claim.v1'),
    claim_id TEXT PRIMARY KEY CHECK(length(TRIM(claim_id)) BETWEEN 1 AND 256),
    aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('state', 'reconciliation')),
    aggregate_id TEXT NOT NULL CHECK(length(TRIM(aggregate_id)) BETWEEN 1 AND 256),
    remediation_id TEXT NOT NULL REFERENCES governed_remediation_states(remediation_id) ON DELETE RESTRICT,
    phase TEXT NOT NULL CHECK(phase IN (
      'parent_reserve', 'apply', 'verify', 'activate_and_verify', 'rollback', 'resume',
      'effect_reconcile', 'resume_reconcile'
    )),
    claim_revision INTEGER NOT NULL CHECK(typeof(claim_revision) = 'integer' AND claim_revision >= 1),
    claimant_id TEXT NOT NULL CHECK(length(TRIM(claimant_id)) BETWEEN 1 AND 256),
    expected_aggregate_revision INTEGER NOT NULL
      CHECK(typeof(expected_aggregate_revision) = 'integer' AND expected_aggregate_revision >= 1),
    operation_id TEXT NOT NULL CHECK(length(TRIM(operation_id)) BETWEEN 1 AND 256),
    effect_id TEXT CHECK(effect_id IS NULL OR length(TRIM(effect_id)) BETWEEN 1 AND 256),
    expected_owner_revision TEXT CHECK(
      expected_owner_revision IS NULL OR length(TRIM(expected_owner_revision)) BETWEEN 1 AND 512
    ),
    lease_token_sha256 TEXT NOT NULL CHECK(
      length(lease_token_sha256) = 64 AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    lease_expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at, '+0 days') = lease_expires_at),
    status TEXT NOT NULL CHECK(status IN ('active', 'completed')),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
    outcome_sha256 TEXT CHECK(outcome_sha256 IS NULL OR (length(outcome_sha256) = 64 AND outcome_sha256 NOT GLOB '*[^0-9a-f]*')),
    outcome_idempotency_key TEXT CHECK(
      outcome_idempotency_key IS NULL OR length(TRIM(outcome_idempotency_key)) BETWEEN 1 AND 512
    ),
    created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at),
    updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') = updated_at),
    CHECK(updated_at >= created_at AND lease_expires_at >= updated_at),
    CHECK((status = 'active' AND outcome_sha256 IS NULL AND outcome_idempotency_key IS NULL)
      OR (status = 'completed' AND outcome_sha256 IS NOT NULL AND outcome_idempotency_key IS NOT NULL)),
    CHECK((aggregate_kind = 'state' AND aggregate_id = remediation_id
        AND phase <> 'effect_reconcile')
      OR (aggregate_kind = 'reconciliation' AND phase IN ('effect_reconcile', 'resume_reconcile'))),
    CHECK((phase IN ('parent_reserve', 'apply', 'verify', 'activate_and_verify', 'rollback',
      'resume', 'effect_reconcile', 'resume_reconcile')) = (effect_id IS NOT NULL)),
    UNIQUE(aggregate_kind, aggregate_id, phase, expected_aggregate_revision, operation_id)
  );
  CREATE UNIQUE INDEX idx_governed_remediation_phase_claims_active
    ON governed_remediation_phase_claims(aggregate_kind, aggregate_id, phase, expected_aggregate_revision)
    WHERE status = 'active';
  CREATE INDEX idx_governed_remediation_phase_claims_recovery
    ON governed_remediation_phase_claims(status, lease_expires_at, aggregate_kind, aggregate_id);

  CREATE TABLE governed_remediation_phase_claim_acquisitions (
    acquisition_idempotency_key TEXT PRIMARY KEY CHECK(length(TRIM(acquisition_idempotency_key)) BETWEEN 1 AND 512),
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
    claim_id TEXT REFERENCES governed_remediation_phase_claims(claim_id) ON DELETE RESTRICT,
    observed_claim_revision INTEGER CHECK(
      observed_claim_revision IS NULL OR (typeof(observed_claim_revision) = 'integer' AND observed_claim_revision >= 1)
    ),
    disposition TEXT NOT NULL CHECK(disposition IN ('acquired', 'busy', 'stale', 'completed')),
    recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 days') = recorded_at),
    CHECK((claim_id IS NULL) = (observed_claim_revision IS NULL))
  );

  CREATE TRIGGER trg_governed_remediation_phase_claims_insert_guard
  BEFORE INSERT ON governed_remediation_phase_claims
  WHEN NEW.claim_revision <> 1 OR NEW.status <> 'active'
    OR NEW.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    OR julianday(NEW.lease_expires_at) > julianday('now') + (900.0 / 86400.0)
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
        AND (NEW.phase = 'parent_reserve' OR state.effect_id = NEW.effect_id)
    ))
    OR (NEW.aggregate_kind = 'reconciliation' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_reconciliations reconciliation
      JOIN governed_remediation_states state ON state.remediation_id = reconciliation.remediation_id
      WHERE reconciliation.reconciliation_id = NEW.aggregate_id
        AND reconciliation.remediation_id = NEW.remediation_id
        AND reconciliation.revision = NEW.expected_aggregate_revision
        AND reconciliation.state IN ('open', 'quarantined')
        AND state.effect_id = NEW.effect_id
        AND ((NEW.phase = 'effect_reconcile' AND reconciliation.domain = 'effect')
          OR (NEW.phase = 'resume_reconcile' AND reconciliation.domain = 'resume'))
    ))
  BEGIN SELECT RAISE(ABORT, 'governed remediation phase claim aggregate binding violated'); END;

  CREATE TRIGGER trg_governed_remediation_phase_claims_update_guard
  BEFORE UPDATE ON governed_remediation_phase_claims
  WHEN NEW.schema_version <> OLD.schema_version OR NEW.claim_id <> OLD.claim_id
    OR NEW.aggregate_kind <> OLD.aggregate_kind OR NEW.aggregate_id <> OLD.aggregate_id
    OR NEW.remediation_id <> OLD.remediation_id OR NEW.phase <> OLD.phase
    OR NEW.expected_aggregate_revision <> OLD.expected_aggregate_revision
    OR NEW.operation_id <> OLD.operation_id OR NEW.effect_id IS NOT OLD.effect_id
    OR NEW.expected_owner_revision IS NOT OLD.expected_owner_revision
    OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.created_at <> OLD.created_at
    OR NOT (
      (OLD.status = 'active' AND OLD.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND NEW.status = 'active' AND NEW.claim_revision = OLD.claim_revision + 1
        AND NEW.outcome_sha256 IS NULL AND NEW.outcome_idempotency_key IS NULL
        AND NEW.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND julianday(NEW.lease_expires_at) <= julianday('now') + (900.0 / 86400.0))
      OR (OLD.status = 'active' AND NEW.status = 'completed' AND NEW.claim_revision = OLD.claim_revision
        AND NEW.claimant_id = OLD.claimant_id AND NEW.lease_token_sha256 = OLD.lease_token_sha256
        AND NEW.lease_expires_at = OLD.lease_expires_at AND NEW.updated_at >= OLD.updated_at
        AND OLD.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND NEW.updated_at < NEW.lease_expires_at AND NEW.outcome_sha256 IS NOT NULL
        AND NEW.outcome_idempotency_key IS NOT NULL)
    )
  BEGIN SELECT RAISE(ABORT, 'governed remediation phase claim lifecycle violated'); END;

  CREATE TRIGGER trg_governed_remediation_phase_claims_no_delete
  BEFORE DELETE ON governed_remediation_phase_claims
  BEGIN SELECT RAISE(ABORT, 'governed remediation phase claims are immutable'); END;
  CREATE TRIGGER trg_governed_remediation_phase_claim_acquisitions_no_update
  BEFORE UPDATE ON governed_remediation_phase_claim_acquisitions
  BEGIN SELECT RAISE(ABORT, 'governed remediation phase acquisitions are immutable'); END;
  CREATE TRIGGER trg_governed_remediation_phase_claim_acquisitions_no_delete
  BEFORE DELETE ON governed_remediation_phase_claim_acquisitions
  BEGIN SELECT RAISE(ABORT, 'governed remediation phase acquisitions are immutable'); END;
`;

const LINEAGE_GUARDS_SQLITE_SQL = `
  CREATE TRIGGER trg_governed_remediation_states_v2_insert_guard
  BEFORE INSERT ON governed_remediation_states
  WHEN NEW.state <> 'blocked' OR NEW.parent_reservation_id IS NOT NULL
    OR NEW.prompt_id IS NOT NULL OR NEW.prompt_expires_at IS NOT NULL
    OR NEW.pre_effect_approval_id IS NOT NULL OR NEW.activation_approval_id IS NOT NULL
    OR NEW.effect_id IS NOT NULL OR NEW.latest_receipt_id IS NOT NULL
    OR NEW.failure_id IS NOT NULL OR NEW.reconciliation_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'governed remediation v2 state creation authority violated'); END;

  CREATE TRIGGER trg_governed_remediation_receipts_lineage_guard
  BEFORE INSERT ON governed_remediation_receipts
  WHEN (NEW.kind = 'verification' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts application
      JOIN governed_remediation_states state ON state.remediation_id = NEW.remediation_id
      WHERE application.receipt_id = NEW.application_receipt_id AND application.kind = 'application'
        AND application.remediation_id = NEW.remediation_id AND application.recipe_id = NEW.recipe_id
        AND application.recipe_version = NEW.recipe_version AND application.deployment_id = NEW.deployment_id
        AND application.scope_kind = NEW.scope_kind AND application.scope_id = NEW.scope_id
        AND application.target_id = NEW.target_id AND application.effect_id = state.effect_id
        AND (
          (NEW.activation_receipt_id IS NULL
            AND application.owner_revision_after = NEW.owner_revision_observed)
          OR EXISTS (
            SELECT 1 FROM governed_remediation_receipts activation
            WHERE activation.receipt_id = NEW.activation_receipt_id AND activation.kind = 'activation'
              AND activation.application_receipt_id = application.receipt_id
              AND activation.owner_revision_after = NEW.owner_revision_observed
              AND activation.remediation_id = NEW.remediation_id
          )
        )
    ))
    OR (NEW.kind = 'activation' AND NOT EXISTS (
      SELECT 1
      FROM governed_remediation_receipts application
      JOIN governed_remediation_receipts verification
        ON verification.receipt_id = NEW.verification_receipt_id
      WHERE application.receipt_id = NEW.application_receipt_id AND application.kind = 'application'
        AND application.remediation_id = NEW.remediation_id
        AND verification.kind = 'verification' AND verification.remediation_id = NEW.remediation_id
        AND verification.application_receipt_id = application.receipt_id
        AND verification.activation_receipt_id IS NULL
        AND verification.owner_revision_observed = NEW.owner_revision_before
    ))
    OR (NEW.kind = 'rollback' AND NOT EXISTS (
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
    ))
    OR (NEW.kind = 'resume' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts verification
      JOIN governed_remediation_states state ON state.remediation_id = NEW.remediation_id
      WHERE verification.receipt_id = NEW.verification_receipt_id AND verification.kind = 'verification'
        AND verification.remediation_id = NEW.remediation_id AND verification.recipe_id = NEW.recipe_id
        AND verification.recipe_version = NEW.recipe_version AND verification.deployment_id = NEW.deployment_id
        AND verification.scope_kind = NEW.scope_kind AND verification.scope_id = NEW.scope_id
        AND verification.target_id = NEW.target_id AND NEW.durable_run_id = state.durable_run_id
        AND NEW.blocked_checkpoint_id = state.blocked_checkpoint_id
        AND NEW.resumed_run_version = state.expected_waiting_run_version + 1
    ))
    OR (NEW.kind = 'reconciliation' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_reconciliations reconciliation
      JOIN governed_remediation_failures failure ON failure.failure_id = NEW.failure_id
      WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
        AND reconciliation.remediation_id = NEW.remediation_id AND reconciliation.failure_id = NEW.failure_id
        AND ((reconciliation.domain = 'effect' AND NEW.resolution IN (
              'confirmed_no_effect', 'confirmed_rolled_back', 'confirmed_verified'))
          OR (reconciliation.domain = 'resume' AND NEW.resolution IN (
              'confirmed_resumed', 'confirmed_not_resumed')))
        AND (NEW.application_receipt_id IS NULL OR EXISTS (
          SELECT 1 FROM governed_remediation_receipts application
          WHERE application.receipt_id = NEW.application_receipt_id AND application.kind = 'application'
            AND application.remediation_id = NEW.remediation_id
        ))
        AND (NEW.resume_receipt_id IS NULL OR EXISTS (
          SELECT 1 FROM governed_remediation_receipts resume
          WHERE resume.receipt_id = NEW.resume_receipt_id AND resume.kind = 'resume'
            AND resume.remediation_id = NEW.remediation_id
        ))
    ))
  BEGIN SELECT RAISE(ABORT, 'governed remediation receipt lineage violated'); END;

  CREATE TRIGGER trg_governed_remediation_states_authority_lineage_guard
  BEFORE UPDATE ON governed_remediation_states
  WHEN (((OLD.parent_reservation_id IS NULL AND NEW.parent_reservation_id IS NOT NULL)
      OR (OLD.effect_id IS NULL AND NEW.effect_id IS NOT NULL))
    AND (NEW.state <> 'applying' OR NEW.parent_reservation_id IS NULL OR NEW.effect_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM governed_remediation_phase_claims claim
        WHERE claim.aggregate_kind = 'state' AND claim.aggregate_id = OLD.remediation_id
          AND claim.phase = 'parent_reserve' AND claim.expected_aggregate_revision = OLD.revision
          AND claim.effect_id = NEW.effect_id AND claim.status = 'active'
          AND claim.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )))
    OR (NEW.state = 'completed' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.latest_receipt_id AND receipt.kind = 'resume'
        AND receipt.remediation_id = OLD.remediation_id AND receipt.durable_run_id = OLD.durable_run_id
        AND receipt.blocked_checkpoint_id = OLD.blocked_checkpoint_id
        AND receipt.resumed_run_version = OLD.expected_waiting_run_version + 1
    ))
    OR (NEW.state = 'rolled_back' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_receipts receipt
      WHERE receipt.receipt_id = NEW.latest_receipt_id AND receipt.kind = 'rollback'
        AND receipt.remediation_id = OLD.remediation_id
    ))
    OR (NEW.state = 'reconciling_resume' AND NOT EXISTS (
      SELECT 1 FROM governed_remediation_reconciliations reconciliation
      WHERE reconciliation.reconciliation_id = NEW.reconciliation_id
        AND reconciliation.remediation_id = OLD.remediation_id AND reconciliation.domain = 'resume'
    ))
  BEGIN SELECT RAISE(ABORT, 'governed remediation state authority lineage violated'); END;
`;

function assertGovernedRemediationOwnerIsEmpty(db: DatabaseSync): void {
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM governed_remediation_states)
        + (SELECT COUNT(*) FROM governed_remediation_receipts)
        + (SELECT COUNT(*) FROM governed_remediation_failures)
        + (SELECT COUNT(*) FROM governed_remediation_reconciliations)
        + (SELECT COUNT(*) FROM governed_remediation_cas_transitions) AS row_count`,
    )
    .get() as { row_count: number | bigint };
  if (Number(row.row_count) !== 0) {
    throw new Error(
      "SQLite migration 192 refuses non-empty governed-remediation v1 rows because requester, recipe, approval, and rollback authority cannot be reconstructed.",
    );
  }
}

function readSql(db: DatabaseSync, type: "table" | "trigger", name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) as
    | { sql?: string }
    | undefined;
  if (!row?.sql) throw new Error(`SQLite migration 192 requires governed-remediation ${type} ${name}.`);
  return row.sql;
}

function readGovernedTriggers(db: DatabaseSync): Array<{ name: string; sql: string }> {
  return db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'trg_governed_remediation_%' ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>;
}

function replaceRequired(sql: string, from: string, to: string, label: string): string {
  if (!sql.includes(from)) throw new Error(`SQLite migration 192 found an unsupported ${label} shape.`);
  return sql.replace(from, to);
}
