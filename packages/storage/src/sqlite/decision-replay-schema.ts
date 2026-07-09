import type { DatabaseSync } from "node:sqlite";

export function createWeeklyDecisionReplaySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_replay_runs (
      run_id TEXT PRIMARY KEY,
      trigger_mode TEXT NOT NULL,
      sample_size INTEGER NOT NULL DEFAULT 500,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      status TEXT NOT NULL,
      report_id TEXT,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      total_scored INTEGER NOT NULL DEFAULT 0,
      likely_wrong_count INTEGER NOT NULL DEFAULT 0,
      model_judged_count INTEGER NOT NULL DEFAULT 0,
      error_text TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decision_replay_runs_started
      ON decision_replay_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_replay_runs_status
      ON decision_replay_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS decision_replay_items (
      item_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      tool_run_id TEXT,
      occurred_at TEXT NOT NULL,
      wrongness_probability REAL NOT NULL DEFAULT 0,
      label TEXT NOT NULL,
      cause_class TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      rule_scores_json TEXT NOT NULL,
      model_scores_json TEXT,
      evidence_json TEXT NOT NULL,
      summary_text TEXT,
      input_excerpt TEXT,
      output_excerpt TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_decision_replay_items_run_wrongness
      ON decision_replay_items(run_id, wrongness_probability DESC, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_replay_items_cause
      ON decision_replay_items(cause_class, label, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS decision_replay_findings (
      finding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      cause_class TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      severity TEXT NOT NULL,
      recurrence_count INTEGER NOT NULL DEFAULT 0,
      impacted_sessions INTEGER NOT NULL DEFAULT 0,
      impacted_turns INTEGER NOT NULL DEFAULT 0,
      avg_wrongness REAL NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      recommendation TEXT,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      duplicate_of_fingerprint TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_decision_replay_findings_run
      ON decision_replay_findings(run_id, is_duplicate, recurrence_count DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_replay_findings_fingerprint
      ON decision_replay_findings(fingerprint, created_at DESC);

    CREATE TABLE IF NOT EXISTS decision_autotunes (
      tune_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      finding_id TEXT,
      tune_class TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      snapshot_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      reverted_at TEXT,
      FOREIGN KEY(run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_decision_autotunes_run_status
      ON decision_autotunes(run_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS improvement_reports (
      report_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      top_findings_json TEXT NOT NULL,
      applied_tunes_json TEXT NOT NULL,
      queued_tunes_json TEXT NOT NULL,
      week_over_week_json TEXT NOT NULL,
      previous_report_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES decision_replay_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_improvement_reports_week
      ON improvement_reports(week_end DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS decision_replay_dedup (
      fingerprint TEXT PRIMARY KEY,
      last_seen_report_id TEXT,
      last_seen_at TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      last_summary_hash TEXT
    );
  `);
}
