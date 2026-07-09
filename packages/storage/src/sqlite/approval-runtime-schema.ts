import type { DatabaseSync } from "node:sqlite";

export interface SqliteApprovalRuntimeSchemaDeps {
  addColumnIfMissingIfTableExists: (db: DatabaseSync, tableName: string, columnName: string, columnSql: string) => void;
}

export interface SqliteApprovalRuntimeSchemaBuilders {
  createAuthDeviceAccessSchema: (db: DatabaseSync) => void;
  createPhase2ApprovalRuntimeSchema: (db: DatabaseSync) => void;
  createApprovalEffectsSchema: (db: DatabaseSync) => void;
  createApprovalInboxSchema: (db: DatabaseSync) => void;
  createApprovalExpiryRuntimeSchema: (db: DatabaseSync) => void;
  createRealtimeEventSequenceStateSchema: (db: DatabaseSync) => void;
}

export function createApprovalRuntimeSqliteSchemaBuilders(
  deps: SqliteApprovalRuntimeSchemaDeps,
): SqliteApprovalRuntimeSchemaBuilders {
  const { addColumnIfMissingIfTableExists } = deps;

  function createAuthDeviceAccessSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_device_requests (
        request_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        request_secret_hash TEXT NOT NULL,
        device_label TEXT NOT NULL,
        device_type TEXT NOT NULL,
        platform TEXT,
        requested_origin TEXT,
        requested_ip TEXT,
        user_agent TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT,
        approved_token_plaintext TEXT,
        approved_token_expires_at TEXT,
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_auth_device_requests_status_created
        ON auth_device_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auth_device_requests_expires_at
        ON auth_device_requests(expires_at);

      CREATE TABLE IF NOT EXISTS auth_device_grants (
        grant_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT NOT NULL,
        device_type TEXT NOT NULL,
        platform TEXT,
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(request_id) REFERENCES auth_device_requests(request_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_auth_device_grants_expires_at
        ON auth_device_grants(expires_at);
      CREATE INDEX IF NOT EXISTS idx_auth_device_grants_last_used
        ON auth_device_grants(last_used_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auth_device_grants_revoked
        ON auth_device_grants(revoked_at, created_at DESC);
    `);
  }

  function createPhase2ApprovalRuntimeSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_wait_runs (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_approval_wait_runs_run_id
        ON approval_wait_runs(run_id);
    `);
    createApprovalEffectsSchema(db);
    db.exec(`

      CREATE TABLE IF NOT EXISTS remote_action_tokens (
        token_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        action_type TEXT NOT NULL,
        approval_id TEXT,
        connector_id TEXT NOT NULL,
        mutation_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        consumed_at TEXT,
        consumed_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_remote_action_tokens_connector_state
        ON remote_action_tokens(connector_id, state, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_remote_action_tokens_expires_at
        ON remote_action_tokens(expires_at);
    `);
  }

  function createApprovalEffectsSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_effects (
        effect_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        effect_kind TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        detail TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL DEFAULT '{}',
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_effects_idempotency
        ON approval_effects(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_approval_effects_lookup
        ON approval_effects(approval_id, effect_kind, target_kind, target_id);
      CREATE INDEX IF NOT EXISTS idx_approval_effects_approval_created
        ON approval_effects(approval_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_approval_effects_status_lease_updated
        ON approval_effects(status, lease_expires_at, updated_at DESC);
    `);
  }

  function createApprovalInboxSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_inbox_items (
        inbox_item_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        receiver_kind TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        token TEXT NOT NULL,
        action_type TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        approval_kind TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        preview_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        last_error TEXT,
        delivery_count INTEGER NOT NULL DEFAULT 1,
        last_delivered_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_inbox_receiver_token
        ON approval_inbox_items(receiver_kind, receiver_id, token_id);
      CREATE INDEX IF NOT EXISTS idx_approval_inbox_receiver_state_created
        ON approval_inbox_items(receiver_kind, receiver_id, state, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approval_inbox_approval_created
        ON approval_inbox_items(approval_id, created_at DESC);
    `);
  }

  function createApprovalExpiryRuntimeSchema(db: DatabaseSync): void {
    addColumnIfMissingIfTableExists(db, "approvals", "expires_at", "TEXT");
    addColumnIfMissingIfTableExists(db, "chat_inline_approvals", "expires_at", "TEXT");
  }

  function createRealtimeEventSequenceStateSchema(db: DatabaseSync): void {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("realtime_events") as { name: string } | undefined;
    if (!tableExists) {
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS realtime_event_sequence_state (
        stream_name TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL
      );
    `);
    const maxSequenceRow = db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM realtime_events")
      .get() as { max_sequence?: number | null } | undefined;
    const maxSequence = Number(maxSequenceRow?.max_sequence ?? 0);
    db.prepare(
      `
      INSERT INTO realtime_event_sequence_state (stream_name, last_sequence)
      VALUES ('events', @lastSequence)
      ON CONFLICT(stream_name) DO UPDATE SET
        last_sequence = CASE
          WHEN realtime_event_sequence_state.last_sequence < excluded.last_sequence
            THEN excluded.last_sequence
          ELSE realtime_event_sequence_state.last_sequence
        END
    `,
    ).run({ lastSequence: maxSequence });
  }

  return {
    createApprovalEffectsSchema,
    createApprovalExpiryRuntimeSchema,
    createApprovalInboxSchema,
    createAuthDeviceAccessSchema,
    createPhase2ApprovalRuntimeSchema,
    createRealtimeEventSequenceStateSchema,
  };
}
