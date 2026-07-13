/* eslint-disable max-lines */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clampInt } from "@goatcitadel/contracts";
import {
  assertSynchronousTransactionResult,
  type DatabaseClient,
  type DbStatement,
  type DbTransactionMode,
} from "./db.js";
import {
  createSqliteMigrationRegistry,
  runSqliteMigrations,
  type SqliteMigrationGroup,
} from "./sqlite/migration-registry.js";
import {
  createPromptPackSqliteSchemaBuilders,
  type SqlitePromptPackSchemaBuilders,
} from "./sqlite/prompt-pack-schema.js";
import {
  createApprovalRuntimeSqliteSchemaBuilders,
  type SqliteApprovalRuntimeSchemaBuilders,
} from "./sqlite/approval-runtime-schema.js";
import {
  backfillChatMessagesFts,
  createChatMessagesFtsSchema,
  createDurableRunFoundationSchema,
  createGapClosureExtensionSchema,
  createOperationalHotPathSchema,
} from "./sqlite/runtime-foundation-schema.js";
import {
  createContextManifestSchema,
  createMemoryMaintenanceSchema,
  createMemoryQualityIssueSchema,
  createStructuredMemoryDecisionJournalSchema,
  createTranscriptOutboxSchema,
} from "./sqlite/memory-lifecycle-schema.js";
import { createCitadelCoreSchema, migrateLegacyCitadelCharters } from "./sqlite/citadel-core-schema.js";
import { createImprovementLedgerSchema } from "./sqlite/improvement-ledger-schema.js";
import { createWeeklyDecisionReplaySchema } from "./sqlite/decision-replay-schema.js";
import { createRealtimeStreamLeaseSchema } from "./sqlite/realtime-stream-schema.js";
import { createAssemblyOfMindsSchema } from "./sqlite/assembly-schema.js";
import {
  createLlmRuntimeMeasurementSchema,
  createRuntimeEvidenceEnvelopeSchema,
} from "./sqlite/runtime-observability-schema.js";
import { createSkillEvaluationRunsSchema } from "./sqlite/skill-evaluation-schema.js";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const LEGACY_REMOTE_APPROVAL_BEARER_PATTERN = /grat_[A-Za-z0-9_-]{43}/;
const LEGACY_REMOTE_APPROVAL_BEARER_GLOBAL_PATTERN = /grat_[A-Za-z0-9_-]{43}/g;
const LEGACY_REMOTE_APPROVAL_BEARER_VALUE_PATTERN = /grat_[A-Za-z0-9_-]{43}/;
const LEGACY_REMOTE_APPROVAL_SCRUB_BATCH_SIZE = 250;

/**
 * Quote a SQLite identifier (table/index name) for safe interpolation into
 * PRAGMA statements, which do not accept bound parameters. Names are sourced
 * from `sqlite_master`, but quoting keeps the statements robust if a name ever
 * contains spaces or quotes. Embedded double quotes are doubled per SQLite rules.
 */
function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
export interface SqliteOptions {
  dbPath: string;
  tuning?: {
    cacheSizeKb?: number;
    tempStoreMemory?: boolean;
    walAutoCheckpointPages?: number;
    synchronous?: "NORMAL" | "FULL" | "EXTRA" | "OFF";
    mmapSizeBytes?: number;
    journalSizeLimitBytes?: number;
  };
}

export function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

type SqliteStatement = ReturnType<DatabaseSync["prepare"]>;

class SqliteStatementAdapter implements DbStatement {
  public constructor(private readonly statement: SqliteStatement) {}

