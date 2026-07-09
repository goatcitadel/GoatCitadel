import type { DatabaseSync } from "node:sqlite";

export function createDurableRunFoundationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_runs (
      run_id TEXT PRIMARY KEY,
      workflow_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      payload_json TEXT NOT NULL,
      metadata_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      last_error TEXT,
      lease_owner_id TEXT,
      lease_expires_at TEXT,
      lease_heartbeat_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runs_status_updated
      ON durable_runs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_durable_runs_status_lease_updated
      ON durable_runs(status, lease_expires_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_durable_runs_workflow_created
      ON durable_runs(workflow_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS durable_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      checkpoint_kind TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_checkpoints_run_created
      ON durable_checkpoints(run_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS durable_retries (
      retry_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      reason TEXT NOT NULL,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_retries_run_attempt
      ON durable_retries(run_id, attempt_no);
    CREATE INDEX IF NOT EXISTS idx_durable_retries_next_retry
      ON durable_retries(next_retry_at, run_id);

    CREATE TABLE IF NOT EXISTS durable_dead_letters (
      dead_letter_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_note TEXT,
      FOREIGN KEY(run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_dead_letters_created
      ON durable_dead_letters(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_durable_dead_letters_resolved
      ON durable_dead_letters(resolved_at, created_at DESC);
  `);
}

export function createGapClosureExtensionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_run_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      step_key TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_run_events_run_created
      ON durable_run_events(run_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS replay_override_runs (
      replay_run_id TEXT PRIMARY KEY,
      source_run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      overrides_json TEXT NOT NULL,
      diff_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_text TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_replay_override_runs_source
      ON replay_override_runs(source_run_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_replay_override_runs_status
      ON replay_override_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS replay_override_steps (
      step_id TEXT PRIMARY KEY,
      replay_run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      override_kind TEXT NOT NULL,
      override_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(replay_run_id) REFERENCES replay_override_runs(replay_run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_replay_override_steps_run
      ON replay_override_steps(replay_run_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS memory_items (
      item_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      ttl_override_seconds INTEGER,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      forgotten_at TEXT,
      workspace_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_namespace_status
      ON memory_items(namespace, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_pinned_updated
      ON memory_items(pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_workspace
      ON memory_items(workspace_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_change_history (
      change_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      actor_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_memory_change_history_item
      ON memory_change_history(item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS connector_health_runs (
      health_run_id TEXT PRIMARY KEY,
      connector_type TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_connector_health_runs_connector
      ON connector_health_runs(connector_type, connector_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cron_review_items (
      item_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      diff_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cron_review_items_status_updated
      ON cron_review_items(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cron_review_items_job_created
      ON cron_review_items(job_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cron_run_diffs (
      diff_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      previous_run_id TEXT,
      diff_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cron_run_diffs_run
      ON cron_run_diffs(run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS replay_regression_runs (
      regression_run_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      status TEXT NOT NULL,
      test_codes_json TEXT NOT NULL,
      baseline_ref TEXT,
      summary_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_text TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_replay_regression_runs_pack_started
      ON replay_regression_runs(pack_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_replay_regression_runs_status_started
      ON replay_regression_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS replay_regression_results (
      result_id TEXT PRIMARY KEY,
      regression_run_id TEXT NOT NULL,
      test_code TEXT NOT NULL,
      capability TEXT NOT NULL,
      score_delta REAL NOT NULL,
      pass_delta REAL NOT NULL,
      latency_delta_ms REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(regression_run_id) REFERENCES replay_regression_runs(regression_run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_replay_regression_results_run_capability
      ON replay_regression_results(regression_run_id, capability, created_at DESC);
  `);
}

export function createOperationalHotPathSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      content TEXT NOT NULL,
      parts_json TEXT,
      attachments_json TEXT,
      timestamp TEXT NOT NULL,
      token_input INTEGER,
      token_output INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq
      ON chat_messages(session_id, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_message
      ON chat_messages(session_id, message_id);

    CREATE INDEX IF NOT EXISTS idx_approvals_status_created
      ON approvals(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tool_invocations_session_time
      ON tool_invocations(session_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_policy_blocks_session_time
      ON policy_blocks(session_id, timestamp DESC);
  `);
  // P2-S4a: co-locate the chat-message FTS5 recall index with its source table so
  // fresh databases (which replay every migration) build it alongside chat_messages.
  // Existing databases pick it up via the sequential migration below, which also
  // backfills already-persisted rows.
  createChatMessagesFtsSchema(db);
}

/**
 * P2-S4a (`session.search`): a contentless FTS5 index mirroring `chat_messages`,
 * kept in sync by INSERT/UPDATE/DELETE triggers. Hermes' tier-2 recall — the agent
 * searches older persisted turns on demand instead of relying only on the frozen
 * snapshot.
 *
 * Uses the external-content pattern (`content='chat_messages'`, `content_rowid='seq'`)
 * so the index stores only the inverted terms, not a second copy of every message.
 * The triggers follow the canonical SQLite FTS5 "external content table" recipe
 * (https://www.sqlite.org/fts5.html#external_content_tables): the delete/update
 * triggers emit a special `'delete'` row into the FTS table to retract the old terms
 * before the new ones are indexed.
 *
 * NOTE FOR THE POSTGRES MIRROR: FTS5 virtual tables (and their shadow tables) are
 * non-portable. They are excluded from the SQLite schema blueprint at its source
 * (`createSqliteSchemaBlueprintFromDatabase`) so `buildPostgresRuntimeSchemaSql`
 * never tries to reflect them. Keep that guard in lockstep with this table's name.
 */
export function createChatMessagesFtsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
      content,
      session_id UNINDEXED,
      role UNINDEXED,
      message_id UNINDEXED,
      content='chat_messages',
      content_rowid='seq'
    );

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, content, session_id, role, message_id)
      VALUES (new.seq, new.content, new.session_id, new.role, new.message_id);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content, session_id, role, message_id)
      VALUES ('delete', old.seq, old.content, old.session_id, old.role, old.message_id);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content, session_id, role, message_id)
      VALUES ('delete', old.seq, old.content, old.session_id, old.role, old.message_id);
      INSERT INTO chat_messages_fts(rowid, content, session_id, role, message_id)
      VALUES (new.seq, new.content, new.session_id, new.role, new.message_id);
    END;
  `);
}

/**
 * P2-S4a backfill: rebuild the FTS index from the existing `chat_messages` rows.
 * Runs once when the sequential migration first adds the index to an existing
 * database. Safe to re-run: the FTS5 `'rebuild'` command rebuilds from the linked
 * content table, so it is idempotent. Skipped when there are no rows to index.
 */
export function backfillChatMessagesFts(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(1) AS count FROM chat_messages").get() as { count?: number } | undefined;
  if (!row || Number(row.count ?? 0) === 0) {
    return;
  }
  db.exec(`INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');`);
}
