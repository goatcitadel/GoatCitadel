import type { DatabaseSync } from "node:sqlite";

export function createMemoryMaintenanceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_memory_maintenance_policies (
      workspace_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      run_mode TEXT NOT NULL,
      timing_strategy TEXT NOT NULL,
      schedule_json TEXT,
      time_zone TEXT NOT NULL,
      min_hours_since_last_success INTEGER NOT NULL DEFAULT 24,
      min_changed_sessions INTEGER NOT NULL DEFAULT 3,
      provider_id TEXT,
      model TEXT,
      execution_target TEXT NOT NULL,
      unavailable_model_policy TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_memory_maintenance_policies_enabled
      ON workspace_memory_maintenance_policies(enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_memory_maintenance_state (
      workspace_id TEXT PRIMARY KEY,
      last_eligibility_at TEXT,
      last_successful_run_at TEXT,
      changed_session_count INTEGER NOT NULL DEFAULT 0,
      active_run_id TEXT,
      last_recommendation_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_memory_maintenance_state_active_run
      ON workspace_memory_maintenance_state(active_run_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
      run_id TEXT PRIMARY KEY,
      durable_run_id TEXT UNIQUE,
      workspace_id TEXT NOT NULL,
      trigger_source TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      policy_snapshot_json TEXT NOT NULL,
      source_session_count INTEGER NOT NULL DEFAULT 0,
      changed_artifact_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_workspace_created
      ON memory_maintenance_runs(workspace_id, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_workspace_status_created
      ON memory_maintenance_runs(workspace_id, status, created_at DESC, run_id DESC);

    CREATE TABLE IF NOT EXISTS memory_maintenance_run_sources (
      source_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      modified_at TEXT,
      excerpt TEXT,
      token_estimate INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES memory_maintenance_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_run_sources_run
      ON memory_maintenance_run_sources(run_id, created_at ASC, source_id ASC);

    CREATE TABLE IF NOT EXISTS memory_maintenance_run_changes (
      change_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      change_kind TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      before_ref TEXT,
      after_ref TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES memory_maintenance_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_run_changes_run
      ON memory_maintenance_run_changes(run_id, created_at ASC, change_id ASC);

    CREATE TABLE IF NOT EXISTS memory_maintenance_recommendations (
      recommendation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      proposed_patch_json TEXT NOT NULL,
      rationale TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_recommendations_workspace_status
      ON memory_maintenance_recommendations(workspace_id, status, updated_at DESC, recommendation_id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_maintenance_recommendations_workspace_created
      ON memory_maintenance_recommendations(workspace_id, created_at DESC, recommendation_id DESC);
  `);
}

export function createMemoryQualityIssueSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_quality_issues (
      issue_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      related_refs_json TEXT NOT NULL DEFAULT '[]',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL,
      rationale TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_quality_issues_workspace_status
      ON memory_quality_issues(workspace_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_quality_issues_kind_status
      ON memory_quality_issues(kind, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_quality_issues_target
      ON memory_quality_issues(target_kind, target_ref, updated_at DESC);
  `);
}

export function createContextManifestSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_manifests (
      manifest_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      turn_id TEXT NOT NULL UNIQUE,
      session_id TEXT,
      task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_context_manifests_session
      ON context_manifests(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_context_manifests_turn
      ON context_manifests(turn_id);

    CREATE TABLE IF NOT EXISTS context_manifest_entries (
      entry_id TEXT PRIMARY KEY,
      manifest_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      entry_index INTEGER NOT NULL,
      title TEXT,
      source_ref TEXT,
      content_text TEXT,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(manifest_id) REFERENCES context_manifests(manifest_id) ON DELETE CASCADE,
      UNIQUE(manifest_id, kind, source_ref, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_context_manifest_entries_manifest
      ON context_manifest_entries(manifest_id, entry_index ASC, created_at ASC);
  `);
}

export function createTranscriptOutboxSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_outbox (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      delivered_at TEXT,
      transcript_offset INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_transcript_outbox_pending
      ON transcript_outbox(delivered_at, enqueued_at ASC, event_id ASC);
    CREATE INDEX IF NOT EXISTS idx_transcript_outbox_session_pending
      ON transcript_outbox(session_id, delivered_at, enqueued_at ASC, event_id ASC);
  `);
}

export function createStructuredMemoryDecisionJournalSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entities (
      entity_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_refs_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      authority TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      forgotten_at TEXT,
      superseded_by_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_entities_workspace_status
      ON memory_entities(workspace_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_entities_type
      ON memory_entities(entity_type, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_relations (
      relation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      from_entity_id TEXT NOT NULL,
      to_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_refs_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      authority TEXT NOT NULL,
      degraded_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      forgotten_at TEXT,
      superseded_by_id TEXT,
      FOREIGN KEY(from_entity_id) REFERENCES memory_entities(entity_id) ON DELETE RESTRICT,
      FOREIGN KEY(to_entity_id) REFERENCES memory_entities(entity_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_relations_workspace_status
      ON memory_relations(workspace_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_entities
      ON memory_relations(from_entity_id, to_entity_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_decisions (
      decision_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      decision_text TEXT NOT NULL,
      alternatives_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      expected_outcome TEXT,
      review_at TEXT,
      retrospective_json TEXT,
      linked_entity_ids_json TEXT NOT NULL,
      linked_relation_ids_json TEXT NOT NULL,
      session_id TEXT,
      run_id TEXT,
      improvement_candidate_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_refs_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      authority TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      forgotten_at TEXT,
      superseded_by_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_decisions_workspace_status
      ON memory_decisions(workspace_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_decisions_review_at
      ON memory_decisions(review_at, status);
    CREATE INDEX IF NOT EXISTS idx_memory_decisions_session
      ON memory_decisions(session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_structured_change_history (
      change_id TEXT PRIMARY KEY,
      record_kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      actor_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_structured_history_record
      ON memory_structured_change_history(record_kind, record_id, created_at DESC);
  `);
}
