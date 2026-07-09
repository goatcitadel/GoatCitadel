import type { DatabaseSync } from "node:sqlite";

export function createLlmRuntimeMeasurementSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_runtime_measurements (
      measurement_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      engine_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      task_id TEXT,
      run_id TEXT,
      metrics_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      error_text TEXT,
      collected_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_provider_model_collected
      ON llm_runtime_measurements(provider_id, model, collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_session
      ON llm_runtime_measurements(session_id, collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_runtime_measurements_source_status
      ON llm_runtime_measurements(source, status, collected_at DESC);

    CREATE TABLE IF NOT EXISTS llm_eval_proof_runs (
      run_id TEXT PRIMARY KEY,
      prompt_hash TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      status TEXT NOT NULL,
      candidates_json TEXT NOT NULL DEFAULT '[]',
      results_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_llm_eval_proof_runs_created
      ON llm_eval_proof_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_eval_proof_runs_session
      ON llm_eval_proof_runs(session_id, created_at DESC);
  `);
}

export function createRuntimeEvidenceEnvelopeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_evidence_envelopes (
      envelope_id TEXT PRIMARY KEY,
      event_kind TEXT NOT NULL,
      workspace_id TEXT,
      session_id TEXT,
      turn_id TEXT,
      run_id TEXT,
      approval_id TEXT,
      content_hash TEXT NOT NULL,
      previous_envelope_hash TEXT,
      payload_hash TEXT NOT NULL,
      tool_call_hashes_json TEXT NOT NULL DEFAULT '[]',
      memory_lineage_json TEXT NOT NULL DEFAULT '[]',
      policy_hash TEXT,
      signature_status TEXT NOT NULL,
      signature TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_evidence_session_created
      ON runtime_evidence_envelopes(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_evidence_workspace_created
      ON runtime_evidence_envelopes(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_evidence_turn_created
      ON runtime_evidence_envelopes(turn_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_evidence_run_created
      ON runtime_evidence_envelopes(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_evidence_kind_created
      ON runtime_evidence_envelopes(event_kind, created_at DESC);
  `);
}
