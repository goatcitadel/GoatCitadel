import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clampInt } from "@goatcitadel/contracts";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteOptions {
  dbPath: string;
  tuning?: {
    cacheSizeKb?: number;
    tempStoreMemory?: boolean;
    walAutoCheckpointPages?: number;
  };
}

export function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function createDatabase(options: SqliteOptions): DatabaseSync {
  ensureParentDir(options.dbPath);
  const db = new DatabaseSync(options.dbPath, {
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  if (options.tuning?.cacheSizeKb !== undefined) {
    db.exec(`PRAGMA cache_size = -${clampInt(options.tuning.cacheSizeKb, 4_096, 4_096, 262_144)};`);
  }
  if (options.tuning?.tempStoreMemory ?? false) {
    db.exec("PRAGMA temp_store = MEMORY;");
  }
  if (options.tuning?.walAutoCheckpointPages !== undefined) {
    db.exec(`PRAGMA wal_autocheckpoint = ${clampInt(options.tuning.walAutoCheckpointPages, 1_000, 1_000, 20_000)};`);
  }
  migrate(db);
  return db;
}


function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  const markApplied = db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (@version, @name, @appliedAt)
  `);

  for (const migration of SCHEMA_MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      markApplied.run({
        version: migration.version,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

interface SchemaMigration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    name: "base_schema",
    up: createBaseSchema,
  },
  {
    version: 2,
    name: "approval_explainer_columns",
    up: migrateApprovalsColumns,
  },
  {
    version: 3,
    name: "task_subagent_agent_session_rename",
    up: migrateTaskSubagentSessionColumns,
  },
  {
    version: 4,
    name: "drop_legacy_integration_index",
    up: (db) => {
      db.exec("DROP INDEX IF EXISTS idx_integration_connections_catalog_label");
    },
  },
  {
    version: 5,
    name: "mesh_schema",
    up: createMeshSchema,
  },
  {
    version: 6,
    name: "memory_qmd_schema",
    up: createMemoryQmdSchema,
  },
  {
    version: 7,
    name: "task_soft_delete_columns",
    up: migrateTaskSoftDeleteColumns,
  },
  {
    version: 8,
    name: "agent_profiles_schema",
    up: createAgentProfilesSchema,
  },
  {
    version: 9,
    name: "native_tools_expansion_schema",
    up: createNativeToolsExpansionSchema,
  },
  {
    version: 10,
    name: "chat_workspace_schema",
    up: createChatWorkspaceSchema,
  },
  {
    version: 11,
    name: "system_settings_schema",
    up: createSystemSettingsSchema,
  },
  {
    version: 12,
    name: "v11_expansion_schema",
    up: createV11ExpansionSchema,
  },
  {
    version: 13,
    name: "agentic_chat_schema",
    up: createAgenticChatSchema,
  },
  {
    version: 14,
    name: "prompt_pack_readiness_schema",
    up: createPromptPackReadinessSchema,
  },
  {
    version: 15,
    name: "skill_runtime_state_schema",
    up: createSkillRuntimeStateSchema,
  },
  {
    version: 16,
    name: "bankr_safety_schema",
    up: createBankrSafetySchema,
  },
  {
    version: 17,
    name: "agentic_depth_schema",
    up: createAgenticDepthSchema,
  },
  {
    version: 18,
    name: "weekly_decision_replay_schema",
    up: createWeeklyDecisionReplaySchema,
  },
  {
    version: 19,
    name: "prompt_pack_benchmark_schema",
    up: createPromptPackBenchmarkSchema,
  },
  {
    version: 20,
    name: "workspace_isolation_schema",
    up: createWorkspaceIsolationSchema,
  },
  {
    version: 21,
    name: "durable_run_foundation_schema",
    up: createDurableRunFoundationSchema,
  },
  {
    version: 22,
    name: "gap_closure_extension_schema",
    up: createGapClosureExtensionSchema,
  },
  {
    version: 23,
    name: "operational_hot_path_schema",
    up: createOperationalHotPathSchema,
  },
  {
    version: 24,
    name: "sessions_operator_summary_index",
    up: createSessionsOperatorSummaryIndex,
  },
  {
    version: 25,
    name: "chat_branching_and_planning_mode",
    up: createChatBranchingAndPlanningSchema,
  },
  {
    version: 26,
    name: "chat_mode_orchestration_foundation",
    up: createChatModeOrchestrationFoundationSchema,
  },
  {
    version: 27,
    name: "auth_device_requests_and_grants",
    up: createAuthDeviceAccessSchema,
  },
  {
    version: 28,
    name: "chat_specialist_candidates",
    up: createChatSpecialistCandidateSchema,
  },
  {
    version: 29,
    name: "chat_turn_trace_shape_repair",
    up: repairChatTurnTraceShape,
  },
  {
    version: 30,
    name: "chat_plans_and_summaries",
    up: createChatPlansAndSummariesSchema,
  },
  {
    version: 31,
    name: "robust_agent_execution_schema",
    up: createRobustAgentExecutionSchema,
  },
  {
    version: 32,
    name: "hot_path_covering_indexes",
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session_status ON chat_turn_traces(session_id, status, started_at DESC);
      `);
      // chat_tool_runs may not exist in databases that pre-date migration 31
      const hasToolRuns = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_tool_runs'`
      ).get();
      if (hasToolRuns) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_chat_tool_runs_session_status ON chat_tool_runs(session_id, status, started_at DESC);
        `);
      }
    },
  },
  {
    version: 33,
    name: "prompt_pack_test_mode_and_tool_tier",
    up: (db) => {
      addColumnIfMissingIfTableExists(db, "prompt_pack_tests", "mode", "TEXT");
      addColumnIfMissingIfTableExists(db, "prompt_pack_tests", "tool_tier", "TEXT");
    },
  },
  {
    version: 34,
    name: "prompt_pack_run_execution_profile",
    up: (db) => {
      addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "mode", "TEXT");
      addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "tool_tier", "TEXT");
      addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "tool_autonomy", "TEXT");
      addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "web_mode", "TEXT");
      addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "memory_mode", "TEXT");
      addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "thinking_level", "TEXT");
    },
  },
  {
    version: 35,
    name: "assembly_of_minds_schema",
    up: createAssemblyOfMindsSchema,
  },
  {
    version: 36,
    name: "realtime_event_sequence_cursor",
    up: createRealtimeEventSequenceCursorSchema,
  },
  {
    version: 37,
    name: "phase2_approval_runtime_schema",
    up: createPhase2ApprovalRuntimeSchema,
  },
  {
    version: 38,
    name: "approval_inbox_schema",
    up: createApprovalInboxSchema,
  },
  {
    version: 39,
    name: "approval_expiry_runtime_schema",
    up: createApprovalExpiryRuntimeSchema,
  },
  {
    version: 40,
    name: "realtime_event_sequence_state",
    up: createRealtimeEventSequenceStateSchema,
  },
  {
    version: 41,
    name: "tool_access_decision_hot_path_indexes",
    up: createToolAccessDecisionHotPathIndexes,
  },
  {
    version: 42,
    name: "workspace_hook_runtime_schema",
    up: createWorkspaceHookRuntimeSchema,
  },
  {
    version: 43,
    name: "chat_session_history_visibility",
    up: createChatSessionHistoryVisibilitySchema,
  },
  {
    version: 44,
    name: "channel_setup_drafts",
    up: createChannelSetupDraftsSchema,
  },
  {
    version: 45,
    name: "companion_session_runtime_schema",
    up: createCompanionSessionRuntimeSchema,
  },
  {
    version: 46,
    name: "memory_maintenance_schema",
    up: createMemoryMaintenanceSchema,
  },
  {
    version: 47,
    name: "context_manifest_schema",
    up: createContextManifestSchema,
  },
  {
    version: 48,
    name: "transcript_outbox_schema",
    up: createTranscriptOutboxSchema,
  },
  {
    version: 49,
    name: "realtime_stream_lease_schema",
    up: createRealtimeStreamLeaseSchema,
  },
  {
    version: 50,
    name: "approval_linkage_json_schema",
    up: (db) => {
      addColumnIfMissingIfTableExists(db, "approvals", "linkage_json", "TEXT");
    },
  },
];

function createBaseSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      display_name TEXT,
      routing_hints_json TEXT,
      last_activity_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      health TEXT NOT NULL DEFAULT 'healthy',
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      token_cached_input INTEGER NOT NULL DEFAULT 0,
      token_total INTEGER NOT NULL DEFAULT 0,
      cost_usd_total REAL NOT NULL DEFAULT 0,
      budget_state TEXT NOT NULL DEFAULT 'ok'
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at ON sessions(last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_account_last_activity_at ON sessions(account, last_activity_at DESC);

    CREATE TABLE IF NOT EXISTS inbound_events (
      endpoint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      status TEXT NOT NULL,
      PRIMARY KEY (endpoint, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      linkage_json TEXT,
      payload_json TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      explanation_status TEXT NOT NULL DEFAULT 'not_requested',
      explanation_json TEXT,
      explanation_error TEXT,
      explanation_updated_at TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT
    );

    CREATE TABLE IF NOT EXISTS approval_events (
      event_id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_approval_events_approval_id ON approval_events(approval_id, timestamp);

    CREATE TABLE IF NOT EXISTS pending_approval_actions (
      approval_id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_status TEXT NOT NULL DEFAULT 'pending',
      result_json TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_invocations (
      audit_event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      policy_reason TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT,
      approval_id TEXT
    );

    CREATE TABLE IF NOT EXISTS policy_blocks (
      audit_event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cost_ledger (
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      day TEXT NOT NULL,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      token_cached_input INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cost_ledger_day ON cost_ledger(day);
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_session_id ON cost_ledger(session_id);

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assigned_agent_id TEXT,
      created_by TEXT,
      due_at TEXT,
      deleted_at TEXT,
      deleted_by TEXT,
      delete_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_updated_at ON tasks(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS task_activities (
      activity_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT,
      activity_type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_activities_task_created_at
      ON task_activities(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS task_deliverables (
      deliverable_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      deliverable_type TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_deliverables_task_created_at
      ON task_deliverables(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS task_subagent_sessions (
      subagent_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL UNIQUE,
      agent_name TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_task_created_at
      ON task_subagent_sessions(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_status
      ON task_subagent_sessions(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS realtime_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_realtime_events_created_at
      ON realtime_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS cron_jobs (
      job_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills_index (
      skill_id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      source TEXT NOT NULL,
      dir TEXT NOT NULL,
      mtime TEXT NOT NULL,
      declared_tools_json TEXT NOT NULL,
      requires_json TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      avg_quality_score REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orchestration_runs (
      run_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      current_wave_id TEXT,
      current_phase_id TEXT,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_iterations INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_orchestration_runs_plan_id ON orchestration_runs(plan_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS orchestration_plans (
      plan_id TEXT PRIMARY KEY,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orchestration_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      wave_id TEXT,
      phase_id TEXT,
      checkpoint_kind TEXT NOT NULL,
      git_ref TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orchestration_checkpoints_run_id
      ON orchestration_checkpoints(run_id, created_at);

    CREATE TABLE IF NOT EXISTS orchestration_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orchestration_events_run_id
      ON orchestration_events(run_id, created_at);

    CREATE TABLE IF NOT EXISTS integration_connections (
      connection_id TEXT PRIMARY KEY,
      catalog_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      integration_key TEXT NOT NULL,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_sync_at TEXT,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_integration_connections_kind
      ON integration_connections(kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_integration_connections_catalog_id
      ON integration_connections(catalog_id, updated_at DESC);
  `);
}

function createMeshSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mesh_nodes (
      node_id TEXT PRIMARY KEY,
      label TEXT,
      advertise_address TEXT,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      tls_fingerprint TEXT,
      joined_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mesh_nodes_status
      ON mesh_nodes(status, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS mesh_leases (
      lease_key TEXT PRIMARY KEY,
      holder_node_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mesh_leases_expires_at
      ON mesh_leases(expires_at);

    CREATE TABLE IF NOT EXISTS mesh_session_owners (
      session_id TEXT PRIMARY KEY,
      owner_node_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mesh_session_owners_owner
      ON mesh_session_owners(owner_node_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS mesh_replication_log (
      replication_id TEXT PRIMARY KEY,
      source_node_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_node_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_mesh_replication_log_created_at
      ON mesh_replication_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS mesh_replication_offsets (
      consumer_node_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      last_replication_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (consumer_node_id, source_node_id)
    );

    CREATE TABLE IF NOT EXISTS mesh_join_tokens (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by_node_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mesh_join_tokens_expires_at
      ON mesh_join_tokens(expires_at);
  `);
}

function createMemoryQmdSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_context_packs (
      context_id TEXT PRIMARY KEY,
      cache_key TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      run_id TEXT,
      phase_id TEXT,
      query_hash TEXT NOT NULL,
      sources_hash TEXT NOT NULL,
      context_text TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      quality_json TEXT NOT NULL,
      original_token_estimate INTEGER NOT NULL,
      distilled_token_estimate INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_context_packs_session
      ON memory_context_packs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_context_packs_run_phase
      ON memory_context_packs(run_id, phase_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_context_packs_created_at
      ON memory_context_packs(created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_qmd_runs (
      run_event_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      run_id TEXT,
      phase_id TEXT,
      status TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      duration_ms INTEGER NOT NULL,
      candidate_count INTEGER NOT NULL,
      citations_count INTEGER NOT NULL,
      original_token_estimate INTEGER NOT NULL,
      distilled_token_estimate INTEGER NOT NULL,
      savings_percent REAL NOT NULL,
      error_text TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_created_at
      ON memory_qmd_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_scope
      ON memory_qmd_runs(scope, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_session
      ON memory_qmd_runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_qmd_runs_run_phase
      ON memory_qmd_runs(run_id, phase_id, created_at DESC);
  `);
}

function createSessionsOperatorSummaryIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_account_last_activity_at
      ON sessions(account, last_activity_at DESC);
  `);
}

function createChatBranchingAndPlanningSchema(db: DatabaseSync): void {
  addColumnIfMissing(db, "chat_session_prefs", "planning_mode", "TEXT NOT NULL DEFAULT 'off'");
  addColumnIfMissing(db, "chat_turn_traces", "parent_turn_id", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "branch_kind", "TEXT NOT NULL DEFAULT 'append'");
  addColumnIfMissing(db, "chat_turn_traces", "source_turn_id", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "citations_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "capability_upgrade_suggestions_json", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_branch_state (
      session_id TEXT PRIMARY KEY,
      active_leaf_turn_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session_parent_started
      ON chat_turn_traces(session_id, parent_turn_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_session_branch_state_updated
      ON chat_session_branch_state(updated_at DESC);

    UPDATE chat_session_prefs
    SET planning_mode = 'off'
    WHERE planning_mode IS NULL OR TRIM(planning_mode) = '';

    UPDATE chat_turn_traces
    SET branch_kind = 'append'
    WHERE branch_kind IS NULL OR TRIM(branch_kind) = '';

    WITH ordered_turns AS (
      SELECT
        turn_id,
        LAG(turn_id) OVER (
          PARTITION BY session_id
          ORDER BY started_at ASC, turn_id ASC
        ) AS computed_parent_turn_id
      FROM chat_turn_traces
    )
    UPDATE chat_turn_traces
    SET parent_turn_id = (
      SELECT ordered_turns.computed_parent_turn_id
      FROM ordered_turns
      WHERE ordered_turns.turn_id = chat_turn_traces.turn_id
    )
    WHERE (parent_turn_id IS NULL OR TRIM(parent_turn_id) = '')
      AND EXISTS (
        SELECT 1
        FROM ordered_turns
        WHERE ordered_turns.turn_id = chat_turn_traces.turn_id
          AND ordered_turns.computed_parent_turn_id IS NOT NULL
      );

    WITH ranked_turns AS (
      SELECT
        session_id,
        turn_id,
        COALESCE(finished_at, started_at) AS updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY started_at DESC, turn_id DESC
        ) AS row_num
      FROM chat_turn_traces
    )
    INSERT INTO chat_session_branch_state (session_id, active_leaf_turn_id, updated_at)
    SELECT session_id, turn_id, updated_at
    FROM ranked_turns
    WHERE row_num = 1
    ON CONFLICT(session_id) DO UPDATE SET
      active_leaf_turn_id = excluded.active_leaf_turn_id,
      updated_at = excluded.updated_at;
  `);
}

function createChatModeOrchestrationFoundationSchema(db: DatabaseSync): void {
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_intensity", "TEXT NOT NULL DEFAULT 'balanced'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_visibility", "TEXT NOT NULL DEFAULT 'summarized'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_provider_preference", "TEXT NOT NULL DEFAULT 'balanced'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_review_depth", "TEXT NOT NULL DEFAULT 'standard'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_parallelism", "TEXT NOT NULL DEFAULT 'auto'");
  addColumnIfMissing(db, "chat_session_prefs", "code_auto_apply", "TEXT NOT NULL DEFAULT 'aggressive_auto'");
  addColumnIfMissing(db, "chat_turn_traces", "orchestration_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "visibility", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "workflow_template", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "route_decision_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "final_summary", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "provider_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "model", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "summary", "TEXT");
}

function createChatSpecialistCandidateSchema(db: DatabaseSync): void {
  addColumnIfMissing(db, "chat_turn_traces", "specialist_candidate_suggestions_json", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_specialist_candidates (
      candidate_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      session_id TEXT NOT NULL,
      lead_turn_id TEXT,
      lead_run_id TEXT,
      title TEXT NOT NULL,
      role TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      routing_mode TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      requires_approval INTEGER NOT NULL DEFAULT 1,
      suggested_tools_json TEXT,
      suggested_skills_json TEXT,
      routing_hints_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT,
      retired_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_specialist_candidates_session
      ON chat_specialist_candidates(session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_specialist_candidates_status
      ON chat_specialist_candidates(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_specialist_candidates_workspace
      ON chat_specialist_candidates(workspace_id, updated_at DESC);
  `);
}

function repairChatTurnTraceShape(db: DatabaseSync): void {
  addColumnIfMissing(db, "chat_turn_traces", "retrieval_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "reflection_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "proactive_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "orchestration_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "guidance_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "citations_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "failure_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "capability_upgrade_suggestions_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "specialist_candidate_suggestions_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "parent_turn_id", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "branch_kind", "TEXT NOT NULL DEFAULT 'append'");
  addColumnIfMissing(db, "chat_turn_traces", "source_turn_id", "TEXT");

  db.exec(`
    UPDATE chat_turn_traces
    SET branch_kind = 'append'
    WHERE branch_kind IS NULL OR TRIM(branch_kind) = '';

    CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session
      ON chat_turn_traces(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session_parent_started
      ON chat_turn_traces(session_id, parent_turn_id, started_at DESC);
  `);
}

function createChatPlansAndSummariesSchema(db: DatabaseSync): void {
  addColumnIfMissing(db, "chat_turn_traces", "execution_plan_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_tool_runs", "failure_guidance", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "execution_plan_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "failure_guidance", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "child_session_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "child_turn_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "citations_json", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_execution_plans (
      plan_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      planning_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      advisory_only INTEGER NOT NULL DEFAULT 0,
      objective TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_execution_plans_session
      ON chat_execution_plans(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_execution_plans_turn
      ON chat_execution_plans(turn_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_execution_plan_steps (
      plan_id TEXT NOT NULL,
      step_id TEXT PRIMARY KEY,
      step_index INTEGER NOT NULL,
      objective TEXT NOT NULL,
      success_criteria TEXT,
      suggested_tools_json TEXT,
      expected_output TEXT,
      parallelizable INTEGER NOT NULL DEFAULT 0,
      depends_on_step_ids_json TEXT,
      delegated_role TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      child_run_id TEXT,
      child_session_id TEXT,
      child_turn_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_execution_plan_steps_plan
      ON chat_execution_plan_steps(plan_id, step_index ASC);

    CREATE TABLE IF NOT EXISTS chat_conversation_summaries (
      summary_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch_head_turn_id TEXT NOT NULL,
      start_turn_id TEXT NOT NULL,
      end_turn_id TEXT NOT NULL,
      turn_ids_json TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      summary_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, branch_head_turn_id, start_turn_id, end_turn_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_conversation_summaries_session
      ON chat_conversation_summaries(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_conversation_summaries_branch
      ON chat_conversation_summaries(session_id, branch_head_turn_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_execution_plan
      ON chat_turn_traces(execution_plan_id);
  `);
}

function migrateApprovalsColumns(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));

  if (!columns.has("explanation_status")) {
    db.exec("ALTER TABLE approvals ADD COLUMN explanation_status TEXT NOT NULL DEFAULT 'not_requested'");
  }
  if (!columns.has("explanation_json")) {
    db.exec("ALTER TABLE approvals ADD COLUMN explanation_json TEXT");
  }
  if (!columns.has("explanation_error")) {
    db.exec("ALTER TABLE approvals ADD COLUMN explanation_error TEXT");
  }
  if (!columns.has("explanation_updated_at")) {
    db.exec("ALTER TABLE approvals ADD COLUMN explanation_updated_at TEXT");
  }
}

function migrateTaskSubagentSessionColumns(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(task_subagent_sessions)").all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));

  if (columns.has("agent_session_id")) {
    return;
  }

  if (!columns.has("openclaw_session_id")) {
    return;
  }

  try {
    db.exec("ALTER TABLE task_subagent_sessions RENAME COLUMN openclaw_session_id TO agent_session_id");
    return;
  } catch {
    // Fall back to table rebuild if RENAME COLUMN is not available.
  }

  db.exec(`
    CREATE TABLE task_subagent_sessions_new (
      subagent_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_session_id TEXT NOT NULL UNIQUE,
      agent_name TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );

    INSERT INTO task_subagent_sessions_new (
      subagent_session_id, task_id, agent_session_id, agent_name, status, created_at, updated_at, ended_at
    )
    SELECT
      subagent_session_id, task_id, openclaw_session_id, agent_name, status, created_at, updated_at, ended_at
    FROM task_subagent_sessions;

    DROP TABLE task_subagent_sessions;
    ALTER TABLE task_subagent_sessions_new RENAME TO task_subagent_sessions;

    CREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_task_created_at
      ON task_subagent_sessions(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_status
      ON task_subagent_sessions(status, updated_at DESC);
  `);
}

function migrateTaskSoftDeleteColumns(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));

  if (!columns.has("deleted_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN deleted_at TEXT");
  }
  if (!columns.has("deleted_by")) {
    db.exec("ALTER TABLE tasks ADD COLUMN deleted_by TEXT");
  }
  if (!columns.has("delete_reason")) {
    db.exec("ALTER TABLE tasks ADD COLUMN delete_reason TEXT");
  }
}

function createAgentProfilesSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      agent_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      specialties_json TEXT NOT NULL,
      default_tools_json TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      is_builtin INTEGER NOT NULL,
      lifecycle_status TEXT NOT NULL DEFAULT 'active',
      archived_at TEXT,
      archived_by TEXT,
      archive_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_profiles_lifecycle_status
      ON agent_profiles(lifecycle_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_role_id
      ON agent_profiles(role_id);
  `);
}

function createNativeToolsExpansionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_grants (
      grant_id TEXT PRIMARY KEY,
      tool_pattern TEXT NOT NULL,
      decision TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      grant_type TEXT NOT NULL,
      constraints_json TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      uses_remaining INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tool_grants_scope
      ON tool_grants(scope, scope_ref, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_grants_pattern
      ON tool_grants(tool_pattern, created_at DESC);

    CREATE TABLE IF NOT EXISTS tool_access_decisions (
      decision_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      allowed INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      matched_grant_id TEXT,
      requires_approval INTEGER NOT NULL,
      risk_level TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_tool_time
      ON tool_access_decisions(tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_agent_time
      ON tool_access_decisions(agent_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      doc_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_namespace_time
      ON knowledge_documents(namespace, created_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      chunk_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding_json TEXT,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(doc_id) REFERENCES knowledge_documents(doc_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_seq
      ON knowledge_chunks(doc_id, seq);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_created_at
      ON knowledge_chunks(created_at DESC);

    CREATE TABLE IF NOT EXISTS comms_deliveries (
      delivery_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      target TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_msg_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_comms_deliveries_connection_time
      ON comms_deliveries(connection_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comms_deliveries_channel_time
      ON comms_deliveries(channel_key, created_at DESC);
  `);
}

function createChatWorkspaceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      workspace_path TEXT NOT NULL,
      color TEXT,
      lifecycle_status TEXT NOT NULL DEFAULT 'active',
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_projects_updated_at
      ON chat_projects(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_projects_lifecycle
      ON chat_projects(lifecycle_status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_session_meta (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      title TEXT,
      origin TEXT,
      include_in_history INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      lifecycle_status TEXT NOT NULL DEFAULT 'active',
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_session_meta_updated_at
      ON chat_session_meta(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_session_meta_lifecycle
      ON chat_session_meta(lifecycle_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_session_meta_pinned
      ON chat_session_meta(pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_session_meta_history_visibility
      ON chat_session_meta(workspace_id, include_in_history, lifecycle_status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_session_projects (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES chat_projects(project_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_session_projects_project
      ON chat_session_projects(project_id, assigned_at DESC);

    CREATE TABLE IF NOT EXISTS chat_session_bindings (
      session_id TEXT PRIMARY KEY,
      transport TEXT NOT NULL,
      connection_id TEXT,
      target_json TEXT,
      writable INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_attachments (
      attachment_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_rel_path TEXT NOT NULL,
      extract_status TEXT NOT NULL,
      extract_preview TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES chat_projects(project_id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_attachments_session
      ON chat_attachments(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_project
      ON chat_attachments(project_id, created_at DESC);
  `);
}

function createSystemSettingsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function createV11ExpansionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      server_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      transport TEXT NOT NULL,
      command TEXT,
      args_json TEXT,
      url TEXT,
      auth_type TEXT NOT NULL DEFAULT 'none',
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'disconnected',
      last_error TEXT,
      last_connected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_servers_updated
      ON mcp_servers(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled
      ON mcp_servers(enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS mcp_server_auth (
      server_id TEXT PRIMARY KEY,
      access_token_ref TEXT,
      refresh_token_ref TEXT,
      token_expires_at TEXT,
      oauth_state TEXT,
      scopes_json TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(server_id) REFERENCES mcp_servers(server_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mcp_tools_cache (
      cache_id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      description TEXT,
      input_schema_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      UNIQUE(server_id, tool_name),
      FOREIGN KEY(server_id) REFERENCES mcp_servers(server_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_tools_cache_server
      ON mcp_tools_cache(server_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS media_jobs (
      job_id TEXT PRIMARY KEY,
      session_id TEXT,
      attachment_id TEXT,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_media_jobs_session
      ON media_jobs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_jobs_attachment
      ON media_jobs(attachment_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_jobs_status
      ON media_jobs(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS media_artifacts (
      artifact_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attachment_id TEXT,
      kind TEXT NOT NULL,
      storage_rel_path TEXT,
      text_preview TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES media_jobs(job_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_artifacts_job
      ON media_artifacts(job_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS voice_sessions (
      voice_session_id TEXT PRIMARY KEY,
      talk_session_id TEXT,
      mode TEXT NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_voice_sessions_updated
      ON voice_sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS voice_wake_profiles (
      profile_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sensitivity REAL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_voice_wake_profiles_enabled
      ON voice_wake_profiles(enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS daemon_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_daemon_events_created
      ON daemon_events(created_at DESC);
  `);

  addColumnIfMissing(db, "chat_attachments", "media_type", "TEXT");
  addColumnIfMissing(db, "chat_attachments", "thumbnail_rel_path", "TEXT");
  addColumnIfMissing(db, "chat_attachments", "ocr_text", "TEXT");
  addColumnIfMissing(db, "chat_attachments", "transcript_text", "TEXT");
  addColumnIfMissing(db, "chat_attachments", "analysis_status", "TEXT NOT NULL DEFAULT 'pending'");

  addColumnIfMissing(db, "integration_connections", "plugin_id", "TEXT");
  addColumnIfMissing(db, "integration_connections", "plugin_version", "TEXT");
  addColumnIfMissing(db, "integration_connections", "plugin_enabled", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "integration_connections", "plugin_meta_json", "TEXT");
}

function createAgenticChatSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_prefs (
      session_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'chat',
      planning_mode TEXT NOT NULL DEFAULT 'off',
      provider_id TEXT,
      model TEXT,
      web_mode TEXT NOT NULL DEFAULT 'auto',
      memory_mode TEXT NOT NULL DEFAULT 'auto',
      thinking_level TEXT NOT NULL DEFAULT 'standard',
      tool_autonomy TEXT NOT NULL DEFAULT 'safe_auto',
      vision_fallback_model TEXT,
      orchestration_enabled INTEGER NOT NULL DEFAULT 1,
      orchestration_intensity TEXT NOT NULL DEFAULT 'balanced',
      orchestration_visibility TEXT NOT NULL DEFAULT 'summarized',
      orchestration_provider_preference TEXT NOT NULL DEFAULT 'balanced',
      orchestration_review_depth TEXT NOT NULL DEFAULT 'standard',
      orchestration_parallelism TEXT NOT NULL DEFAULT 'auto',
      code_auto_apply TEXT NOT NULL DEFAULT 'aggressive_auto',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_session_prefs_updated
      ON chat_session_prefs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_turn_traces (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT,
      web_mode TEXT NOT NULL,
      memory_mode TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      routing_json TEXT NOT NULL,
      retrieval_json TEXT,
      reflection_json TEXT,
      proactive_json TEXT,
      orchestration_json TEXT,
      guidance_json TEXT,
      citations_json TEXT,
      failure_json TEXT,
      capability_upgrade_suggestions_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session
      ON chat_turn_traces(session_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS chat_tool_runs (
      tool_run_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_id TEXT,
      args_json TEXT,
      result_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_tool_runs_turn
      ON chat_tool_runs(turn_id, started_at ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_tool_runs_session
      ON chat_tool_runs(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_tool_runs_approval
      ON chat_tool_runs(approval_id);

    CREATE TABLE IF NOT EXISTS research_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_research_runs_session
      ON research_runs(session_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS research_sources (
      source_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      title TEXT,
      url TEXT NOT NULL,
      snippet TEXT,
      rank INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_research_sources_run
      ON research_sources(run_id, rank ASC, created_at ASC);

    CREATE TABLE IF NOT EXISTS chat_inline_approvals (
      approval_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tool_name TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      expires_at TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_inline_approvals_session
      ON chat_inline_approvals(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_inline_approvals_turn
      ON chat_inline_approvals(turn_id, created_at DESC);
  `);
}

function createPromptPackReadinessSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_delegation_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      mode TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      status TEXT NOT NULL,
      visibility TEXT,
      workflow_template TEXT,
      route_decision_json TEXT,
      final_summary TEXT,
      stitched_output TEXT,
      citations_json TEXT NOT NULL,
      trace_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_session
      ON chat_delegation_runs(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_task
      ON chat_delegation_runs(task_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS chat_delegation_steps (
      step_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      summary TEXT,
      output TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_chat_delegation_steps_run
      ON chat_delegation_steps(run_id, step_index ASC, started_at ASC);

    CREATE TABLE IF NOT EXISTS prompt_packs (
      pack_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_label TEXT,
      test_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_packs_updated
      ON prompt_packs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS prompt_pack_tests (
      test_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_tests_pack_code
      ON prompt_pack_tests(pack_id, code);
    CREATE INDEX IF NOT EXISTS idx_prompt_pack_tests_pack_order
      ON prompt_pack_tests(pack_id, order_index ASC, created_at ASC);

    CREATE TABLE IF NOT EXISTS prompt_pack_runs (
      run_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      response_text TEXT,
      trace_json TEXT,
      citations_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_pack_runs_pack
      ON prompt_pack_runs(pack_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_pack_runs_test
      ON prompt_pack_runs(test_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS prompt_pack_scores (
      score_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      routing_score INTEGER NOT NULL,
      honesty_score INTEGER NOT NULL,
      handoff_score INTEGER NOT NULL,
      robustness_score INTEGER NOT NULL,
      usability_score INTEGER NOT NULL,
      total_score INTEGER NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_pack_scores_pack_test
      ON prompt_pack_scores(pack_id, test_id, created_at DESC);
  `);
}

function createRobustAgentExecutionSchema(db: DatabaseSync): void {
  addColumnIfMissing(db, "chat_turn_traces", "completion_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "durable_json", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_stream_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      run_id TEXT,
      chunk_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_stream_events_turn_sequence
      ON chat_stream_events(turn_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_chat_stream_events_session_turn
      ON chat_stream_events(session_id, turn_id, sequence ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_stream_events_created
      ON chat_stream_events(created_at ASC);

    CREATE TABLE IF NOT EXISTS chat_tool_artifacts (
      artifact_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tool_run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      content_type TEXT,
      byte_length INTEGER NOT NULL,
      snippet TEXT,
      storage_rel_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_tool_artifacts_turn
      ON chat_tool_artifacts(turn_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_tool_artifacts_tool_run
      ON chat_tool_artifacts(tool_run_id);
    CREATE INDEX IF NOT EXISTS idx_chat_tool_artifacts_session
      ON chat_tool_artifacts(session_id, created_at DESC);
  `);
}

function createSkillRuntimeStateSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_state (
      skill_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'enabled',
      note TEXT,
      updated_at TEXT NOT NULL,
      first_auto_approved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_skill_state_state_updated
      ON skill_state(state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS skill_activation_events (
      event_id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_activation_events_skill
      ON skill_activation_events(skill_id, created_at DESC);
  `);
}

function createBankrSafetySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bankr_action_audit (
      action_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      chain TEXT,
      symbol TEXT,
      usd_estimate REAL,
      status TEXT NOT NULL,
      approval_id TEXT,
      policy_reason TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bankr_action_audit_created
      ON bankr_action_audit(created_at DESC, action_id DESC);

    CREATE INDEX IF NOT EXISTS idx_bankr_action_audit_session
      ON bankr_action_audit(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bankr_budget_usage_daily (
      day TEXT PRIMARY KEY,
      usd_total REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

function createAgenticDepthSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_autonomy_prefs (
      session_id TEXT PRIMARY KEY,
      proactive_mode TEXT NOT NULL DEFAULT 'off',
      max_actions_per_hour INTEGER NOT NULL DEFAULT 6,
      max_actions_per_turn INTEGER NOT NULL DEFAULT 2,
      cooldown_seconds INTEGER NOT NULL DEFAULT 60,
      retrieval_mode TEXT NOT NULL DEFAULT 'standard',
      reflection_mode TEXT NOT NULL DEFAULT 'off',
      last_proactive_at TEXT,
      last_proactive_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_autonomy_prefs_updated
      ON session_autonomy_prefs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS proactive_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      reasoning_summary TEXT,
      action_count INTEGER NOT NULL DEFAULT 0,
      suggested_actions_json TEXT NOT NULL,
      executed_actions_json TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_runs_session_created
      ON proactive_runs(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_runs_status
      ON proactive_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS proactive_actions (
      action_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      tool_name TEXT,
      args_json TEXT,
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_actions_session_created
      ON proactive_actions(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_actions_run
      ON proactive_actions(run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_proactive_actions_status
      ON proactive_actions(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS learned_memory_items (
      item_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by_item_id TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      disabled_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_learned_memory_items_session_created
      ON learned_memory_items(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learned_memory_items_type
      ON learned_memory_items(item_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learned_memory_items_status
      ON learned_memory_items(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS learned_memory_sources (
      source_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      snippet TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_learned_memory_sources_item
      ON learned_memory_sources(item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS learned_memory_conflicts (
      conflict_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      existing_item_id TEXT,
      incoming_item_id TEXT,
      incoming_content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_learned_memory_conflicts_session
      ON learned_memory_conflicts(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learned_memory_conflicts_status
      ON learned_memory_conflicts(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_reflection_attempts (
      attempt_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      outcome TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      strategy TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_reflection_attempts_turn
      ON chat_reflection_attempts(turn_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_reflection_attempts_session
      ON chat_reflection_attempts(session_id, created_at DESC);
  `);

  addColumnIfMissing(db, "chat_turn_traces", "retrieval_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "reflection_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "proactive_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "failure_json", "TEXT");
}

function createWeeklyDecisionReplaySchema(db: DatabaseSync): void {
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

function createPromptPackBenchmarkSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_pack_benchmark_runs (
      benchmark_run_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      status TEXT NOT NULL,
      test_codes_json TEXT NOT NULL,
      providers_json TEXT NOT NULL,
      total_items INTEGER NOT NULL DEFAULT 0,
      completed_items INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_pack_started
      ON prompt_pack_benchmark_runs(pack_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_status
      ON prompt_pack_benchmark_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS prompt_pack_benchmark_items (
      item_id TEXT PRIMARY KEY,
      benchmark_run_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      test_id TEXT NOT NULL,
      test_code TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      run_id TEXT,
      score_id TEXT,
      run_status TEXT NOT NULL,
      total_score INTEGER,
      failure_signal TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(benchmark_run_id) REFERENCES prompt_pack_benchmark_runs(benchmark_run_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_run
      ON prompt_pack_benchmark_items(benchmark_run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_model
      ON prompt_pack_benchmark_items(provider_id, model, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_test
      ON prompt_pack_benchmark_items(test_code, created_at DESC);
  `);
}

function createWorkspaceIsolationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      slug TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL DEFAULT 'active',
      archived_at TEXT,
      workspace_prefs_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug_unique
      ON workspaces(slug);
    CREATE INDEX IF NOT EXISTS idx_workspaces_updated
      ON workspaces(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspaces_lifecycle
      ON workspaces(lifecycle_status, updated_at DESC);
  `);

  addColumnIfMissing(db, "chat_projects", "workspace_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "chat_session_meta", "workspace_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "chat_session_bindings", "workspace_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "chat_attachments", "workspace_id", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "chat_turn_traces", "guidance_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "failure_json", "TEXT");
  addColumnIfMissing(db, "tasks", "workspace_id", "TEXT NOT NULL DEFAULT 'default'");

  db.exec(`
    UPDATE chat_projects SET workspace_id = 'default' WHERE workspace_id IS NULL OR TRIM(workspace_id) = '';
    UPDATE chat_session_meta SET workspace_id = 'default' WHERE workspace_id IS NULL OR TRIM(workspace_id) = '';
    UPDATE chat_session_bindings SET workspace_id = 'default' WHERE workspace_id IS NULL OR TRIM(workspace_id) = '';
    UPDATE chat_attachments SET workspace_id = 'default' WHERE workspace_id IS NULL OR TRIM(workspace_id) = '';
    UPDATE tasks SET workspace_id = 'default' WHERE workspace_id IS NULL OR TRIM(workspace_id) = '';

    CREATE INDEX IF NOT EXISTS idx_chat_projects_workspace_updated
      ON chat_projects(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_session_meta_workspace_updated
      ON chat_session_meta(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_session_bindings_workspace_updated
      ON chat_session_bindings(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_workspace_created
      ON chat_attachments(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated
      ON tasks(workspace_id, updated_at DESC);

    INSERT INTO workspaces (
      workspace_id, name, description, slug, lifecycle_status, archived_at, workspace_prefs_json, created_at, updated_at
    )
    VALUES (
      'default',
      'Default Workspace',
      'Auto-migrated workspace for existing GoatCitadel data.',
      'default',
      'active',
      NULL,
      '{}',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(workspace_id) DO UPDATE SET
      name = CASE WHEN COALESCE(TRIM(workspaces.name), '') = '' THEN excluded.name ELSE workspaces.name END,
      slug = CASE WHEN COALESCE(TRIM(workspaces.slug), '') = '' THEN excluded.slug ELSE workspaces.slug END,
      updated_at = CASE WHEN workspaces.updated_at IS NULL THEN excluded.updated_at ELSE workspaces.updated_at END;
  `);
}

function createDurableRunFoundationSchema(db: DatabaseSync): void {
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runs_status_updated
      ON durable_runs(status, updated_at DESC);
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

function createGapClosureExtensionSchema(db: DatabaseSync): void {
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
      forgotten_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_namespace_status
      ON memory_items(namespace, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_pinned_updated
      ON memory_items(pinned DESC, updated_at DESC);

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

function createOperationalHotPathSchema(db: DatabaseSync): void {
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
}

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
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get("realtime_events") as { name: string } | undefined;
  if (!tableExists) {
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS realtime_event_sequence_state (
      stream_name TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL
    );
  `);
  const maxSequenceRow = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM realtime_events")
    .get() as { max_sequence?: number | null } | undefined;
  const maxSequence = Number(maxSequenceRow?.max_sequence ?? 0);
  db.prepare(`
    INSERT INTO realtime_event_sequence_state (stream_name, last_sequence)
    VALUES ('events', @lastSequence)
    ON CONFLICT(stream_name) DO UPDATE SET
      last_sequence = CASE
        WHEN realtime_event_sequence_state.last_sequence < excluded.last_sequence
          THEN excluded.last_sequence
        ELSE realtime_event_sequence_state.last_sequence
      END
  `).run({ lastSequence: maxSequence });
}

function createToolAccessDecisionHotPathIndexes(db: DatabaseSync): void {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get("tool_access_decisions") as { name: string } | undefined;
  if (!tableExists) {
    return;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_tool_agent_session_time
      ON tool_access_decisions(tool_name, agent_id, session_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_tool_task_time
      ON tool_access_decisions(tool_name, task_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_allowed_tool_time
      ON tool_access_decisions(allowed, tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_agent_allowed_tool_time
      ON tool_access_decisions(agent_id, allowed, tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_session_allowed_tool_time
      ON tool_access_decisions(agent_id, session_id, allowed, tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_task_allowed_tool_time
      ON tool_access_decisions(task_id, allowed, tool_name, timestamp DESC);
  `);
}

function createCompanionSessionRuntimeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_sessions (
      session_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      access_token_hash TEXT NOT NULL UNIQUE,
      access_token_expires_at TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      refresh_token_expires_at TEXT NOT NULL,
      signing_public_key_pem TEXT NOT NULL,
      signature_algorithm TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_rotated_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(grant_id) REFERENCES auth_device_grants(grant_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_companion_sessions_grant_active
      ON companion_sessions(grant_id, revoked_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_companion_sessions_access_expires
      ON companion_sessions(access_token_expires_at);
    CREATE INDEX IF NOT EXISTS idx_companion_sessions_refresh_expires
      ON companion_sessions(refresh_token_expires_at);

    CREATE TABLE IF NOT EXISTS companion_request_replays (
      session_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(session_id, nonce),
      FOREIGN KEY(session_id) REFERENCES companion_sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_companion_request_replays_expires
      ON companion_request_replays(expires_at);
  `);
}

function createChannelSetupDraftsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_setup_drafts (
      draft_id TEXT PRIMARY KEY,
      catalog_id TEXT NOT NULL,
      connection_id TEXT,
      lifecycle_mode TEXT NOT NULL,
      label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      draft_json TEXT NOT NULL,
      hydration_json TEXT,
      content_version TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      validation_version TEXT NOT NULL,
      test_version TEXT NOT NULL,
      last_validated_at TEXT,
      last_tested_at TEXT,
      last_failure_category TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_setup_drafts_catalog
      ON channel_setup_drafts(catalog_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_setup_drafts_connection
      ON channel_setup_drafts(connection_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_setup_drafts_lifecycle
      ON channel_setup_drafts(lifecycle_mode, updated_at DESC);
  `);
}

function createChatSessionHistoryVisibilitySchema(db: DatabaseSync): void {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get("chat_session_meta") as { name: string } | undefined;
  if (!tableExists) {
    return;
  }

  addColumnIfMissing(db, "chat_session_meta", "origin", "TEXT");
  addColumnIfMissing(db, "chat_session_meta", "include_in_history", "INTEGER NOT NULL DEFAULT 1");

  db.exec(`
    UPDATE chat_session_meta
    SET include_in_history = 1
    WHERE include_in_history IS NULL;

    CREATE INDEX IF NOT EXISTS idx_chat_session_meta_history_visibility
      ON chat_session_meta(workspace_id, include_in_history, lifecycle_status, updated_at DESC);
  `);
}

function createWorkspaceHookRuntimeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_hooks (
      hook_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      label TEXT NOT NULL,
      trigger TEXT NOT NULL,
      mode TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      timeout_ms INTEGER NOT NULL DEFAULT 5000,
      fail_policy TEXT NOT NULL DEFAULT 'open',
      action_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_hooks_workspace_priority
      ON workspace_hooks(workspace_id, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_workspace_hooks_workspace_trigger
      ON workspace_hooks(workspace_id, trigger, enabled, priority DESC, created_at ASC);

    CREATE TABLE IF NOT EXISTS hook_runs (
      run_id TEXT PRIMARY KEY,
      hook_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      durable_run_id TEXT,
      decision_json TEXT,
      patch_summary_json TEXT,
      error_text TEXT,
      latency_ms INTEGER,
      request_payload_json TEXT,
      response_payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_runs_hook_idempotency
      ON hook_runs(hook_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_hook_runs_workspace_created
      ON hook_runs(workspace_id, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_hook_runs_durable
      ON hook_runs(durable_run_id, created_at DESC);
  `);
}

function createMemoryMaintenanceSchema(db: DatabaseSync): void {
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

function createContextManifestSchema(db: DatabaseSync): void {
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

function createTranscriptOutboxSchema(db: DatabaseSync): void {
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

function createRealtimeStreamLeaseSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS realtime_stream_leases (
      lease_id TEXT PRIMARY KEY,
      stream_name TEXT NOT NULL,
      client_id TEXT NOT NULL,
      gateway_node_id TEXT NOT NULL,
      requested_cursor INTEGER,
      last_sent_sequence INTEGER,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      last_event_at TEXT,
      closed_at TEXT,
      close_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_stream_state_updated
      ON realtime_stream_leases(stream_name, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_client_state_updated
      ON realtime_stream_leases(client_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_node_state_updated
      ON realtime_stream_leases(gateway_node_id, state, updated_at DESC);
  `);
}

function createAssemblyOfMindsSchema(db: DatabaseSync): void {
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

function createRealtimeEventSequenceCursorSchema(db: DatabaseSync): void {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get("realtime_events") as { name: string } | undefined;
  if (!tableExists) {
    return;
  }
  addColumnIfMissingIfTableExists(db, "realtime_events", "sequence", "INTEGER");
  db.exec(`
    WITH ordered_events AS (
      SELECT
        event_id,
        ROW_NUMBER() OVER (ORDER BY created_at ASC, event_id ASC) AS next_sequence
      FROM realtime_events
    )
    UPDATE realtime_events
    SET sequence = (
      SELECT next_sequence
      FROM ordered_events
      WHERE ordered_events.event_id = realtime_events.event_id
    )
    WHERE sequence IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_events_sequence
      ON realtime_events(sequence DESC);
  `);
}

function addColumnIfMissing(db: DatabaseSync, tableName: string, columnName: string, columnSql: string): void {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
  }
}

function addColumnIfMissingIfTableExists(db: DatabaseSync, tableName: string, columnName: string, columnSql: string): void {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) as { name: string } | undefined;
  if (!row) {
    return;
  }
  addColumnIfMissing(db, tableName, columnName, columnSql);
}