  public run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint } {
    const result = this.statement.run(...(params as Parameters<SqliteStatement["run"]>));
    return {
      changes: typeof result.changes === "number" ? result.changes : 0,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  public get<T = unknown>(...params: unknown[]): T | undefined {
    return this.statement.get(...(params as Parameters<SqliteStatement["get"]>)) as T | undefined;
  }

  public all<T = unknown>(...params: unknown[]): T[] {
    return this.statement.all(...(params as Parameters<SqliteStatement["all"]>)) as T[];
  }
}

class SqliteDatabaseClient implements DatabaseClient {
  public readonly dialect = "sqlite" as const;
  private transactionDepth = 0;
  private savepointCounter = 0;

  public constructor(private readonly db: DatabaseSync) {}

  public prepare(sql: string): DbStatement {
    return new SqliteStatementAdapter(this.db.prepare(sql));
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public close(): void {
    if (typeof this.db.close === "function") {
      this.db.close();
    }
  }

  public transaction<T>(mode: DbTransactionMode, callback: () => T): T {
    if (this.transactionDepth > 0) {
      const savepointName = `gc_nested_${(this.savepointCounter += 1)}`;
      this.db.exec(`SAVEPOINT ${savepointName}`);
      this.transactionDepth += 1;
      try {
        const result = callback();
        assertSynchronousTransactionResult(result);
        this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
        throw error;
      } finally {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      }
    }

    const beginSql = mode === "exclusive" ? "BEGIN EXCLUSIVE" : mode === "deferred" ? "BEGIN" : "BEGIN IMMEDIATE";
    this.db.exec(beginSql);
    this.transactionDepth = 1;
    try {
      const result = callback();
      assertSynchronousTransactionResult(result);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }
}

export function createDatabase(options: SqliteOptions): DatabaseClient {
  ensureParentDir(options.dbPath);
  const db = new DatabaseSync(options.dbPath, {
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const syncMode = options.tuning?.synchronous ?? "FULL";
  if (syncMode === "NORMAL" || syncMode === "FULL" || syncMode === "EXTRA" || syncMode === "OFF") {
    db.exec(`PRAGMA synchronous = ${syncMode};`);
  } else {
    db.exec("PRAGMA synchronous = FULL;");
  }
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
  if (options.tuning?.mmapSizeBytes !== undefined) {
    db.exec(`PRAGMA mmap_size = ${clampInt(options.tuning.mmapSizeBytes, 0, 0, 1073741824)};`);
  }
  if (options.tuning?.journalSizeLimitBytes !== undefined) {
    db.exec(`PRAGMA journal_size_limit = ${clampInt(options.tuning.journalSizeLimitBytes, -1, -1, 268435456)};`);
  }
  migrate(db);
  return new SqliteDatabaseClient(db);
}

function migrate(db: DatabaseSync): void {
  runSqliteMigrations(db, SCHEMA_MIGRATIONS);
}

export interface SqliteSchemaColumnBlueprint {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
  autoIncrement: boolean;
}

export interface SqliteSchemaForeignKeyBlueprint {
  id: number;
  seq: number;
  from: string;
  to: string;
  referencedTable: string;
  onUpdate: string;
  onDelete: string;
}

export interface SqliteSchemaIndexBlueprint {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
  /**
   * Partial-index predicate (the `WHERE <expr>` tail of `CREATE INDEX ... WHERE ...`),
   * without the leading `WHERE` keyword. `null` for full (non-partial) indexes.
   *
   * SQLite stores this only in `sqlite_master.sql` — `PRAGMA index_list`/`index_info`
   * do not expose it — so it must be threaded through explicitly to keep partial
   * indexes partial when the blueprint is rendered to other dialects (e.g. Postgres).
   */
  where: string | null;
}

export interface SqliteSchemaTableBlueprint {
  name: string;
  sql: string;
  columns: SqliteSchemaColumnBlueprint[];
  foreignKeys: SqliteSchemaForeignKeyBlueprint[];
  indexes: SqliteSchemaIndexBlueprint[];
  seedRows: Record<string, unknown>[];
}

export interface SqliteSchemaBlueprint {
  tables: SqliteSchemaTableBlueprint[];
}

const SCHEMA_MIGRATION_GROUPS: SqliteMigrationGroup[] = [
  {
    name: "canonical",
    migrations: [
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
        name: "deprecated_placeholder_v16",
        up: () => {
          // Migration slot reserved to keep contiguous version numbering after a feature removal.
        },
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
          const hasToolRuns = db
            .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_tool_runs'`)
            .get();
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
      {
        version: 51,
        name: "proactive_orchestration_linkage_schema",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "tasks", "metadata_json", "TEXT");

          addColumnIfMissingIfTableExists(db, "proactive_runs", "linked_task_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "linked_durable_run_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "approval_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "trigger_source", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "origin_surface", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "next_wake_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "stop_reason", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "external_reference_roots_json", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_runs", "resume_metadata_json", "TEXT");

          addColumnIfMissingIfTableExists(db, "proactive_actions", "linked_task_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_actions", "linked_durable_run_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_actions", "approval_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_actions", "trigger_source", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_actions", "origin_surface", "TEXT");
          addColumnIfMissingIfTableExists(db, "proactive_actions", "external_reference_roots_json", "TEXT");
        },
      },
      {
        version: 52,
        name: "prompt_pack_integrity_and_judge_schema",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "integrity_json", "TEXT");
          addColumnIfMissingIfTableExists(db, "prompt_pack_scores", "judge_json", "TEXT");
        },
      },
      {
        version: 53,
        name: "prompt_pack_scoring_v2_schema",
        up: createPromptPackScoringV2Schema,
      },
      {
        version: 54,
        name: "capability_system_v1_schema",
        up: createCapabilitySystemV1Schema,
      },
      {
        version: 55,
        name: "chat_session_workbench_schema",
        up: createChatSessionWorkbenchSchema,
      },
      {
        version: 56,
        name: "code_mode_sandbox_metadata_schema",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "sandbox_json", "TEXT");
        },
      },
      {
        version: 57,
        name: "improvement_ledger_v1_schema",
        up: createImprovementLedgerSchema,
      },
      {
        version: 58,
        name: "durable_lease_and_approval_effects_schema",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "durable_runs", "lease_owner_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "durable_runs", "lease_expires_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "durable_runs", "lease_heartbeat_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "durable_runs", "version", "INTEGER NOT NULL DEFAULT 1");
          createApprovalEffectsSchema(db);
          if (tableExists(db, "durable_runs")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_durable_runs_status_lease_updated
            ON durable_runs(status, lease_expires_at, updated_at DESC);
        `);
          }
        },
      },
      {
        version: 59,
        name: "approval_effects_pipeline_schema",
        up: (db) => {
          if (!tableExists(db, "approval_effects")) {
            createApprovalEffectsSchema(db);
          }
          addColumnIfMissingIfTableExists(db, "approval_effects", "target_kind", "TEXT");
          addColumnIfMissingIfTableExists(db, "approval_effects", "idempotency_key", "TEXT");
          addColumnIfMissingIfTableExists(db, "approval_effects", "payload_json", "TEXT NOT NULL DEFAULT '{}'");
          addColumnIfMissingIfTableExists(db, "approval_effects", "result_json", "TEXT NOT NULL DEFAULT '{}'");
          addColumnIfMissingIfTableExists(db, "approval_effects", "claimed_by", "TEXT");
          addColumnIfMissingIfTableExists(db, "approval_effects", "claimed_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "approval_effects", "lease_expires_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "approval_effects", "version", "INTEGER NOT NULL DEFAULT 1");
          if (tableExists(db, "approval_effects")) {
            db.exec(`
          UPDATE approval_effects
          SET effect_kind = 'approval_wait_wake'
          WHERE effect_kind = 'wake_durable_run';

          UPDATE approval_effects
          SET target_kind = COALESCE(NULLIF(target_kind, ''), 'durable_run');

          UPDATE approval_effects
          SET idempotency_key = approval_id || ':' || effect_kind || ':' || COALESCE(target_kind, 'durable_run') || ':' || target_id
          WHERE idempotency_key IS NULL OR TRIM(idempotency_key) = '';

          UPDATE approval_effects
          SET payload_json = COALESCE(NULLIF(payload_json, ''), '{}')
          WHERE payload_json IS NULL OR TRIM(payload_json) = '';

          UPDATE approval_effects
          SET result_json = COALESCE(NULLIF(result_json, ''), COALESCE(NULLIF(details_json, ''), '{}'))
          WHERE result_json IS NULL OR TRIM(result_json) = '';

          UPDATE approval_effects
          SET version = 1
          WHERE version IS NULL OR version < 1;

          DROP INDEX IF EXISTS idx_approval_effects_target;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_effects_idempotency
            ON approval_effects(idempotency_key);
          CREATE INDEX IF NOT EXISTS idx_approval_effects_lookup
            ON approval_effects(approval_id, effect_kind, target_kind, target_id);
          CREATE INDEX IF NOT EXISTS idx_approval_effects_status_lease_updated
            ON approval_effects(status, lease_expires_at, updated_at DESC);
        `);
          }
        },
      },
      {
        version: 60,
        name: "prompt_pack_benchmark_dedup_audit_schema",
        up: ensurePromptPackBenchmarkDedupAudit,
      },
      {
        version: 61,
        name: "prompt_pack_benchmark_dedup_repair_schema",
        up: ensurePromptPackBenchmarkDedupRepair,
      },
      {
        version: 62,
        name: "prompt_pack_run_derived_response_fields",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "derived_response_text", "TEXT");
          addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "derived_response_signals_json", "TEXT");
        },
      },
      {
        version: 63,
        name: "orchestration_execution_ownership_schema",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "workspace_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "durable_run_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "execution_state", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "worktree_path", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "worktree_status", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "worktree_base_ref", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "pending_approval_phase_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "pending_approved_by", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "pending_cost_increment_usd", "REAL");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "last_error", "TEXT");
          if (tableExists(db, "orchestration_runs")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_orchestration_runs_durable_run_id
            ON orchestration_runs(durable_run_id);
        `);
          }
        },
      },
      {
        version: 64,
        name: "imported_agent_catalog_schema",
        up: createImportedAgentCatalogSchema,
      },
      {
        version: 65,
        name: "cron_jobs_action_description_end_at",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cron_jobs", "action", "TEXT NOT NULL DEFAULT 'task'");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "description", "TEXT");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "end_at", "TEXT");
          if (tableExists(db, "cron_jobs")) {
            db.exec(`
          UPDATE cron_jobs
          SET action = CASE job_id
            WHEN 'self_improvement_weekly_replay' THEN 'improvement'
            WHEN 'improvement_weekly' THEN 'improvement'
            WHEN 'private_beta_backup_daily' THEN 'backup'
            WHEN 'memory-flush-daily' THEN 'memory_flush'
            WHEN 'cost-report-hourly' THEN 'cost_report'
            WHEN 'update-review-daily' THEN 'update_review'
            ELSE COALESCE(NULLIF(action, ''), 'task')
          END
          WHERE action IS NULL OR TRIM(action) = '' OR action = 'task';
        `);
          }
        },
      },
      {
        version: 66,
        name: "chat_session_organization",
        up: migrateChatSessionOrganization,
      },
      {
        version: 67,
        name: "agent_profile_preset_defaults",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "agent_profiles", "preset_defaults_json", "TEXT");
        },
      },
      {
        version: 68,
        name: "chat_generated_artifacts_and_thread_knowledge",
        up: createChatGeneratedArtifactsAndThreadKnowledgeSchema,
      },
      {
        version: 69,
        name: "mutation_idempotency_runtime_repairs",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_idempotency (
          method TEXT NOT NULL,
          route_path TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          actor_scope TEXT NOT NULL DEFAULT '',
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (method, route_path, idempotency_key, actor_scope)
        );

        CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_updated
          ON mutation_idempotency(updated_at DESC);
      `);
        },
      },
      {
        version: 70,
        name: "generated_artifact_provenance_repairs",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_generated_artifacts", "source_block_index", "INTEGER");
          addColumnIfMissingIfTableExists(db, "chat_generated_artifacts", "content_hash", "TEXT");
        },
      },
      {
        version: 71,
        name: "chat_image_route_preferences",
        up: createChatImageRoutePreferenceSchema,
      },
      {
        version: 72,
        name: "prompt_pack_agentic_diagnostics",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "prompt_pack_tests", "diagnostic_metadata_json", "TEXT");
          addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "execution_style", "TEXT");
          addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "diagnostic_metadata_json", "TEXT");
          addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_runs", "execution_style", "TEXT");
        },
      },
      {
        version: 73,
        name: "pending_approval_action_expiry_and_trace_index_parity",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "pending_approval_actions", "expires_at", "TEXT");
          db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_turn_traces_session_status
          ON chat_turn_traces(session_id, status, started_at DESC);
      `);
        },
      },
      {
        version: 74,
        name: "runtime_evidence_envelopes",
        up: createRuntimeEvidenceEnvelopeSchema,
      },
      {
        version: 75,
        name: "skill_evaluation_runs",
        up: createSkillEvaluationRunsSchema,
      },
      {
        version: 76,
        name: "agentic_runtime_task_metadata",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "task_subagent_sessions", "metadata_json", "TEXT");
          if (tableExists(db, "tasks")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status_updated
            ON tasks(workspace_id, status, updated_at DESC);
        `);
          }
          if (tableExists(db, "task_subagent_sessions")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_task_subagent_sessions_agent_status_updated
            ON task_subagent_sessions(agent_session_id, status, updated_at DESC);
        `);
          }
        },
      },
      {
        version: 77,
        name: "comms_delivery_runtime_metadata",
        up: migrateCommsDeliveryRuntimeMetadata,
      },
      {
        version: 78,
        name: "cron_jobs_action_config",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cron_jobs", "action_config_json", "TEXT");
        },
      },
      {
        version: 79,
        name: "state_validation_quarantine",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS state_validation_quarantine (
          quarantine_id TEXT PRIMARY KEY,
          store TEXT NOT NULL,
          row_id TEXT NOT NULL,
          raw_value TEXT,
          schema_error TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed
          ON state_validation_quarantine(store, observed_at DESC);
      `);
        },
      },
      {
        version: 80,
        name: "chat_session_meta_goal",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_session_meta", "pinned_goal", "TEXT");
          addColumnIfMissingIfTableExists(db, "chat_session_meta", "goal_turn_budget", "INTEGER");
          addColumnIfMissingIfTableExists(db, "chat_session_meta", "goal_turns_used", "INTEGER NOT NULL DEFAULT 0");
          addColumnIfMissingIfTableExists(db, "chat_session_meta", "goal_set_at", "TEXT");
        },
      },
      {
        version: 81,
        name: "chat_messages_steer_audit",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_messages", "steered", "INTEGER");
          addColumnIfMissingIfTableExists(db, "chat_messages", "parent_delegation_step_id", "TEXT");
        },
      },
      {
        version: 82,
        name: "task_kanban_columns",
        up: (db) => {
          if (tableExists(db, "tasks")) {
            addColumnIfMissingIfTableExists(db, "tasks", "distress_signals_json", "TEXT");
            addColumnIfMissingIfTableExists(db, "tasks", "retry_budget_json", "TEXT");
            addColumnIfMissingIfTableExists(db, "tasks", "artifact_verification_json", "TEXT");
          }
        },
      },
      {
        version: 83,
        name: "approvals_shell_explanations",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "approvals", "shell_explanations_json", "TEXT");
        },
      },
      {
        version: 84,
        name: "permission_profiles_and_override_context",
        up: createPermissionProfilesAndOverrideSchema,
      },
      {
        version: 85,
        name: "permission_revocation_actor",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "tool_grants", "revoked_by", "TEXT");
          addColumnIfMissingIfTableExists(db, "local_operator_overrides", "revoked_by", "TEXT");
        },
      },
      {
        version: 86,
        name: "tool_access_decision_run_lineage",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "tool_access_decisions", "run_id", "TEXT");
          if (tableExists(db, "tool_access_decisions")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_run_time
            ON tool_access_decisions(run_id, timestamp DESC);
        `);
          }
        },
      },
      {
        version: 87,
        name: "tool_access_decision_countable_usage",
        up: (db) => {
          addColumnIfMissingIfTableExists(
            db,
            "tool_access_decisions",
            "counts_toward_limits",
            "INTEGER NOT NULL DEFAULT 1",
          );
        },
      },
      {
        version: 88,
        name: "tool_invocation_permission_evidence",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "tool_invocations", "run_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "tool_invocations", "matched_grant_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "tool_invocations", "permission_profile_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "tool_invocations", "local_operator_override_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "tool_invocations", "approval_mode", "TEXT");
          addColumnIfMissingIfTableExists(db, "tool_invocations", "reason_codes_json", "TEXT");

          addColumnIfMissingIfTableExists(db, "policy_blocks", "task_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "policy_blocks", "run_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "policy_blocks", "matched_grant_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "policy_blocks", "permission_profile_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "policy_blocks", "local_operator_override_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "policy_blocks", "approval_mode", "TEXT");
          addColumnIfMissingIfTableExists(db, "policy_blocks", "reason_codes_json", "TEXT");
        },
      },
      {
        version: 89,
        name: "code_mode_structured_error_evidence",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "error_code", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "error_details_json", "TEXT");
        },
      },
      {
        version: 90,
        name: "code_mode_run_sandbox_schema_parity",
        up: ensureCodeModeRunSandboxSchemaParity,
      },
      {
        version: 91,
        name: "orchestration_run_policy_context",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "operator_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "auth_actor_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "auth_actor_source", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "permission_profile_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "local_operator_override_id", "TEXT");
        },
      },
      {
        version: 92,
        name: "drop_bankr_safety_schema",
        up: (db) => {
          db.exec(`
        DROP INDEX IF EXISTS idx_bankr_action_audit_session;
        DROP INDEX IF EXISTS idx_bankr_action_audit_created;
        DROP TABLE IF EXISTS bankr_action_audit;
        DROP TABLE IF EXISTS bankr_budget_usage_daily;
      `);
        },
      },
      {
        version: 93,
        name: "orchestration_plan_workspace_scope",
        up: migrateOrchestrationPlanWorkspaceScope,
      },
      {
        version: 94,
        name: "code_mode_run_status_listing_indexes",
        up: ensureCodeModeRunStatusListingIndexes,
      },
      {
        version: 95,
        name: "structured_memory_decision_journal_schema",
        up: createStructuredMemoryDecisionJournalSchema,
      },
      {
        version: 96,
        name: "chat_session_workbench_package_manager",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_session_workbench", "package_manager", "TEXT");
        },
      },
      {
        version: 97,
        name: "chat_generated_artifacts_project_scope",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_generated_artifacts", "project_id", "TEXT");
          if (tableExists(db, "chat_generated_artifacts")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_project_created
            ON chat_generated_artifacts(project_id, created_at DESC);
        `);
          }
        },
      },
      {
        version: 98,
        name: "chat_generated_artifacts_project_scope_backfill",
        up: (db) => {
          if (!tableExists(db, "chat_generated_artifacts") || !tableExists(db, "chat_session_projects")) {
            return;
          }
          db.exec(`
        UPDATE chat_generated_artifacts
        SET project_id = (
          SELECT chat_session_projects.project_id
          FROM chat_session_projects
          WHERE chat_session_projects.session_id = chat_generated_artifacts.session_id
        )
        WHERE project_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM chat_session_projects
            WHERE chat_session_projects.session_id = chat_generated_artifacts.session_id
          );
      `);
        },
      },
      {
        version: 99,
        name: "orchestration_runs_wave_budget_accumulator",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "wave_cost_usd_by_wave_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "stop_reason", "TEXT");
        },
      },
      {
        version: 100,
        name: "llm_runtime_measurement_and_eval_proof",
        up: createLlmRuntimeMeasurementSchema,
      },
      {
        version: 101,
        name: "chat_side_chats",
        up: createChatSideChatsSchema,
      },
      {
        version: 102,
        name: "cost_ledger_provider_timeseries",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cost_ledger", "provider_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "cost_ledger", "model_id", "TEXT");
          if (tableExists(db, "cost_ledger")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_cost_ledger_day_provider
            ON cost_ledger(day, provider_id);
        `);
          }
        },
      },
      {
        version: 103,
        name: "code_mode_execution_backend_identity",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "execution_backend_json", "TEXT");
        },
      },
      {
        version: 104,
        name: "external_side_effect_run_ledger",
        up: createExternalSideEffectRunSchema,
      },
      {
        version: 105,
        name: "memory_quality_issues",
        up: createMemoryQualityIssueSchema,
      },
      {
        version: 106,
        name: "a2a_task_bindings",
        up: createA2ATaskBindingSchema,
      },
      {
        version: 107,
        name: "a2a_task_push_configs",
        up: createA2ATaskPushConfigSchema,
      },
      {
        version: 108,
        name: "prompt_pack_run_score_facing_response_fields",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "final_response_text", "TEXT");
          addColumnIfMissingIfTableExists(db, "prompt_pack_runs", "final_response_signals_json", "TEXT");
        },
      },
      {
        version: 109,
        name: "knowledge_chunk_embedding_metadata",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "knowledge_chunks", "embedding_metadata_json", "TEXT");
        },
      },
      {
        version: 110,
        name: "memory_items_workspace_scope",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "memory_items", "workspace_id", "TEXT");
          if (tableExists(db, "memory_items")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_memory_items_workspace
            ON memory_items(workspace_id, status, updated_at DESC);
        `);
          }
        },
      },
      {
        version: 111,
        name: "citadel_core_schema",
        up: createCitadelCoreSchema,
      },
      {
        version: 112,
        name: "cron_jobs_citadel_scope",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cron_jobs", "citadel_id", "TEXT");
          if (tableExists(db, "cron_jobs")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_cron_jobs_citadel
            ON cron_jobs(citadel_id, job_id);
        `);
          }
        },
      },
      {
        version: 113,
        name: "citadel_agent_assignments_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS citadel_agent_assignments (
          assignment_id TEXT PRIMARY KEY,
          citadel_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_agent_assignments_unique
          ON citadel_agent_assignments(citadel_id, agent_id);
      `);
        },
      },
      {
        version: 114,
        name: "citadel_wards_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS citadel_wards (
          ward_id TEXT PRIMARY KEY,
          citadel_id TEXT NOT NULL,
          name TEXT NOT NULL,
          action_pattern TEXT NOT NULL,
          effect TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_citadel_wards_citadel
          ON citadel_wards(citadel_id, created_at ASC);
      `);
        },
      },
      {
        version: 115,
        name: "citadel_passages_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS citadel_passages (
          passage_id TEXT PRIMARY KEY,
          source_citadel_id TEXT NOT NULL,
          source_chamber_id TEXT,
          destination_citadel_id TEXT NOT NULL,
          allowed_fields_json TEXT NOT NULL DEFAULT '[]',
          expires_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_citadel_passages_source
          ON citadel_passages(source_citadel_id, created_at ASC);
      `);
        },
      },
      {
        version: 116,
        name: "citadel_members_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS citadel_members (
          member_id TEXT PRIMARY KEY,
          citadel_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_members_unique
          ON citadel_members(citadel_id, subject_id);
      `);
        },
      },
      {
        version: 117,
        name: "mason_sessions_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS mason_sessions (
          session_id TEXT PRIMARY KEY,
          answers_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'collecting',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mason_sessions_updated
          ON mason_sessions(updated_at DESC);
      `);
        },
      },
      {
        version: 118,
        name: "citadel_integration_grants_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS citadel_integration_grants (
          grant_id TEXT PRIMARY KEY,
          citadel_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          account TEXT,
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          mode TEXT NOT NULL DEFAULT 'read',
          expires_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_citadel_integration_grants_citadel
          ON citadel_integration_grants(citadel_id, created_at ASC);
      `);
        },
      },
      {
        version: 119,
        name: "citadel_vault_secrets_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS citadel_vault_secrets (
          secret_id TEXT PRIMARY KEY,
          citadel_id TEXT NOT NULL,
          secret_name TEXT NOT NULL,
          sealed_value_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_citadel_vault_secrets_name
          ON citadel_vault_secrets(citadel_id, secret_name);

        CREATE INDEX IF NOT EXISTS idx_citadel_vault_secrets_citadel
          ON citadel_vault_secrets(citadel_id, created_at DESC);
      `);
        },
      },
      {
        version: 120,
        name: "runtime_decision_traces_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_decision_traces (
          decision_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          workspace_id TEXT,
          session_id TEXT,
          turn_id TEXT,
          run_id TEXT,
          plan_id TEXT,
          step_id TEXT,
          tool_run_id TEXT,
          approval_id TEXT,
          task_id TEXT,
          durable_run_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_session_turn
          ON runtime_decision_traces(session_id, turn_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_run
          ON runtime_decision_traces(run_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_plan
          ON runtime_decision_traces(plan_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_approval
          ON runtime_decision_traces(approval_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_created
          ON runtime_decision_traces(created_at ASC);
      `);
        },
      },
      {
        version: 121,
        name: "citadel_operating_model_parent_scope",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS citadel_records (
          citadel_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          slug TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'custom',
          lifecycle_status TEXT NOT NULL DEFAULT 'active',
          archived_at TEXT,
          default_workspace_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_citadel_records_lifecycle_updated
          ON citadel_records(lifecycle_status, updated_at DESC);
      `);

          addColumnIfMissingIfTableExists(db, "workspaces", "citadel_id", "TEXT NOT NULL DEFAULT 'personal'");
          addColumnIfMissingIfTableExists(db, "runtime_decision_traces", "citadel_id", "TEXT");

          const now = new Date().toISOString();
          db.prepare(
            `
        INSERT INTO citadel_records (
          citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
          default_workspace_id, created_at, updated_at
        ) VALUES (
          'personal',
          'Personal',
          'Default personal operating world for private work, memory, files, agents, and projects.',
          'personal',
          'personal',
          'active',
          NULL,
          'default',
          @now,
          @now
        )
        ON CONFLICT(citadel_id) DO UPDATE SET
          default_workspace_id = COALESCE(citadel_records.default_workspace_id, excluded.default_workspace_id),
          updated_at = citadel_records.updated_at
      `,
          ).run({ now });
          db.prepare(
            `
        INSERT INTO citadel_records (
          citadel_id, name, description, slug, kind, lifecycle_status, archived_at,
          default_workspace_id, created_at, updated_at
        ) VALUES (
          'company',
          'Company',
          'Default company operating world for shared workspaces such as Engineering, Product, Sales, Finance, HR, Legal, and Support.',
          'company',
          'company',
          'active',
          NULL,
          NULL,
          @now,
          @now
        )
        ON CONFLICT(citadel_id) DO UPDATE SET
          updated_at = citadel_records.updated_at
      `,
          ).run({ now });

          if (tableExists(db, "citadel_charters")) {
            migrateLegacyCitadelCharters(db);
          }

          if (tableExists(db, "workspaces")) {
            db.exec(`
          UPDATE workspaces
          SET citadel_id = 'personal'
          WHERE citadel_id IS NULL OR TRIM(citadel_id) = '';

          UPDATE workspaces
          SET citadel_id = workspace_id
          WHERE EXISTS (
            SELECT 1
            FROM citadel_records
            WHERE citadel_records.citadel_id = workspaces.workspace_id
              AND citadel_records.citadel_id NOT IN ('personal', 'company')
          );

          CREATE INDEX IF NOT EXISTS idx_workspaces_citadel_updated
            ON workspaces(citadel_id, lifecycle_status, updated_at DESC);
        `);
          }
          if (tableExists(db, "runtime_decision_traces")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_runtime_decision_traces_citadel_created
            ON runtime_decision_traces(citadel_id, created_at ASC);
        `);
          }
        },
      },
      {
        version: 122,
        name: "external_connector_review_states",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS external_connector_review_states (
          workspace_id TEXT NOT NULL DEFAULT 'default',
          source_id TEXT NOT NULL,
          service_id TEXT NOT NULL,
          action_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          proposal_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, source_id, service_id, action_id)
        );

        CREATE INDEX IF NOT EXISTS idx_external_connector_review_states_workspace
          ON external_connector_review_states(workspace_id, status, pinned, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_external_connector_review_states_service
          ON external_connector_review_states(source_id, service_id, action_id);
      `);
        },
      },
      {
        version: 123,
        name: "agent_commitments_schema",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS agent_commitments (
          commitment_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL DEFAULT 'default',
          kind TEXT NOT NULL,
          due_at TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0,
          dedupe_key TEXT NOT NULL,
          suggested_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_by TEXT NOT NULL DEFAULT 'classifier',
          created_at TEXT NOT NULL,
          sent_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_commitments_session_dedupe
          ON agent_commitments(session_id, dedupe_key);
        CREATE INDEX IF NOT EXISTS idx_agent_commitments_status_due
          ON agent_commitments(status, due_at);
      `);
        },
      },
      {
        version: 124,
        name: "session_autonomy_heartbeat_columns",
        up: (db) => {
          // P1-F4 heartbeat (silent self-wake). Additive columns on the existing
          // table — defaults backfill existing rows without rewriting them. Heartbeat
          // defaults ON (chosen on-by-default posture); the master autonomy switch
          // still gates whether any tick fires.
          addColumnIfMissingIfTableExists(
            db,
            "session_autonomy_prefs",
            "heartbeat_enabled",
            "INTEGER NOT NULL DEFAULT 1",
          );
          addColumnIfMissingIfTableExists(
            db,
            "session_autonomy_prefs",
            "heartbeat_interval_seconds",
            "INTEGER NOT NULL DEFAULT 3600",
          );
          addColumnIfMissingIfTableExists(db, "session_autonomy_prefs", "active_hours_json", "TEXT");
        },
      },
      {
        version: 125,
        name: "chat_messages_fts_recall_schema",
        up: (db) => {
          // P2-S4a session.search: FTS5 recall index over persisted chat messages.
          // The table + sync triggers are co-located with chat_messages for fresh DBs;
          // this migration adds them to existing databases and backfills prior rows.
          if (tableExists(db, "chat_messages")) {
            createChatMessagesFtsSchema(db);
            backfillChatMessagesFts(db);
          }
        },
      },
      {
        version: 126,
        name: "operator_profiles_schema",
        // P2-S4b cross-session operator profile. A plain workspace-scoped table; this
        // migration is the only definition (fresh DBs replay all migrations, so they
        // gain it here, matching the agent_commitments v123 pattern). The Postgres
        // canonical schema auto-derives it from the SQLite blueprint, so no targeted
        // Postgres backfill is required for fresh installs.
        up: createOperatorProfileSchema,
      },
      {
        version: 127,
        name: "autonomy_audit_schema",
        // Cross-cutting kill-switch & rollback. A unified, append-only ledger of every
        // autonomous mutation so an operator can "revert all autonomous changes since T".
        // Each row points at the subsystem's own snapshot/ref via restore_ref_json (no
        // duplicate snapshots). Like v126, this is the only definition (fresh DBs replay
        // it); the Postgres canonical schema auto-derives it from the SQLite blueprint.
        up: createAutonomyAuditSchema,
      },
      {
        version: 128,
        name: "cost_ledger_credential_pool",
        // Anthropic Jun-2026 billing pool split: record which credential class (api_key
        // vs oauth) and billing pool (standard vs subscription) each usage row drew from.
        // Additive nullable columns; the repo's insert is column-aware so older DBs that
        // predate this migration keep working.
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cost_ledger", "credential_type", "TEXT");
          addColumnIfMissingIfTableExists(db, "cost_ledger", "usage_pool", "TEXT");
        },
      },
      {
        version: 129,
        name: "runtime_evidence_workspace_scope",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "runtime_evidence_envelopes", "workspace_id", "TEXT");
          if (tableExists(db, "runtime_evidence_envelopes")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_runtime_evidence_workspace_created
            ON runtime_evidence_envelopes(workspace_id, created_at DESC);
        `);
          }
        },
      },
      {
        version: 130,
        name: "chat_delegation_parent_run_id",
        up: ensureChatDelegationParentRunIdSchema,
      },
      {
        version: 131,
        name: "cost_ledger_created_at_index",
        up: (db) => {
          if (tableExists(db, "cost_ledger")) {
            db.exec(`
          CREATE INDEX IF NOT EXISTS idx_cost_ledger_created_at
            ON cost_ledger(created_at);
        `);
          }
        },
      },
      {
        version: 132,
        name: "capability_scope_assignments",
        up: (db) => {
          db.exec(`
        CREATE TABLE IF NOT EXISTS capability_scope_assignments (
          assignment_id TEXT PRIMARY KEY,
          scope_kind TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_ref TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_scope_assignments_unique
          ON capability_scope_assignments(scope_kind, scope_id, resource_type, resource_ref);

        CREATE INDEX IF NOT EXISTS idx_capability_scope_assignments_lookup
          ON capability_scope_assignments(scope_kind, scope_id, resource_type, enabled);
      `);
        },
      },
      {
        version: 133,
        name: "cron_jobs_run_evidence_state",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cron_jobs", "last_run_status", "TEXT");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "last_run_evidence_envelope_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "last_failure_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "last_failure_json", "TEXT");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "failure_count", "INTEGER");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "backoff_until", "TEXT");
        },
      },
      {
        version: 134,
        name: "integration_connections_workspace_scope_parity",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "integration_connections", "workspace_id", "TEXT");
        },
      },
      {
        version: 135,
        name: "dry_run_commits_ledger_parity",
        up: createDryRunCommitSchema,
      },
      {
        version: 136,
        name: "prompt_packs_content_sha256",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "prompt_packs", "content_sha256", "TEXT");
        },
      },
      {
        version: 137,
        name: "scrub_legacy_device_token_plaintext",
        up: scrubLegacyDeviceTokenPlaintext,
      },
      {
        version: 138,
        name: "approval_expiry_sweep_index_parity",
        up: (db) => {
          if (tableExists(db, "approvals")) {
            db.exec(`
              CREATE INDEX IF NOT EXISTS idx_approvals_status_expires_at
                ON approvals(status, julianday(expires_at), approval_id)
                WHERE expires_at IS NOT NULL;
            `);
          }
        },
      },
      {
        version: 139,
        name: "scrub_legacy_remote_approval_bearers",
        up: scrubLegacyRemoteApprovalBearers,
      },
      {
        version: 140,
        name: "mutation_idempotency_claim_lease_parity",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "mutation_idempotency", "claim_token", "TEXT");
          addColumnIfMissingIfTableExists(db, "mutation_idempotency", "claim_expires_at", "TEXT");
          if (tableExists(db, "mutation_idempotency")) {
            db.exec(`
              UPDATE mutation_idempotency
              SET claim_token = COALESCE(claim_token, 'legacy-' || lower(hex(randomblob(16)))),
                  claim_expires_at = COALESCE(claim_expires_at, updated_at)
              WHERE status = 'pending';

              CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_pending_lease
                ON mutation_idempotency(status, claim_expires_at, updated_at);
            `);
          }
        },
      },
      {
        version: 141,
        name: "chat_delegation_step_plan_truth",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "parallelizable", "INTEGER NOT NULL DEFAULT 0");
          addColumnIfMissingIfTableExists(
            db,
            "chat_delegation_steps",
            "depends_on_step_ids_json",
            "TEXT NOT NULL DEFAULT '[]'",
          );
        },
      },
      {
        version: 142,
        name: "chat_delegation_dispatch_claim_lease",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "dispatch_claim_token", "TEXT");
          addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "dispatch_claim_expires_at", "TEXT");
          if (tableExists(db, "chat_delegation_steps")) {
            db.exec(`
              UPDATE chat_delegation_steps
              SET dispatch_claim_token = child_session_id,
                  dispatch_claim_expires_at = COALESCE(
                    strftime(
                      '%Y-%m-%dT%H:%M:%fZ',
                      CAST(
                        substr(
                          child_session_id,
                          length('delegation-claim:v1:') + 1,
                          instr(substr(child_session_id, length('delegation-claim:v1:') + 1), ':') - 1
                        ) AS REAL
                      ) / 1000.0,
                      'unixepoch'
                    ),
                    '1970-01-01T00:00:00.000Z'
                  ),
                  child_session_id = NULL
              WHERE child_session_id LIKE 'delegation-claim:v1:%';

              UPDATE chat_delegation_steps
              SET dispatch_claim_token = child_turn_id,
                  dispatch_claim_expires_at = COALESCE(
                    strftime(
                      '%Y-%m-%dT%H:%M:%fZ',
                      CAST(
                        substr(
                          child_turn_id,
                          length('delegation-dispatch:v1:') + 1,
                          instr(substr(child_turn_id, length('delegation-dispatch:v1:') + 1), ':') - 1
                        ) AS REAL
                      ) / 1000.0,
                      'unixepoch'
                    ),
                    '1970-01-01T00:00:00.000Z'
                  ),
                  child_turn_id = NULL
              WHERE child_turn_id LIKE 'delegation-dispatch:v1:%';

              CREATE INDEX IF NOT EXISTS idx_chat_delegation_steps_dispatch_claim
                ON chat_delegation_steps(status, dispatch_claim_expires_at, step_id);
            `);
          }
        },
      },
      {
        version: 143,
        name: "scrub_legacy_remote_approval_bearers_from_effect_results",
        up: (db) => {
          // v139 intentionally remains frozen. This forward correction covers
          // current result truth plus legacy effect detail columns that v139
          // did not inspect.
          scrubLegacyRemoteApprovalBearerColumns(db, "approval_effects", [
            "result_json",
            "detail",
            "details_json",
            "outcome",
          ]);
        },
      },
    ],
  },
];

const SCHEMA_MIGRATIONS = createSqliteMigrationRegistry(SCHEMA_MIGRATION_GROUPS);

function scrubLegacyDeviceTokenPlaintext(db: DatabaseSync): void {
  if (!tableExists(db, "auth_device_requests")) {
    return;
  }
  const scrubbedAt = new Date().toISOString();
  const resolutionNote =
    "Legacy device credential was revoked because its plaintext handoff predated secure in-memory delivery. Request access again.";
  if (tableExists(db, "auth_device_grants")) {
    db.prepare(
      `
      UPDATE auth_device_grants
      SET revoked_at = COALESCE(revoked_at, @scrubbedAt)
      WHERE revoked_at IS NULL
        AND request_id IN (
          SELECT request_id
          FROM auth_device_requests
          WHERE approved_token_plaintext IS NOT NULL
            AND TRIM(approved_token_plaintext) <> ''
            AND delivered_at IS NULL
        )
    `,
    ).run({ scrubbedAt });
  }
  db.prepare(
    `
    UPDATE auth_device_requests
    SET status = CASE
          WHEN approved_token_plaintext IS NOT NULL
            AND TRIM(approved_token_plaintext) <> ''
            AND delivered_at IS NULL
          THEN 'expired'
          ELSE status
        END,
        resolution_note = CASE
          WHEN approved_token_plaintext IS NOT NULL
            AND TRIM(approved_token_plaintext) <> ''
            AND delivered_at IS NULL
          THEN COALESCE(NULLIF(TRIM(resolution_note), ''), @resolutionNote)
          ELSE resolution_note
        END,
        approved_token_expires_at = CASE
          WHEN approved_token_plaintext IS NOT NULL
            AND TRIM(approved_token_plaintext) <> ''
            AND delivered_at IS NULL
          THEN NULL
          ELSE approved_token_expires_at
        END,
        approved_token_plaintext = NULL
    WHERE approved_token_plaintext IS NOT NULL
  `,
  ).run({ resolutionNote });
}

function scrubLegacyRemoteApprovalBearers(db: DatabaseSync): void {
  const now = new Date().toISOString();
  if (tableExists(db, "durable_runs")) {
    const listCandidates = db.prepare(`
      SELECT rowid AS row_id, run_id, payload_json
      FROM durable_runs
      WHERE (@afterRowId IS NULL OR rowid > @afterRowId)
        AND workflow_key = 'connector.delivery'
        AND payload_json LIKE '%grat\\_%' ESCAPE '\\'
        AND status IN ('queued', 'running', 'waiting', 'paused')
      ORDER BY rowid
      LIMIT @limit
    `);
    const failRun = db.prepare(
      `
      UPDATE durable_runs
      SET status = 'failed',
          finished_at = COALESCE(finished_at, @now),
          last_error = COALESCE(
            last_error,
            'Legacy remote approval bearer was removed from durable state; issue a new remote action token.'
          ),
          lease_owner_id = NULL,
          lease_expires_at = NULL,
          lease_heartbeat_at = NULL,
          updated_at = @now,
          version = version + 1
      WHERE run_id = @runId
        AND workflow_key = 'connector.delivery'
        AND status IN ('queued', 'running', 'waiting', 'paused')
    `,
    );
    let afterRowId: number | bigint | null = null;
    while (true) {
      const candidates = listCandidates.all({
        afterRowId,
        limit: LEGACY_REMOTE_APPROVAL_SCRUB_BATCH_SIZE,
      }) as Array<{ row_id: number | bigint; run_id: string; payload_json: string }>;
      if (candidates.length === 0) {
        break;
      }
      for (const candidate of candidates) {
        if (LEGACY_REMOTE_APPROVAL_BEARER_PATTERN.test(candidate.payload_json)) {
          failRun.run({ runId: candidate.run_id, now });
        }
      }
      afterRowId = candidates.at(-1)!.row_id;
    }
  }
  if (tableExists(db, "comms_deliveries")) {
    const listCandidates = db.prepare(`
      SELECT rowid AS row_id, delivery_id, payload_json
      FROM comms_deliveries
      WHERE (@afterRowId IS NULL OR rowid > @afterRowId)
        AND payload_json LIKE '%grat\\_%' ESCAPE '\\'
        AND status IN ('queued', 'running', 'retrying')
      ORDER BY rowid
      LIMIT @limit
    `);
    const failDelivery = db.prepare(
      `
      UPDATE comms_deliveries
      SET status = 'failed',
          delivery_status = 'manual_reconciliation_required',
          next_attempt_at = NULL,
          error = COALESCE(
            error,
            'Legacy remote approval bearer was removed before delivery; issue a new remote action token.'
          ),
          updated_at = @now
      WHERE delivery_id = @deliveryId
        AND status IN ('queued', 'running', 'retrying')
    `,
    );
    let afterRowId: number | bigint | null = null;
    while (true) {
      const candidates = listCandidates.all({
        afterRowId,
        limit: LEGACY_REMOTE_APPROVAL_SCRUB_BATCH_SIZE,
      }) as Array<{ row_id: number | bigint; delivery_id: string; payload_json: string }>;
      if (candidates.length === 0) {
        break;
      }
      for (const candidate of candidates) {
        if (LEGACY_REMOTE_APPROVAL_BEARER_PATTERN.test(candidate.payload_json)) {
          failDelivery.run({ deliveryId: candidate.delivery_id, now });
        }
      }
      afterRowId = candidates.at(-1)!.row_id;
    }
  }

  const textColumns: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
    { table: "durable_runs", columns: ["payload_json", "metadata_json", "last_error"] },
    { table: "durable_checkpoints", columns: ["state_json"] },
    { table: "durable_run_events", columns: ["payload_json"] },
    { table: "comms_deliveries", columns: ["payload_json", "error", "stale_reason"] },
    { table: "realtime_events", columns: ["payload_json"] },
    { table: "approval_events", columns: ["payload_json"] },
    {
      table: "approvals",
      columns: [
        "linkage_json",
        "payload_json",
        "preview_json",
        "explanation_json",
        "explanation_error",
        "resolution_note",
        "shell_explanations_json",
      ],
    },
    { table: "pending_approval_actions", columns: ["request_json", "result_json"] },
    { table: "tool_invocations", columns: ["args_json", "result_json", "policy_reason"] },
    { table: "policy_blocks", columns: ["details_json", "reason"] },
    { table: "approval_effects", columns: ["payload_json", "last_error"] },
    {
      table: "external_side_effect_runs",
      columns: ["request_payload_json", "response_payload_json", "error_text"],
    },
    { table: "runtime_decision_traces", columns: ["payload_json"] },
  ];
  for (const target of textColumns) {
    scrubLegacyRemoteApprovalBearerColumns(db, target.table, target.columns);
  }
  if (tableExists(db, "approval_inbox_items")) {
    const listCandidates = db.prepare(
      `SELECT rowid AS row_id, inbox_item_id, token
       FROM approval_inbox_items
       WHERE (@afterRowId IS NULL OR rowid > @afterRowId)
         AND token LIKE '%grat\\_%' ESCAPE '\\'
       ORDER BY rowid
       LIMIT @limit`,
    );
    const redactToken = db.prepare(
      `UPDATE approval_inbox_items SET token = 'redacted:' || token_id WHERE inbox_item_id = ?`,
    );
    let afterRowId: number | bigint | null = null;
    while (true) {
      const candidates = listCandidates.all({
        afterRowId,
        limit: LEGACY_REMOTE_APPROVAL_SCRUB_BATCH_SIZE,
      }) as Array<{ row_id: number | bigint; inbox_item_id: string; token: string }>;
      if (candidates.length === 0) {
        break;
      }
      for (const candidate of candidates) {
        if (LEGACY_REMOTE_APPROVAL_BEARER_VALUE_PATTERN.test(candidate.token)) {
          redactToken.run(candidate.inbox_item_id);
        }
      }
      afterRowId = candidates.at(-1)!.row_id;
    }
  }
}

function scrubLegacyRemoteApprovalBearerColumns(
  db: DatabaseSync,
  tableName: string,
  columnNames: readonly string[],
): void {
  if (!tableExists(db, tableName)) {
    return;
  }
  const existingColumns = new Set(
    (db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const columnName of columnNames) {
    if (!existingColumns.has(columnName)) {
      continue;
    }
    const table = quoteSqliteIdentifier(tableName);
    const column = quoteSqliteIdentifier(columnName);
    const listRows = db.prepare(
      `SELECT rowid AS row_id, ${column} AS value
       FROM ${table}
       WHERE (@afterRowId IS NULL OR rowid > @afterRowId)
         AND ${column} LIKE '%grat\\_%' ESCAPE '\\'
       ORDER BY rowid
       LIMIT @limit`,
    );
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
    let afterRowId: number | bigint | null = null;
    while (true) {
      const rows = listRows.all({
        afterRowId,
        limit: LEGACY_REMOTE_APPROVAL_SCRUB_BATCH_SIZE,
      }) as Array<{ row_id: number | bigint; value: string }>;
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const scrubbed = row.value.replace(LEGACY_REMOTE_APPROVAL_BEARER_GLOBAL_PATTERN, "[REDACTED]");
        if (scrubbed !== row.value) {
          update.run(scrubbed, row.row_id);
        }
      }
      afterRowId = rows.at(-1)!.row_id;
    }
  }
}

function createDryRunCommitSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dry_run_commits (
      dry_run_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      boundary TEXT NOT NULL,
      workspace_id TEXT,
      planned_action_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      dry_run_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT,
      committed_at TEXT,
      diagnostic_json TEXT,
      external_reference_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dry_run_commits_run
      ON dry_run_commits(run_id);
    CREATE INDEX IF NOT EXISTS idx_dry_run_commits_state_created
      ON dry_run_commits(state, created_at DESC);
  `);
}

