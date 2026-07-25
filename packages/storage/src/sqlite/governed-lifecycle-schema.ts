import type { DatabaseSync } from "node:sqlite";

/**
 * HX-402 P0 shared immutable lifecycle foundation (SQLite 175; paired with
 * PostgreSQL 117). Additive only: five new append-only tables, their frozen
 * kind-registry/fencing insert guards, and no-update/no-delete triggers. No
 * existing table is altered.
 *
 * The governed-mutation kind rows below are a FROZEN literal copy of
 * `GOVERNED_MUTATION_KINDS` in `@goatcitadel/contracts` at the time this
 * migration was authored. They are intentionally not generated from the live
 * contract so the committed migration can never drift; the
 * journey-producer-schema-parity suite proves the copy stays byte-aligned
 * with the contract and the PostgreSQL 117 twin. Extending the registry
 * requires a NEW migration pair.
 */
export function createGovernedLifecycleSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE governed_lifecycle_events (
      schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.governed-lifecycle-event.v1'),
      event_id TEXT PRIMARY KEY CHECK(length(TRIM(event_id)) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
      domain TEXT NOT NULL CHECK(domain IN ('memory', 'skill_state', 'capability_state', 'improvement')),
      operation TEXT NOT NULL CHECK(length(TRIM(operation)) BETWEEN 1 AND 128),
      target_kind TEXT NOT NULL CHECK(length(TRIM(target_kind)) BETWEEN 1 AND 128),
      target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
      material_sha256 TEXT NOT NULL CHECK(length(material_sha256) = 64 AND material_sha256 NOT GLOB '*[^0-9a-f]*'),
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace', 'global')),
      workspace_id TEXT,
      actor_id TEXT NOT NULL CHECK(length(TRIM(actor_id)) BETWEEN 1 AND 256),
      actor_type TEXT NOT NULL CHECK(actor_type IN ('operator', 'system', 'approval_effect')),
      session_id TEXT CHECK(session_id IS NULL OR length(TRIM(session_id)) BETWEEN 1 AND 256),
      turn_id TEXT CHECK(turn_id IS NULL OR length(TRIM(turn_id)) BETWEEN 1 AND 256),
      source_required INTEGER NOT NULL CHECK(source_required IN (0, 1)),
      approval_required INTEGER NOT NULL CHECK(approval_required IN (0, 1)),
      source_kind TEXT CHECK(source_kind IS NULL OR length(TRIM(source_kind)) BETWEEN 1 AND 128),
      source_id TEXT CHECK(source_id IS NULL OR length(TRIM(source_id)) BETWEEN 1 AND 256),
      approval_id TEXT CHECK(approval_id IS NULL OR length(TRIM(approval_id)) BETWEEN 1 AND 256),
      occurred_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') = occurred_at
      ),
      recorded_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at, '+0 days') = recorded_at
      ),
      CHECK(
        (scope_kind = 'workspace' AND workspace_id IS NOT NULL AND length(TRIM(workspace_id)) BETWEEN 1 AND 256)
        OR (scope_kind = 'global' AND workspace_id IS NULL)
      ),
      CHECK(turn_id IS NULL OR session_id IS NOT NULL),
      CHECK(
        (approval_required = 1 AND approval_id IS NOT NULL)
        OR (approval_required = 0 AND approval_id IS NULL)
      ),
      CHECK(source_required = 0 OR (source_kind IS NOT NULL AND source_id IS NOT NULL)),
      CHECK(
        (source_kind IS NULL AND source_id IS NULL)
        OR (source_kind IS NOT NULL AND source_id IS NOT NULL)
      )
    );

    CREATE INDEX idx_governed_lifecycle_events_scope_recorded
      ON governed_lifecycle_events(workspace_id, recorded_at DESC, event_id DESC);
    CREATE INDEX idx_governed_lifecycle_events_target
      ON governed_lifecycle_events(domain, target_kind, target_id, recorded_at DESC, event_id DESC);
    CREATE INDEX idx_governed_lifecycle_events_approval
      ON governed_lifecycle_events(approval_id);

    CREATE TRIGGER trg_governed_lifecycle_events_kind_guard
    BEFORE INSERT ON governed_lifecycle_events
    WHEN NOT EXISTS (
      SELECT 1 FROM (
        SELECT 'memory' AS domain, 'item_updated' AS operation, 'memory_item' AS target_kind,
               1 AS source_required, 1 AS approval_required, 0 AS system_actor_only
        UNION ALL SELECT 'memory', 'pin_changed', 'memory_item', 1, 1, 0
        UNION ALL SELECT 'memory', 'ttl_changed', 'memory_item', 1, 1, 0
        UNION ALL SELECT 'memory', 'item_forgotten', 'memory_item', 1, 1, 0
        UNION ALL SELECT 'memory', 'batch_mutated', 'memory_batch', 1, 1, 0
        UNION ALL SELECT 'memory', 'maintenance_expired', 'memory_item', 1, 0, 1
        UNION ALL SELECT 'memory', 'entity_created', 'memory_entity', 1, 1, 0
        UNION ALL SELECT 'memory', 'entity_forgotten', 'memory_entity', 1, 1, 0
        UNION ALL SELECT 'memory', 'relation_created', 'memory_relation', 1, 1, 0
        UNION ALL SELECT 'memory', 'decision_created', 'memory_decision', 1, 1, 0
        UNION ALL SELECT 'memory', 'decision_retrospective_added', 'memory_decision', 1, 1, 0
        UNION ALL SELECT 'memory', 'decision_forgotten', 'memory_decision', 1, 1, 0
        UNION ALL SELECT 'memory', 'learning_created', 'memory_learning', 1, 1, 0
        UNION ALL SELECT 'memory', 'learning_superseded', 'memory_learning', 1, 1, 0
        UNION ALL SELECT 'memory', 'learning_forgotten', 'memory_learning', 1, 1, 0
        UNION ALL SELECT 'memory', 'trace_candidate_promoted', 'memory_learning', 1, 1, 0
        UNION ALL SELECT 'memory', 'session_learned_updated', 'session_learned_memory', 1, 1, 0
        UNION ALL SELECT 'skill_state', 'enabled', 'skill', 1, 1, 0
        UNION ALL SELECT 'skill_state', 'disabled', 'skill', 1, 1, 0
        UNION ALL SELECT 'skill_state', 'slept', 'skill', 1, 1, 0
        UNION ALL SELECT 'skill_state', 'auto_set', 'skill', 1, 1, 0
        UNION ALL SELECT 'skill_state', 'activation_policy_updated', 'skill_activation_policy', 1, 1, 0
        UNION ALL SELECT 'skill_state', 'system_disabled', 'skill', 1, 0, 1
        UNION ALL SELECT 'capability_state', 'proposal_created', 'capability_proposal', 1, 0, 0
        UNION ALL SELECT 'capability_state', 'candidate_promoted', 'capability_candidate', 1, 1, 0
        UNION ALL SELECT 'capability_state', 'candidate_revoked', 'capability_candidate', 1, 1, 0
        UNION ALL SELECT 'capability_state', 'candidate_rolled_back', 'capability_candidate', 1, 1, 0
        UNION ALL SELECT 'capability_state', 'system_revoked', 'capability_candidate', 1, 0, 1
        UNION ALL SELECT 'improvement', 'activation_applied', 'improvement_activation', 1, 1, 0
        UNION ALL SELECT 'improvement', 'activation_paused', 'improvement_activation', 1, 1, 0
        UNION ALL SELECT 'improvement', 'activation_rolled_back', 'improvement_activation', 1, 1, 0
        UNION ALL SELECT 'improvement', 'activation_failed', 'improvement_activation', 1, 1, 0
      ) AS kind_registry
      WHERE kind_registry.domain = NEW.domain
        AND kind_registry.operation = NEW.operation
        AND kind_registry.target_kind = NEW.target_kind
        AND kind_registry.source_required = NEW.source_required
        AND kind_registry.approval_required = NEW.approval_required
        AND (kind_registry.system_actor_only = 0 OR NEW.actor_type = 'system')
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed lifecycle event kind is not in the frozen registry');
    END;

    CREATE TRIGGER trg_governed_lifecycle_events_no_update
    BEFORE UPDATE ON governed_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'governed lifecycle events are immutable'); END;
    CREATE TRIGGER trg_governed_lifecycle_events_no_delete
    BEFORE DELETE ON governed_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'governed lifecycle events are immutable'); END;

    CREATE TABLE improvement_lifecycle_operations (
      operation_id TEXT PRIMARY KEY CHECK(length(TRIM(operation_id)) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
      workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('activate', 'pause', 'rollback')),
      target_kind TEXT NOT NULL CHECK(target_kind IN ('improvement_activation', 'improvement_candidate')),
      target_id TEXT NOT NULL CHECK(length(TRIM(target_id)) BETWEEN 1 AND 256),
      approval_id TEXT NOT NULL UNIQUE CHECK(length(TRIM(approval_id)) BETWEEN 1 AND 256),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      actor_id TEXT NOT NULL CHECK(length(TRIM(actor_id)) BETWEEN 1 AND 256),
      session_id TEXT CHECK(session_id IS NULL OR length(TRIM(session_id)) BETWEEN 1 AND 256),
      turn_id TEXT CHECK(turn_id IS NULL OR length(TRIM(turn_id)) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      CHECK(turn_id IS NULL OR session_id IS NOT NULL)
    );

    CREATE INDEX idx_improvement_lifecycle_operations_workspace_created
      ON improvement_lifecycle_operations(workspace_id, created_at DESC, operation_id DESC);
    CREATE INDEX idx_improvement_lifecycle_operations_target
      ON improvement_lifecycle_operations(target_kind, target_id, created_at DESC);

    CREATE TRIGGER trg_improvement_lifecycle_operations_no_update
    BEFORE UPDATE ON improvement_lifecycle_operations
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle operations are immutable'); END;
    CREATE TRIGGER trg_improvement_lifecycle_operations_no_delete
    BEFORE DELETE ON improvement_lifecycle_operations
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle operations are immutable'); END;

    CREATE TABLE improvement_lifecycle_operation_claims (
      operation_id TEXT NOT NULL REFERENCES improvement_lifecycle_operations(operation_id) ON DELETE RESTRICT,
      claim_generation INTEGER NOT NULL CHECK(typeof(claim_generation) = 'integer' AND claim_generation > 0),
      worker_id TEXT NOT NULL CHECK(length(TRIM(worker_id)) BETWEEN 1 AND 256),
      claimed_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') = claimed_at
      ),
      lease_expires_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at, '+0 days') = lease_expires_at
      ),
      PRIMARY KEY(operation_id, claim_generation),
      CHECK(lease_expires_at > claimed_at)
    );

    CREATE TRIGGER trg_improvement_lifecycle_operation_claims_no_update
    BEFORE UPDATE ON improvement_lifecycle_operation_claims
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle claims are immutable'); END;
    CREATE TRIGGER trg_improvement_lifecycle_operation_claims_no_delete
    BEFORE DELETE ON improvement_lifecycle_operation_claims
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle claims are immutable'); END;

    CREATE TABLE improvement_lifecycle_operation_inspections (
      inspection_id TEXT PRIMARY KEY CHECK(length(TRIM(inspection_id)) BETWEEN 1 AND 256),
      operation_id TEXT NOT NULL,
      claim_generation INTEGER NOT NULL CHECK(typeof(claim_generation) = 'integer' AND claim_generation > 0),
      observed_state_sha256 TEXT NOT NULL CHECK(
        length(observed_state_sha256) = 64 AND observed_state_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      disposition TEXT NOT NULL CHECK(disposition IN ('matches_intent', 'diverged', 'unreachable')),
      observed_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at, '+0 days') = observed_at
      ),
      FOREIGN KEY(operation_id, claim_generation)
        REFERENCES improvement_lifecycle_operation_claims(operation_id, claim_generation) ON DELETE RESTRICT
    );

    CREATE INDEX idx_improvement_lifecycle_operation_inspections_operation
      ON improvement_lifecycle_operation_inspections(operation_id, claim_generation, observed_at DESC);

    CREATE TRIGGER trg_improvement_lifecycle_operation_inspections_no_update
    BEFORE UPDATE ON improvement_lifecycle_operation_inspections
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle inspections are immutable'); END;
    CREATE TRIGGER trg_improvement_lifecycle_operation_inspections_no_delete
    BEFORE DELETE ON improvement_lifecycle_operation_inspections
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle inspections are immutable'); END;

    CREATE TABLE improvement_lifecycle_operation_settlements (
      settlement_id TEXT PRIMARY KEY CHECK(length(TRIM(settlement_id)) BETWEEN 1 AND 256),
      operation_id TEXT NOT NULL UNIQUE REFERENCES improvement_lifecycle_operations(operation_id) ON DELETE RESTRICT,
      claim_generation INTEGER NOT NULL CHECK(typeof(claim_generation) = 'integer' AND claim_generation > 0),
      inspection_id TEXT NOT NULL UNIQUE
        REFERENCES improvement_lifecycle_operation_inspections(inspection_id) ON DELETE RESTRICT,
      disposition TEXT NOT NULL CHECK(disposition IN ('applied', 'failed', 'aborted')),
      observed_state_sha256 TEXT NOT NULL CHECK(
        length(observed_state_sha256) = 64 AND observed_state_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) <= 16384),
      result_sha256 TEXT NOT NULL CHECK(length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'),
      settled_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', settled_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', settled_at, '+0 days') = settled_at
      ),
      FOREIGN KEY(operation_id, claim_generation)
        REFERENCES improvement_lifecycle_operation_claims(operation_id, claim_generation) ON DELETE RESTRICT
    );

    CREATE TRIGGER trg_improvement_lifecycle_operation_claims_insert_guard
    BEFORE INSERT ON improvement_lifecycle_operation_claims
    WHEN EXISTS (
        SELECT 1 FROM improvement_lifecycle_operation_settlements settlement
        WHERE settlement.operation_id = NEW.operation_id
      )
      OR NEW.claim_generation <> (
        SELECT COALESCE(MAX(prior.claim_generation), 0) + 1
        FROM improvement_lifecycle_operation_claims prior
        WHERE prior.operation_id = NEW.operation_id
      )
      OR EXISTS (
        SELECT 1 FROM improvement_lifecycle_operation_claims prior
        WHERE prior.operation_id = NEW.operation_id
          AND prior.claim_generation = NEW.claim_generation - 1
          AND prior.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    BEGIN
      SELECT RAISE(ABORT, 'improvement lifecycle claim admission violated: settled, non-sequential, or live prior lease');
    END;

    CREATE TRIGGER trg_improvement_lifecycle_operation_inspections_insert_guard
    BEFORE INSERT ON improvement_lifecycle_operation_inspections
    WHEN EXISTS (
        SELECT 1 FROM improvement_lifecycle_operation_settlements settlement
        WHERE settlement.operation_id = NEW.operation_id
      )
      OR NEW.claim_generation <> (
        SELECT MAX(claim.claim_generation)
        FROM improvement_lifecycle_operation_claims claim
        WHERE claim.operation_id = NEW.operation_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'improvement lifecycle inspection admission violated: settled or fenced stale claim');
    END;

    CREATE TRIGGER trg_improvement_lifecycle_operation_settlements_insert_guard
    BEFORE INSERT ON improvement_lifecycle_operation_settlements
    WHEN NEW.claim_generation <> (
        SELECT MAX(claim.claim_generation)
        FROM improvement_lifecycle_operation_claims claim
        WHERE claim.operation_id = NEW.operation_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM improvement_lifecycle_operation_inspections inspection
        WHERE inspection.inspection_id = NEW.inspection_id
          AND inspection.operation_id = NEW.operation_id
          AND inspection.claim_generation = NEW.claim_generation
          AND inspection.observed_state_sha256 = NEW.observed_state_sha256
      )
      OR (
        NEW.disposition = 'applied'
        AND NOT EXISTS (
          SELECT 1 FROM improvement_lifecycle_operation_inspections inspection
          WHERE inspection.inspection_id = NEW.inspection_id
            AND inspection.disposition = 'matches_intent'
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'improvement lifecycle settlement admission violated: fenced claim, missing re-inspection, or false applied claim');
    END;

    CREATE TRIGGER trg_improvement_lifecycle_operation_settlements_no_update
    BEFORE UPDATE ON improvement_lifecycle_operation_settlements
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle settlements are immutable'); END;
    CREATE TRIGGER trg_improvement_lifecycle_operation_settlements_no_delete
    BEFORE DELETE ON improvement_lifecycle_operation_settlements
    BEGIN SELECT RAISE(ABORT, 'improvement lifecycle settlements are immutable'); END;
  `);
}
