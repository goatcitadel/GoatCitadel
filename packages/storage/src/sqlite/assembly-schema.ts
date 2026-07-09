import type { DatabaseSync } from "node:sqlite";

export function createAssemblyOfMindsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assembly_runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      source_session_id TEXT,
      source_task_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      current_round_index INTEGER NOT NULL DEFAULT 0,
      problem_json TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      adversarial_settings_json TEXT NOT NULL,
      result_json TEXT,
      stop_reason TEXT,
      usage_json TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assembly_runs_status_updated
      ON assembly_runs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assembly_runs_workspace_updated
      ON assembly_runs(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assembly_runs_source_session
      ON assembly_runs(source_session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS assembly_rounds (
      round_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      round_index INTEGER NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      participant_ids_json TEXT NOT NULL,
      artifact_ids_json TEXT NOT NULL,
      convergence_snapshot_json TEXT,
      stop_check_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(run_id) REFERENCES assembly_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_assembly_rounds_run_round
      ON assembly_rounds(run_id, round_index ASC, started_at ASC);
    CREATE INDEX IF NOT EXISTS idx_assembly_rounds_stage_status
      ON assembly_rounds(stage, status, started_at DESC);

    CREATE TABLE IF NOT EXISTS assembly_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      round_index INTEGER NOT NULL,
      stage TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      participant_model_ref TEXT,
      blinded_author_token TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES assembly_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_assembly_artifacts_run_round
      ON assembly_artifacts(run_id, round_index ASC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_assembly_artifacts_type_created
      ON assembly_artifacts(artifact_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS assembly_reputation (
      model_ref TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      overall REAL NOT NULL,
      by_domain_json TEXT NOT NULL,
      accuracy REAL NOT NULL,
      reasoning_strength REAL NOT NULL,
      critique_quality REAL NOT NULL,
      consensus_leadership REAL NOT NULL,
      stability REAL NOT NULL,
      adversarial_usefulness REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assembly_reputation_overall
      ON assembly_reputation(overall DESC, sample_count DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assembly_reputation_provider_model
      ON assembly_reputation(provider_id, model_id, updated_at DESC);
  `);
}