function ensureChatDelegationParentRunIdSchema(db: DatabaseSync): void {
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "parent_run_id", "TEXT");
  if (tableExists(db, "chat_delegation_runs")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_parent
        ON chat_delegation_runs(parent_run_id, started_at DESC);
    `);
  }
}

function createAutonomyAuditSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_audit (
      audit_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_key TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      restore_ref_json TEXT NOT NULL DEFAULT '{}',
      reverted INTEGER NOT NULL DEFAULT 0,
      reverted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_autonomy_audit_since
      ON autonomy_audit(occurred_at);

    CREATE INDEX IF NOT EXISTS idx_autonomy_audit_unreverted
      ON autonomy_audit(reverted, occurred_at);
  `);
}

function createOperatorProfileSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_profiles (
      operator_profile_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      summary TEXT NOT NULL DEFAULT '',
      facts_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_profiles_workspace
      ON operator_profiles(workspace_id);
  `);
}

export function createSqliteSchemaBlueprint(): SqliteSchemaBlueprint {
  const db = new DatabaseSync(":memory:");
  return createSqliteSchemaBlueprintFromDatabase(db);
}

function createSqliteSchemaBlueprintFromDatabase(db: DatabaseSync): SqliteSchemaBlueprint {
  if (typeof db.exec !== "function" || typeof db.prepare !== "function") {
    return { tables: [] };
  }
  try {
    migrate(db);
    const tableRows = db
      .prepare(
        `
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'table'
        AND sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `,
      )
      .all() as Array<{ name: string; sql: string }>;

    // The Postgres runtime schema is auto-derived from this blueprint. FTS5 virtual
    // tables and their auto-generated shadow tables (`<name>_data/_idx/_content/
    // _config/_docsize`) are SQLite-only and non-portable, so they must never reach
    // the Postgres mirror. Drop them here, at the single source the mirror reads.
    const portableTableRows = excludeFtsVirtualTables(tableRows);

    const tables = portableTableRows.map((row) => buildTableBlueprint(db, row.name, row.sql));
    return { tables };
  } finally {
    if (typeof db.close === "function") {
      db.close();
    }
  }
}

