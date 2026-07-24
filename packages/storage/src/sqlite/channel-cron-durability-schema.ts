import type { DatabaseSync } from "node:sqlite";

/**
 * Additive canonical schema shared by fresh SQLite databases and migration 149.
 * Later additive migrations must also be reflected here for fresh installs.
 * Keep this function idempotent: the live Postgres blueprint is derived from a
 * freshly migrated SQLite database.
 */
export function createChannelCronDurabilitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_channel_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      dispatch_kind TEXT NOT NULL,
      provider_source_id TEXT,
      idempotency_key TEXT NOT NULL,
      lane_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claim_generation INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      claim_owner_id TEXT,
      claim_expires_at TEXT,
      claim_heartbeat_at TEXT,
      next_attempt_at TEXT,
      bot_loop_decision TEXT,
      bot_loop_reason TEXT,
      session_key TEXT,
      session_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      assistant_message_id TEXT,
      durable_run_id TEXT,
      delivery_id TEXT,
      provider_message_id TEXT,
      message_content_hash TEXT,
      delivery_payload_hash TEXT,
      command_operation_key TEXT,
      command_result_text TEXT,
      last_error TEXT,
      reconciliation_reason TEXT,
      received_at TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_channel_events_event_id
      ON inbound_channel_events(event_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_channel_events_identity
      ON inbound_channel_events(channel_key, connection_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_due
      ON inbound_channel_events(status, next_attempt_at, claim_expires_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_lane
      ON inbound_channel_events(channel_key, connection_id, lane_key, sequence);
    CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_session
      ON inbound_channel_events(session_id, sequence);

    CREATE TABLE IF NOT EXISTS cron_runs (
      run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      admission_key TEXT NOT NULL,
      execution_generation INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL,
      job_revision INTEGER NOT NULL,
      action TEXT NOT NULL,
      action_snapshot_json TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'admitting',
      phase TEXT NOT NULL DEFAULT 'child_admission',
      child_session_id TEXT,
      child_message_id TEXT,
      child_turn_id TEXT,
      child_assistant_message_id TEXT,
      child_durable_run_id TEXT,
      delivery_run_id TEXT,
      external_side_effect_run_id TEXT,
      evidence_envelope_id TEXT,
      outcome_json TEXT,
      failure_json TEXT,
      reconciliation_reason TEXT,
      reconciliation_resolution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      admitted_at TEXT,
      started_at TEXT,
      settled_at TEXT,
      reconciled_at TEXT,
      reconciled_by TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_admission
      ON cron_runs(job_id, admission_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_job_generation
      ON cron_runs(job_id, execution_generation);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_job_created
      ON cron_runs(job_id, created_at DESC, run_id);
    CREATE INDEX IF NOT EXISTS idx_cron_runs_status_scheduled
      ON cron_runs(status, scheduled_for, run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_child_durable
      ON cron_runs(child_durable_run_id)
      WHERE child_durable_run_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_evidence
      ON cron_runs(evidence_envelope_id)
      WHERE evidence_envelope_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cron_runs_pending_settlement
      ON cron_runs(status, phase, updated_at, run_id)
      WHERE status IN ('admitting', 'admitted', 'running', 'waiting');
    CREATE INDEX IF NOT EXISTS idx_cron_runs_reconciliation
      ON cron_runs(reconciled_at, updated_at, run_id)
      WHERE status = 'manual_reconciliation_required';
  `);
}
