interface SqlExecutor {
  exec(sql: string): void;
}

/**
 * Canonical Evolution Control Plane ledger. Plans are mutable only through
 * revisioned CAS updates; events and links are append-only evidence.
 */
export function createChangePlanSchema(db: SqlExecutor): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_plans (
      schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version >= 1),
      plan_id TEXT PRIMARY KEY,
      origin_surface TEXT NOT NULL CHECK(origin_surface IN ('chat', 'settings', 'system')),
      workspace_id TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      requester_actor_id TEXT,
      request_id TEXT,
      idempotency_key TEXT,
      adapter_id TEXT NOT NULL,
      adapter_version INTEGER NOT NULL CHECK(typeof(adapter_version) = 'integer' AND adapter_version >= 1),
      kind TEXT NOT NULL CHECK(kind IN (
        'session_model', 'installation_default_model', 'provider_connection', 'runtime_configuration',
        'channel_connection', 'runtime_remediation', 'capability_candidate', 'improvement_candidate',
        'managed_source_registration', 'product_source_update'
      )),
      scope TEXT NOT NULL CHECK(scope IN (
        'current_chat', 'installation', 'provider', 'runtime', 'channel', 'remediation',
        'capability', 'improvement', 'product_source'
      )),
      status TEXT NOT NULL CHECK(status IN (
        'draft', 'awaiting_input', 'awaiting_confirmation', 'staging', 'awaiting_approval',
        'applying', 'verifying', 'monitoring', 'completed', 'applied', 'manual_required',
        'failed', 'cancelled', 'rolling_back', 'rolled_back', 'rollback_failed'
      )),
      phase TEXT NOT NULL CHECK(phase IN (
        'planning', 'input', 'confirmation', 'staging', 'authorization', 'mutation',
        'validation', 'monitoring', 'recovery', 'terminal'
      )),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 1),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
      intent_hash TEXT NOT NULL CHECK(length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*'),
      target_owner_id TEXT NOT NULL,
      target_resource_id TEXT NOT NULL,
      expected_target_revision INTEGER CHECK(
        expected_target_revision IS NULL OR (typeof(expected_target_revision) = 'integer' AND expected_target_revision >= 1)
      ),
      expected_target_hash TEXT CHECK(
        expected_target_hash IS NULL OR (length(expected_target_hash) = 64 AND expected_target_hash NOT GLOB '*[^0-9a-f]*')
      ),
      active_target_key TEXT CHECK(
        active_target_key IS NULL OR (length(active_target_key) = 64 AND active_target_key NOT GLOB '*[^0-9a-f]*')
      ),
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 180),
      summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 1 AND 2000),
      impact TEXT NOT NULL CHECK(length(trim(impact)) BETWEEN 1 AND 2000),
      risk TEXT NOT NULL CHECK(risk IN ('safe', 'caution', 'danger')),
      required_action_json TEXT CHECK(
        required_action_json IS NULL OR (json_valid(required_action_json) AND json_type(required_action_json) = 'object')
      ),
      action_snapshot_hash TEXT CHECK(
        action_snapshot_hash IS NULL OR (length(action_snapshot_hash) = 64 AND action_snapshot_hash NOT GLOB '*[^0-9a-f]*')
      ),
      action_nonce_hash TEXT CHECK(
        action_nonce_hash IS NULL OR (length(action_nonce_hash) = 64 AND action_nonce_hash NOT GLOB '*[^0-9a-f]*')
      ),
      approval_refs_json TEXT NOT NULL CHECK(json_valid(approval_refs_json) AND json_type(approval_refs_json) = 'array'),
      evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json) AND json_type(evidence_refs_json) = 'array'),
      rollback_refs_json TEXT NOT NULL CHECK(json_valid(rollback_refs_json) AND json_type(rollback_refs_json) = 'array'),
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      CHECK(
        (required_action_json IS NULL AND action_snapshot_hash IS NULL AND action_nonce_hash IS NULL)
        OR (required_action_json IS NOT NULL AND action_snapshot_hash IS NOT NULL AND action_nonce_hash IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_change_plans_workspace_idempotency
      ON change_plans(workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_change_plans_active_target
      ON change_plans(active_target_key)
      WHERE active_target_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_change_plans_workspace_created
      ON change_plans(workspace_id, created_at DESC, plan_id DESC);
    CREATE INDEX IF NOT EXISTS idx_change_plans_session_created
      ON change_plans(workspace_id, session_id, created_at DESC, plan_id DESC);
    CREATE INDEX IF NOT EXISTS idx_change_plans_active_recovery
      ON change_plans(status, updated_at ASC, plan_id ASC)
      WHERE active_target_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS change_plan_events (
      event_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence >= 1),
      from_status TEXT,
      to_status TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(length(trim(event_type)) BETWEEN 1 AND 128),
      actor_id TEXT,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
      created_at TEXT NOT NULL,
      UNIQUE(plan_id, sequence),
      FOREIGN KEY(plan_id) REFERENCES change_plans(plan_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_change_plan_events_plan_sequence
      ON change_plan_events(plan_id, sequence ASC);

    CREATE TABLE IF NOT EXISTS change_plan_links (
      plan_id TEXT NOT NULL,
      link_kind TEXT NOT NULL CHECK(link_kind IN ('approval', 'evidence', 'rollback', 'owner')),
      link_id TEXT NOT NULL,
      material_hash TEXT CHECK(
        material_hash IS NULL OR (length(material_hash) = 64 AND material_hash NOT GLOB '*[^0-9a-f]*')
      ),
      created_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, link_kind, link_id),
      FOREIGN KEY(plan_id) REFERENCES change_plans(plan_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_change_plan_links_kind
      ON change_plan_links(link_kind, link_id, created_at);

    CREATE TRIGGER IF NOT EXISTS trg_change_plan_events_no_update
    BEFORE UPDATE ON change_plan_events BEGIN
      SELECT RAISE(ABORT, 'change plan events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_change_plan_events_no_delete
    BEFORE DELETE ON change_plan_events BEGIN
      SELECT RAISE(ABORT, 'change plan events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_change_plan_links_no_update
    BEFORE UPDATE ON change_plan_links BEGIN
      SELECT RAISE(ABORT, 'change plan links are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_change_plan_links_no_delete
    BEFORE DELETE ON change_plan_links BEGIN
      SELECT RAISE(ABORT, 'change plan links are immutable');
    END;
  `);
}

export const CHANGE_PLAN_POSTGRES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS change_plans (
    schema_version BIGINT NOT NULL CHECK(schema_version >= 1),
    plan_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(plan_id)) BETWEEN 1 AND 256),
    origin_surface TEXT NOT NULL CHECK(origin_surface IN ('chat', 'settings', 'system')),
    workspace_id TEXT NOT NULL CHECK(char_length(BTRIM(workspace_id)) BETWEEN 1 AND 256),
    session_id TEXT CHECK(session_id IS NULL OR char_length(BTRIM(session_id)) BETWEEN 1 AND 256),
    turn_id TEXT CHECK(turn_id IS NULL OR char_length(BTRIM(turn_id)) BETWEEN 1 AND 256),
    requester_actor_id TEXT CHECK(requester_actor_id IS NULL OR char_length(BTRIM(requester_actor_id)) BETWEEN 1 AND 256),
    request_id TEXT CHECK(request_id IS NULL OR char_length(BTRIM(request_id)) BETWEEN 1 AND 256),
    idempotency_key TEXT CHECK(idempotency_key IS NULL OR char_length(BTRIM(idempotency_key)) BETWEEN 1 AND 512),
    adapter_id TEXT NOT NULL CHECK(char_length(BTRIM(adapter_id)) BETWEEN 1 AND 256),
    adapter_version BIGINT NOT NULL CHECK(adapter_version >= 1),
    kind TEXT NOT NULL CHECK(kind IN (
      'session_model', 'installation_default_model', 'provider_connection', 'runtime_configuration',
      'channel_connection', 'runtime_remediation', 'capability_candidate', 'improvement_candidate',
      'managed_source_registration', 'product_source_update'
    )),
    scope TEXT NOT NULL CHECK(scope IN (
      'current_chat', 'installation', 'provider', 'runtime', 'channel', 'remediation',
      'capability', 'improvement', 'product_source'
    )),
    status TEXT NOT NULL CHECK(status IN (
      'draft', 'awaiting_input', 'awaiting_confirmation', 'staging', 'awaiting_approval',
      'applying', 'verifying', 'monitoring', 'completed', 'applied', 'manual_required',
      'failed', 'cancelled', 'rolling_back', 'rolled_back', 'rollback_failed'
    )),
    phase TEXT NOT NULL CHECK(phase IN (
      'planning', 'input', 'confirmation', 'staging', 'authorization', 'mutation',
      'validation', 'monitoring', 'recovery', 'terminal'
    )),
    revision BIGINT NOT NULL CHECK(revision >= 1),
    request_json TEXT NOT NULL CHECK(jsonb_typeof(request_json::jsonb) = 'object' AND octet_length(request_json) <= 32768),
    intent_hash TEXT NOT NULL CHECK(intent_hash ~ '^[0-9a-f]{64}$'),
    target_owner_id TEXT NOT NULL CHECK(char_length(BTRIM(target_owner_id)) BETWEEN 1 AND 256),
    target_resource_id TEXT NOT NULL CHECK(char_length(BTRIM(target_resource_id)) BETWEEN 1 AND 256),
    expected_target_revision BIGINT CHECK(expected_target_revision IS NULL OR expected_target_revision >= 1),
    expected_target_hash TEXT CHECK(expected_target_hash IS NULL OR expected_target_hash ~ '^[0-9a-f]{64}$'),
    active_target_key TEXT CHECK(active_target_key IS NULL OR active_target_key ~ '^[0-9a-f]{64}$'),
    title TEXT NOT NULL CHECK(char_length(BTRIM(title)) BETWEEN 1 AND 180),
    summary TEXT NOT NULL CHECK(char_length(BTRIM(summary)) BETWEEN 1 AND 2000),
    impact TEXT NOT NULL CHECK(char_length(BTRIM(impact)) BETWEEN 1 AND 2000),
    risk TEXT NOT NULL CHECK(risk IN ('safe', 'caution', 'danger')),
    required_action_json TEXT CHECK(required_action_json IS NULL OR (jsonb_typeof(required_action_json::jsonb) = 'object' AND octet_length(required_action_json) <= 32768)),
    action_snapshot_hash TEXT CHECK(action_snapshot_hash IS NULL OR action_snapshot_hash ~ '^[0-9a-f]{64}$'),
    action_nonce_hash TEXT CHECK(action_nonce_hash IS NULL OR action_nonce_hash ~ '^[0-9a-f]{64}$'),
    approval_refs_json TEXT NOT NULL CHECK(jsonb_typeof(approval_refs_json::jsonb) = 'array' AND octet_length(approval_refs_json) <= 32768),
    evidence_refs_json TEXT NOT NULL CHECK(jsonb_typeof(evidence_refs_json::jsonb) = 'array' AND octet_length(evidence_refs_json) <= 32768),
    rollback_refs_json TEXT NOT NULL CHECK(jsonb_typeof(rollback_refs_json::jsonb) = 'array' AND octet_length(rollback_refs_json) <= 32768),
    result_json TEXT CHECK(result_json IS NULL OR (jsonb_typeof(result_json::jsonb) = 'object' AND octet_length(result_json) <= 32768)),
    expires_at TEXT,
    created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK(char_length(BTRIM(updated_at)) > 0),
    applied_at TEXT,
    CHECK(
      (required_action_json IS NULL AND action_snapshot_hash IS NULL AND action_nonce_hash IS NULL)
      OR (required_action_json IS NOT NULL AND action_snapshot_hash IS NOT NULL AND action_nonce_hash IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_change_plans_workspace_idempotency
    ON change_plans(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_change_plans_active_target
    ON change_plans(active_target_key) WHERE active_target_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_change_plans_workspace_created
    ON change_plans(workspace_id, created_at DESC, plan_id DESC);
  CREATE INDEX IF NOT EXISTS idx_change_plans_session_created
    ON change_plans(workspace_id, session_id, created_at DESC, plan_id DESC);
  CREATE INDEX IF NOT EXISTS idx_change_plans_active_recovery
    ON change_plans(status, updated_at ASC, plan_id ASC) WHERE active_target_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS change_plan_events (
    event_id TEXT PRIMARY KEY CHECK(char_length(BTRIM(event_id)) BETWEEN 1 AND 256),
    plan_id TEXT NOT NULL REFERENCES change_plans(plan_id) ON DELETE RESTRICT,
    sequence BIGINT NOT NULL CHECK(sequence >= 1),
    from_status TEXT,
    to_status TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(char_length(BTRIM(event_type)) BETWEEN 1 AND 128),
    actor_id TEXT,
    payload_json TEXT NOT NULL CHECK(jsonb_typeof(payload_json::jsonb) = 'object' AND octet_length(payload_json) <= 16384),
    created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
    UNIQUE(plan_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_change_plan_events_plan_sequence
    ON change_plan_events(plan_id, sequence ASC);

  CREATE TABLE IF NOT EXISTS change_plan_links (
    plan_id TEXT NOT NULL REFERENCES change_plans(plan_id) ON DELETE RESTRICT,
    link_kind TEXT NOT NULL CHECK(link_kind IN ('approval', 'evidence', 'rollback', 'owner')),
    link_id TEXT NOT NULL CHECK(char_length(BTRIM(link_id)) BETWEEN 1 AND 512),
    material_hash TEXT CHECK(material_hash IS NULL OR material_hash ~ '^[0-9a-f]{64}$'),
    created_at TEXT NOT NULL CHECK(char_length(BTRIM(created_at)) > 0),
    PRIMARY KEY(plan_id, link_kind, link_id)
  );
  CREATE INDEX IF NOT EXISTS idx_change_plan_links_kind
    ON change_plan_links(link_kind, link_id, created_at);

  CREATE OR REPLACE FUNCTION gc_reject_change_plan_evidence_mutation()
  RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'change plan evidence is append-only' USING ERRCODE = '23514';
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_change_plan_events_no_update ON change_plan_events;
  CREATE TRIGGER trg_change_plan_events_no_update BEFORE UPDATE OR DELETE ON change_plan_events
    FOR EACH ROW EXECUTE FUNCTION gc_reject_change_plan_evidence_mutation();
  DROP TRIGGER IF EXISTS trg_change_plan_links_no_update ON change_plan_links;
  CREATE TRIGGER trg_change_plan_links_no_update BEFORE UPDATE OR DELETE ON change_plan_links
    FOR EACH ROW EXECUTE FUNCTION gc_reject_change_plan_evidence_mutation();
`;