/**
 * The five suffixes SQLite appends to an FTS5 virtual table to create its backing
 * "shadow" tables. These are real `CREATE TABLE` rows in `sqlite_master`, so they
 * would otherwise be reflected into the Postgres mirror.
 */
const FTS5_SHADOW_TABLE_SUFFIXES = ["_data", "_idx", "_content", "_config", "_docsize"] as const;

/**
 * Drop FTS5 virtual tables and their auto-generated shadow tables from a set of
 * `sqlite_master` table rows. The virtual table is identified by its
 * `CREATE VIRTUAL TABLE ... USING fts5` DDL; each shadow table is identified by
 * matching a virtual table's name plus one of {@link FTS5_SHADOW_TABLE_SUFFIXES}.
 * Matching shadow tables by their owning virtual table's name (rather than the
 * suffix alone) avoids excluding any ordinary table that merely ends in `_config`.
 */
function excludeFtsVirtualTables(
  tableRows: Array<{ name: string; sql: string }>,
): Array<{ name: string; sql: string }> {
  const virtualTableNames = new Set(
    tableRows.filter((row) => /create\s+virtual\s+table/i.test(row.sql)).map((row) => row.name),
  );
  if (virtualTableNames.size === 0) {
    return tableRows;
  }
  const shadowTableNames = new Set<string>();
  for (const baseName of virtualTableNames) {
    for (const suffix of FTS5_SHADOW_TABLE_SUFFIXES) {
      shadowTableNames.add(`${baseName}${suffix}`);
    }
  }
  return tableRows.filter((row) => !virtualTableNames.has(row.name) && !shadowTableNames.has(row.name));
}

