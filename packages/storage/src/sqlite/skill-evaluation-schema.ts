import type { DatabaseSync } from "node:sqlite";

export function createSkillEvaluationRunsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_evaluation_runs (
      run_id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      status TEXT NOT NULL,
      target_pass_rate REAL NOT NULL,
      max_rounds INTEGER NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0,
      improvement_delta REAL NOT NULL DEFAULT 0,
      proposal_id TEXT,
      improvement_candidate_id TEXT,
      ledger_signal_id TEXT,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_skill_updated
      ON skill_evaluation_runs(skill_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_evaluation_runs_status_updated
      ON skill_evaluation_runs(status, updated_at DESC);
  `);
}
