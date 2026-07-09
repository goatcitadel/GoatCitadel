import type { DatabaseSync } from "node:sqlite";

export function createImprovementLedgerSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS improvement_signals (
      signal_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      source_service TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      origin TEXT NOT NULL,
      signal_class TEXT NOT NULL,
      signal_kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      durable_run_id TEXT,
      approval_id TEXT,
      task_id TEXT,
      tool_name TEXT,
      capability_id TEXT,
      memory_item_id TEXT,
      severity TEXT,
      cost_delta_usd REAL,
      latency_delta_ms REAL,
      score_delta REAL,
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_signals_source_idempotency
      ON improvement_signals(source_service, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_improvement_signals_workspace_recorded
      ON improvement_signals(workspace_id, recorded_at DESC, signal_id DESC);
    CREATE INDEX IF NOT EXISTS idx_improvement_signals_workspace_fingerprint
      ON improvement_signals(workspace_id, fingerprint, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS improvement_candidates (
      candidate_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      target_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      summary TEXT NOT NULL,
      current_revision_id TEXT,
      supporting_signal_count INTEGER NOT NULL DEFAULT 0,
      negative_signal_count INTEGER NOT NULL DEFAULT 0,
      severity TEXT,
      suppression_until TEXT,
      latest_signal_at TEXT,
      aggregate_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by_actor_id TEXT,
      created_by_actor_type TEXT,
      updated_by_actor_id TEXT,
      updated_by_actor_type TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_improvement_candidates_open_fingerprint
      ON improvement_candidates(workspace_id, kind, fingerprint)
      WHERE status IN ('proposed', 'evaluating', 'ready_for_approval', 'approval_pending', 'approved');
    CREATE INDEX IF NOT EXISTS idx_improvement_candidates_workspace_updated
      ON improvement_candidates(workspace_id, updated_at DESC, candidate_id DESC);

    CREATE TABLE IF NOT EXISTS improvement_candidate_revisions (
      revision_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      candidate_ref_json TEXT NOT NULL,
      change_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by_actor_id TEXT NOT NULL,
      created_by_actor_type TEXT NOT NULL,
      FOREIGN KEY(candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_improvement_candidate_revisions_candidate
      ON improvement_candidate_revisions(candidate_id, created_at DESC, revision_id DESC);

    CREATE TABLE IF NOT EXISTS improvement_candidate_signals (
      candidate_id TEXT NOT NULL,
      signal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(candidate_id, signal_id),
      FOREIGN KEY(candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE,
      FOREIGN KEY(signal_id) REFERENCES improvement_signals(signal_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS improvement_evaluations (
      evaluation_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      status TEXT NOT NULL,
      baseline_ref_json TEXT NOT NULL,
      candidate_ref_json TEXT NOT NULL,
      evaluator_kind TEXT NOT NULL,
      evaluator_version TEXT NOT NULL,
      dataset_or_pack_ref_json TEXT,
      change_hash TEXT NOT NULL,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      created_by_actor_id TEXT NOT NULL,
      created_by_actor_type TEXT NOT NULL,
      completed_by_actor_id TEXT,
      completed_by_actor_type TEXT,
      FOREIGN KEY(candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE,
      FOREIGN KEY(revision_id) REFERENCES improvement_candidate_revisions(revision_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_improvement_evaluations_candidate
      ON improvement_evaluations(candidate_id, created_at DESC, evaluation_id DESC);

    CREATE TABLE IF NOT EXISTS improvement_activations (
      activation_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      activation_target_json TEXT NOT NULL,
      pre_activation_snapshot_json TEXT NOT NULL,
      applied_change_hash TEXT NOT NULL,
      watch_status TEXT NOT NULL,
      watch_started_at TEXT,
      watch_ends_at TEXT,
      watch_signal_target INTEGER NOT NULL DEFAULT 20,
      watch_signal_count INTEGER NOT NULL DEFAULT 0,
      regression_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      requested_by_actor_id TEXT NOT NULL,
      requested_by_actor_type TEXT NOT NULL,
      approved_by_actor_id TEXT,
      approved_by_actor_type TEXT,
      paused_by_actor_id TEXT,
      paused_by_actor_type TEXT,
      rolled_back_by_actor_id TEXT,
      rolled_back_by_actor_type TEXT,
      stable_at TEXT,
      paused_at TEXT,
      rolled_back_at TEXT,
      failure_reason TEXT,
      FOREIGN KEY(candidate_id) REFERENCES improvement_candidates(candidate_id) ON DELETE CASCADE,
      FOREIGN KEY(revision_id) REFERENCES improvement_candidate_revisions(revision_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_improvement_activations_candidate
      ON improvement_activations(candidate_id, created_at DESC, activation_id DESC);
    CREATE INDEX IF NOT EXISTS idx_improvement_activations_approval
      ON improvement_activations(approval_id, created_at DESC);
  `);
}