function buildTableBlueprint(db: DatabaseSync, tableName: string, sql: string): SqliteSchemaTableBlueprint {
  const autoIncrementColumns = new Set(
    [...sql.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi)]
      .map((match) => match[1])
      .filter((value): value is string => typeof value === "string"),
  );
  const columns = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(tableName)})`).all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  const indexSqlByName = new Map(
    (
      db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(tableName) as Array<{
        name: string;
        sql: string | null;
      }>
    ).map((row) => [row.name, row.sql]),
  );
  const indexes = (
    db.prepare(`PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>
  )
    .map((index) => {
      const indexColumns = db.prepare(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all() as Array<{
        name: string;
      }>;
      const columns = indexColumns
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
      return {
        name: index.name.startsWith("sqlite_autoindex_")
          ? buildGeneratedIndexName(tableName, columns, index.unique === 1)
          : index.name,
        unique: index.unique === 1,
        origin: index.origin,
        columns,
        where: extractIndexPredicate(indexSqlByName.get(index.name) ?? null),
      } satisfies SqliteSchemaIndexBlueprint;
    })
    .filter((index) => index.origin !== "pk");

  const seedRows =
    tableName === "workspaces" || tableName === "realtime_event_sequence_state"
      ? (db.prepare(`SELECT * FROM ${tableName}`).all() as Record<string, unknown>[])
      : [];

  return {
    name: tableName,
    sql,
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notnull === 1,
      defaultValue: column.dflt_value,
      primaryKeyPosition: column.pk,
      autoIncrement: autoIncrementColumns.has(column.name),
    })),
    foreignKeys: foreignKeys.map((foreignKey) => ({
      id: foreignKey.id,
      seq: foreignKey.seq,
      from: foreignKey.from,
      to: foreignKey.to,
      referencedTable: foreignKey.table,
      onUpdate: foreignKey.on_update,
      onDelete: foreignKey.on_delete,
    })),
    indexes,
    seedRows,
  };
}

function buildGeneratedIndexName(tableName: string, columns: string[], unique: boolean): string {
  const suffix = unique ? "unique" : "index";
  const columnPart = columns.length > 0 ? columns.join("_") : "constraint";
  return `idx_${tableName}_${columnPart}_${suffix}`;
}

/**
 * Extract the partial-index predicate from an index's `CREATE INDEX ... WHERE <expr>` DDL.
 *
 * Returns the predicate expression (without the leading `WHERE` keyword) or `null` when
 * the index is full (no `WHERE` clause) or has no stored SQL (auto-generated UNIQUE indexes
 * report `sql = NULL` in `sqlite_master`). The predicate is the tail of the statement, so a
 * greedy match from the introducing `WHERE` captures the full expression even when it
 * contains string literals.
 */
function extractIndexPredicate(indexSql: string | null): string | null {
  if (indexSql === null) {
    return null;
  }
  const match = /\sWHERE\s+([\s\S]+)$/i.exec(indexSql.trim());
  if (!match || typeof match[1] !== "string") {
    return null;
  }
  const predicate = match[1].trim();
  return predicate.length > 0 ? predicate : null;
}

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

    CREATE TABLE IF NOT EXISTS mutation_idempotency (
      method TEXT NOT NULL,
      route_path TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      actor_scope TEXT NOT NULL DEFAULT '',
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (method, route_path, idempotency_key, actor_scope)
    );

    CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_updated
      ON mutation_idempotency(updated_at DESC);

    CREATE TABLE IF NOT EXISTS external_side_effect_runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      boundary TEXT NOT NULL,
      route_path TEXT NOT NULL,
      catalog_id TEXT,
      connection_id TEXT,
      action_id TEXT,
      actor_scope TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      replay_policy TEXT NOT NULL,
      replay_outcome TEXT,
      replay_attempt TEXT,
      resume_state TEXT NOT NULL,
      request_payload_json TEXT,
      response_payload_json TEXT,
      external_reference_id TEXT,
      envelope_id TEXT,
      error_text TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      external_call_started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_side_effect_runs_idempotency
      ON external_side_effect_runs(route_path, idempotency_key, actor_scope);
    CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_workspace_created
      ON external_side_effect_runs(workspace_id, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_status_updated
      ON external_side_effect_runs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_connection_created
      ON external_side_effect_runs(connection_id, created_at DESC);

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
      resolution_note TEXT,
      shell_explanations_json TEXT
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
      expires_at TEXT,
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
      run_id TEXT,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      policy_reason TEXT NOT NULL,
      args_json TEXT NOT NULL,
      result_json TEXT,
      approval_id TEXT,
      matched_grant_id TEXT,
      permission_profile_id TEXT,
      local_operator_override_id TEXT,
      approval_mode TEXT,
      reason_codes_json TEXT
    );

    CREATE TABLE IF NOT EXISTS policy_blocks (
      audit_event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      tool_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      details_json TEXT NOT NULL,
      matched_grant_id TEXT,
      permission_profile_id TEXT,
      local_operator_override_id TEXT,
      approval_mode TEXT,
      reason_codes_json TEXT
    );

    CREATE TABLE IF NOT EXISTS cost_ledger (
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      task_id TEXT,
      provider_id TEXT,
      model_id TEXT,
      day TEXT NOT NULL,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      token_cached_input INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cost_ledger_day ON cost_ledger(day);
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_session_id ON cost_ledger(session_id);
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_created_at ON cost_ledger(created_at);

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assigned_agent_id TEXT,
      created_by TEXT,
      due_at TEXT,
      metadata_json TEXT,
      deleted_at TEXT,
      deleted_by TEXT,
      delete_reason TEXT,
      distress_signals_json TEXT,
      retry_budget_json TEXT,
      artifact_verification_json TEXT,
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
      metadata_json TEXT,
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
      action TEXT NOT NULL DEFAULT 'task',
      action_config_json TEXT,
      description TEXT,
      schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      end_at TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      workdir TEXT,
      context_from TEXT,
      last_run_output TEXT,
      last_run_id TEXT,
      last_run_status TEXT,
      last_run_evidence_envelope_id TEXT,
      last_failure_at TEXT,
      last_failure_json TEXT,
      failure_count INTEGER,
      backoff_until TEXT,
      citadel_id TEXT,
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
      total_iterations INTEGER NOT NULL DEFAULT 0,
      wave_cost_usd_by_wave_id TEXT,
      stop_reason TEXT,
      workspace_id TEXT,
      durable_run_id TEXT,
      operator_id TEXT,
      auth_actor_id TEXT,
      auth_actor_source TEXT,
      permission_profile_id TEXT,
      local_operator_override_id TEXT,
      execution_state TEXT,
      worktree_path TEXT,
      worktree_status TEXT,
      worktree_base_ref TEXT,
      pending_approval_phase_id TEXT,
      pending_approved_by TEXT,
      pending_cost_increment_usd REAL,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orchestration_runs_plan_id ON orchestration_runs(plan_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orchestration_runs_durable_run_id ON orchestration_runs(durable_run_id);

    CREATE TABLE IF NOT EXISTS orchestration_plans (
      plan_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, workspace_id)
    );

    CREATE INDEX IF NOT EXISTS idx_orchestration_plans_workspace
      ON orchestration_plans(workspace_id, updated_at DESC);

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

    CREATE TABLE IF NOT EXISTS state_validation_quarantine (
      quarantine_id TEXT PRIMARY KEY,
      store TEXT NOT NULL,
      row_id TEXT NOT NULL,
      raw_value TEXT,
      schema_error TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_state_validation_quarantine_store_observed
      ON state_validation_quarantine(store, observed_at DESC);
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
  createChatSessionPrefsTableIfMissing(db);
  addColumnIfMissing(db, "chat_session_prefs", "planning_mode", "TEXT NOT NULL DEFAULT 'off'");
  addColumnIfMissing(db, "chat_turn_traces", "parent_turn_id", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "branch_kind", "TEXT NOT NULL DEFAULT 'append'");
  addColumnIfMissing(db, "chat_turn_traces", "source_turn_id", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "citations_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "loop_guard_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "pending_user_input_json", "TEXT");
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
  createChatSessionPrefsTableIfMissing(db);
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_intensity", "TEXT NOT NULL DEFAULT 'balanced'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_visibility", "TEXT NOT NULL DEFAULT 'summarized'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_provider_preference", "TEXT NOT NULL DEFAULT 'balanced'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_review_depth", "TEXT NOT NULL DEFAULT 'standard'");
  addColumnIfMissing(db, "chat_session_prefs", "orchestration_parallelism", "TEXT NOT NULL DEFAULT 'auto'");
  addColumnIfMissing(db, "chat_session_prefs", "code_auto_apply", "TEXT NOT NULL DEFAULT 'aggressive_auto'");
  addColumnIfMissing(db, "chat_turn_traces", "orchestration_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "visibility", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "parent_run_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "workflow_template", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "route_decision_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "final_summary", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "provider_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "model", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "label", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "summary", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "degraded_handoff_step_ids_json", "TEXT");
}

function createChatImageRoutePreferenceSchema(db: DatabaseSync): void {
  createChatSessionPrefsTableIfMissing(db);
  addColumnIfMissing(db, "chat_session_prefs", "image_provider_id", "TEXT");
  addColumnIfMissing(db, "chat_session_prefs", "image_model", "TEXT");
  addColumnIfMissing(db, "chat_session_prefs", "speed_mode", "TEXT NOT NULL DEFAULT 'standard'");
  addColumnIfMissing(db, "chat_session_prefs", "subagent_policy", "TEXT NOT NULL DEFAULT 'ask_when_useful'");
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
  addColumnIfMissing(db, "chat_turn_traces", "loop_guard_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "pending_user_input_json", "TEXT");
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
  addColumnIfMissingIfTableExists(db, "chat_tool_runs", "reused", "INTEGER");
  addColumnIfMissingIfTableExists(db, "chat_tool_runs", "reused_from_tool_run_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_tool_runs", "reuse_reason", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_runs", "execution_plan_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "failure_guidance", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "label", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "durable_run_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "child_session_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "child_turn_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "citations_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_delegation_steps", "degraded_handoff_step_ids_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_execution_plan_steps", "durable_run_id", "TEXT");

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
      durable_run_id TEXT,
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
      preset_defaults_json TEXT,
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

function createImportedAgentCatalogSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS imported_agent_catalog (
      entry_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      division TEXT NOT NULL,
      state TEXT NOT NULL,
      definition_id TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      frontmatter_json TEXT NOT NULL,
      raw_markdown TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      section_order_json TEXT NOT NULL,
      section_map_json TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      parse_warnings_json TEXT NOT NULL,
      provenance_provider TEXT NOT NULL,
      provenance_repo_url TEXT,
      provenance_ref TEXT,
      provenance_commit TEXT,
      provenance_path TEXT NOT NULL,
      provenance_sha256 TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      activated_at TEXT,
      retired_at TEXT,
      search_text TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace
      ON imported_agent_catalog(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_division
      ON imported_agent_catalog(workspace_id, division, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_state
      ON imported_agent_catalog(workspace_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_imported_agent_catalog_workspace_parse
      ON imported_agent_catalog(workspace_id, parse_status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_agent_catalog_source_path
      ON imported_agent_catalog(workspace_id, provenance_provider, COALESCE(provenance_repo_url, ''), provenance_path);
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
      revoked_by TEXT,
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
      run_id TEXT,
      allowed INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      matched_grant_id TEXT,
      requires_approval INTEGER NOT NULL,
      risk_level TEXT NOT NULL,
      counts_toward_limits INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_tool_time
      ON tool_access_decisions(tool_name, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_access_decisions_agent_time
      ON tool_access_decisions(agent_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS permission_profiles (
      profile_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_ref TEXT,
      approval_mode TEXT NOT NULL,
      legacy_tool_profile TEXT,
      tool_patterns_json TEXT NOT NULL,
      allow_json TEXT NOT NULL,
      deny_json TEXT NOT NULL,
      read_access_mode TEXT,
      default_for_surfaces_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_permission_profiles_scope_status
      ON permission_profiles(scope, scope_ref, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS permission_profile_activations (
      activation_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      operator_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      surface TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_permission_profile_activations_lookup
      ON permission_profile_activations(active, operator_id, workspace_id, session_id, surface, updated_at DESC);

    CREATE TABLE IF NOT EXISTS local_operator_overrides (
      override_id TEXT PRIMARY KEY,
      operator_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_ref TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_local_operator_overrides_active
      ON local_operator_overrides(status, operator_id, scope, scope_ref, expires_at DESC);

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
      embedding_metadata_json TEXT,
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
      payload_json TEXT,
      status TEXT NOT NULL,
      delivery_status TEXT,
      idempotency_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT,
      stale_after_ms INTEGER,
      base_backoff_ms INTEGER,
      max_backoff_ms INTEGER,
      provider_msg_id TEXT,
      error TEXT,
      stale_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_comms_deliveries_connection_time
      ON comms_deliveries(connection_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comms_deliveries_channel_time
      ON comms_deliveries(channel_key, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_deliveries_idempotency
      ON comms_deliveries(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_comms_deliveries_due
      ON comms_deliveries(status, next_attempt_at, created_at);
  `);
}

function migrateCommsDeliveryRuntimeMetadata(db: DatabaseSync): void {
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "payload_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "delivery_status", "TEXT");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "idempotency_key", "TEXT");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "max_attempts", "INTEGER NOT NULL DEFAULT 3");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "next_attempt_at", "TEXT");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "stale_after_ms", "INTEGER");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "base_backoff_ms", "INTEGER");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "max_backoff_ms", "INTEGER");
  addColumnIfMissingIfTableExists(db, "comms_deliveries", "stale_reason", "TEXT");
  if (tableExists(db, "comms_deliveries")) {
    db.exec(`
      UPDATE comms_deliveries
      SET delivery_status = CASE status
        WHEN 'sent' THEN 'sent'
        WHEN 'failed' THEN COALESCE(NULLIF(delivery_status, ''), 'degraded')
        ELSE COALESCE(NULLIF(delivery_status, ''), 'retrying')
      END
      WHERE delivery_status IS NULL OR TRIM(delivery_status) = '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_comms_deliveries_idempotency
        ON comms_deliveries(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_comms_deliveries_due
        ON comms_deliveries(status, next_attempt_at, created_at);
    `);
  }
}

function createExternalSideEffectRunSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_side_effect_runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      boundary TEXT NOT NULL,
      route_path TEXT NOT NULL,
      catalog_id TEXT,
      connection_id TEXT,
      action_id TEXT,
      actor_scope TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      replay_policy TEXT NOT NULL,
      replay_outcome TEXT,
      replay_attempt TEXT,
      resume_state TEXT NOT NULL,
      request_payload_json TEXT,
      response_payload_json TEXT,
      external_reference_id TEXT,
      envelope_id TEXT,
      error_text TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      external_call_started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_side_effect_runs_idempotency
      ON external_side_effect_runs(route_path, idempotency_key, actor_scope);
    CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_workspace_created
      ON external_side_effect_runs(workspace_id, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_status_updated
      ON external_side_effect_runs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_external_side_effect_runs_connection_created
      ON external_side_effect_runs(connection_id, created_at DESC);
  `);
}

function createA2ATaskBindingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_task_bindings (
      a2a_task_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT,
      local_task_id TEXT,
      durable_run_id TEXT,
      state TEXT NOT NULL,
      last_event_sequence INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_task_bindings_idempotency
      ON a2a_task_bindings(peer_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_a2a_task_bindings_context_peer
      ON a2a_task_bindings(peer_id, context_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_a2a_task_bindings_local_task
      ON a2a_task_bindings(local_task_id);
  `);
}

function createA2ATaskPushConfigSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_task_push_configs (
      a2a_task_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events_json TEXT NOT NULL DEFAULT '["task.status"]',
      enabled INTEGER NOT NULL DEFAULT 1,
      auth_token TEXT,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_delivery_status TEXT NOT NULL DEFAULT 'pending',
      last_delivery_error TEXT,
      last_delivered_at TEXT,
      next_retry_at TEXT,
      last_event_sequence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (a2a_task_id, peer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_a2a_task_push_configs_peer_updated
      ON a2a_task_push_configs(peer_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_a2a_task_push_configs_retry
      ON a2a_task_push_configs(last_delivery_status, next_retry_at);
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
      folder_id TEXT,
      folder_name TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
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
    CREATE INDEX IF NOT EXISTS idx_chat_session_meta_folder
      ON chat_session_meta(workspace_id, folder_id, updated_at DESC);

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

    CREATE TABLE IF NOT EXISTS chat_side_chats (
      side_chat_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL UNIQUE,
      child_session_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      created_from_surface TEXT NOT NULL DEFAULT 'chat',
      source_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(parent_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY(child_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_side_chats_workspace_parent
      ON chat_side_chats(workspace_id, parent_session_id);

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
  createChatSessionPrefsTableIfMissing(db);
  db.exec(`
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
      loop_guard_json TEXT,
      pending_user_input_json TEXT,
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
      reused INTEGER,
      reused_from_tool_run_id TEXT,
      reuse_reason TEXT,
      error TEXT,
      failure_guidance TEXT,
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

function createChatSessionPrefsTableIfMissing(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_prefs (
      session_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'chat',
      planning_mode TEXT NOT NULL DEFAULT 'off',
      provider_id TEXT,
      model TEXT,
      image_provider_id TEXT,
      image_model TEXT,
      web_mode TEXT NOT NULL DEFAULT 'auto',
      memory_mode TEXT NOT NULL DEFAULT 'auto',
      thinking_level TEXT NOT NULL DEFAULT 'standard',
      speed_mode TEXT NOT NULL DEFAULT 'standard',
      subagent_policy TEXT NOT NULL DEFAULT 'ask_when_useful',
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
  `);
}

function createPromptPackReadinessSchema(db: DatabaseSync): void {
  getPromptPackSchemaBuilders().createPromptPackReadinessSchema(db);
}

let promptPackSchemaBuilders: SqlitePromptPackSchemaBuilders | undefined;

function getPromptPackSchemaBuilders(): SqlitePromptPackSchemaBuilders {
  promptPackSchemaBuilders ??= createPromptPackSqliteSchemaBuilders({
    addColumnIfMissingIfTableExists,
    tableExists,
  });
  return promptPackSchemaBuilders;
}

function createPromptPackBenchmarkSchema(db: DatabaseSync): void {
  getPromptPackSchemaBuilders().createPromptPackBenchmarkSchema(db);
}

function createPromptPackScoringV2Schema(db: DatabaseSync): void {
  getPromptPackSchemaBuilders().createPromptPackScoringV2Schema(db);
}

function ensurePromptPackBenchmarkDedupAudit(db: DatabaseSync): void {
  getPromptPackSchemaBuilders().ensurePromptPackBenchmarkDedupAudit(db);
}

function ensurePromptPackBenchmarkDedupRepair(db: DatabaseSync): void {
  getPromptPackSchemaBuilders().ensurePromptPackBenchmarkDedupRepair(db);
}

function runPromptPackBenchmarkDedupPass(db: DatabaseSync): void {
  getPromptPackSchemaBuilders().runPromptPackBenchmarkDedupPass(db);
}

function repairPromptPackBenchmarkDedupWinners(db: DatabaseSync): void {
  getPromptPackSchemaBuilders().repairPromptPackBenchmarkDedupWinners(db);
}

function comparePromptPackBenchmarkDedupRowsForTest(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return getPromptPackSchemaBuilders().comparePromptPackBenchmarkDedupRowsForTest(left, right);
}

function getPromptPackBenchmarkDedupCompletenessRankForTest(row: Record<string, unknown>): number {
  return getPromptPackSchemaBuilders().getPromptPackBenchmarkDedupCompletenessRankForTest(row);
}

function getPromptPackBenchmarkDedupTimestampForTest(row: Record<string, unknown>): number {
  return getPromptPackSchemaBuilders().getPromptPackBenchmarkDedupTimestampForTest(row);
}

function getPromptPackBenchmarkDedupOrdinalForTest(row: Record<string, unknown>): number {
  return getPromptPackSchemaBuilders().getPromptPackBenchmarkDedupOrdinalForTest(row);
}

let approvalRuntimeSchemaBuilders: SqliteApprovalRuntimeSchemaBuilders | undefined;

function getApprovalRuntimeSchemaBuilders(): SqliteApprovalRuntimeSchemaBuilders {
  approvalRuntimeSchemaBuilders ??= createApprovalRuntimeSqliteSchemaBuilders({
    addColumnIfMissingIfTableExists,
  });
  return approvalRuntimeSchemaBuilders;
}

function createAuthDeviceAccessSchema(db: DatabaseSync): void {
  getApprovalRuntimeSchemaBuilders().createAuthDeviceAccessSchema(db);
}

function createPhase2ApprovalRuntimeSchema(db: DatabaseSync): void {
  getApprovalRuntimeSchemaBuilders().createPhase2ApprovalRuntimeSchema(db);
}

function createApprovalEffectsSchema(db: DatabaseSync): void {
  getApprovalRuntimeSchemaBuilders().createApprovalEffectsSchema(db);
}

function createApprovalInboxSchema(db: DatabaseSync): void {
  getApprovalRuntimeSchemaBuilders().createApprovalInboxSchema(db);
}

function createApprovalExpiryRuntimeSchema(db: DatabaseSync): void {
  getApprovalRuntimeSchemaBuilders().createApprovalExpiryRuntimeSchema(db);
}

function createRealtimeEventSequenceStateSchema(db: DatabaseSync): void {
  getApprovalRuntimeSchemaBuilders().createRealtimeEventSequenceStateSchema(db);
}

function createRobustAgentExecutionSchema(db: DatabaseSync): void {
  addColumnIfMissing(db, "chat_turn_traces", "completion_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "durable_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "pending_user_input_json", "TEXT");

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

function createCapabilitySystemV1Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_catalog_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      inspectable_json TEXT NOT NULL,
      callable_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_lifecycle (
      skill_id TEXT PRIMARY KEY,
      capability_category TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      trust_label TEXT NOT NULL,
      review_warning TEXT,
      provenance_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_category
      ON skill_lifecycle(capability_category, lifecycle_state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS candidate_skill_versions (
      version_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      bundle_root TEXT NOT NULL,
      originating_run_id TEXT,
      wrapper_manifest_hash TEXT,
      lifecycle_state TEXT NOT NULL,
      manifest_artifact_json TEXT NOT NULL,
      instruction_artifact_json TEXT NOT NULL,
      proof_artifact_json TEXT NOT NULL,
      program_artifact_json TEXT,
      schema_artifact_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_successful_execution_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_candidate_skill_versions_candidate
      ON candidate_skill_versions(candidate_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS capability_proposals (
      proposal_id TEXT PRIMARY KEY,
      proposal_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      candidate_id TEXT,
      activation_target_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_capability_proposals_status_updated
      ON capability_proposals(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS capability_proposal_events (
      event_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(proposal_id) REFERENCES capability_proposals(proposal_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_capability_proposal_events_proposal
      ON capability_proposal_events(proposal_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS code_mode_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      language TEXT NOT NULL,
      origin_surface TEXT,
      requested_output_intent TEXT,
      save_candidate_on_success INTEGER NOT NULL DEFAULT 0,
      capability_snapshot_id TEXT NOT NULL,
      code_mode_input_hash TEXT,
      wrapper_manifest_hash TEXT NOT NULL,
      policy_snapshot_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      approval_id TEXT,
      session_id TEXT,
      turn_id TEXT,
      execution_backend_json TEXT,
      code_artifact_json TEXT NOT NULL,
      wrapper_manifest_artifact_json TEXT NOT NULL,
      policy_snapshot_artifact_json TEXT NOT NULL,
      stdout_artifact_json TEXT,
      stderr_artifact_json TEXT,
      stdout_preview TEXT,
      stderr_preview TEXT,
      stdout_truncated INTEGER NOT NULL DEFAULT 0,
      stderr_truncated INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error_text TEXT,
      error_code TEXT,
      error_details_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_status_created
      ON code_mode_runs(status, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_created
      ON code_mode_runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_approval
      ON code_mode_runs(approval_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_status_created
      ON code_mode_runs(session_id, status, created_at DESC, run_id DESC);
  `);

  addColumnIfMissingIfTableExists(db, "chat_inline_approvals", "kind", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_inline_approvals", "risk_level", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_inline_approvals", "details_json", "TEXT");
  createPermissionProfilesAndOverrideSchema(db);
}

function createPermissionProfilesAndOverrideSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_profiles (
      profile_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_ref TEXT,
      approval_mode TEXT NOT NULL,
      legacy_tool_profile TEXT,
      tool_patterns_json TEXT NOT NULL,
      allow_json TEXT NOT NULL,
      deny_json TEXT NOT NULL,
      read_access_mode TEXT,
      default_for_surfaces_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_permission_profiles_scope_status
      ON permission_profiles(scope, scope_ref, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS permission_profile_activations (
      activation_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      operator_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      surface TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_permission_profile_activations_lookup
      ON permission_profile_activations(active, operator_id, workspace_id, session_id, surface, updated_at DESC);

    CREATE TABLE IF NOT EXISTS local_operator_overrides (
      override_id TEXT PRIMARY KEY,
      operator_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_ref TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_local_operator_overrides_active
      ON local_operator_overrides(status, operator_id, scope, scope_ref, expires_at DESC);
  `);

  addColumnIfMissingIfTableExists(db, "tool_access_decisions", "workspace_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "tool_access_decisions", "run_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "tool_access_decisions", "permission_profile_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "tool_access_decisions", "local_operator_override_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "tool_access_decisions", "counts_toward_limits", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "origin_surface", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "workspace_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "operator_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "permission_profile_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "permission_profile_label", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "local_operator_override_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "execution_backend_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "code_mode_input_hash", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "error_code", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "error_details_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "tool_grants", "revoked_by", "TEXT");
  addColumnIfMissingIfTableExists(db, "local_operator_overrides", "revoked_by", "TEXT");
}

function ensureCodeModeRunSandboxSchemaParity(db: DatabaseSync): void {
  if (!tableExists(db, "code_mode_runs")) {
    createCapabilitySystemV1Schema(db);
  }
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "origin_surface", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "workspace_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "operator_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "permission_profile_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "permission_profile_label", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "local_operator_override_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "sandbox_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "execution_backend_json", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "code_mode_input_hash", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "error_code", "TEXT");
  addColumnIfMissingIfTableExists(db, "code_mode_runs", "error_details_json", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_status_created
      ON code_mode_runs(status, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_created
      ON code_mode_runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_approval
      ON code_mode_runs(approval_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_workspace_status_created
      ON code_mode_runs(workspace_id, status, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_status_created
      ON code_mode_runs(session_id, status, created_at DESC, run_id DESC);
  `);
}

function ensureCodeModeRunStatusListingIndexes(db: DatabaseSync): void {
  if (!tableExists(db, "code_mode_runs")) {
    return;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_status_created
      ON code_mode_runs(status, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_workspace_status_created
      ON code_mode_runs(workspace_id, status, created_at DESC, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_code_mode_runs_session_status_created
      ON code_mode_runs(session_id, status, created_at DESC, run_id DESC);
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
      heartbeat_enabled INTEGER NOT NULL DEFAULT 1,
      heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 3600,
      active_hours_json TEXT,
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
      linked_task_id TEXT,
      linked_durable_run_id TEXT,
      approval_id TEXT,
      trigger_source TEXT,
      origin_surface TEXT,
      next_wake_at TEXT,
      stop_reason TEXT,
      external_reference_roots_json TEXT,
      resume_metadata_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_runs_session_created
      ON proactive_runs(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_runs_status
      ON proactive_runs(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_runs_approval
      ON proactive_runs(approval_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_runs_durable
      ON proactive_runs(linked_durable_run_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS proactive_actions (
      action_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      tool_name TEXT,
      args_json TEXT,
      result_json TEXT,
      linked_task_id TEXT,
      linked_durable_run_id TEXT,
      approval_id TEXT,
      trigger_source TEXT,
      origin_surface TEXT,
      external_reference_roots_json TEXT,
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
  addColumnIfMissing(db, "chat_turn_traces", "pending_user_input_json", "TEXT");
}

function applySchemaMigrationForTest(version: number, db: DatabaseSync): void {
  const migration = SCHEMA_MIGRATIONS.find((candidate) => candidate.version === version);
  if (!migration) {
    throw new Error(`Unknown SQLite schema migration version: ${version}`);
  }
  migration.up(db);
}

function getSchemaMigrationNameForTest(version: number): string {
  const migration = SCHEMA_MIGRATIONS.find((candidate) => candidate.version === version);
  if (!migration) {
    throw new Error(`Unknown SQLite schema migration version: ${version}`);
  }
  // Return only immutable identity data. Migration callbacks remain private so
  // tests cannot mutate or execute the production registry by reference.
  return migration.name;
}

export const __sqliteInternals = {
  migrate,
  addColumnIfMissing,
  createSqliteSchemaBlueprintFromDatabase,
  applySchemaMigrationForTest,
  getSchemaMigrationNameForTest,
  migrateTaskSubagentSessionColumns,
  runPromptPackBenchmarkDedupPass,
  repairPromptPackBenchmarkDedupWinners,
  comparePromptPackBenchmarkDedupRowsForTest,
  getPromptPackBenchmarkDedupCompletenessRankForTest,
  getPromptPackBenchmarkDedupTimestampForTest,
  getPromptPackBenchmarkDedupOrdinalForTest,
  createChatMessagesFtsSchema,
  backfillChatMessagesFts,
  excludeFtsVirtualTables,
};

function createChatSideChatsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_side_chats (
      side_chat_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL UNIQUE,
      child_session_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      created_from_surface TEXT NOT NULL DEFAULT 'chat',
      source_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(parent_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY(child_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_side_chats_workspace_parent
      ON chat_side_chats(workspace_id, parent_session_id);
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
  addColumnIfMissing(db, "chat_turn_traces", "loop_guard_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "failure_json", "TEXT");
  addColumnIfMissing(db, "chat_turn_traces", "pending_user_input_json", "TEXT");
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

function createToolAccessDecisionHotPathIndexes(db: DatabaseSync): void {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("tool_access_decisions") as { name: string } | undefined;
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
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("chat_session_meta") as { name: string } | undefined;
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

function createRealtimeEventSequenceCursorSchema(db: DatabaseSync): void {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("realtime_events") as { name: string } | undefined;
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

function createChatSessionWorkbenchSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_workbench (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      base_ref TEXT,
      worktree_path TEXT,
      worktree_status TEXT NOT NULL DEFAULT 'uninitialized',
      active_file_path TEXT,
      diff_artifact_id TEXT,
      output_artifact_id TEXT,
      validation_status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES chat_projects(project_id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_session_workbench_project
      ON chat_session_workbench(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_session_workbench_status
      ON chat_session_workbench(worktree_status, validation_status, updated_at DESC);
  `);
}

function migrateChatSessionOrganization(db: DatabaseSync): void {
  addColumnIfMissingIfTableExists(db, "chat_session_meta", "folder_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_session_meta", "folder_name", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_session_meta", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  if (tableExists(db, "chat_session_meta")) {
    db.exec(`
      UPDATE chat_session_meta
      SET tags_json = '[]'
      WHERE tags_json IS NULL OR TRIM(tags_json) = '';

      CREATE INDEX IF NOT EXISTS idx_chat_session_meta_folder
        ON chat_session_meta(workspace_id, folder_id, updated_at DESC);
    `);
  }
}

function createChatGeneratedArtifactsAndThreadKnowledgeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_generated_artifacts (
      artifact_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT,
      project_id TEXT,
      turn_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      language TEXT,
      source_surface TEXT NOT NULL,
      version INTEGER NOT NULL,
      supersedes_artifact_id TEXT,
      provider_id TEXT,
      model TEXT,
      source_block_index INTEGER,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_session_created
      ON chat_generated_artifacts(session_id, created_at DESC, version DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_turn_created
      ON chat_generated_artifacts(turn_id, version DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_workspace_created
      ON chat_generated_artifacts(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_project_created
      ON chat_generated_artifacts(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_generated_artifacts_surface_kind_created
      ON chat_generated_artifacts(source_surface, kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_thread_knowledge_attachments (
      attachment_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      retrieval_mode TEXT NOT NULL,
      ingest_status TEXT NOT NULL,
      chunk_count INTEGER,
      namespace TEXT,
      chat_attachment_id TEXT,
      document_id TEXT,
      error_message TEXT,
      last_ingest_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_session_created
      ON chat_thread_knowledge_attachments(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_session_mode
      ON chat_thread_knowledge_attachments(session_id, retrieval_mode, ingest_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_thread_knowledge_attachments_document
      ON chat_thread_knowledge_attachments(document_id, updated_at DESC);
  `);
}

function migrateOrchestrationPlanWorkspaceScope(db: DatabaseSync): void {
  if (!tableExists(db, "orchestration_plans")) {
    return;
  }
  const columns = db.prepare("PRAGMA table_info(orchestration_plans)").all() as Array<{ name: string; pk: number }>;
  const primaryKeyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (primaryKeyColumns.join("|") === "plan_id|workspace_id") {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orchestration_plans_workspace
        ON orchestration_plans(workspace_id, updated_at DESC);
    `);
    return;
  }

  const hasWorkspaceId = columns.some((column) => column.name === "workspace_id");
  const workspaceSelect = hasWorkspaceId ? "COALESCE(NULLIF(TRIM(workspace_id), ''), 'default')" : "'default'";
  const planWorkspaceSelect = hasWorkspaceId ? "COALESCE(NULLIF(TRIM(plan.workspace_id), ''), 'default')" : "'default'";
  const runColumns = tableExists(db, "orchestration_runs")
    ? (db.prepare("PRAGMA table_info(orchestration_runs)").all() as Array<{ name: string }>)
    : [];
  const canBackfillRunWorkspaces = runColumns.some((column) => column.name === "workspace_id");
  const runWorkspaceBackfillSql = canBackfillRunWorkspaces
    ? `
    INSERT OR IGNORE INTO orchestration_plans_next (
      plan_id,
      workspace_id,
      plan_json,
      created_at,
      updated_at
    )
    SELECT
      plan.plan_id,
      run_workspace.workspace_id,
      plan.plan_json,
      plan.created_at,
      plan.updated_at
    FROM orchestration_plans plan
    INNER JOIN (
      SELECT DISTINCT
        plan_id,
        COALESCE(NULLIF(TRIM(workspace_id), ''), 'default') AS workspace_id
      FROM orchestration_runs
      WHERE plan_id IS NOT NULL
        AND COALESCE(NULLIF(TRIM(workspace_id), ''), 'default') <> 'default'
    ) run_workspace
      ON run_workspace.plan_id = plan.plan_id
    WHERE ${planWorkspaceSelect} = 'default';
    `
    : "";
  db.exec(`
    DROP TABLE IF EXISTS orchestration_plans_next;
    CREATE TABLE orchestration_plans_next (
      plan_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, workspace_id)
    );
    INSERT OR REPLACE INTO orchestration_plans_next (
      plan_id,
      workspace_id,
      plan_json,
      created_at,
      updated_at
    )
    SELECT
      plan_id,
      ${workspaceSelect},
      plan_json,
      created_at,
      updated_at
    FROM orchestration_plans;
    ${runWorkspaceBackfillSql}
    DROP TABLE orchestration_plans;
    ALTER TABLE orchestration_plans_next RENAME TO orchestration_plans;
    CREATE INDEX IF NOT EXISTS idx_orchestration_plans_workspace
      ON orchestration_plans(workspace_id, updated_at DESC);
  `);
}

/**
 * Adds `columnName` to `tableName` when absent. `tableName` and `columnName` are
 * quoted as SQLite identifiers so reserved words / case-folding names are safe.
 *
 * SECURITY CONTRACT: `columnSql` is a column TYPE expression (e.g.
 * `"TEXT NOT NULL DEFAULT 'x'"`), NOT an identifier, so it cannot be quoted or
 * parameterized. It is spliced verbatim into DDL and MUST only ever be a static
 * literal supplied by a caller in this module — never user/runtime input.
 */
function addColumnIfMissing(db: DatabaseSync, tableName: string, columnName: string, columnSql: string): void {
  const rows = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  if (!columns.has(columnName)) {
    db.exec(
      `ALTER TABLE ${quoteSqliteIdentifier(tableName)} ADD COLUMN ${quoteSqliteIdentifier(columnName)} ${columnSql}`,
    );
  }
}

function addColumnIfMissingIfTableExists(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  columnSql: string,
): void {
  if (!tableExists(db, tableName)) {
    return;
  }
  addColumnIfMissing(db, tableName, columnName, columnSql);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return Boolean(row);
}
