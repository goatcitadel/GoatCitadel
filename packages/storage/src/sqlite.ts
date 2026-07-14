/* eslint-disable max-lines */
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { clampInt } from "@goatcitadel/contracts";
import {
  assertSynchronousTransactionResult,
  type DatabaseClient,
  type DatabaseOnlineBackupOptions,
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
import { createChannelCronDurabilitySchema } from "./sqlite/channel-cron-durability-schema.js";

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

  public async backupTo(destinationPath: string, options: DatabaseOnlineBackupOptions = {}): Promise<void> {
    const normalizedDestination = destinationPath.trim();
    if (!normalizedDestination) {
      throw new TypeError("SQLite backup destination path is required");
    }
    const resolvedDestination = path.resolve(normalizedDestination);
    const sourceLocation = this.db.location("main");
    if (sourceLocation && pathsReferToSameFile(path.resolve(sourceLocation), resolvedDestination)) {
      throw new Error("SQLite backup destination must differ from the live database path");
    }
    if (fs.existsSync(resolvedDestination)) {
      throw new Error(`SQLite backup destination already exists: ${resolvedDestination}`);
    }
    const pagesPerBatch = options.pagesPerBatch ?? 100;
    if (!Number.isSafeInteger(pagesPerBatch) || pagesPerBatch <= 0) {
      throw new TypeError("SQLite backup pagesPerBatch must be a positive safe integer");
    }

    ensureParentDir(resolvedDestination);
    try {
      await backup(this.db, resolvedDestination, {
        rate: pagesPerBatch,
        progress: options.onProgress,
      });
      makeSqliteSnapshotSelfContained(resolvedDestination);
    } catch (error) {
      for (const candidate of [resolvedDestination, `${resolvedDestination}-wal`, `${resolvedDestination}-shm`]) {
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // Preserve the original backup failure; best-effort cleanup is retried
          // by the caller's private staging-directory cleanup.
        }
      }
      throw error;
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

function pathsReferToSameFile(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function makeSqliteSnapshotSelfContained(snapshotPath: string): void {
  const snapshot = new DatabaseSync(snapshotPath);
  try {
    const result = snapshot.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: unknown } | undefined;
    if (String(result?.journal_mode ?? "").toLowerCase() !== "delete") {
      throw new Error("SQLite online snapshot could not be finalized as a self-contained database");
    }
  } finally {
    snapshot.close();
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
      {
        version: 144,
        name: "orchestration_worktree_generation_leases",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "worktree_lease_owner_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "worktree_lease_generation", "INTEGER");
          addColumnIfMissingIfTableExists(db, "orchestration_runs", "worktree_lease_expires_at", "TEXT");
          db.exec(`
            CREATE TABLE IF NOT EXISTS orchestration_worktree_leases (
              worktree_path TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              owner_id TEXT NOT NULL,
              generation INTEGER NOT NULL DEFAULT 1,
              lease_expires_at TEXT NOT NULL,
              released_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_orchestration_worktree_leases_run
              ON orchestration_worktree_leases(run_id, generation DESC);
            CREATE INDEX IF NOT EXISTS idx_orchestration_worktree_leases_expiry
              ON orchestration_worktree_leases(released_at, lease_expires_at);
          `);
        },
      },
      {
        version: 145,
        name: "operator_resource_revision_cas_foundation",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "workspaces", "revision", "INTEGER NOT NULL DEFAULT 1");
          addColumnIfMissingIfTableExists(db, "chat_projects", "revision", "INTEGER NOT NULL DEFAULT 1");
        },
      },
      {
        version: 146,
        name: "chat_session_aggregate_revision_cas",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_session_meta", "revision", "INTEGER NOT NULL DEFAULT 1");
        },
      },
      {
        version: 147,
        name: "cron_job_spec_revision_cas",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cron_jobs", "revision", "INTEGER NOT NULL DEFAULT 1");
        },
      },
      {
        version: 148,
        name: "task_resource_revision_cas",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "tasks", "revision", "INTEGER NOT NULL DEFAULT 1");
        },
      },
      {
        version: 149,
        name: "channel_acceptance_and_cron_run_durability",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "cron_jobs", "execution_generation", "INTEGER NOT NULL DEFAULT 0");
          addColumnIfMissingIfTableExists(db, "cron_jobs", "active_run_id", "TEXT");
          createChannelCronDurabilitySchema(db);
          if (tableExists(db, "cron_jobs")) {
            db.exec(`
              CREATE INDEX IF NOT EXISTS idx_cron_jobs_active_run
                ON cron_jobs(active_run_id, execution_generation);
            `);
          }
        },
      },
      {
        version: 150,
        name: "inbound_channel_admission_settlement",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "inbound_channel_events", "bot_loop_decision", "TEXT");
          addColumnIfMissingIfTableExists(db, "inbound_channel_events", "bot_loop_reason", "TEXT");
          addColumnIfMissingIfTableExists(db, "inbound_channel_events", "command_operation_key", "TEXT");
          addColumnIfMissingIfTableExists(db, "inbound_channel_events", "command_result_text", "TEXT");
        },
      },
      {
        version: 151,
        name: "code_mode_verification_ledger",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "trusted_code_write_verification_json", "TEXT");
          addColumnIfMissingIfTableExists(
            db,
            "code_mode_runs",
            "verification_status",
            "TEXT NOT NULL DEFAULT 'not_applicable'",
          );
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "verification_evidence_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "verification_subject_hash", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "verification_reason", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "verification_updated_at", "TEXT");
          if (tableExists(db, "code_mode_runs")) {
            db.exec(`
              UPDATE code_mode_runs
              SET verification_status = CASE
                    WHEN status = 'completed' THEN 'completed_unverified'
                    ELSE 'not_applicable'
                  END,
                  verification_updated_at = COALESCE(finished_at, started_at, created_at)
              WHERE verification_evidence_id IS NULL;
            `);
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS code_mode_verification_evidence (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              evidence_id TEXT NOT NULL UNIQUE,
              run_id TEXT NOT NULL,
              status TEXT NOT NULL,
              subject_hash TEXT NOT NULL,
              command_name TEXT NOT NULL,
              command_label TEXT NOT NULL,
              scope TEXT NOT NULL,
              evidence_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(run_id) REFERENCES code_mode_runs(run_id)
            );
            CREATE INDEX IF NOT EXISTS idx_code_mode_verification_evidence_run
              ON code_mode_verification_evidence(run_id, sequence DESC);
            CREATE TRIGGER IF NOT EXISTS reject_code_mode_verification_evidence_update
              BEFORE UPDATE ON code_mode_verification_evidence
              BEGIN
                SELECT RAISE(ABORT, 'code_mode_verification_evidence is append-only');
              END;
            CREATE TRIGGER IF NOT EXISTS reject_code_mode_verification_evidence_delete
              BEFORE DELETE ON code_mode_verification_evidence
              BEGIN
                SELECT RAISE(ABORT, 'code_mode_verification_evidence is append-only');
              END;
          `);
        },
      },
      {
        version: 152,
        name: "durable_child_watchers",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "durable_run_events", "sequence", "INTEGER");
          if (tableExists(db, "durable_run_events") && tableExists(db, "durable_runs")) {
            db.exec(`
            WITH ranked AS (
              SELECT
                event_id,
                ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created_at ASC, event_id ASC) AS run_sequence
              FROM durable_run_events
            )
            UPDATE durable_run_events
            SET sequence = (
              SELECT ranked.run_sequence
              FROM ranked
              WHERE ranked.event_id = durable_run_events.event_id
            )
            WHERE sequence IS NULL;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_run_events_run_sequence
              ON durable_run_events(run_id, sequence);
            CREATE INDEX IF NOT EXISTS idx_durable_run_events_run_sequence_scan
              ON durable_run_events(run_id, sequence ASC);
            CREATE TRIGGER IF NOT EXISTS reject_durable_run_event_without_sequence
              BEFORE INSERT ON durable_run_events
              WHEN NEW.sequence IS NULL OR NEW.sequence < 1
              BEGIN
                SELECT RAISE(ABORT, 'durable_run_events.sequence must be a positive per-run sequence');
              END;
            CREATE TRIGGER IF NOT EXISTS reject_durable_run_event_sequence_clear
              BEFORE UPDATE OF sequence ON durable_run_events
              WHEN NEW.sequence IS NULL OR NEW.sequence < 1
              BEGIN
                SELECT RAISE(ABORT, 'durable_run_events.sequence must be a positive per-run sequence');
              END;

            CREATE TABLE IF NOT EXISTS durable_run_event_sequences (
              run_id TEXT PRIMARY KEY,
              last_sequence INTEGER NOT NULL,
              FOREIGN KEY(run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
            );

            INSERT INTO durable_run_event_sequences (run_id, last_sequence)
            SELECT run_id, MAX(sequence)
            FROM durable_run_events
            GROUP BY run_id
            ON CONFLICT(run_id) DO UPDATE SET
              last_sequence = MAX(durable_run_event_sequences.last_sequence, excluded.last_sequence);

            CREATE TABLE IF NOT EXISTS durable_child_watcher_scan_state (
              scan_key TEXT PRIMARY KEY,
              last_watcher_id TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL
            );
            INSERT OR IGNORE INTO durable_child_watcher_scan_state (
              scan_key, last_watcher_id, updated_at
            ) VALUES ('global', '', '1970-01-01T00:00:00.000Z');

            CREATE TABLE IF NOT EXISTS durable_child_watchers (
              watcher_id TEXT PRIMARY KEY,
              parent_run_id TEXT NOT NULL,
              child_run_id TEXT NOT NULL,
              state TEXT NOT NULL DEFAULT 'attached'
                CHECK(state IN ('attached', 'detached', 'closed')),
              next_sequence INTEGER NOT NULL DEFAULT 1,
              last_consumed_sequence INTEGER NOT NULL DEFAULT 0,
              projected_notice_count INTEGER NOT NULL DEFAULT 0,
              source TEXT,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              detached_at TEXT,
              reattached_at TEXT,
              closed_at TEXT,
              FOREIGN KEY(parent_run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE,
              FOREIGN KEY(child_run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE,
              UNIQUE(parent_run_id, child_run_id),
              CHECK(parent_run_id <> child_run_id),
              CHECK(next_sequence = last_consumed_sequence + 1)
            );

            CREATE INDEX IF NOT EXISTS idx_durable_child_watchers_parent
              ON durable_child_watchers(parent_run_id, state, created_at, watcher_id);
            CREATE INDEX IF NOT EXISTS idx_durable_child_watchers_child_attached
              ON durable_child_watchers(child_run_id, state, watcher_id);
            `);
          }
        },
      },
      {
        version: 153,
        name: "code_mode_interruption_recovery",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "execution_generation", "INTEGER NOT NULL DEFAULT 0");
          addColumnIfMissingIfTableExists(
            db,
            "code_mode_runs",
            "execution_phase",
            "TEXT NOT NULL DEFAULT 'legacy_unknown'",
          );
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "recovery_disposition", "TEXT NOT NULL DEFAULT 'none'");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "execution_boundary_crossed_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "interrupted_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "interruption_reason", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "final_transcript_event_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "code_mode_runs", "final_transcript_enqueued_at", "TEXT");
          if (tableExists(db, "code_mode_runs")) {
            db.exec(`
              UPDATE code_mode_runs
              SET execution_phase = CASE
                    WHEN status IN ('completed', 'failed', 'rejected', 'expired') THEN 'terminal'
                    WHEN status IN ('approval_pending', 'queued') THEN 'not_started'
                    ELSE 'legacy_unknown'
                  END,
                  recovery_disposition = CASE
                    WHEN status IN ('completed', 'failed', 'rejected', 'expired') THEN 'terminal'
                    WHEN status = 'running' THEN 'manual_reconciliation'
                    ELSE 'none'
                  END,
                  final_transcript_event_id = CASE
                    WHEN session_id IS NOT NULL AND TRIM(session_id) <> ''
                    THEN 'code-mode-final:' || run_id
                    ELSE final_transcript_event_id
                  END;

              CREATE INDEX IF NOT EXISTS idx_code_mode_runs_pending_final_transcript
                ON code_mode_runs(finished_at, run_id)
                WHERE session_id IS NOT NULL
                  AND status IN ('completed', 'failed')
                  AND final_transcript_enqueued_at IS NULL;
            `);
          }
        },
      },
      {
        version: 154,
        name: "chat_turn_capability_profiles",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_turn_traces", "capability_snapshot_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "chat_turn_traces", "capability_profile_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "chat_turn_traces", "capability_profile_hash", "TEXT");
          db.exec(`
            CREATE TABLE IF NOT EXISTS chat_turn_capability_profiles (
              profile_id TEXT PRIMARY KEY,
              turn_id TEXT NOT NULL UNIQUE,
              session_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL,
              durable_run_id TEXT UNIQUE,
              operator_id TEXT,
              auth_actor_id TEXT,
              schema_version TEXT NOT NULL,
              profile_hash TEXT NOT NULL,
              catalog_snapshot_id TEXT NOT NULL,
              inspectable_hash TEXT NOT NULL,
              callable_hash TEXT NOT NULL,
              selection_hash TEXT NOT NULL,
              governance_hash TEXT NOT NULL,
              preflight_fingerprint TEXT NOT NULL,
              profile_json TEXT NOT NULL CHECK(length(profile_json) <= 524288),
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chat_turn_capability_profiles_session_created
              ON chat_turn_capability_profiles(session_id, created_at, profile_id);
            CREATE INDEX IF NOT EXISTS idx_chat_turn_capability_profiles_workspace_created
              ON chat_turn_capability_profiles(workspace_id, created_at, profile_id);

            CREATE TRIGGER IF NOT EXISTS trg_chat_turn_capability_profiles_no_update
            BEFORE UPDATE ON chat_turn_capability_profiles
            BEGIN
              SELECT RAISE(ABORT, 'chat turn capability profiles are immutable');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_chat_turn_capability_profiles_no_delete
            BEFORE DELETE ON chat_turn_capability_profiles
            BEGIN
              SELECT RAISE(ABORT, 'chat turn capability profiles are immutable');
            END;
          `);
        },
      },
      {
        version: 155,
        name: "chat_compaction_hysteresis_state",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_conversation_summaries", "window_key", "TEXT");
          if (tableExists(db, "chat_conversation_summaries")) {
            db.exec(`
              CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversation_summaries_window_key
                ON chat_conversation_summaries(window_key)
                WHERE window_key IS NOT NULL;
            `);
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS chat_compaction_states (
              state_key TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              dimension_hash TEXT NOT NULL,
              provider_id TEXT,
              model TEXT,
              profile_fingerprint TEXT,
              boundary_turn_ids_json TEXT NOT NULL CHECK(length(boundary_turn_ids_json) <= 131072),
              boundary_source_hash TEXT NOT NULL,
              baseline_input_tokens INTEGER NOT NULL,
              last_observed_input_tokens INTEGER NOT NULL,
              observed_turn_count INTEGER NOT NULL,
              armed INTEGER NOT NULL CHECK(armed IN (0, 1)),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chat_compaction_states_session_dimension
              ON chat_compaction_states(session_id, dimension_hash, observed_turn_count DESC, updated_at DESC);
          `);
        },
      },
      {
        version: 156,
        name: "durable_child_watcher_revision_cas",
        up: (db) => {
          addColumnIfMissingIfTableExists(
            db,
            "durable_child_watchers",
            "revision",
            "INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)",
          );
        },
      },
      {
        version: 157,
        name: "chat_tool_effect_truth",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "chat_tool_runs", "effect_potential", "TEXT");
          addColumnIfMissingIfTableExists(db, "chat_tool_runs", "effect_disposition", "TEXT");
          addColumnIfMissingIfTableExists(db, "chat_tool_runs", "effect_outcome_kind", "TEXT");
          addColumnIfMissingIfTableExists(db, "chat_tool_runs", "effect_evidence_json", "TEXT");
          // Existing rows intentionally remain NULL. The repository derives a
          // conservative public projection from trusted legacy status instead
          // of treating a migration-authored marker as runtime evidence.
        },
      },
      {
        version: 158,
        name: "model_usage_events",
        up: (db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS model_usage_events (
              event_id TEXT PRIMARY KEY,
              idempotency_key TEXT NOT NULL UNIQUE,
              source TEXT NOT NULL CHECK(source IN ('llm_service', 'embedding_runtime', 'manual_test')),
              call_kind TEXT NOT NULL,
              requested_provider_id TEXT,
              requested_model_id TEXT,
              requested_reasoning_level TEXT,
              dispatched_reasoning_effort TEXT,
              reasoning_disposition TEXT
                CHECK(reasoning_disposition IS NULL OR reasoning_disposition IN (
                  'honored', 'downgraded', 'unsupported_blocked', 'provider_default'
                )),
              reasoning_reason_code TEXT,
              dispatched_model_id TEXT,
              effective_provider_id TEXT,
              effective_model_id TEXT,
              effective_api_style TEXT,
              route_decision_id TEXT,
              context_snapshot_id TEXT,
              context_intent_hash TEXT,
              context_entry_ref_id TEXT,
              context_resolution_hash TEXT,
              operation_id TEXT NOT NULL,
              parent_operation_id TEXT,
              dispatch_generation TEXT NOT NULL,
              attempt_index INTEGER NOT NULL DEFAULT 0 CHECK(attempt_index >= 0),
              transport_attempt_index INTEGER NOT NULL DEFAULT 0 CHECK(transport_attempt_index >= 0),
              transport_status TEXT NOT NULL DEFAULT 'intent'
                CHECK(transport_status IN ('intent', 'accepted', 'dispatch_unknown')),
              dispatch_owner_id TEXT NOT NULL,
              dispatch_lease_expires_at TEXT NOT NULL,
              dispatch_uncertain_at TEXT,
              dispatch_uncertainty_reason TEXT,
              dispatch_reconciled_at TEXT,
              dispatch_reconciled_by TEXT,
              dispatch_reconciliation TEXT
                CHECK(dispatch_reconciliation IS NULL OR dispatch_reconciliation IN (
                  'confirmed_not_dispatched',
                  'confirmed_dispatched_usage_unknown',
                  'superseded_by_new_generation'
                )),
              dispatch_reconciliation_evidence TEXT,
              fallback_index INTEGER NOT NULL DEFAULT 0 CHECK(fallback_index >= 0),
              repair_index INTEGER NOT NULL DEFAULT 0 CHECK(repair_index >= 0),
              workspace_id TEXT,
              session_id TEXT,
              turn_id TEXT,
              durable_run_id TEXT,
              task_id TEXT,
              agent_id TEXT,
              assembly_run_id TEXT,
              assembly_round_index INTEGER CHECK(assembly_round_index IS NULL OR assembly_round_index >= 0),
              assembly_stage TEXT,
              worker_id TEXT,
              utility_kind TEXT,
              credential_type TEXT NOT NULL DEFAULT 'unknown'
                CHECK(credential_type IN ('api_key', 'oauth', 'service_account', 'adc', 'unknown')),
              usage_pool TEXT NOT NULL DEFAULT 'unknown'
                CHECK(usage_pool IN ('standard', 'subscription', 'local', 'unknown')),
              credential_source TEXT NOT NULL DEFAULT 'unknown'
                CHECK(credential_source IN ('inline', 'env', 'keychain', 'oauth', 'adc', 'none', 'unknown')),
              credential_config_fingerprint TEXT,
              pricing_source TEXT NOT NULL DEFAULT 'not_available'
                CHECK(pricing_source IN ('provider_reported', 'gateway_estimate', 'not_available')),
              cost_source TEXT NOT NULL DEFAULT 'not_available'
                CHECK(cost_source IN ('provider_reported', 'gateway_estimate', 'not_available')),
              pricing_catalog_version TEXT,
              pricing_catalog_hash TEXT,
              input_rate_usd_per_million REAL CHECK(input_rate_usd_per_million IS NULL OR input_rate_usd_per_million >= 0),
              output_rate_usd_per_million REAL CHECK(output_rate_usd_per_million IS NULL OR output_rate_usd_per_million >= 0),
              cached_input_rate_usd_per_million REAL CHECK(cached_input_rate_usd_per_million IS NULL OR cached_input_rate_usd_per_million >= 0),
              input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
              output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
              cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
              cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd >= 0),
              availability TEXT NOT NULL DEFAULT 'unknown'
                CHECK(availability IN ('tracked', 'unknown')),
              terminal_outcome TEXT NOT NULL DEFAULT 'in_flight'
                CHECK(terminal_outcome IN (
                  'in_flight', 'succeeded', 'failed_before_usage', 'failed_after_usage',
                  'interrupted_after_dispatch', 'cancelled'
                )),
              error_code TEXT,
              started_at TEXT NOT NULL,
              finished_at TEXT,
              duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
              compatibility_projected_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_model_usage_events_workspace_started
              ON model_usage_events(workspace_id, started_at DESC, event_id DESC);
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_session_started
              ON model_usage_events(session_id, started_at DESC, event_id DESC);
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_turn_started
              ON model_usage_events(turn_id, started_at ASC, event_id ASC);
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_durable_started
              ON model_usage_events(durable_run_id, started_at ASC, event_id ASC);
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_task_started
              ON model_usage_events(task_id, started_at ASC, event_id ASC);
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_assembly_started
              ON model_usage_events(assembly_run_id, assembly_round_index, started_at ASC, event_id ASC);
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_operation_attempt
              ON model_usage_events(operation_id, dispatch_generation, fallback_index, repair_index, attempt_index, transport_attempt_index);
            CREATE INDEX IF NOT EXISTS idx_model_usage_events_outcome_started
              ON model_usage_events(transport_status, terminal_outcome, availability, started_at DESC);
          `);

          addColumnIfMissingIfTableExists(db, "cost_ledger", "canonical_usage_event_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "cost_ledger", "usage_known_mask", "TEXT");
          if (tableExists(db, "cost_ledger")) {
            db.exec(`
              CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_ledger_canonical_usage_event
                ON cost_ledger(canonical_usage_event_id);
            `);
          }
        },
      },
      {
        version: 159,
        name: "chat_routed_context_snapshots",
        up: (db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS chat_routed_context_snapshots (
              snapshot_id TEXT PRIMARY KEY CHECK(length(TRIM(snapshot_id)) BETWEEN 1 AND 256),
              schema_version TEXT NOT NULL CHECK(schema_version = 'chat.routed-context-snapshot.v1'),
              turn_id TEXT NOT NULL UNIQUE CHECK(length(TRIM(turn_id)) BETWEEN 1 AND 256),
              session_id TEXT NOT NULL CHECK(length(TRIM(session_id)) BETWEEN 1 AND 256),
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 80),
              capability_profile_id TEXT NOT NULL UNIQUE CHECK(length(TRIM(capability_profile_id)) BETWEEN 1 AND 256),
              capability_profile_hash TEXT NOT NULL CHECK(
                length(capability_profile_hash) = 64 AND capability_profile_hash NOT GLOB '*[^0-9a-f]*'
              ),
              source_request_hash TEXT NOT NULL CHECK(
                length(source_request_hash) = 64 AND source_request_hash NOT GLOB '*[^0-9a-f]*'
              ),
              content_hash TEXT NOT NULL CHECK(
                length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
              ),
              snapshot_hash TEXT NOT NULL UNIQUE CHECK(
                length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'
              ),
              effective_provider_id TEXT NOT NULL CHECK(length(TRIM(effective_provider_id)) BETWEEN 1 AND 128),
              effective_model TEXT NOT NULL CHECK(length(TRIM(effective_model)) BETWEEN 1 AND 256),
              context_window_tokens INTEGER NOT NULL CHECK(context_window_tokens > 0),
              prompt_reserved_tokens INTEGER NOT NULL CHECK(prompt_reserved_tokens >= 0),
              output_reserved_tokens INTEGER NOT NULL CHECK(output_reserved_tokens > 0),
              hard_cap_tokens INTEGER NOT NULL CHECK(hard_cap_tokens > 0),
              effective_budget_tokens INTEGER NOT NULL CHECK(
                effective_budget_tokens >= 0 AND effective_budget_tokens <= hard_cap_tokens
              ),
              used_tokens INTEGER NOT NULL CHECK(used_tokens >= 0 AND used_tokens <= effective_budget_tokens),
              source_count INTEGER NOT NULL CHECK(source_count BETWEEN 0 AND 16),
              included_count INTEGER NOT NULL CHECK(included_count >= 0),
              truncated_count INTEGER NOT NULL CHECK(truncated_count >= 0),
              omitted_count INTEGER NOT NULL CHECK(omitted_count >= 0),
              already_attached_count INTEGER NOT NULL CHECK(already_attached_count >= 0),
              estimator_version TEXT NOT NULL CHECK(estimator_version = 'gc-approx-tokens.v1'),
              budget_policy_version TEXT NOT NULL CHECK(budget_policy_version = 'chat.routed-context-budget.v1'),
              snapshot_json TEXT NOT NULL CHECK(length(CAST(snapshot_json AS BLOB)) <= 1048576),
              created_at TEXT NOT NULL,
              CHECK(prompt_reserved_tokens + output_reserved_tokens <= context_window_tokens),
              CHECK(used_tokens + prompt_reserved_tokens + output_reserved_tokens <= context_window_tokens),
              CHECK(included_count + truncated_count + omitted_count + already_attached_count = source_count)
            );

            CREATE INDEX IF NOT EXISTS idx_chat_routed_context_snapshots_session_created
              ON chat_routed_context_snapshots(session_id, created_at, snapshot_id);
            CREATE INDEX IF NOT EXISTS idx_chat_routed_context_snapshots_workspace_created
              ON chat_routed_context_snapshots(workspace_id, created_at, snapshot_id);

            CREATE TRIGGER IF NOT EXISTS trg_chat_routed_context_snapshots_no_update
            BEFORE UPDATE ON chat_routed_context_snapshots
            BEGIN
              SELECT RAISE(ABORT, 'chat routed context snapshots are immutable');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_chat_routed_context_snapshots_no_delete
            BEFORE DELETE ON chat_routed_context_snapshots
            BEGIN
              SELECT RAISE(ABORT, 'chat routed context snapshots are immutable');
            END;
          `);
        },
      },
      {
        version: 160,
        name: "assembly_model_council_recovery",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "assembly_runs", "source_turn_id", "TEXT");
          addColumnIfMissingIfTableExists(
            db,
            "assembly_runs",
            "run_kind",
            "TEXT NOT NULL DEFAULT 'assembly' CHECK(run_kind IN ('assembly', 'chat_model_council'))",
          );
          addColumnIfMissingIfTableExists(
            db,
            "assembly_runs",
            "generation",
            "INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)",
          );
          addColumnIfMissingIfTableExists(db, "assembly_runs", "lease_owner_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "assembly_runs", "lease_expires_at", "TEXT");
          addColumnIfMissingIfTableExists(db, "assembly_runs", "council_resolution_json", "TEXT");
          addColumnIfMissingIfTableExists(db, "assembly_runs", "council_evidence_json", "TEXT");
          if (tableExists(db, "assembly_runs")) {
            db.exec(`
              CREATE UNIQUE INDEX IF NOT EXISTS idx_assembly_runs_council_source_turn
                ON assembly_runs(run_kind, source_turn_id)
                WHERE run_kind = 'chat_model_council' AND source_turn_id IS NOT NULL;
              CREATE INDEX IF NOT EXISTS idx_assembly_runs_council_lease
                ON assembly_runs(run_kind, status, lease_expires_at, updated_at DESC);
            `);
          }
        },
      },
      {
        version: 161,
        name: "skill_governance_journey_foundation",
        up: (db) => {
          addColumnIfMissingIfTableExists(db, "candidate_skill_versions", "workspace_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "candidate_skill_versions", "source_fingerprint", "TEXT");
          addColumnIfMissingIfTableExists(db, "candidate_skill_versions", "upstream_snapshot_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "candidate_skill_versions", "supersedes_version_id", "TEXT");
          addColumnIfMissingIfTableExists(db, "candidate_skill_versions", "created_by_actor_id", "TEXT");

          db.exec(`
            CREATE TABLE IF NOT EXISTS skill_hub_version_claims (
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              canonical_source_key TEXT NOT NULL CHECK(length(TRIM(canonical_source_key)) BETWEEN 1 AND 1024),
              version_kind TEXT NOT NULL CHECK(version_kind IN ('declared', 'resolved')),
              version_value TEXT NOT NULL CHECK(length(TRIM(version_value)) BETWEEN 1 AND 512),
              first_tree_sha256 TEXT NOT NULL CHECK(
                length(first_tree_sha256) = 64 AND first_tree_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              first_snapshot_id TEXT NOT NULL CHECK(length(TRIM(first_snapshot_id)) BETWEEN 1 AND 256),
              created_at TEXT NOT NULL,
              PRIMARY KEY (workspace_id, canonical_source_key, version_kind, version_value)
            );

            CREATE TABLE IF NOT EXISTS skill_hub_audit_floors (
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              canonical_source_key TEXT NOT NULL CHECK(length(TRIM(canonical_source_key)) BETWEEN 1 AND 1024),
              floor_json TEXT NOT NULL CHECK(
                json_valid(floor_json) AND length(CAST(floor_json AS BLOB)) <= 16384
              ),
              floor_sha256 TEXT NOT NULL CHECK(
                length(floor_sha256) = 64 AND floor_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              updated_by_snapshot_id TEXT NOT NULL CHECK(length(TRIM(updated_by_snapshot_id)) BETWEEN 1 AND 256),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (workspace_id, canonical_source_key)
            );

            CREATE TABLE IF NOT EXISTS skill_hub_snapshots (
              snapshot_id TEXT PRIMARY KEY CHECK(length(TRIM(snapshot_id)) BETWEEN 1 AND 256),
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              operation TEXT NOT NULL CHECK(operation IN ('review', 'install', 'update_check', 'update_stage', 'rollback_check')),
              source_provider TEXT NOT NULL CHECK(length(TRIM(source_provider)) BETWEEN 1 AND 128),
              source_type TEXT NOT NULL CHECK(length(TRIM(source_type)) BETWEEN 1 AND 128),
              source_ref TEXT NOT NULL CHECK(length(TRIM(source_ref)) BETWEEN 1 AND 2048),
              canonical_source_key TEXT NOT NULL CHECK(length(TRIM(canonical_source_key)) BETWEEN 1 AND 1024),
              declared_version TEXT CHECK(declared_version IS NULL OR length(TRIM(declared_version)) BETWEEN 1 AND 512),
              resolved_version TEXT CHECK(resolved_version IS NULL OR length(TRIM(resolved_version)) BETWEEN 1 AND 512),
              content_tree_sha256 TEXT NOT NULL CHECK(
                length(content_tree_sha256) = 64 AND content_tree_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB)) <= 16384),
              audit_json TEXT NOT NULL CHECK(length(CAST(audit_json AS BLOB)) <= 16384),
              audit_sha256 TEXT NOT NULL CHECK(
                length(audit_sha256) = 64 AND audit_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              audit_floor_json TEXT NOT NULL CHECK(
                json_valid(audit_floor_json) AND length(CAST(audit_floor_json AS BLOB)) <= 16384
              ),
              audit_floor_sha256 TEXT NOT NULL CHECK(
                length(audit_floor_sha256) = 64 AND audit_floor_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              permission_envelope_json TEXT NOT NULL CHECK(length(CAST(permission_envelope_json AS BLOB)) <= 16384),
              permission_envelope_sha256 TEXT NOT NULL CHECK(
                length(permission_envelope_sha256) = 64 AND permission_envelope_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              permission_diff_json TEXT NOT NULL CHECK(length(CAST(permission_diff_json AS BLOB)) <= 16384),
              compatibility_json TEXT NOT NULL CHECK(length(CAST(compatibility_json AS BLOB)) <= 16384),
              risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'unknown')),
              trust_disposition TEXT NOT NULL CHECK(trust_disposition IN ('review_only', 'candidate', 'blocked', 'revoked')),
              prior_snapshot_id TEXT CHECK(prior_snapshot_id IS NULL OR length(TRIM(prior_snapshot_id)) BETWEEN 1 AND 256),
              blocker_codes_json TEXT NOT NULL CHECK(length(CAST(blocker_codes_json AS BLOB)) <= 8192),
              created_at TEXT NOT NULL,
              CHECK(declared_version IS NOT NULL OR resolved_version IS NOT NULL)
            );

            CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshots_source_created
              ON skill_hub_snapshots(workspace_id, canonical_source_key, created_at DESC, snapshot_id DESC);
            CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshots_declared_version
              ON skill_hub_snapshots(workspace_id, canonical_source_key, declared_version)
              WHERE declared_version IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshots_resolved_version
              ON skill_hub_snapshots(workspace_id, canonical_source_key, resolved_version)
              WHERE resolved_version IS NOT NULL;

            CREATE TABLE IF NOT EXISTS skill_learning_evidence (
              evidence_id TEXT PRIMARY KEY CHECK(length(TRIM(evidence_id)) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              target_key TEXT NOT NULL CHECK(length(TRIM(target_key)) BETWEEN 1 AND 256),
              fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
              source_kind TEXT NOT NULL CHECK(source_kind IN ('chat_turn', 'library_text')),
              source_session_id TEXT,
              source_turn_id TEXT,
              source_message_id TEXT,
              correction_action_id TEXT NOT NULL CHECK(length(TRIM(correction_action_id)) BETWEEN 1 AND 256),
              actor_id TEXT NOT NULL CHECK(length(TRIM(actor_id)) BETWEEN 1 AND 256),
              source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
              correction_sha256 TEXT NOT NULL CHECK(length(correction_sha256) = 64 AND correction_sha256 NOT GLOB '*[^0-9a-f]*'),
              source_artifact_json TEXT CHECK(source_artifact_json IS NULL OR length(CAST(source_artifact_json AS BLOB)) <= 2048),
              correction_artifact_json TEXT CHECK(correction_artifact_json IS NULL OR length(CAST(correction_artifact_json AS BLOB)) <= 2048),
              provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB)) <= 16384),
              poisoning_status TEXT NOT NULL CHECK(poisoning_status IN ('clean', 'blocked', 'quarantined', 'conflicting')),
              blocker_codes_json TEXT NOT NULL CHECK(length(CAST(blocker_codes_json AS BLOB)) <= 8192),
              created_at TEXT NOT NULL,
              CHECK(
                (source_kind = 'chat_turn' AND source_session_id IS NOT NULL AND source_turn_id IS NOT NULL AND source_message_id IS NOT NULL)
                OR (source_kind = 'library_text' AND source_session_id IS NULL AND source_turn_id IS NULL AND source_message_id IS NULL)
              )
            );

            CREATE INDEX IF NOT EXISTS idx_skill_learning_evidence_recurrence
              ON skill_learning_evidence(workspace_id, target_key, fingerprint, poisoning_status, source_session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_skill_learning_evidence_target_created
              ON skill_learning_evidence(workspace_id, target_key, created_at DESC, evidence_id DESC);

            CREATE TABLE IF NOT EXISTS governance_journey_events (
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.journey-event.v1'),
              event_id TEXT PRIMARY KEY CHECK(length(TRIM(event_id)) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
              scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace', 'global')),
              workspace_id TEXT,
              event_type TEXT NOT NULL CHECK(length(TRIM(event_type)) BETWEEN 1 AND 128),
              subject_kind TEXT NOT NULL CHECK(length(TRIM(subject_kind)) BETWEEN 1 AND 128),
              subject_id TEXT NOT NULL CHECK(length(TRIM(subject_id)) BETWEEN 1 AND 256),
              action TEXT NOT NULL CHECK(length(TRIM(action)) BETWEEN 1 AND 128),
              actor_id TEXT NOT NULL CHECK(length(TRIM(actor_id)) BETWEEN 1 AND 256),
              actor_type TEXT NOT NULL CHECK(actor_type IN ('operator', 'system', 'approval_effect')),
              session_id TEXT,
              turn_id TEXT,
              approval_id TEXT,
              fingerprint TEXT CHECK(fingerprint IS NULL OR (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*')),
              source_kind TEXT,
              source_id TEXT,
              trust_disposition TEXT,
              poisoning_status TEXT CHECK(poisoning_status IS NULL OR poisoning_status IN ('clean', 'blocked', 'quarantined', 'conflicting')),
              evidence_refs_json TEXT NOT NULL CHECK(length(CAST(evidence_refs_json AS BLOB)) <= 16384),
              provenance_json TEXT NOT NULL CHECK(length(CAST(provenance_json AS BLOB)) <= 16384),
              summary_json TEXT NOT NULL CHECK(length(CAST(summary_json AS BLOB)) <= 16384),
              occurred_at TEXT NOT NULL,
              recorded_at TEXT NOT NULL,
              CHECK(
                (scope_kind = 'workspace' AND workspace_id IS NOT NULL AND length(TRIM(workspace_id)) BETWEEN 1 AND 256)
                OR (scope_kind = 'global' AND workspace_id IS NULL)
              )
            );

            CREATE INDEX IF NOT EXISTS idx_governance_journey_workspace_recorded
              ON governance_journey_events(workspace_id, recorded_at DESC, event_id DESC);
            CREATE INDEX IF NOT EXISTS idx_governance_journey_subject_recorded
              ON governance_journey_events(subject_kind, subject_id, recorded_at DESC, event_id DESC);
            CREATE INDEX IF NOT EXISTS idx_governance_journey_fingerprint_session
              ON governance_journey_events(fingerprint, session_id, recorded_at DESC, event_id DESC);

            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_version_claims_no_update
            BEFORE UPDATE ON skill_hub_version_claims BEGIN SELECT RAISE(ABORT, 'skill Hub version claims are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_version_claims_no_delete
            BEFORE DELETE ON skill_hub_version_claims BEGIN SELECT RAISE(ABORT, 'skill Hub version claims are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_audit_floors_identity_guard
            BEFORE UPDATE ON skill_hub_audit_floors
            WHEN NEW.workspace_id IS NOT OLD.workspace_id
              OR NEW.canonical_source_key IS NOT OLD.canonical_source_key
              OR NEW.created_at IS NOT OLD.created_at
            BEGIN
              SELECT RAISE(ABORT, 'skill Hub audit floor identity is immutable');
            END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_audit_floors_monotonic_guard
            BEFORE UPDATE ON skill_hub_audit_floors
            WHEN json_extract(NEW.floor_json, '$.policyId') IS NOT json_extract(OLD.floor_json, '$.policyId')
              OR CAST(json_extract(NEW.floor_json, '$.policyRevision') AS INTEGER)
                < CAST(json_extract(OLD.floor_json, '$.policyRevision') AS INTEGER)
              OR (
                json_extract(NEW.floor_json, '$.policyVersion') IS NOT json_extract(OLD.floor_json, '$.policyVersion')
                AND CAST(json_extract(NEW.floor_json, '$.policyRevision') AS INTEGER)
                  <= CAST(json_extract(OLD.floor_json, '$.policyRevision') AS INTEGER)
              )
              OR EXISTS (
                SELECT 1
                FROM json_each(OLD.floor_json, '$.effectiveBlockerCodes') AS old_blocker
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM json_each(NEW.floor_json, '$.effectiveBlockerCodes') AS new_blocker
                  WHERE new_blocker.value = old_blocker.value
                )
              )
              OR EXISTS (
                SELECT 1
                FROM json_each(OLD.floor_json, '$.scanners') AS old_scanner
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM json_each(NEW.floor_json, '$.scanners') AS new_scanner
                  WHERE json_extract(new_scanner.value, '$.scannerId') = json_extract(old_scanner.value, '$.scannerId')
                    AND CAST(json_extract(new_scanner.value, '$.revision') AS INTEGER)
                      >= CAST(json_extract(old_scanner.value, '$.revision') AS INTEGER)
                    AND (
                      json_extract(new_scanner.value, '$.scannerVersion') = json_extract(old_scanner.value, '$.scannerVersion')
                      OR CAST(json_extract(new_scanner.value, '$.revision') AS INTEGER)
                        > CAST(json_extract(old_scanner.value, '$.revision') AS INTEGER)
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM json_each(old_scanner.value, '$.coverageIds') AS old_coverage
                      WHERE NOT EXISTS (
                        SELECT 1
                        FROM json_each(new_scanner.value, '$.coverageIds') AS new_coverage
                        WHERE new_coverage.value = old_coverage.value
                      )
                    )
                )
              )
            BEGIN
              SELECT RAISE(ABORT, 'skill Hub audit floors are monotonic');
            END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_audit_floors_no_delete
            BEFORE DELETE ON skill_hub_audit_floors BEGIN SELECT RAISE(ABORT, 'skill Hub audit floors cannot be deleted'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_snapshots_no_update
            BEFORE UPDATE ON skill_hub_snapshots BEGIN SELECT RAISE(ABORT, 'skill Hub snapshots are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_snapshots_no_delete
            BEFORE DELETE ON skill_hub_snapshots BEGIN SELECT RAISE(ABORT, 'skill Hub snapshots are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_learning_evidence_no_update
            BEFORE UPDATE ON skill_learning_evidence BEGIN SELECT RAISE(ABORT, 'skill learning evidence is immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_learning_evidence_no_delete
            BEFORE DELETE ON skill_learning_evidence BEGIN SELECT RAISE(ABORT, 'skill learning evidence is immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_governance_journey_events_no_update
            BEFORE UPDATE ON governance_journey_events BEGIN SELECT RAISE(ABORT, 'governance Journey events are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_governance_journey_events_no_delete
            BEFORE DELETE ON governance_journey_events BEGIN SELECT RAISE(ABORT, 'governance Journey events are immutable'); END;
          `);
          if (tableExists(db, "candidate_skill_versions")) {
            db.exec(`
              CREATE TABLE IF NOT EXISTS candidate_skill_evidence_links (
                version_id TEXT NOT NULL REFERENCES candidate_skill_versions(version_id) ON DELETE RESTRICT,
                evidence_id TEXT NOT NULL REFERENCES skill_learning_evidence(evidence_id) ON DELETE RESTRICT,
                linked_at TEXT NOT NULL,
                PRIMARY KEY (version_id, evidence_id)
              );

              CREATE TRIGGER IF NOT EXISTS trg_candidate_skill_versions_inactive_insert
              BEFORE INSERT ON candidate_skill_versions
              WHEN NEW.lifecycle_state NOT IN ('draft', 'candidate')
              BEGIN
                SELECT RAISE(ABORT, 'candidate skill versions must be inserted inactive');
              END;

              CREATE TRIGGER IF NOT EXISTS trg_candidate_skill_versions_immutable_content
              BEFORE UPDATE ON candidate_skill_versions
              WHEN NEW.version_id IS NOT OLD.version_id
                OR NEW.candidate_id IS NOT OLD.candidate_id
                OR NEW.source_kind IS NOT OLD.source_kind
                OR NEW.title IS NOT OLD.title
                OR NEW.summary IS NOT OLD.summary
                OR NEW.bundle_root IS NOT OLD.bundle_root
                OR NEW.originating_run_id IS NOT OLD.originating_run_id
                OR NEW.wrapper_manifest_hash IS NOT OLD.wrapper_manifest_hash
                OR NEW.manifest_artifact_json IS NOT OLD.manifest_artifact_json
                OR NEW.instruction_artifact_json IS NOT OLD.instruction_artifact_json
                OR NEW.proof_artifact_json IS NOT OLD.proof_artifact_json
                OR NEW.program_artifact_json IS NOT OLD.program_artifact_json
                OR NEW.schema_artifact_json IS NOT OLD.schema_artifact_json
                OR NEW.created_at IS NOT OLD.created_at
                OR NEW.workspace_id IS NOT OLD.workspace_id
                OR NEW.source_fingerprint IS NOT OLD.source_fingerprint
                OR NEW.upstream_snapshot_id IS NOT OLD.upstream_snapshot_id
                OR NEW.supersedes_version_id IS NOT OLD.supersedes_version_id
                OR NEW.created_by_actor_id IS NOT OLD.created_by_actor_id
              BEGIN
                SELECT RAISE(ABORT, 'candidate skill version content and provenance are immutable');
              END;

              CREATE TRIGGER IF NOT EXISTS trg_candidate_skill_versions_no_delete
              BEFORE DELETE ON candidate_skill_versions
              BEGIN
                SELECT RAISE(ABORT, 'candidate skill versions are immutable');
              END;

              CREATE TRIGGER IF NOT EXISTS trg_candidate_skill_evidence_links_no_update
              BEFORE UPDATE ON candidate_skill_evidence_links BEGIN SELECT RAISE(ABORT, 'candidate skill evidence links are immutable'); END;
              CREATE TRIGGER IF NOT EXISTS trg_candidate_skill_evidence_links_no_delete
              BEFORE DELETE ON candidate_skill_evidence_links BEGIN SELECT RAISE(ABORT, 'candidate skill evidence links are immutable'); END;
            `);
          }
        },
      },
      {
        version: 162,
        name: "workspace_path_bridge_snapshots",
        up: (db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS workspace_path_bridge_snapshots (
              snapshot_id TEXT PRIMARY KEY CHECK(length(TRIM(snapshot_id)) BETWEEN 1 AND 256),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.workspace-path-bridge-snapshot.v1'),
              request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              input_flavor TEXT NOT NULL CHECK(input_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
              target_flavor TEXT NOT NULL CHECK(target_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
              git_identity_required INTEGER NOT NULL CHECK(git_identity_required IN (0, 1)),
              input_path_hash TEXT NOT NULL CHECK(length(input_path_hash) = 64 AND input_path_hash NOT GLOB '*[^0-9a-f]*'),
              allowed_roots_hash TEXT NOT NULL CHECK(length(allowed_roots_hash) = 64 AND allowed_roots_hash NOT GLOB '*[^0-9a-f]*'),
              canonical_host_path TEXT CHECK(
                canonical_host_path IS NULL OR length(TRIM(canonical_host_path)) BETWEEN 1 AND 2048
              ),
              canonical_target_path TEXT CHECK(
                canonical_target_path IS NULL OR length(TRIM(canonical_target_path)) BETWEEN 1 AND 2048
              ),
              distro TEXT CHECK(distro IS NULL OR length(TRIM(distro)) BETWEEN 1 AND 64),
              round_trip_json TEXT NOT NULL CHECK(
                json_valid(round_trip_json) AND length(CAST(round_trip_json AS BLOB)) <= 8192
              ),
              git_identity_json TEXT NOT NULL CHECK(
                json_valid(git_identity_json) AND length(CAST(git_identity_json AS BLOB)) <= 16384
              ),
              status TEXT NOT NULL CHECK(status IN ('verified', 'blocked', 'unavailable')),
              reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN (
                'invalid_path', 'outside_jail', 'canonicalization_failed', 'symlink_escape',
                'round_trip_mismatch', 'wsl_unavailable', 'wsl_conversion_failed',
                'git_not_repository', 'git_unavailable', 'git_verification_failed', 'git_identity_mismatch'
              )),
              callable INTEGER NOT NULL CHECK(callable IN (0, 1)),
              snapshot_json TEXT NOT NULL CHECK(
                json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 65536
              ),
              snapshot_sha256 TEXT NOT NULL CHECK(
                length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              created_at TEXT NOT NULL,
              CHECK(
                (status = 'verified' AND reason_code IS NULL AND callable = 1
                  AND canonical_host_path IS NOT NULL AND canonical_target_path IS NOT NULL)
                OR (status <> 'verified' AND reason_code IS NOT NULL AND callable = 0)
              ),
              CHECK(
                ((input_flavor = 'wsl' OR target_flavor = 'wsl') AND distro IS NOT NULL)
                OR (input_flavor <> 'wsl' AND target_flavor <> 'wsl' AND distro IS NULL)
              )
            );

            CREATE INDEX IF NOT EXISTS idx_workspace_path_bridge_workspace_created
              ON workspace_path_bridge_snapshots(workspace_id, created_at DESC, snapshot_id DESC);
            CREATE INDEX IF NOT EXISTS idx_workspace_path_bridge_workspace_request
              ON workspace_path_bridge_snapshots(workspace_id, request_hash);

            CREATE TRIGGER IF NOT EXISTS trg_workspace_path_bridge_snapshots_no_update
            BEFORE UPDATE ON workspace_path_bridge_snapshots
            BEGIN
              SELECT RAISE(ABORT, 'workspace path bridge snapshots are immutable');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_workspace_path_bridge_snapshots_no_delete
            BEFORE DELETE ON workspace_path_bridge_snapshots
            BEGIN
              SELECT RAISE(ABORT, 'workspace path bridge snapshots are immutable');
            END;
          `);
        },
      },
      {
        version: 163,
        name: "context_pressure_recovery_truth",
        up: (db) => {
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "requested_output_token_cap",
            "INTEGER CHECK(requested_output_token_cap IS NULL OR requested_output_token_cap > 0)",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "effective_output_token_cap",
            "INTEGER CHECK(effective_output_token_cap IS NULL OR effective_output_token_cap > 0)",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_disposition",
            "TEXT CHECK(output_cap_disposition IS NULL OR output_cap_disposition IN ('initial', 'preserved_retry', 'reduced_retry'))",
          );
          addColumnIfMissingIfTableExists(db, "model_usage_events", "output_cap_recovery_source_event_id", "TEXT");
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_recovery_reason_code",
            "TEXT CHECK(output_cap_recovery_reason_code IS NULL OR output_cap_recovery_reason_code = 'safe_lower_cap')",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_provider_available_tokens",
            "INTEGER CHECK(output_cap_provider_available_tokens IS NULL OR output_cap_provider_available_tokens > 0)",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_provider_minimum_tokens",
            "INTEGER CHECK(output_cap_provider_minimum_tokens IS NULL OR output_cap_provider_minimum_tokens > 0)",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_request_input_estimate",
            "INTEGER CHECK(output_cap_request_input_estimate IS NULL OR output_cap_request_input_estimate > 0)",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_configured_context_window_tokens",
            "INTEGER CHECK(output_cap_configured_context_window_tokens IS NULL OR output_cap_configured_context_window_tokens > 0)",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_safety_margin_tokens",
            "INTEGER CHECK(output_cap_safety_margin_tokens IS NULL OR output_cap_safety_margin_tokens >= 0)",
          );
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "output_cap_evidence_format",
            "TEXT CHECK(output_cap_evidence_format IS NULL OR output_cap_evidence_format IN ('anthropic_equation', 'bounded_range', 'context_breakdown', 'character_prompt', 'vllm_context'))",
          );
          addColumnIfMissingIfTableExists(db, "model_usage_events", "transport_retry_parent_event_id", "TEXT");
          addColumnIfMissingIfTableExists(
            db,
            "model_usage_events",
            "transport_retry_reason",
            "TEXT CHECK(transport_retry_reason IS NULL OR transport_retry_reason IN ('output_cap_recovery', 'metadata_compatibility'))",
          );
          db.exec(`
            CREATE TABLE IF NOT EXISTS chat_compaction_breakers (
              session_id TEXT NOT NULL,
              dimension_hash TEXT NOT NULL,
              provider_id TEXT,
              model TEXT,
              profile_fingerprint TEXT,
              status TEXT NOT NULL DEFAULT 'closed'
                CHECK(status IN ('closed', 'awaiting_evidence', 'tripped', 'blocked_corrupt')),
              fallback_streak INTEGER NOT NULL DEFAULT 0 CHECK(fallback_streak BETWEEN 0 AND 2),
              ineffective_streak INTEGER NOT NULL DEFAULT 0 CHECK(ineffective_streak BETWEEN 0 AND 2),
              pending_attempt_id TEXT,
              pending_state_key TEXT,
              quarantined_state_key TEXT,
              pending_branch_head_turn_id TEXT,
              pending_observed_turn_count INTEGER CHECK(pending_observed_turn_count IS NULL OR pending_observed_turn_count >= 0),
              pending_disposition TEXT CHECK(pending_disposition IS NULL OR pending_disposition IN ('structured', 'fallback', 'no_progress')),
              pending_started_at TEXT,
              last_attempt_id TEXT,
              last_evidence_turn_id TEXT,
              last_evidence_input_tokens INTEGER CHECK(last_evidence_input_tokens IS NULL OR last_evidence_input_tokens >= 0),
              last_outcome TEXT NOT NULL DEFAULT 'unverified'
                CHECK(last_outcome IN ('healthy', 'ineffective', 'fallback', 'no_progress', 'unverified')),
              revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
              last_repaired_at TEXT,
              last_repair_reason TEXT,
              last_repaired_actor_hash TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(session_id, dimension_hash),
              FOREIGN KEY(pending_state_key) REFERENCES chat_compaction_states(state_key) ON DELETE RESTRICT,
              CHECK (
                (
                  pending_attempt_id IS NULL AND pending_state_key IS NULL
                  AND pending_branch_head_turn_id IS NULL AND pending_observed_turn_count IS NULL
                  AND pending_disposition IS NULL AND pending_started_at IS NULL
                  AND status <> 'awaiting_evidence'
                ) OR (
                  pending_attempt_id IS NOT NULL AND pending_state_key IS NOT NULL
                  AND pending_branch_head_turn_id IS NOT NULL AND pending_observed_turn_count IS NOT NULL
                  AND pending_disposition IS NOT NULL AND pending_started_at IS NOT NULL
                  AND status = 'awaiting_evidence'
                )
              )
            );

            CREATE INDEX IF NOT EXISTS idx_chat_compaction_breakers_pending_state
              ON chat_compaction_breakers(pending_state_key)
              WHERE pending_state_key IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_chat_compaction_breakers_session_status
              ON chat_compaction_breakers(session_id, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS chat_compaction_breaker_actions (
              action_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              dimension_hash TEXT NOT NULL,
              action_kind TEXT NOT NULL CHECK(action_kind IN ('force', 'repair')),
              expected_breaker_revision INTEGER NOT NULL CHECK(expected_breaker_revision >= 0),
              actor_hash TEXT NOT NULL,
              request_evidence_hash TEXT NOT NULL,
              policy_decision_hash TEXT NOT NULL,
              audit_evidence_hash TEXT NOT NULL,
              approval_id TEXT,
              reason TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('pending', 'consumed', 'expired', 'rejected')),
              rejection_reason TEXT,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              consumed_at TEXT,
              resulting_attempt_id TEXT,
              resulting_breaker_revision INTEGER CHECK(resulting_breaker_revision IS NULL OR resulting_breaker_revision >= 0),
              quarantined_state_key TEXT,
              updated_at TEXT NOT NULL,
              FOREIGN KEY(session_id, dimension_hash)
                REFERENCES chat_compaction_breakers(session_id, dimension_hash) ON DELETE CASCADE,
              CHECK (
                (
                  status = 'pending'
                  AND rejection_reason IS NULL AND consumed_at IS NULL
                  AND resulting_attempt_id IS NULL AND resulting_breaker_revision IS NULL
                  AND quarantined_state_key IS NULL
                ) OR (
                  status = 'consumed'
                  AND rejection_reason IS NULL AND consumed_at IS NOT NULL
                  AND resulting_breaker_revision IS NOT NULL
                  AND (
                    (action_kind = 'force' AND resulting_attempt_id IS NOT NULL AND quarantined_state_key IS NULL)
                    OR (action_kind = 'repair' AND resulting_attempt_id IS NULL)
                  )
                ) OR (
                  status = 'expired'
                  AND rejection_reason IS NULL AND consumed_at IS NULL
                  AND resulting_attempt_id IS NULL AND resulting_breaker_revision IS NULL
                  AND quarantined_state_key IS NULL
                ) OR (
                  status = 'rejected'
                  AND rejection_reason IS NOT NULL AND consumed_at IS NULL
                  AND resulting_attempt_id IS NULL AND resulting_breaker_revision IS NULL
                  AND quarantined_state_key IS NULL
                )
              )
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_compaction_breaker_actions_pending
              ON chat_compaction_breaker_actions(session_id, dimension_hash, action_kind)
              WHERE status = 'pending';
            CREATE INDEX IF NOT EXISTS idx_chat_compaction_breaker_actions_session_created
              ON chat_compaction_breaker_actions(session_id, created_at DESC, action_id DESC);
            CREATE INDEX IF NOT EXISTS idx_chat_compaction_breaker_actions_status_expiry
              ON chat_compaction_breaker_actions(status, expires_at);

            DROP TRIGGER IF EXISTS trg_chat_compaction_breaker_actions_immutable;
            CREATE TRIGGER trg_chat_compaction_breaker_actions_immutable
            BEFORE UPDATE ON chat_compaction_breaker_actions
            WHEN OLD.action_id IS NOT NEW.action_id
              OR OLD.session_id IS NOT NEW.session_id
              OR OLD.dimension_hash IS NOT NEW.dimension_hash
              OR OLD.action_kind IS NOT NEW.action_kind
              OR OLD.expected_breaker_revision IS NOT NEW.expected_breaker_revision
              OR OLD.actor_hash IS NOT NEW.actor_hash
              OR OLD.request_evidence_hash IS NOT NEW.request_evidence_hash
              OR OLD.policy_decision_hash IS NOT NEW.policy_decision_hash
              OR OLD.audit_evidence_hash IS NOT NEW.audit_evidence_hash
              OR OLD.approval_id IS NOT NEW.approval_id
              OR OLD.reason IS NOT NEW.reason
              OR OLD.created_at IS NOT NEW.created_at
              OR OLD.expires_at IS NOT NEW.expires_at
            BEGIN
              SELECT RAISE(ABORT, 'chat compaction breaker action identity is immutable');
            END;

            DROP TRIGGER IF EXISTS trg_chat_compaction_breaker_actions_transition;
            CREATE TRIGGER trg_chat_compaction_breaker_actions_transition
            BEFORE UPDATE ON chat_compaction_breaker_actions
            WHEN OLD.status IS NOT 'pending'
              OR (
                NEW.status IS NOT 'consumed'
                AND NEW.status IS NOT 'expired'
                AND NEW.status IS NOT 'rejected'
              )
            BEGIN
              SELECT RAISE(ABORT, 'chat compaction breaker action lifecycle is immutable');
            END;
          `);
          addColumnIfMissingIfTableExists(db, "chat_compaction_breakers", "quarantined_state_key", "TEXT");
          if (tableExists(db, "model_usage_events")) {
            db.exec(`
              CREATE INDEX IF NOT EXISTS idx_model_usage_events_output_cap_source
                ON model_usage_events(output_cap_recovery_source_event_id)
                WHERE output_cap_recovery_source_event_id IS NOT NULL;
              CREATE UNIQUE INDEX IF NOT EXISTS idx_model_usage_events_transport_retry_parent
                ON model_usage_events(transport_retry_parent_event_id)
                WHERE transport_retry_parent_event_id IS NOT NULL;

              CREATE TRIGGER IF NOT EXISTS trg_model_usage_events_cap_lineage_insert
              BEFORE INSERT ON model_usage_events
              WHEN NOT (
                (
                  NEW.requested_output_token_cap IS NULL
                  AND NEW.effective_output_token_cap IS NULL
                  AND NEW.output_cap_disposition IS NULL
                  AND NEW.output_cap_recovery_source_event_id IS NULL
                  AND NEW.output_cap_recovery_reason_code IS NULL
                  AND NEW.output_cap_provider_available_tokens IS NULL
                  AND NEW.output_cap_provider_minimum_tokens IS NULL
                  AND NEW.output_cap_request_input_estimate IS NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NULL
                  AND NEW.output_cap_safety_margin_tokens IS NULL
                  AND NEW.output_cap_evidence_format IS NULL
                  AND (NEW.transport_retry_reason IS NULL OR NEW.transport_retry_reason = 'metadata_compatibility')
                ) OR (
                  NEW.requested_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap = NEW.requested_output_token_cap
                  AND NEW.output_cap_disposition = 'initial'
                  AND NEW.output_cap_recovery_source_event_id IS NULL
                  AND NEW.output_cap_recovery_reason_code IS NULL
                  AND NEW.output_cap_provider_available_tokens IS NULL
                  AND NEW.output_cap_provider_minimum_tokens IS NULL
                  AND NEW.output_cap_request_input_estimate IS NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NULL
                  AND NEW.output_cap_safety_margin_tokens IS NULL
                  AND NEW.output_cap_evidence_format IS NULL
                  AND NEW.transport_retry_parent_event_id IS NULL
                  AND NEW.transport_retry_reason IS NULL
                ) OR (
                  NEW.requested_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap <= NEW.requested_output_token_cap
                  AND NEW.output_cap_disposition = 'preserved_retry'
                  AND NEW.output_cap_recovery_source_event_id IS NULL
                  AND NEW.output_cap_recovery_reason_code IS NULL
                  AND NEW.output_cap_provider_available_tokens IS NULL
                  AND NEW.output_cap_provider_minimum_tokens IS NULL
                  AND NEW.output_cap_request_input_estimate IS NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NULL
                  AND NEW.output_cap_safety_margin_tokens IS NULL
                  AND NEW.output_cap_evidence_format IS NULL
                  AND NEW.transport_retry_parent_event_id IS NOT NULL
                  AND NEW.transport_retry_reason = 'metadata_compatibility'
                ) OR (
                  NEW.requested_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap < NEW.requested_output_token_cap
                  AND NEW.output_cap_disposition = 'reduced_retry'
                  AND NEW.output_cap_recovery_source_event_id IS NOT NULL
                  AND NEW.output_cap_recovery_reason_code = 'safe_lower_cap'
                  AND NEW.output_cap_provider_available_tokens IS NOT NULL
                  AND (NEW.output_cap_provider_minimum_tokens IS NULL OR NEW.effective_output_token_cap >= NEW.output_cap_provider_minimum_tokens)
                  AND NEW.output_cap_request_input_estimate IS NOT NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NOT NULL
                  AND NEW.output_cap_safety_margin_tokens IS NOT NULL
                  AND NEW.effective_output_token_cap <= NEW.output_cap_provider_available_tokens - NEW.output_cap_safety_margin_tokens
                  AND NEW.effective_output_token_cap <= NEW.output_cap_configured_context_window_tokens - NEW.output_cap_request_input_estimate - NEW.output_cap_safety_margin_tokens
                  AND NEW.output_cap_evidence_format IS NOT NULL
                  AND NEW.transport_retry_parent_event_id = NEW.output_cap_recovery_source_event_id
                  AND NEW.transport_retry_reason = 'output_cap_recovery'
                )
              ) OR NOT (
                (NEW.transport_retry_parent_event_id IS NULL AND NEW.transport_retry_reason IS NULL)
                OR (
                  NEW.transport_retry_parent_event_id IS NOT NULL
                  AND NEW.transport_retry_reason IN ('output_cap_recovery', 'metadata_compatibility')
                )
              )
              BEGIN
                SELECT RAISE(ABORT, 'invalid model usage output-cap retry lineage');
              END;

              CREATE TRIGGER IF NOT EXISTS trg_model_usage_events_cap_lineage_update
              BEFORE UPDATE OF
                requested_output_token_cap, effective_output_token_cap, output_cap_disposition,
                output_cap_recovery_source_event_id, output_cap_recovery_reason_code,
                output_cap_provider_available_tokens, output_cap_provider_minimum_tokens,
                output_cap_request_input_estimate, output_cap_configured_context_window_tokens,
                output_cap_safety_margin_tokens, output_cap_evidence_format,
                transport_retry_parent_event_id, transport_retry_reason
              ON model_usage_events
              WHEN NOT (
                (
                  NEW.requested_output_token_cap IS NULL
                  AND NEW.effective_output_token_cap IS NULL
                  AND NEW.output_cap_disposition IS NULL
                  AND NEW.output_cap_recovery_source_event_id IS NULL
                  AND NEW.output_cap_recovery_reason_code IS NULL
                  AND NEW.output_cap_provider_available_tokens IS NULL
                  AND NEW.output_cap_provider_minimum_tokens IS NULL
                  AND NEW.output_cap_request_input_estimate IS NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NULL
                  AND NEW.output_cap_safety_margin_tokens IS NULL
                  AND NEW.output_cap_evidence_format IS NULL
                  AND (NEW.transport_retry_reason IS NULL OR NEW.transport_retry_reason = 'metadata_compatibility')
                ) OR (
                  NEW.requested_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap = NEW.requested_output_token_cap
                  AND NEW.output_cap_disposition = 'initial'
                  AND NEW.output_cap_recovery_source_event_id IS NULL
                  AND NEW.output_cap_recovery_reason_code IS NULL
                  AND NEW.output_cap_provider_available_tokens IS NULL
                  AND NEW.output_cap_provider_minimum_tokens IS NULL
                  AND NEW.output_cap_request_input_estimate IS NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NULL
                  AND NEW.output_cap_safety_margin_tokens IS NULL
                  AND NEW.output_cap_evidence_format IS NULL
                  AND NEW.transport_retry_parent_event_id IS NULL
                  AND NEW.transport_retry_reason IS NULL
                ) OR (
                  NEW.requested_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap <= NEW.requested_output_token_cap
                  AND NEW.output_cap_disposition = 'preserved_retry'
                  AND NEW.output_cap_recovery_source_event_id IS NULL
                  AND NEW.output_cap_recovery_reason_code IS NULL
                  AND NEW.output_cap_provider_available_tokens IS NULL
                  AND NEW.output_cap_provider_minimum_tokens IS NULL
                  AND NEW.output_cap_request_input_estimate IS NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NULL
                  AND NEW.output_cap_safety_margin_tokens IS NULL
                  AND NEW.output_cap_evidence_format IS NULL
                  AND NEW.transport_retry_parent_event_id IS NOT NULL
                  AND NEW.transport_retry_reason = 'metadata_compatibility'
                ) OR (
                  NEW.requested_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap IS NOT NULL
                  AND NEW.effective_output_token_cap < NEW.requested_output_token_cap
                  AND NEW.output_cap_disposition = 'reduced_retry'
                  AND NEW.output_cap_recovery_source_event_id IS NOT NULL
                  AND NEW.output_cap_recovery_reason_code = 'safe_lower_cap'
                  AND NEW.output_cap_provider_available_tokens IS NOT NULL
                  AND (NEW.output_cap_provider_minimum_tokens IS NULL OR NEW.effective_output_token_cap >= NEW.output_cap_provider_minimum_tokens)
                  AND NEW.output_cap_request_input_estimate IS NOT NULL
                  AND NEW.output_cap_configured_context_window_tokens IS NOT NULL
                  AND NEW.output_cap_safety_margin_tokens IS NOT NULL
                  AND NEW.effective_output_token_cap <= NEW.output_cap_provider_available_tokens - NEW.output_cap_safety_margin_tokens
                  AND NEW.effective_output_token_cap <= NEW.output_cap_configured_context_window_tokens - NEW.output_cap_request_input_estimate - NEW.output_cap_safety_margin_tokens
                  AND NEW.output_cap_evidence_format IS NOT NULL
                  AND NEW.transport_retry_parent_event_id = NEW.output_cap_recovery_source_event_id
                  AND NEW.transport_retry_reason = 'output_cap_recovery'
                )
              ) OR NOT (
                (NEW.transport_retry_parent_event_id IS NULL AND NEW.transport_retry_reason IS NULL)
                OR (
                  NEW.transport_retry_parent_event_id IS NOT NULL
                  AND NEW.transport_retry_reason IN ('output_cap_recovery', 'metadata_compatibility')
                )
              )
              BEGIN
                SELECT RAISE(ABORT, 'invalid model usage output-cap retry lineage');
              END;
            `);
          }
        },
      },
      {
        version: 164,
        name: "skill_aggregate_revision_cas",
        up: (db) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS skill_aggregate_revisions (
              aggregate_kind TEXT NOT NULL CHECK(
                aggregate_kind IN ('runtime_skill', 'candidate_skill', 'activation_policy')
              ),
              aggregate_id TEXT NOT NULL CHECK(
                aggregate_id = TRIM(aggregate_id) AND length(aggregate_id) BETWEEN 1 AND 256
              ),
              revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision) = 'integer' AND revision > 0),
              created_at TEXT NOT NULL CHECK(length(TRIM(created_at)) > 0),
              updated_at TEXT NOT NULL CHECK(length(TRIM(updated_at)) > 0),
              PRIMARY KEY (aggregate_kind, aggregate_id)
            );
          `);
          backfillSkillAggregateRevisions(db);
        },
      },
      {
        version: 165,
        name: "skill_hub_lifecycle_foundation",
        up: (db) => {
          if (tableExists(db, "skill_hub_snapshots")) {
            db.exec(`
              CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_hub_snapshots_workspace_id_tree
                ON skill_hub_snapshots(workspace_id, snapshot_id, content_tree_sha256);
            `);
          }
          if (tableExists(db, "runtime_evidence_envelopes")) {
            db.exec(`
              CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_evidence_skill_hub_identity
                ON runtime_evidence_envelopes(envelope_id, workspace_id, approval_id);
            `);
          }
          if (tableExists(db, "governance_journey_events")) {
            db.exec(`
              CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_journey_skill_hub_identity
                ON governance_journey_events(event_id, workspace_id, approval_id);
            `);
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS skill_hub_snapshot_artifacts (
              artifact_id TEXT PRIMARY KEY CHECK(length(TRIM(artifact_id)) BETWEEN 1 AND 256),
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              snapshot_id TEXT NOT NULL CHECK(length(TRIM(snapshot_id)) BETWEEN 1 AND 256),
              content_tree_sha256 TEXT NOT NULL CHECK(
                length(content_tree_sha256) = 64 AND content_tree_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              bundle_rel_path TEXT NOT NULL CHECK(length(TRIM(bundle_rel_path)) BETWEEN 1 AND 1024),
              manifest_version TEXT NOT NULL CHECK(manifest_version = 'goatcitadel.skill-tree.v1'),
              manifest_json TEXT NOT NULL CHECK(
                json_valid(manifest_json)
                AND json_type(manifest_json) = 'object'
                AND length(CAST(manifest_json AS BLOB)) <= 262144
              ),
              manifest_sha256 TEXT NOT NULL CHECK(
                length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              file_count INTEGER NOT NULL CHECK(
                typeof(file_count) = 'integer' AND file_count BETWEEN 0 AND 96
              ),
              total_bytes INTEGER NOT NULL CHECK(
                typeof(total_bytes) = 'integer' AND total_bytes BETWEEN 0 AND 4194304
              ),
              created_at TEXT NOT NULL CHECK(length(TRIM(created_at)) > 0),
              UNIQUE(workspace_id, snapshot_id),
              UNIQUE(workspace_id, snapshot_id, content_tree_sha256),
              FOREIGN KEY(workspace_id, snapshot_id, content_tree_sha256)
                REFERENCES skill_hub_snapshots(workspace_id, snapshot_id, content_tree_sha256) ON DELETE RESTRICT
            );

            CREATE INDEX IF NOT EXISTS idx_skill_hub_snapshot_artifacts_tree
              ON skill_hub_snapshot_artifacts(workspace_id, content_tree_sha256, created_at DESC, artifact_id DESC);

            CREATE TABLE IF NOT EXISTS skill_hub_operation_intents (
              operation_id TEXT PRIMARY KEY CHECK(length(TRIM(operation_id)) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL UNIQUE CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              operation_kind TEXT NOT NULL CHECK(operation_kind IN (
                'install_inactive', 'stage_update_candidate', 'stage_rollback_candidate', 'activate', 'revoke'
              )),
              approval_id TEXT NOT NULL UNIQUE CHECK(length(TRIM(approval_id)) BETWEEN 1 AND 256),
              snapshot_id TEXT NOT NULL CHECK(length(TRIM(snapshot_id)) BETWEEN 1 AND 256),
              content_tree_sha256 TEXT NOT NULL CHECK(
                length(content_tree_sha256) = 64 AND content_tree_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              skill_id TEXT NOT NULL CHECK(length(TRIM(skill_id)) BETWEEN 1 AND 256),
              target_candidate_id TEXT CHECK(
                target_candidate_id IS NULL OR length(TRIM(target_candidate_id)) BETWEEN 1 AND 256
              ),
              target_version_id TEXT CHECK(
                target_version_id IS NULL OR length(TRIM(target_version_id)) BETWEEN 1 AND 256
              ),
              supersedes_version_id TEXT CHECK(
                supersedes_version_id IS NULL OR length(TRIM(supersedes_version_id)) BETWEEN 1 AND 256
              ),
              expected_candidate_revision INTEGER CHECK(
                expected_candidate_revision IS NULL
                OR (typeof(expected_candidate_revision) = 'integer' AND expected_candidate_revision > 0)
              ),
              expected_runtime_revision INTEGER CHECK(
                expected_runtime_revision IS NULL
                OR (typeof(expected_runtime_revision) = 'integer' AND expected_runtime_revision > 0)
              ),
              expected_candidate_absent INTEGER NOT NULL CHECK(expected_candidate_absent IN (0, 1)),
              expected_runtime_absent INTEGER NOT NULL CHECK(expected_runtime_absent IN (0, 1)),
              actor_id TEXT NOT NULL CHECK(length(TRIM(actor_id)) BETWEEN 1 AND 256),
              session_id TEXT CHECK(session_id IS NULL OR length(TRIM(session_id)) BETWEEN 1 AND 256),
              turn_id TEXT CHECK(turn_id IS NULL OR length(TRIM(turn_id)) BETWEEN 1 AND 256),
              request_sha256 TEXT NOT NULL CHECK(
                length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              created_at TEXT NOT NULL CHECK(length(TRIM(created_at)) > 0),
              FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT,
              FOREIGN KEY(workspace_id, snapshot_id, content_tree_sha256)
                REFERENCES skill_hub_snapshot_artifacts(workspace_id, snapshot_id, content_tree_sha256) ON DELETE RESTRICT,
              CHECK(turn_id IS NULL OR session_id IS NOT NULL),
              CHECK(
                (expected_candidate_absent = 1 AND expected_candidate_revision IS NULL)
                OR (expected_candidate_absent = 0 AND expected_candidate_revision IS NOT NULL)
              ),
              CHECK(
                (expected_runtime_absent = 1 AND expected_runtime_revision IS NULL)
                OR (expected_runtime_absent = 0 AND expected_runtime_revision IS NOT NULL)
              ),
              CHECK(target_candidate_id IS NOT NULL AND target_version_id IS NOT NULL),
              CHECK(
                (operation_kind = 'install_inactive'
                  AND expected_candidate_absent = 1
                  AND expected_runtime_absent = 1
                  AND supersedes_version_id IS NULL)
                OR (operation_kind IN ('stage_update_candidate', 'stage_rollback_candidate')
                  AND expected_candidate_absent = 0
                  AND expected_runtime_absent = 0
                  AND supersedes_version_id IS NOT NULL)
                OR (operation_kind = 'activate' AND expected_candidate_absent = 0)
                OR (operation_kind = 'revoke'
                  AND expected_candidate_absent = 0
                  AND expected_runtime_absent = 0)
              )
            );

            CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_intents_workspace_skill_created
              ON skill_hub_operation_intents(workspace_id, skill_id, created_at DESC, operation_id DESC);
            CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_intents_snapshot
              ON skill_hub_operation_intents(workspace_id, snapshot_id, created_at DESC, operation_id DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_hub_operation_intents_terminal_identity
              ON skill_hub_operation_intents(operation_id, workspace_id, approval_id, content_tree_sha256);

            CREATE TABLE IF NOT EXISTS skill_hub_operation_settlements (
              settlement_id TEXT PRIMARY KEY CHECK(length(TRIM(settlement_id)) BETWEEN 1 AND 256),
              operation_id TEXT NOT NULL UNIQUE CHECK(length(TRIM(operation_id)) BETWEEN 1 AND 256),
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              approval_id TEXT NOT NULL CHECK(length(TRIM(approval_id)) BETWEEN 1 AND 256),
              content_tree_sha256 TEXT NOT NULL CHECK(
                length(content_tree_sha256) = 64 AND content_tree_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              disposition TEXT NOT NULL CHECK(disposition IN ('applied', 'blocked', 'manual_reconciliation')),
              observed_tree_sha256 TEXT NOT NULL CHECK(
                length(observed_tree_sha256) = 64 AND observed_tree_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              candidate_version_id TEXT REFERENCES candidate_skill_versions(version_id) ON DELETE RESTRICT,
              runtime_skill_id TEXT CHECK(
                runtime_skill_id IS NULL OR length(TRIM(runtime_skill_id)) BETWEEN 1 AND 256
              ),
              candidate_revision INTEGER CHECK(
                candidate_revision IS NULL OR (typeof(candidate_revision) = 'integer' AND candidate_revision > 0)
              ),
              runtime_revision INTEGER CHECK(
                runtime_revision IS NULL OR (typeof(runtime_revision) = 'integer' AND runtime_revision > 0)
              ),
              evidence_envelope_id TEXT NOT NULL,
              journey_event_id TEXT NOT NULL,
              result_json TEXT NOT NULL CHECK(
                json_valid(result_json)
                AND json_type(result_json) = 'object'
                AND length(CAST(result_json AS BLOB)) <= 16384
              ),
              result_sha256 TEXT NOT NULL CHECK(
                length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              settled_at TEXT NOT NULL CHECK(length(TRIM(settled_at)) > 0),
              FOREIGN KEY(operation_id, workspace_id, approval_id, content_tree_sha256)
                REFERENCES skill_hub_operation_intents(
                  operation_id, workspace_id, approval_id, content_tree_sha256
                ) ON DELETE RESTRICT,
              FOREIGN KEY(evidence_envelope_id, workspace_id, approval_id)
                REFERENCES runtime_evidence_envelopes(envelope_id, workspace_id, approval_id) ON DELETE RESTRICT,
              FOREIGN KEY(journey_event_id, workspace_id, approval_id)
                REFERENCES governance_journey_events(event_id, workspace_id, approval_id) ON DELETE RESTRICT,
              CHECK(disposition <> 'applied' OR observed_tree_sha256 = content_tree_sha256)
            );

            CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_settlements_evidence
              ON skill_hub_operation_settlements(evidence_envelope_id, settled_at DESC, settlement_id DESC);
            CREATE INDEX IF NOT EXISTS idx_skill_hub_operation_settlements_journey
              ON skill_hub_operation_settlements(journey_event_id, settled_at DESC, settlement_id DESC);

            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_operation_intents_approval_binding
            BEFORE INSERT ON skill_hub_operation_intents
            WHEN NOT EXISTS (
              SELECT 1
              FROM approvals AS approval
              WHERE approval.approval_id = NEW.approval_id
                AND approval.status = 'approved'
                AND approval.kind = 'skill_hub.lifecycle'
                AND json_valid(approval.payload_json)
                AND json_type(approval.payload_json) = 'object'
                AND json_extract(approval.payload_json, '$.operationId') IS NEW.operation_id
                AND json_extract(approval.payload_json, '$.requestSha256') IS NEW.request_sha256
                AND json_extract(approval.payload_json, '$.workspaceId') IS NEW.workspace_id
                AND json_extract(approval.payload_json, '$.operationKind') IS NEW.operation_kind
                AND json_extract(approval.payload_json, '$.skillId') IS NEW.skill_id
                AND json_extract(approval.payload_json, '$.snapshotId') IS NEW.snapshot_id
                AND json_extract(approval.payload_json, '$.contentTreeSha256') IS NEW.content_tree_sha256
                AND (SELECT COUNT(*) FROM json_each(approval.payload_json)) = 7
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(approval.payload_json) AS payload_field
                  WHERE payload_field.key NOT IN (
                    'operationId', 'requestSha256', 'workspaceId', 'operationKind',
                    'skillId', 'snapshotId', 'contentTreeSha256'
                  )
                )
                AND approval.linkage_json IS NOT NULL
                AND json_valid(approval.linkage_json)
                AND json_type(approval.linkage_json) = 'object'
                AND json_extract(approval.linkage_json, '$.workspaceId') IS NEW.workspace_id
                AND (NEW.session_id IS NULL OR json_extract(approval.linkage_json, '$.sessionId') IS NEW.session_id)
                AND (NEW.turn_id IS NULL OR json_extract(approval.linkage_json, '$.turnId') IS NEW.turn_id)
                AND (SELECT COUNT(*) FROM json_each(approval.linkage_json)) =
                  1
                  + CASE WHEN NEW.session_id IS NULL THEN 0 ELSE 1 END
                  + CASE WHEN NEW.turn_id IS NULL THEN 0 ELSE 1 END
                AND NOT EXISTS (
                  SELECT 1
                  FROM json_each(approval.linkage_json) AS linkage_field
                  WHERE linkage_field.key NOT IN ('workspaceId', 'sessionId', 'turnId')
                )
            )
            BEGIN
              SELECT RAISE(ABORT, 'skill Hub operation approval does not match the immutable intent');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_operation_settlements_semantic_binding
            BEFORE INSERT ON skill_hub_operation_settlements
            WHEN NOT EXISTS (
              SELECT 1
              FROM skill_hub_operation_intents AS intent
              JOIN skill_hub_snapshot_artifacts AS artifact
                ON artifact.workspace_id = intent.workspace_id
                AND artifact.snapshot_id = intent.snapshot_id
                AND artifact.content_tree_sha256 = intent.content_tree_sha256
              JOIN runtime_evidence_envelopes AS evidence
                ON evidence.envelope_id = NEW.evidence_envelope_id
                AND evidence.workspace_id = intent.workspace_id
                AND evidence.approval_id = intent.approval_id
              JOIN governance_journey_events AS journey
                ON journey.event_id = NEW.journey_event_id
                AND journey.workspace_id = intent.workspace_id
                AND journey.approval_id = intent.approval_id
              WHERE intent.operation_id = NEW.operation_id
                AND intent.workspace_id = NEW.workspace_id
                AND intent.approval_id = NEW.approval_id
                AND intent.content_tree_sha256 = NEW.content_tree_sha256
                AND (NEW.disposition <> 'applied' OR NEW.observed_tree_sha256 = intent.content_tree_sha256)
                AND evidence.event_kind = 'approval_resolution'
                AND evidence.payload_hash = NEW.result_sha256
                AND json_valid(evidence.metadata_json)
                AND json_type(evidence.metadata_json) = 'object'
                AND json_extract(evidence.metadata_json, '$.operationId') IS intent.operation_id
                AND json_extract(evidence.metadata_json, '$.action') IS intent.operation_kind
                AND json_extract(evidence.metadata_json, '$.subjectKind') = 'skill'
                AND json_extract(evidence.metadata_json, '$.subjectId') IS intent.skill_id
                AND json_extract(evidence.metadata_json, '$.sourceKind') = 'upstream_snapshot'
                AND json_extract(evidence.metadata_json, '$.sourceId') IS intent.snapshot_id
                AND json_extract(evidence.metadata_json, '$.contentTreeSha256') IS intent.content_tree_sha256
                AND json_extract(evidence.metadata_json, '$.requestSha256') IS intent.request_sha256
                AND json_extract(evidence.metadata_json, '$.resultSha256') IS NEW.result_sha256
                AND journey.scope_kind = 'workspace'
                AND journey.event_type = 'skill_hub_lifecycle'
                AND journey.subject_kind = 'skill'
                AND journey.subject_id = intent.skill_id
                AND journey.action = intent.operation_kind
                AND journey.actor_type = 'approval_effect'
                AND journey.fingerprint = intent.request_sha256
                AND journey.source_kind = 'upstream_snapshot'
                AND journey.source_id = intent.snapshot_id
                AND json_valid(journey.evidence_refs_json)
                AND json_type(journey.evidence_refs_json) = 'array'
                AND EXISTS (
                  SELECT 1 FROM json_each(journey.evidence_refs_json) AS ref
                  WHERE json_extract(ref.value, '$.owner') = 'approval'
                    AND json_extract(ref.value, '$.refId') = intent.approval_id
                )
                AND EXISTS (
                  SELECT 1 FROM json_each(journey.evidence_refs_json) AS ref
                  WHERE json_extract(ref.value, '$.owner') = 'upstream_snapshot'
                    AND json_extract(ref.value, '$.refId') = intent.snapshot_id
                )
                AND EXISTS (
                  SELECT 1 FROM json_each(journey.evidence_refs_json) AS ref
                  WHERE json_extract(ref.value, '$.owner') = 'artifact'
                    AND json_extract(ref.value, '$.refId') = artifact.artifact_id
                )
                AND json_valid(journey.provenance_json)
                AND json_extract(journey.provenance_json, '$.approvalRequired') = 1
                AND json_extract(journey.provenance_json, '$.sourceRequired') = 1
                AND json_valid(journey.summary_json)
                AND json_extract(journey.summary_json, '$.operationId') IS intent.operation_id
                AND json_extract(journey.summary_json, '$.requestSha256') IS intent.request_sha256
                AND json_extract(journey.summary_json, '$.contentTreeSha256') IS intent.content_tree_sha256
                AND json_extract(journey.summary_json, '$.resultSha256') IS NEW.result_sha256
            )
            BEGIN
              SELECT RAISE(ABORT, 'skill Hub settlement evidence or Journey binding does not match the operation');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_snapshot_artifacts_no_update
            BEFORE UPDATE ON skill_hub_snapshot_artifacts
            BEGIN SELECT RAISE(ABORT, 'skill Hub snapshot artifacts are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_snapshot_artifacts_no_delete
            BEFORE DELETE ON skill_hub_snapshot_artifacts
            BEGIN SELECT RAISE(ABORT, 'skill Hub snapshot artifacts are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_operation_intents_no_update
            BEFORE UPDATE ON skill_hub_operation_intents
            BEGIN SELECT RAISE(ABORT, 'skill Hub operation intents are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_operation_intents_no_delete
            BEFORE DELETE ON skill_hub_operation_intents
            BEGIN SELECT RAISE(ABORT, 'skill Hub operation intents are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_operation_settlements_no_update
            BEFORE UPDATE ON skill_hub_operation_settlements
            BEGIN SELECT RAISE(ABORT, 'skill Hub operation settlements are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_skill_hub_operation_settlements_no_delete
            BEFORE DELETE ON skill_hub_operation_settlements
            BEGIN SELECT RAISE(ABORT, 'skill Hub operation settlements are immutable'); END;
          `);
        },
      },
      {
        version: 166,
        name: "governed_external_sources_foundation",
        up: (db) => {
          const requiredAuthorityTables = [
            "workspaces",
            "workspace_path_bridge_snapshots",
            "chat_session_meta",
            "approvals",
            "knowledge_documents",
            "chat_thread_knowledge_attachments",
          ];
          if (requiredAuthorityTables.some((tableName) => !tableExists(db, tableName))) {
            // Synthetic and repair-oriented sparse databases may legitimately
            // contain only one historic owner slice. Do not invent competing
            // parent schemas or backfill them from this additive feature lane.
            return;
          }
          db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_path_bridge_workspace_snapshot_hash
              ON workspace_path_bridge_snapshots(workspace_id, snapshot_id, snapshot_sha256);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_meta_workspace_session
              ON chat_session_meta(workspace_id, session_id);

            CREATE TABLE IF NOT EXISTS external_source_configs (
              workspace_id TEXT NOT NULL CHECK(length(TRIM(workspace_id)) BETWEEN 1 AND 256),
              source_id TEXT NOT NULL CHECK(length(TRIM(source_id)) BETWEEN 1 AND 256),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              kind TEXT NOT NULL CHECK(kind IN ('codex_sessions', 'codex_memory', 'claude_sessions', 'claude_memory')),
              label TEXT NOT NULL CHECK(length(TRIM(label)) BETWEEN 1 AND 256),
              owner_actor_id TEXT NOT NULL CHECK(length(TRIM(owner_actor_id)) BETWEEN 1 AND 256),
              auth_actor_id TEXT NOT NULL CHECK(length(TRIM(auth_actor_id)) BETWEEN 1 AND 256),
              auth_actor_source TEXT NOT NULL CHECK(auth_actor_source IN ('token', 'basic', 'loopback', 'device_grant', 'none')),
              canonical_root_path TEXT NOT NULL CHECK(
                length(TRIM(canonical_root_path)) > 1 AND length(CAST(canonical_root_path AS BLOB)) <= 2048
              ),
              root_identity_sha256 TEXT NOT NULL CHECK(length(root_identity_sha256) = 64 AND root_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
              path_bridge_snapshot_id TEXT NOT NULL CHECK(length(TRIM(path_bridge_snapshot_id)) BETWEEN 1 AND 256),
              path_bridge_snapshot_sha256 TEXT NOT NULL CHECK(length(path_bridge_snapshot_sha256) = 64 AND path_bridge_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
              allowed_roots_sha256 TEXT NOT NULL CHECK(length(allowed_roots_sha256) = 64 AND allowed_roots_sha256 NOT GLOB '*[^0-9a-f]*'),
              input_flavor TEXT NOT NULL CHECK(input_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
              target_flavor TEXT NOT NULL CHECK(target_flavor IN ('windows_native', 'windows_forward', 'msys', 'wsl')),
              distro TEXT CHECK(distro IS NULL OR length(TRIM(distro)) BETWEEN 1 AND 64),
              require_git_identity INTEGER NOT NULL CHECK(require_git_identity IN (0, 1)),
              git_identity_sha256 TEXT CHECK(git_identity_sha256 IS NULL OR (length(git_identity_sha256) = 64 AND git_identity_sha256 NOT GLOB '*[^0-9a-f]*')),
              root_grant_approval_id TEXT CHECK(root_grant_approval_id IS NULL OR length(TRIM(root_grant_approval_id)) BETWEEN 1 AND 256),
              ownership_attestation_sha256 TEXT NOT NULL CHECK(length(ownership_attestation_sha256) = 64 AND ownership_attestation_sha256 NOT GLOB '*[^0-9a-f]*'),
              adapter_id TEXT NOT NULL CHECK(adapter_id IN ('codex.rollout-jsonl.v1', 'codex.memory-markdown.v1', 'claude.project-jsonl.v1', 'claude.memory-markdown.v1')),
              adapter_version TEXT NOT NULL CHECK(length(TRIM(adapter_version)) BETWEEN 1 AND 128),
              adapter_policy_json TEXT NOT NULL CHECK(json_valid(adapter_policy_json) AND json_type(adapter_policy_json) = 'object' AND length(CAST(adapter_policy_json AS BLOB)) <= 16384),
              revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
              config_sha256 TEXT NOT NULL CHECK(length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
              status TEXT NOT NULL CHECK(status IN ('active', 'disabled', 'revoked')),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              created_at TEXT NOT NULL CHECK(length(TRIM(created_at)) > 0),
              updated_at TEXT NOT NULL CHECK(length(TRIM(updated_at)) > 0),
              PRIMARY KEY(workspace_id, source_id),
              UNIQUE(workspace_id, source_id, revision, config_sha256),
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
              FOREIGN KEY(workspace_id, path_bridge_snapshot_id, path_bridge_snapshot_sha256)
                REFERENCES workspace_path_bridge_snapshots(workspace_id, snapshot_id, snapshot_sha256) ON DELETE RESTRICT,
              CHECK((require_git_identity = 1 AND git_identity_sha256 IS NOT NULL) OR (require_git_identity = 0 AND git_identity_sha256 IS NULL)),
              CHECK(((input_flavor = 'wsl' OR target_flavor = 'wsl') AND distro IS NOT NULL) OR (input_flavor <> 'wsl' AND target_flavor <> 'wsl' AND distro IS NULL))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_external_source_configs_active_identity
              ON external_source_configs(workspace_id, kind, root_identity_sha256) WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS idx_external_source_configs_workspace_status
              ON external_source_configs(workspace_id, status, updated_at DESC, source_id DESC);

            CREATE TABLE IF NOT EXISTS external_source_scans (
              workspace_id TEXT NOT NULL,
              scan_id TEXT NOT NULL CHECK(length(TRIM(scan_id)) BETWEEN 1 AND 256),
              source_id TEXT NOT NULL CHECK(length(TRIM(source_id)) BETWEEN 1 AND 256),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              config_revision INTEGER NOT NULL CHECK(typeof(config_revision) = 'integer' AND config_revision > 0),
              config_sha256 TEXT NOT NULL CHECK(length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
              root_identity_sha256 TEXT NOT NULL CHECK(length(root_identity_sha256) = 64 AND root_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
              path_bridge_snapshot_sha256 TEXT NOT NULL CHECK(length(path_bridge_snapshot_sha256) = 64 AND path_bridge_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
              adapter_id TEXT NOT NULL CHECK(adapter_id IN ('codex.rollout-jsonl.v1', 'codex.memory-markdown.v1', 'claude.project-jsonl.v1', 'claude.memory-markdown.v1')),
              adapter_version TEXT NOT NULL CHECK(length(TRIM(adapter_version)) BETWEEN 1 AND 128),
              manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              high_water_mtime_ns TEXT CHECK(high_water_mtime_ns IS NULL OR (length(high_water_mtime_ns) = 20 AND high_water_mtime_ns NOT GLOB '*[^0-9]*')),
              high_water_item_id TEXT CHECK(high_water_item_id IS NULL OR length(TRIM(high_water_item_id)) BETWEEN 1 AND 256),
              examined_entry_count INTEGER NOT NULL CHECK(typeof(examined_entry_count) = 'integer' AND examined_entry_count BETWEEN 0 AND 10000),
              item_count INTEGER NOT NULL CHECK(typeof(item_count) = 'integer' AND item_count BETWEEN 0 AND 5000),
              supported_item_count INTEGER NOT NULL CHECK(typeof(supported_item_count) = 'integer' AND supported_item_count BETWEEN 0 AND 5000),
              quarantined_item_count INTEGER NOT NULL CHECK(typeof(quarantined_item_count) = 'integer' AND quarantined_item_count BETWEEN 0 AND 5000),
              blocker_codes_json TEXT NOT NULL CHECK(json_valid(blocker_codes_json) AND json_type(blocker_codes_json) = 'array' AND length(CAST(blocker_codes_json AS BLOB)) <= 8192),
              status TEXT NOT NULL CHECK(status IN ('sealed', 'blocked')),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              started_at TEXT NOT NULL,
              completed_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, scan_id),
              UNIQUE(workspace_id, scan_id, source_id),
              FOREIGN KEY(workspace_id, source_id) REFERENCES external_source_configs(workspace_id, source_id) ON DELETE RESTRICT,
              CHECK((item_count = 0 AND high_water_mtime_ns IS NULL AND high_water_item_id IS NULL) OR (item_count > 0 AND high_water_mtime_ns IS NOT NULL AND high_water_item_id IS NOT NULL)),
              CHECK(supported_item_count + quarantined_item_count <= item_count)
            );
            CREATE INDEX IF NOT EXISTS idx_external_source_scans_source_completed
              ON external_source_scans(workspace_id, source_id, completed_at DESC, scan_id DESC);

            CREATE TABLE IF NOT EXISTS external_source_catalog_items (
              workspace_id TEXT NOT NULL,
              scan_id TEXT NOT NULL,
              source_id TEXT NOT NULL,
              item_id TEXT NOT NULL CHECK(length(TRIM(item_id)) BETWEEN 1 AND 256),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              adapter_id TEXT NOT NULL CHECK(adapter_id IN ('codex.rollout-jsonl.v1', 'codex.memory-markdown.v1', 'claude.project-jsonl.v1', 'claude.memory-markdown.v1')),
              adapter_version TEXT NOT NULL CHECK(length(TRIM(adapter_version)) BETWEEN 1 AND 128),
              normalized_relative_path TEXT NOT NULL CHECK(length(TRIM(normalized_relative_path)) BETWEEN 1 AND 2048),
              alias_paths_json TEXT NOT NULL CHECK(json_valid(alias_paths_json) AND json_type(alias_paths_json) = 'array' AND length(CAST(alias_paths_json AS BLOB)) <= 16384),
              foreign_id_sha256 TEXT NOT NULL CHECK(length(foreign_id_sha256) = 64 AND foreign_id_sha256 NOT GLOB '*[^0-9a-f]*'),
              producer_version TEXT CHECK(producer_version IS NULL OR length(TRIM(producer_version)) BETWEEN 1 AND 128),
              observed_mtime_ns TEXT NOT NULL CHECK(length(observed_mtime_ns) = 20 AND observed_mtime_ns NOT GLOB '*[^0-9]*'),
              file_identity_sha256 TEXT NOT NULL CHECK(length(file_identity_sha256) = 64 AND file_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
              stat_fingerprint_sha256 TEXT NOT NULL CHECK(length(stat_fingerprint_sha256) = 64 AND stat_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
              raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
              raw_byte_count INTEGER NOT NULL CHECK(typeof(raw_byte_count) = 'integer' AND raw_byte_count BETWEEN 0 AND 16777216),
              message_count INTEGER NOT NULL CHECK(typeof(message_count) = 'integer' AND message_count BETWEEN 0 AND 10000),
              lineage_node_count INTEGER NOT NULL CHECK(typeof(lineage_node_count) = 'integer' AND lineage_node_count BETWEEN 0 AND 10000),
              lineage_depth INTEGER NOT NULL CHECK(typeof(lineage_depth) = 'integer' AND lineage_depth BETWEEN 0 AND 64),
              lineage_sha256 TEXT NOT NULL CHECK(length(lineage_sha256) = 64 AND lineage_sha256 NOT GLOB '*[^0-9a-f]*'),
              disposition TEXT NOT NULL CHECK(disposition IN ('supported', 'unsupported_variant', 'quarantined', 'conflicting', 'blocked')),
              reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json) = 'array' AND length(CAST(reason_codes_json AS BLOB)) <= 8192),
              catalog_item_sha256 TEXT NOT NULL CHECK(length(catalog_item_sha256) = 64 AND catalog_item_sha256 NOT GLOB '*[^0-9a-f]*'),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              PRIMARY KEY(workspace_id, scan_id, item_id),
              UNIQUE(workspace_id, scan_id, item_id, raw_sha256),
              FOREIGN KEY(workspace_id, scan_id, source_id) REFERENCES external_source_scans(workspace_id, scan_id, source_id) ON DELETE RESTRICT,
              CHECK(disposition <> 'supported' OR reason_codes_json = '[]')
            );
            CREATE INDEX IF NOT EXISTS idx_external_source_catalog_page
              ON external_source_catalog_items(workspace_id, scan_id, observed_mtime_ns DESC, item_id DESC);
            CREATE INDEX IF NOT EXISTS idx_external_source_catalog_foreign_identity
              ON external_source_catalog_items(workspace_id, source_id, foreign_id_sha256, raw_sha256);

            CREATE TABLE IF NOT EXISTS external_source_import_plans (
              workspace_id TEXT NOT NULL,
              plan_id TEXT NOT NULL CHECK(length(TRIM(plan_id)) BETWEEN 1 AND 256),
              source_id TEXT NOT NULL,
              scan_id TEXT NOT NULL,
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              config_revision INTEGER NOT NULL CHECK(typeof(config_revision) = 'integer' AND config_revision > 0),
              config_sha256 TEXT NOT NULL CHECK(length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
              manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              adapter_versions_json TEXT NOT NULL CHECK(json_valid(adapter_versions_json) AND json_type(adapter_versions_json) = 'array' AND length(CAST(adapter_versions_json AS BLOB)) <= 8192),
              selected_item_ids_json TEXT NOT NULL CHECK(json_valid(selected_item_ids_json) AND json_type(selected_item_ids_json) = 'array' AND json_array_length(selected_item_ids_json) BETWEEN 1 AND 100 AND length(CAST(selected_item_ids_json AS BLOB)) <= 32768),
              selected_item_set_sha256 TEXT NOT NULL CHECK(length(selected_item_set_sha256) = 64 AND selected_item_set_sha256 NOT GLOB '*[^0-9a-f]*'),
              raw_set_sha256 TEXT NOT NULL CHECK(length(raw_set_sha256) = 64 AND raw_set_sha256 NOT GLOB '*[^0-9a-f]*'),
              raw_byte_count INTEGER NOT NULL CHECK(typeof(raw_byte_count) = 'integer' AND raw_byte_count BETWEEN 0 AND 26214400),
              normalized_set_sha256 TEXT NOT NULL CHECK(length(normalized_set_sha256) = 64 AND normalized_set_sha256 NOT GLOB '*[^0-9a-f]*'),
              normalized_byte_count INTEGER NOT NULL CHECK(typeof(normalized_byte_count) = 'integer' AND normalized_byte_count BETWEEN 0 AND 26214400),
              message_count INTEGER NOT NULL CHECK(typeof(message_count) = 'integer' AND message_count BETWEEN 0 AND 50000),
              blocker_codes_json TEXT NOT NULL CHECK(json_valid(blocker_codes_json) AND json_type(blocker_codes_json) = 'array' AND length(CAST(blocker_codes_json AS BLOB)) <= 8192),
              staging_lease_id TEXT NOT NULL CHECK(length(TRIM(staging_lease_id)) BETWEEN 1 AND 256),
              staging_expires_at TEXT NOT NULL,
              plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, plan_id),
              UNIQUE(workspace_id, plan_id, plan_sha256),
              FOREIGN KEY(workspace_id, scan_id, source_id) REFERENCES external_source_scans(workspace_id, scan_id, source_id) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_external_source_import_plans_source_created
              ON external_source_import_plans(workspace_id, source_id, created_at DESC, plan_id DESC);

            CREATE TABLE IF NOT EXISTS external_source_import_intents (
              workspace_id TEXT NOT NULL,
              import_id TEXT NOT NULL CHECK(length(TRIM(import_id)) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL CHECK(length(TRIM(idempotency_key)) BETWEEN 1 AND 512),
              source_id TEXT NOT NULL,
              scan_id TEXT NOT NULL,
              plan_id TEXT NOT NULL,
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              config_revision INTEGER NOT NULL CHECK(typeof(config_revision) = 'integer' AND config_revision > 0),
              config_sha256 TEXT NOT NULL CHECK(length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
              manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
              selected_item_set_sha256 TEXT NOT NULL CHECK(length(selected_item_set_sha256) = 64 AND selected_item_set_sha256 NOT GLOB '*[^0-9a-f]*'),
              adapter_versions_json TEXT NOT NULL CHECK(json_valid(adapter_versions_json) AND json_type(adapter_versions_json) = 'array' AND length(CAST(adapter_versions_json AS BLOB)) <= 8192),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              admitted_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, import_id),
              UNIQUE(workspace_id, idempotency_key),
              UNIQUE(workspace_id, import_id, source_id),
              UNIQUE(workspace_id, import_id, scan_id),
              UNIQUE(workspace_id, import_id, source_id, scan_id),
              FOREIGN KEY(workspace_id, plan_id, plan_sha256) REFERENCES external_source_import_plans(workspace_id, plan_id, plan_sha256) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_external_source_import_intents_source_admitted
              ON external_source_import_intents(workspace_id, source_id, admitted_at DESC, import_id DESC);

            CREATE TABLE IF NOT EXISTS external_source_import_items (
              workspace_id TEXT NOT NULL,
              import_id TEXT NOT NULL,
              scan_id TEXT NOT NULL,
              item_id TEXT NOT NULL,
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              ordinal INTEGER NOT NULL CHECK(typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 99),
              adapter_id TEXT NOT NULL CHECK(adapter_id IN ('codex.rollout-jsonl.v1', 'codex.memory-markdown.v1', 'claude.project-jsonl.v1', 'claude.memory-markdown.v1')),
              adapter_version TEXT NOT NULL CHECK(length(TRIM(adapter_version)) BETWEEN 1 AND 128),
              producer_version TEXT CHECK(producer_version IS NULL OR length(TRIM(producer_version)) BETWEEN 1 AND 128),
              raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
              raw_byte_count INTEGER NOT NULL CHECK(typeof(raw_byte_count) = 'integer' AND raw_byte_count BETWEEN 0 AND 16777216),
              normalized_artifact_sha256 TEXT NOT NULL CHECK(length(normalized_artifact_sha256) = 64 AND normalized_artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
              normalized_byte_count INTEGER NOT NULL CHECK(typeof(normalized_byte_count) = 'integer' AND normalized_byte_count BETWEEN 0 AND 8388608),
              artifact_relative_key TEXT NOT NULL CHECK(length(TRIM(artifact_relative_key)) BETWEEN 1 AND 2048 AND artifact_relative_key LIKE 'external-sources/sha256/%'),
              provenance_sha256 TEXT NOT NULL CHECK(length(provenance_sha256) = 64 AND provenance_sha256 NOT GLOB '*[^0-9a-f]*'),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, import_id, item_id),
              UNIQUE(workspace_id, import_id, ordinal),
              UNIQUE(workspace_id, import_id, item_id, normalized_artifact_sha256),
              FOREIGN KEY(workspace_id, import_id) REFERENCES external_source_import_intents(workspace_id, import_id) ON DELETE RESTRICT,
              FOREIGN KEY(workspace_id, scan_id, item_id, raw_sha256) REFERENCES external_source_catalog_items(workspace_id, scan_id, item_id, raw_sha256) ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS idx_external_source_import_items_artifact
              ON external_source_import_items(workspace_id, normalized_artifact_sha256, import_id, ordinal);

            CREATE TABLE IF NOT EXISTS external_source_import_settlements (
              workspace_id TEXT NOT NULL,
              settlement_id TEXT NOT NULL CHECK(length(TRIM(settlement_id)) BETWEEN 1 AND 256),
              import_id TEXT NOT NULL,
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              disposition TEXT NOT NULL CHECK(disposition IN ('applied', 'blocked', 'manual_reconciliation')),
              artifact_set_sha256 TEXT CHECK(artifact_set_sha256 IS NULL OR (length(artifact_set_sha256) = 64 AND artifact_set_sha256 NOT GLOB '*[^0-9a-f]*')),
              artifacts_verified_at TEXT,
              blocker_codes_json TEXT NOT NULL CHECK(json_valid(blocker_codes_json) AND json_type(blocker_codes_json) = 'array' AND length(CAST(blocker_codes_json AS BLOB)) <= 8192),
              result_sha256 TEXT NOT NULL CHECK(length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'),
              journey_event_id TEXT CHECK(journey_event_id IS NULL OR length(TRIM(journey_event_id)) BETWEEN 1 AND 256),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              settled_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, settlement_id),
              UNIQUE(workspace_id, import_id),
              FOREIGN KEY(workspace_id, import_id) REFERENCES external_source_import_intents(workspace_id, import_id) ON DELETE RESTRICT,
              CHECK((disposition = 'applied' AND artifact_set_sha256 IS NOT NULL AND artifacts_verified_at IS NOT NULL AND blocker_codes_json = '[]') OR (disposition <> 'applied' AND artifact_set_sha256 IS NULL AND artifacts_verified_at IS NULL AND blocker_codes_json <> '[]'))
            );

            CREATE TABLE IF NOT EXISTS chat_external_source_attachments (
              workspace_id TEXT NOT NULL,
              attachment_id TEXT NOT NULL CHECK(length(TRIM(attachment_id)) BETWEEN 1 AND 256),
              session_id TEXT NOT NULL CHECK(length(TRIM(session_id)) BETWEEN 1 AND 256),
              source_id TEXT NOT NULL CHECK(length(TRIM(source_id)) BETWEEN 1 AND 256),
              import_id TEXT NOT NULL,
              item_id TEXT NOT NULL,
              normalized_artifact_sha256 TEXT NOT NULL CHECK(length(normalized_artifact_sha256) = 64 AND normalized_artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              mode TEXT NOT NULL CHECK(mode = 'read_only_external'),
              status TEXT NOT NULL CHECK(status IN ('attached', 'detached')),
              revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
              attached_by_actor_id TEXT NOT NULL CHECK(length(TRIM(attached_by_actor_id)) BETWEEN 1 AND 256),
              attached_at TEXT NOT NULL,
              detached_by_actor_id TEXT,
              detached_at TEXT,
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              PRIMARY KEY(workspace_id, attachment_id),
              UNIQUE(workspace_id, session_id, import_id, item_id),
              FOREIGN KEY(workspace_id, session_id) REFERENCES chat_session_meta(workspace_id, session_id) ON DELETE RESTRICT,
              FOREIGN KEY(workspace_id, import_id, source_id) REFERENCES external_source_import_intents(workspace_id, import_id, source_id) ON DELETE RESTRICT,
              FOREIGN KEY(workspace_id, import_id, item_id, normalized_artifact_sha256) REFERENCES external_source_import_items(workspace_id, import_id, item_id, normalized_artifact_sha256) ON DELETE RESTRICT,
              CHECK((status = 'attached' AND detached_by_actor_id IS NULL AND detached_at IS NULL) OR (status = 'detached' AND detached_by_actor_id IS NOT NULL AND length(TRIM(detached_by_actor_id)) BETWEEN 1 AND 256 AND detached_at IS NOT NULL))
            );
            CREATE INDEX IF NOT EXISTS idx_chat_external_source_attachments_session_status
              ON chat_external_source_attachments(workspace_id, session_id, status, attached_at DESC, attachment_id DESC);

            CREATE TABLE IF NOT EXISTS external_source_knowledge_links (
              workspace_id TEXT NOT NULL,
              link_id TEXT NOT NULL CHECK(length(TRIM(link_id)) BETWEEN 1 AND 256),
              source_id TEXT NOT NULL,
              import_id TEXT NOT NULL,
              item_id TEXT NOT NULL,
              normalized_artifact_sha256 TEXT NOT NULL,
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.external-source.v1'),
              approval_id TEXT NOT NULL CHECK(length(TRIM(approval_id)) BETWEEN 1 AND 256),
              knowledge_document_id TEXT NOT NULL CHECK(length(TRIM(knowledge_document_id)) BETWEEN 1 AND 256),
              thread_knowledge_attachment_id TEXT CHECK(thread_knowledge_attachment_id IS NULL OR length(TRIM(thread_knowledge_attachment_id)) BETWEEN 1 AND 256),
              provenance_sha256 TEXT NOT NULL CHECK(length(provenance_sha256) = 64 AND provenance_sha256 NOT GLOB '*[^0-9a-f]*'),
              record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json) = 'object' AND length(CAST(record_json AS BLOB)) <= 65536),
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, link_id),
              UNIQUE(workspace_id, approval_id, import_id, item_id),
              UNIQUE(workspace_id, import_id, item_id, knowledge_document_id),
              FOREIGN KEY(workspace_id, import_id, source_id) REFERENCES external_source_import_intents(workspace_id, import_id, source_id) ON DELETE RESTRICT,
              FOREIGN KEY(workspace_id, import_id, item_id, normalized_artifact_sha256) REFERENCES external_source_import_items(workspace_id, import_id, item_id, normalized_artifact_sha256) ON DELETE RESTRICT,
              FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT,
              FOREIGN KEY(knowledge_document_id) REFERENCES knowledge_documents(doc_id) ON DELETE RESTRICT,
              FOREIGN KEY(thread_knowledge_attachment_id) REFERENCES chat_thread_knowledge_attachments(attachment_id) ON DELETE RESTRICT
            );

            CREATE TRIGGER IF NOT EXISTS trg_external_source_configs_active_cap_insert
            BEFORE INSERT ON external_source_configs WHEN NEW.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM external_source_configs
              WHERE workspace_id = NEW.workspace_id AND source_id = NEW.source_id
            ) AND (
              SELECT COUNT(*) FROM external_source_configs WHERE workspace_id = NEW.workspace_id AND status = 'active'
            ) >= 16 BEGIN SELECT RAISE(ABORT, 'external source active-root limit exceeded'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_configs_active_cap_update
            BEFORE UPDATE ON external_source_configs WHEN OLD.status <> 'active' AND NEW.status = 'active' AND (
              SELECT COUNT(*) FROM external_source_configs WHERE workspace_id = NEW.workspace_id AND status = 'active'
            ) >= 16 BEGIN SELECT RAISE(ABORT, 'external source active-root limit exceeded'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_configs_cas
            BEFORE UPDATE ON external_source_configs WHEN
              NEW.workspace_id IS NOT OLD.workspace_id OR NEW.source_id IS NOT OLD.source_id OR NEW.kind IS NOT OLD.kind OR
              NEW.owner_actor_id IS NOT OLD.owner_actor_id OR NEW.auth_actor_id IS NOT OLD.auth_actor_id OR
              NEW.auth_actor_source IS NOT OLD.auth_actor_source OR NEW.canonical_root_path IS NOT OLD.canonical_root_path OR
              NEW.root_identity_sha256 IS NOT OLD.root_identity_sha256 OR NEW.path_bridge_snapshot_id IS NOT OLD.path_bridge_snapshot_id OR
              NEW.path_bridge_snapshot_sha256 IS NOT OLD.path_bridge_snapshot_sha256 OR NEW.allowed_roots_sha256 IS NOT OLD.allowed_roots_sha256 OR
              NEW.input_flavor IS NOT OLD.input_flavor OR NEW.target_flavor IS NOT OLD.target_flavor OR NEW.distro IS NOT OLD.distro OR
              NEW.require_git_identity IS NOT OLD.require_git_identity OR NEW.git_identity_sha256 IS NOT OLD.git_identity_sha256 OR
              NEW.root_grant_approval_id IS NOT OLD.root_grant_approval_id OR NEW.ownership_attestation_sha256 IS NOT OLD.ownership_attestation_sha256 OR
              NEW.adapter_id IS NOT OLD.adapter_id OR NEW.created_at IS NOT OLD.created_at OR NEW.revision <> OLD.revision + 1 OR OLD.status = 'revoked'
            BEGIN SELECT RAISE(ABORT, 'external source config CAS or immutable identity violated'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_configs_no_delete BEFORE DELETE ON external_source_configs
            BEGIN SELECT RAISE(ABORT, 'external source configs cannot be deleted'); END;

            CREATE TRIGGER IF NOT EXISTS trg_external_source_scans_no_update BEFORE UPDATE ON external_source_scans BEGIN SELECT RAISE(ABORT, 'external source scans are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_scans_no_delete BEFORE DELETE ON external_source_scans BEGIN SELECT RAISE(ABORT, 'external source scans are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_catalog_no_update BEFORE UPDATE ON external_source_catalog_items BEGIN SELECT RAISE(ABORT, 'external source catalog items are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_catalog_no_delete BEFORE DELETE ON external_source_catalog_items BEGIN SELECT RAISE(ABORT, 'external source catalog items are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_plans_no_update BEFORE UPDATE ON external_source_import_plans BEGIN SELECT RAISE(ABORT, 'external source import plans are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_plans_no_delete BEFORE DELETE ON external_source_import_plans BEGIN SELECT RAISE(ABORT, 'external source import plans are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_intents_no_update BEFORE UPDATE ON external_source_import_intents BEGIN SELECT RAISE(ABORT, 'external source import intents are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_intents_no_delete BEFORE DELETE ON external_source_import_intents BEGIN SELECT RAISE(ABORT, 'external source import intents are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_items_no_update BEFORE UPDATE ON external_source_import_items BEGIN SELECT RAISE(ABORT, 'external source import items are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_items_no_delete BEFORE DELETE ON external_source_import_items BEGIN SELECT RAISE(ABORT, 'external source import items are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_settlements_no_update BEFORE UPDATE ON external_source_import_settlements BEGIN SELECT RAISE(ABORT, 'external source import settlements are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_settlements_no_delete BEFORE DELETE ON external_source_import_settlements BEGIN SELECT RAISE(ABORT, 'external source import settlements are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_knowledge_links_no_update BEFORE UPDATE ON external_source_knowledge_links BEGIN SELECT RAISE(ABORT, 'external source knowledge links are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_external_source_knowledge_links_no_delete BEFORE DELETE ON external_source_knowledge_links BEGIN SELECT RAISE(ABORT, 'external source knowledge links are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_chat_external_source_attachments_cas
            BEFORE UPDATE ON chat_external_source_attachments WHEN
              OLD.status <> 'attached' OR NEW.status <> 'detached' OR NEW.revision <> OLD.revision + 1 OR
              NEW.workspace_id IS NOT OLD.workspace_id OR NEW.attachment_id IS NOT OLD.attachment_id OR
              NEW.session_id IS NOT OLD.session_id OR NEW.source_id IS NOT OLD.source_id OR NEW.import_id IS NOT OLD.import_id OR
              NEW.item_id IS NOT OLD.item_id OR NEW.normalized_artifact_sha256 IS NOT OLD.normalized_artifact_sha256 OR
              NEW.mode IS NOT OLD.mode OR NEW.attached_by_actor_id IS NOT OLD.attached_by_actor_id OR NEW.attached_at IS NOT OLD.attached_at
            BEGIN SELECT RAISE(ABORT, 'external source attachment transition is invalid'); END;
            CREATE TRIGGER IF NOT EXISTS trg_chat_external_source_attachments_no_delete BEFORE DELETE ON chat_external_source_attachments
            BEGIN SELECT RAISE(ABORT, 'external source attachments cannot be deleted'); END;
          `);
        },
      },
      {
        version: 167,
        name: "trusted_ops_saved_boards",
        up: (db) => {
          if (!tableExists(db, "workspaces")) {
            return;
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS ops_saved_boards (
              workspace_id TEXT NOT NULL CHECK(
                workspace_id = TRIM(workspace_id) AND length(workspace_id) BETWEEN 1 AND 256
                AND instr(workspace_id, char(0)) = 0
                AND workspace_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
              ),
              board_id TEXT NOT NULL CHECK(
                board_id = TRIM(board_id) AND length(board_id) BETWEEN 1 AND 256
                AND instr(board_id, char(0)) = 0
                AND board_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
              ),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.ops-board.v1'),
              name TEXT NOT NULL CHECK(
                name = TRIM(name) AND length(name) BETWEEN 1 AND 120
                AND instr(name, char(0)) = 0
                AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
              ),
              description TEXT CHECK(
                description IS NULL OR (
                  description = TRIM(description) AND length(description) BETWEEN 1 AND 500
                  AND instr(description, char(0)) = 0
                  AND description NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
                )
              ),
              layout_json TEXT NOT NULL CHECK(
                json_valid(layout_json)
                AND json_type(layout_json) = 'array'
                AND json_array_length(layout_json) BETWEEN 1 AND 12
                AND length(CAST(layout_json AS BLOB)) <= 16384
              ),
              status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
              revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
              created_by_actor_id TEXT NOT NULL CHECK(
                created_by_actor_id = TRIM(created_by_actor_id) AND length(created_by_actor_id) BETWEEN 1 AND 256
                AND instr(created_by_actor_id, char(0)) = 0
                AND created_by_actor_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
              ),
              created_at TEXT NOT NULL CHECK(length(TRIM(created_at)) > 0),
              updated_by_actor_id TEXT NOT NULL CHECK(
                updated_by_actor_id = TRIM(updated_by_actor_id) AND length(updated_by_actor_id) BETWEEN 1 AND 256
                AND instr(updated_by_actor_id, char(0)) = 0
                AND updated_by_actor_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
              ),
              updated_at TEXT NOT NULL CHECK(length(TRIM(updated_at)) > 0),
              archived_by_actor_id TEXT CHECK(
                archived_by_actor_id IS NULL OR (
                  archived_by_actor_id = TRIM(archived_by_actor_id)
                  AND length(archived_by_actor_id) BETWEEN 1 AND 256
                  AND instr(archived_by_actor_id, char(0)) = 0
                  AND archived_by_actor_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
                )
              ),
              archived_at TEXT CHECK(archived_at IS NULL OR length(TRIM(archived_at)) > 0),
              idempotency_key TEXT NOT NULL CHECK(
                idempotency_key = TRIM(idempotency_key) AND length(idempotency_key) BETWEEN 1 AND 512
                AND instr(idempotency_key, char(0)) = 0
                AND idempotency_key NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')
              ),
              request_sha256 TEXT NOT NULL CHECK(
                length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
              ),
              PRIMARY KEY(workspace_id, board_id),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
              CHECK(
                (status = 'active' AND archived_by_actor_id IS NULL AND archived_at IS NULL)
                OR (status = 'archived' AND archived_by_actor_id IS NOT NULL AND archived_at IS NOT NULL)
              )
            );

            CREATE INDEX IF NOT EXISTS idx_ops_saved_boards_workspace_status_updated
              ON ops_saved_boards(workspace_id, status, updated_at DESC, board_id DESC);

            CREATE TRIGGER IF NOT EXISTS trg_ops_saved_boards_insert_invariant
            BEFORE INSERT ON ops_saved_boards
            WHEN
              NEW.status <> 'active'
              OR NEW.revision <> 1
              OR NEW.created_by_actor_id IS NOT NEW.updated_by_actor_id
              OR NEW.created_at IS NOT NEW.updated_at
              OR NEW.archived_by_actor_id IS NOT NULL
              OR NEW.archived_at IS NOT NULL
            BEGIN
              SELECT RAISE(ABORT, 'ops saved board insert invariant violated');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_ops_saved_boards_cap_insert
            BEFORE INSERT ON ops_saved_boards
            WHEN NOT EXISTS (
              SELECT 1 FROM ops_saved_boards
              WHERE workspace_id = NEW.workspace_id AND idempotency_key = NEW.idempotency_key
            ) AND (
              SELECT COUNT(*) FROM ops_saved_boards WHERE workspace_id = NEW.workspace_id
            ) >= 64
            BEGIN
              SELECT RAISE(ABORT, 'ops saved board workspace limit exceeded');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_ops_saved_boards_cas_update
            BEFORE UPDATE ON ops_saved_boards
            WHEN
              NEW.workspace_id IS NOT OLD.workspace_id
              OR NEW.board_id IS NOT OLD.board_id
              OR NEW.schema_version IS NOT OLD.schema_version
              OR NEW.created_by_actor_id IS NOT OLD.created_by_actor_id
              OR NEW.created_at IS NOT OLD.created_at
              OR NEW.idempotency_key IS NOT OLD.idempotency_key
              OR NEW.request_sha256 IS NOT OLD.request_sha256
              OR NEW.revision <> OLD.revision + 1
              OR NEW.updated_at < OLD.updated_at
              OR NOT (
                (
                  OLD.status = 'active' AND NEW.status = 'active'
                  AND NEW.archived_by_actor_id IS NULL AND NEW.archived_at IS NULL
                ) OR (
                  OLD.status = 'active' AND NEW.status = 'archived'
                  AND NEW.name IS OLD.name AND NEW.description IS OLD.description AND NEW.layout_json IS OLD.layout_json
                  AND NEW.archived_by_actor_id IS NEW.updated_by_actor_id
                  AND NEW.archived_at IS NEW.updated_at
                ) OR (
                  OLD.status = 'archived' AND NEW.status = 'active'
                  AND NEW.name IS OLD.name AND NEW.description IS OLD.description AND NEW.layout_json IS OLD.layout_json
                  AND NEW.archived_by_actor_id IS NULL AND NEW.archived_at IS NULL
                )
              )
            BEGIN
              SELECT RAISE(ABORT, 'ops saved board CAS or transition invariant violated');
            END;

            CREATE TRIGGER IF NOT EXISTS trg_ops_saved_boards_no_delete
            BEFORE DELETE ON ops_saved_boards
            BEGIN
              SELECT RAISE(ABORT, 'ops saved boards cannot be deleted');
            END;
          `);
        },
      },
      {
        version: 168,
        name: "governed_mesh_capability_publication",
        up: (db) => {
          if (!tableExists(db, "workspaces") || !tableExists(db, "mesh_nodes") || !tableExists(db, "mesh_leases")) {
            return;
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS mesh_capability_publishers (
              workspace_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              admission_generation INTEGER NOT NULL CHECK(typeof(admission_generation) = 'integer' AND admission_generation > 0),
              publisher_generation INTEGER NOT NULL CHECK(typeof(publisher_generation) = 'integer' AND publisher_generation > 0),
              mtls_required INTEGER NOT NULL CHECK(mtls_required IN (0, 1)),
              tls_fingerprint TEXT,
              publication_lease_key TEXT NOT NULL,
              publication_lease_fencing_token INTEGER NOT NULL CHECK(typeof(publication_lease_fencing_token) = 'integer' AND publication_lease_fencing_token > 0),
              publication_lease_expires_at TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, node_id, publisher_generation),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
              FOREIGN KEY(node_id) REFERENCES mesh_nodes(node_id) ON DELETE RESTRICT,
              CHECK((mtls_required = 0) OR (tls_fingerprint IS NOT NULL AND length(TRIM(tls_fingerprint)) > 0))
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_publisher_health (
              workspace_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              publisher_generation INTEGER NOT NULL,
              health_generation INTEGER NOT NULL CHECK(typeof(health_generation) = 'integer' AND health_generation > 0),
              status TEXT NOT NULL CHECK(status IN ('online', 'suspect', 'offline', 'revoked')),
              publication_lease_fencing_token INTEGER NOT NULL CHECK(typeof(publication_lease_fencing_token) = 'integer' AND publication_lease_fencing_token > 0),
              publication_lease_expires_at TEXT NOT NULL,
              tls_fingerprint TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, node_id, publisher_generation),
              FOREIGN KEY(workspace_id, node_id, publisher_generation)
                REFERENCES mesh_capability_publishers(workspace_id, node_id, publisher_generation) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_manifests (
              workspace_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              admission_generation INTEGER NOT NULL CHECK(typeof(admission_generation) = 'integer' AND admission_generation > 0),
              publisher_generation INTEGER NOT NULL,
              publication_key TEXT NOT NULL,
              publication_lease_fencing_token INTEGER NOT NULL CHECK(typeof(publication_lease_fencing_token) = 'integer' AND publication_lease_fencing_token > 0),
              manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              supersedes_manifest_sha256 TEXT,
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.mesh-capability-manifest.v1'),
              entry_count INTEGER NOT NULL CHECK(typeof(entry_count) = 'integer' AND entry_count BETWEEN 1 AND 128),
              canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json) = 'object' AND length(CAST(canonical_json AS BLOB)) <= 524288),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, node_id, publisher_generation, manifest_sha256),
              UNIQUE(workspace_id, publication_key),
              FOREIGN KEY(workspace_id, node_id, publisher_generation)
                REFERENCES mesh_capability_publishers(workspace_id, node_id, publisher_generation) ON DELETE RESTRICT,
              FOREIGN KEY(workspace_id, node_id, publisher_generation, supersedes_manifest_sha256)
                REFERENCES mesh_capability_manifests(workspace_id, node_id, publisher_generation, manifest_sha256) ON DELETE RESTRICT,
              CHECK(supersedes_manifest_sha256 IS NULL OR supersedes_manifest_sha256 <> manifest_sha256)
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_manifest_entries (
              workspace_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              publisher_generation INTEGER NOT NULL,
              manifest_sha256 TEXT NOT NULL,
              capability_id TEXT NOT NULL,
              local_id TEXT NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('tool', 'mcp_server', 'skill')),
              descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256) = 64 AND descriptor_sha256 NOT GLOB '*[^0-9a-f]*'),
              permission_envelope_sha256 TEXT NOT NULL CHECK(length(permission_envelope_sha256) = 64 AND permission_envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
              entry_sha256 TEXT NOT NULL CHECK(length(entry_sha256) = 64 AND entry_sha256 NOT GLOB '*[^0-9a-f]*'),
              effect_posture TEXT NOT NULL CHECK(effect_posture IN ('none', 'read_only', 'write_local', 'external_side_effect', 'unknown')),
              canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json) = 'object' AND length(CAST(canonical_json AS BLOB)) <= 65536),
              PRIMARY KEY(workspace_id, node_id, publisher_generation, manifest_sha256, capability_id),
              UNIQUE(workspace_id, node_id, publisher_generation, manifest_sha256, kind, local_id),
              FOREIGN KEY(workspace_id, node_id, publisher_generation, manifest_sha256)
                REFERENCES mesh_capability_manifests(workspace_id, node_id, publisher_generation, manifest_sha256) ON DELETE RESTRICT,
              CHECK(capability_id = 'mesh:' || node_id || ':' || kind || ':' || local_id)
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_activations (
              workspace_id TEXT NOT NULL,
              activation_id TEXT NOT NULL,
              activation_revision INTEGER NOT NULL CHECK(typeof(activation_revision) = 'integer' AND activation_revision > 0),
              capability_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              publisher_generation INTEGER NOT NULL,
              health_generation INTEGER NOT NULL,
              publication_lease_fencing_token INTEGER NOT NULL,
              manifest_sha256 TEXT NOT NULL,
              entry_sha256 TEXT NOT NULL CHECK(length(entry_sha256) = 64 AND entry_sha256 NOT GLOB '*[^0-9a-f]*'),
              descriptor_sha256 TEXT NOT NULL,
              permission_envelope_sha256 TEXT NOT NULL,
              effect_posture TEXT NOT NULL,
              permission_diff_json TEXT NOT NULL CHECK(json_valid(permission_diff_json) AND json_type(permission_diff_json) = 'object'),
              effect_diff_json TEXT NOT NULL CHECK(json_valid(effect_diff_json) AND json_type(effect_diff_json) = 'object'),
              approval_id TEXT NOT NULL,
              actor_id TEXT NOT NULL,
              session_id TEXT,
              turn_id TEXT,
              idempotency_key TEXT NOT NULL,
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, activation_id),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id, node_id, publisher_generation, manifest_sha256, capability_id)
                REFERENCES mesh_capability_manifest_entries(workspace_id, node_id, publisher_generation, manifest_sha256, capability_id) ON DELETE RESTRICT,
              FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_activation_revocations (
              workspace_id TEXT NOT NULL,
              activation_id TEXT NOT NULL,
              reason TEXT NOT NULL,
              actor_id TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              revoked_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, activation_id),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id, activation_id)
                REFERENCES mesh_capability_activations(workspace_id, activation_id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_invocation_intents (
              workspace_id TEXT NOT NULL,
              invocation_id TEXT NOT NULL,
              activation_id TEXT NOT NULL,
              activation_revision INTEGER NOT NULL CHECK(typeof(activation_revision) = 'integer' AND activation_revision > 0),
              capability_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              publisher_generation INTEGER NOT NULL,
              health_generation INTEGER NOT NULL,
              publication_lease_fencing_token INTEGER NOT NULL,
              manifest_sha256 TEXT NOT NULL,
              entry_sha256 TEXT NOT NULL CHECK(length(entry_sha256) = 64 AND entry_sha256 NOT GLOB '*[^0-9a-f]*'),
              descriptor_sha256 TEXT NOT NULL,
              permission_envelope_sha256 TEXT NOT NULL,
              execution_profile_sha256 TEXT NOT NULL CHECK(length(execution_profile_sha256) = 64 AND execution_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
              input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
              session_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              run_id TEXT,
              approval_id TEXT,
              deadline_at TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, invocation_id),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id, activation_id)
                REFERENCES mesh_capability_activations(workspace_id, activation_id) ON DELETE RESTRICT,
              FOREIGN KEY(approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_invocation_settlements (
              workspace_id TEXT NOT NULL,
              invocation_id TEXT NOT NULL,
              disposition TEXT NOT NULL CHECK(disposition IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'unknown')),
              output_sha256 TEXT,
              error_code TEXT,
              settlement_sha256 TEXT NOT NULL CHECK(length(settlement_sha256) = 64 AND settlement_sha256 NOT GLOB '*[^0-9a-f]*'),
              effective_cost_attribution_sha256 TEXT,
              publisher_generation INTEGER NOT NULL,
              publication_lease_fencing_token INTEGER NOT NULL,
              idempotency_key TEXT NOT NULL,
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              settled_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, invocation_id),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id, invocation_id)
                REFERENCES mesh_capability_invocation_intents(workspace_id, invocation_id) ON DELETE RESTRICT,
              CHECK(output_sha256 IS NULL OR (length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^0-9a-f]*')),
              CHECK(effective_cost_attribution_sha256 IS NULL OR (
                length(effective_cost_attribution_sha256) = 64
                AND effective_cost_attribution_sha256 NOT GLOB '*[^0-9a-f]*'
              ))
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_capability_manifests_publisher_created
              ON mesh_capability_manifests(workspace_id, node_id, publisher_generation, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_mesh_capability_entries_capability
              ON mesh_capability_manifest_entries(workspace_id, capability_id, manifest_sha256);
            CREATE INDEX IF NOT EXISTS idx_mesh_capability_activations_capability_created
              ON mesh_capability_activations(workspace_id, capability_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_mesh_capability_intents_activation_created
              ON mesh_capability_invocation_intents(workspace_id, activation_id, created_at DESC);

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_publishers_insert_guard
            BEFORE INSERT ON mesh_capability_publishers
            WHEN
              EXISTS (
                SELECT 1 FROM mesh_capability_publishers
                WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id
                  AND publisher_generation >= NEW.publisher_generation
              )
              OR EXISTS (
                SELECT 1 FROM mesh_capability_publishers
                WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id
                  AND admission_generation > NEW.admission_generation
              )
              OR (
                NOT EXISTS (SELECT 1 FROM mesh_capability_publishers WHERE workspace_id = NEW.workspace_id AND node_id = NEW.node_id)
                AND (SELECT COUNT(DISTINCT node_id) FROM mesh_capability_publishers WHERE workspace_id = NEW.workspace_id) >= 16
              )
              OR NOT EXISTS (
                SELECT 1 FROM mesh_nodes node
                JOIN mesh_leases lease ON lease.lease_key = NEW.publication_lease_key
                WHERE node.node_id = NEW.node_id AND node.status = 'online'
                  AND lease.holder_node_id = NEW.node_id
                  AND lease.fencing_token = NEW.publication_lease_fencing_token
                  AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND lease.expires_at = NEW.publication_lease_expires_at
                  AND (NEW.mtls_required = 0 OR node.tls_fingerprint = NEW.tls_fingerprint)
              )
            BEGIN SELECT RAISE(ABORT, 'mesh capability publisher generation or live database-clock lease invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_health_insert_guard
            BEFORE INSERT ON mesh_capability_publisher_health
            WHEN NEW.health_generation <> 1 OR NEW.status <> 'online' OR NOT EXISTS (
              SELECT 1 FROM mesh_capability_publishers publisher
              WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                AND publisher.publisher_generation = NEW.publisher_generation
                AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                AND publisher.publication_lease_expires_at = NEW.publication_lease_expires_at
                AND publisher.tls_fingerprint IS NEW.tls_fingerprint
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability publisher health insert invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_health_cas
            BEFORE UPDATE ON mesh_capability_publisher_health
            WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.node_id IS NOT OLD.node_id
              OR NEW.publisher_generation IS NOT OLD.publisher_generation
              OR OLD.status IN ('offline', 'revoked')
              OR NOT (
                (
                  NEW.health_generation = OLD.health_generation
                  AND NEW.status = 'online' AND OLD.status = 'online'
                  AND NEW.publication_lease_fencing_token = OLD.publication_lease_fencing_token
                  AND NEW.publication_lease_expires_at > OLD.publication_lease_expires_at
                  AND NEW.tls_fingerprint IS OLD.tls_fingerprint
                  AND NEW.publication_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND EXISTS (
                    SELECT 1 FROM mesh_capability_publishers publisher
                    JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
                    WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                      AND publisher.publisher_generation = NEW.publisher_generation
                      AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                      AND publisher.tls_fingerprint IS NEW.tls_fingerprint
                      AND lease.holder_node_id = NEW.node_id
                      AND lease.fencing_token = NEW.publication_lease_fencing_token
                      AND lease.expires_at = NEW.publication_lease_expires_at
                      AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  )
                ) OR (
                  NEW.health_generation = OLD.health_generation + 1
                  AND NEW.publication_lease_fencing_token = OLD.publication_lease_fencing_token
                  AND NEW.tls_fingerprint IS OLD.tls_fingerprint
                  AND (
                    NEW.status <> 'online' OR (
                      NEW.publication_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      AND EXISTS (
                        SELECT 1 FROM mesh_capability_publishers publisher
                        JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
                        WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                          AND publisher.publisher_generation = NEW.publisher_generation
                          AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                          AND publisher.tls_fingerprint IS NEW.tls_fingerprint
                          AND lease.holder_node_id = NEW.node_id
                          AND lease.fencing_token = NEW.publication_lease_fencing_token
                          AND lease.expires_at = NEW.publication_lease_expires_at
                          AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      )
                    )
                  )
                )
              )
            BEGIN SELECT RAISE(ABORT, 'mesh capability publisher health CAS invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_manifest_insert_guard
            BEFORE INSERT ON mesh_capability_manifests
            WHEN
              NOT EXISTS (
                SELECT 1 FROM mesh_capability_publishers publisher
                JOIN mesh_capability_publisher_health health
                  ON health.workspace_id = publisher.workspace_id AND health.node_id = publisher.node_id
                 AND health.publisher_generation = publisher.publisher_generation
                WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                  AND publisher.publisher_generation = NEW.publisher_generation
                  AND publisher.admission_generation = NEW.admission_generation
                  AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                  AND health.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                  AND health.status = 'online'
                  AND health.publication_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND json_extract(NEW.canonical_json, '$.workspaceId') = NEW.workspace_id
                  AND json_extract(NEW.canonical_json, '$.nodeId') = NEW.node_id
                  AND json_extract(NEW.canonical_json, '$.admissionGeneration') = NEW.admission_generation
                  AND json_extract(NEW.canonical_json, '$.publisherGeneration') = NEW.publisher_generation
                  AND json_extract(NEW.canonical_json, '$.publicationKey') = NEW.publication_key
                  AND json_extract(NEW.canonical_json, '$.publicationLeaseFencingToken') = NEW.publication_lease_fencing_token
                  AND json_extract(NEW.canonical_json, '$.manifestSha256') = NEW.manifest_sha256
                  AND json_extract(NEW.canonical_json, '$.supersedesManifestSha256') IS NEW.supersedes_manifest_sha256
                  AND json_extract(NEW.canonical_json, '$.schemaVersion') = NEW.schema_version
                  AND json_extract(NEW.canonical_json, '$.createdAt') = NEW.created_at
                  AND json_array_length(json_extract(NEW.canonical_json, '$.entries')) = NEW.entry_count
              )
              OR (
                NEW.supersedes_manifest_sha256 IS NOT NULL AND (
                  NOT EXISTS (
                    SELECT 1 FROM mesh_capability_manifests prior
                    WHERE prior.workspace_id = NEW.workspace_id AND prior.node_id = NEW.node_id
                      AND prior.publisher_generation = NEW.publisher_generation
                      AND prior.manifest_sha256 = NEW.supersedes_manifest_sha256
                  )
                  OR EXISTS (
                    SELECT 1 FROM mesh_capability_manifests child
                    WHERE child.workspace_id = NEW.workspace_id AND child.node_id = NEW.node_id
                      AND child.publisher_generation = NEW.publisher_generation
                      AND child.supersedes_manifest_sha256 = NEW.supersedes_manifest_sha256
                  )
                )
              )
              OR (
                NEW.supersedes_manifest_sha256 IS NULL AND (
                  SELECT COUNT(*) FROM mesh_capability_manifests head
                  WHERE head.workspace_id = NEW.workspace_id AND head.node_id = NEW.node_id
                    AND head.publisher_generation = NEW.publisher_generation
                    AND NOT EXISTS (
                      SELECT 1 FROM mesh_capability_manifests child
                      WHERE child.workspace_id = head.workspace_id AND child.node_id = head.node_id
                        AND child.publisher_generation = head.publisher_generation
                        AND child.supersedes_manifest_sha256 = head.manifest_sha256
                    )
                ) >= 32
              )
            BEGIN SELECT RAISE(ABORT, 'mesh capability manifest generation, supersession, health, or cap invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_entries_cap
            BEFORE INSERT ON mesh_capability_manifest_entries
            WHEN json_extract(NEW.canonical_json, '$.localId') IS NOT NEW.local_id
              OR json_extract(NEW.canonical_json, '$.kind') IS NOT NEW.kind
              OR json_extract(NEW.canonical_json, '$.capabilityId') IS NOT NEW.capability_id
              OR json_extract(NEW.canonical_json, '$.descriptorSha256') IS NOT NEW.descriptor_sha256
              OR json_extract(NEW.canonical_json, '$.permissionEnvelopeSha256') IS NOT NEW.permission_envelope_sha256
              OR json_extract(NEW.canonical_json, '$.entrySha256') IS NOT NEW.entry_sha256
              OR json_extract(NEW.canonical_json, '$.descriptor.effectPosture') IS NOT NEW.effect_posture
              OR NOT EXISTS (
                SELECT 1 FROM mesh_capability_manifests manifest,
                  json_each(manifest.canonical_json, '$.entries') manifest_entry
                WHERE manifest.workspace_id = NEW.workspace_id AND manifest.node_id = NEW.node_id
                  AND manifest.publisher_generation = NEW.publisher_generation
                  AND manifest.manifest_sha256 = NEW.manifest_sha256
                  AND manifest_entry.value = NEW.canonical_json
              )
              OR (SELECT COUNT(*) FROM mesh_capability_manifest_entries entry
                  WHERE entry.workspace_id = NEW.workspace_id AND entry.node_id = NEW.node_id
                    AND entry.publisher_generation = NEW.publisher_generation AND entry.manifest_sha256 = NEW.manifest_sha256)
                 >= (SELECT entry_count FROM mesh_capability_manifests manifest
                     WHERE manifest.workspace_id = NEW.workspace_id AND manifest.node_id = NEW.node_id
                       AND manifest.publisher_generation = NEW.publisher_generation AND manifest.manifest_sha256 = NEW.manifest_sha256)
            BEGIN SELECT RAISE(ABORT, 'mesh capability manifest entry count exceeded'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_activation_guard
            BEFORE INSERT ON mesh_capability_activations
            WHEN
              (SELECT COUNT(*) FROM mesh_capability_activations activation
               JOIN mesh_capability_publishers cap_publisher
                 ON cap_publisher.workspace_id = activation.workspace_id AND cap_publisher.node_id = activation.node_id
                AND cap_publisher.publisher_generation = activation.publisher_generation
               JOIN mesh_capability_publisher_health cap_health
                 ON cap_health.workspace_id = activation.workspace_id AND cap_health.node_id = activation.node_id
                AND cap_health.publisher_generation = activation.publisher_generation
               JOIN mesh_nodes cap_node ON cap_node.node_id = activation.node_id
               JOIN mesh_leases cap_lease ON cap_lease.lease_key = cap_publisher.publication_lease_key
               WHERE activation.workspace_id = NEW.workspace_id
                 AND activation.capability_id <> NEW.capability_id
                 AND activation.activation_revision = (
                   SELECT MAX(latest.activation_revision) FROM mesh_capability_activations latest
                   WHERE latest.workspace_id = activation.workspace_id AND latest.capability_id = activation.capability_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM mesh_capability_activation_revocations revoked
                   WHERE revoked.workspace_id = activation.workspace_id AND revoked.activation_id = activation.activation_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM mesh_capability_manifests child
                   WHERE child.workspace_id = activation.workspace_id AND child.node_id = activation.node_id
                     AND child.publisher_generation = activation.publisher_generation
                     AND child.supersedes_manifest_sha256 = activation.manifest_sha256
                 )
                 AND cap_health.status = 'online' AND cap_health.health_generation = activation.health_generation
                 AND cap_health.publication_lease_fencing_token = activation.publication_lease_fencing_token
                 AND cap_publisher.publication_lease_fencing_token = activation.publication_lease_fencing_token
                 AND cap_health.publication_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 AND activation.publisher_generation = (
                   SELECT MAX(current.publisher_generation) FROM mesh_capability_publishers current
                   WHERE current.workspace_id = activation.workspace_id AND current.node_id = activation.node_id
                 )
                 AND cap_node.status = 'online'
                 AND (cap_publisher.mtls_required = 0 OR (
                   cap_node.tls_fingerprint = cap_health.tls_fingerprint
                   AND cap_publisher.tls_fingerprint = cap_health.tls_fingerprint
                 ))
                 AND cap_lease.holder_node_id = activation.node_id
                 AND cap_lease.fencing_token = activation.publication_lease_fencing_token
                 AND cap_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) >= 256
              OR NEW.activation_revision <> 1 + COALESCE((
                SELECT MAX(prior.activation_revision) FROM mesh_capability_activations prior
                WHERE prior.workspace_id = NEW.workspace_id AND prior.capability_id = NEW.capability_id
              ), 0)
              OR NOT EXISTS (
                SELECT 1
                FROM mesh_capability_manifest_entries entry
                JOIN mesh_capability_publisher_health health
                  ON health.workspace_id = entry.workspace_id AND health.node_id = entry.node_id
                 AND health.publisher_generation = entry.publisher_generation
                JOIN mesh_capability_publishers publisher
                  ON publisher.workspace_id = entry.workspace_id AND publisher.node_id = entry.node_id
                 AND publisher.publisher_generation = entry.publisher_generation
                JOIN mesh_nodes node ON node.node_id = entry.node_id
                JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
                JOIN approvals approval ON approval.approval_id = NEW.approval_id
                WHERE entry.workspace_id = NEW.workspace_id AND entry.capability_id = NEW.capability_id
                  AND entry.node_id = NEW.node_id AND entry.publisher_generation = NEW.publisher_generation
                  AND entry.manifest_sha256 = NEW.manifest_sha256 AND entry.kind IN ('tool', 'mcp_server')
                  AND entry.entry_sha256 = NEW.entry_sha256
                  AND entry.descriptor_sha256 = NEW.descriptor_sha256
                  AND entry.permission_envelope_sha256 = NEW.permission_envelope_sha256
                  AND entry.effect_posture = NEW.effect_posture
                  AND NOT EXISTS (
                    SELECT 1 FROM mesh_capability_manifests child
                    WHERE child.workspace_id = entry.workspace_id AND child.node_id = entry.node_id
                      AND child.publisher_generation = entry.publisher_generation
                      AND child.supersedes_manifest_sha256 = entry.manifest_sha256
                  )
                  AND health.health_generation = NEW.health_generation AND health.status = 'online'
                  AND health.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                  AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                  AND health.publication_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND publisher.publisher_generation = (
                    SELECT MAX(current.publisher_generation) FROM mesh_capability_publishers current
                    WHERE current.workspace_id = NEW.workspace_id AND current.node_id = NEW.node_id
                  )
                  AND node.status = 'online'
                  AND (publisher.mtls_required = 0 OR (
                    node.tls_fingerprint = health.tls_fingerprint
                    AND publisher.tls_fingerprint = health.tls_fingerprint
                  ))
                  AND lease.holder_node_id = NEW.node_id
                  AND lease.fencing_token = NEW.publication_lease_fencing_token
                  AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND approval.kind = 'mesh.capability.activate' AND approval.status = 'approved'
                  AND approval.resolved_at IS NOT NULL
                  AND (
                    approval.expires_at IS NULL OR (
                      julianday(approval.expires_at) IS NOT NULL
                      AND julianday(approval.expires_at) > julianday('now')
                    )
                  )
                  AND json_valid(approval.payload_json) AND json_type(approval.payload_json) = 'object'
                  AND json_extract(approval.payload_json, '$.workspaceId') = NEW.workspace_id
                  AND json_extract(approval.payload_json, '$.activationId') = NEW.activation_id
                  AND json_extract(approval.payload_json, '$.activationRevision') = NEW.activation_revision
                  AND json_extract(approval.payload_json, '$.requestSha256') = NEW.request_sha256
                  AND json_extract(approval.payload_json, '$.capabilityId') = NEW.capability_id
                  AND json_extract(approval.payload_json, '$.manifestSha256') = NEW.manifest_sha256
                  AND json_extract(approval.payload_json, '$.entrySha256') = NEW.entry_sha256
                  AND json_extract(approval.payload_json, '$.descriptorSha256') = NEW.descriptor_sha256
                  AND json_extract(approval.payload_json, '$.permissionEnvelopeSha256') = NEW.permission_envelope_sha256
                  AND json_extract(approval.payload_json, '$.effectPosture') = NEW.effect_posture
                  AND (SELECT COUNT(*) FROM json_each(approval.payload_json)) = 10
                  AND approval.linkage_json IS NOT NULL AND json_valid(approval.linkage_json)
                  AND json_extract(approval.linkage_json, '$.workspaceId') = NEW.workspace_id
                  AND (NEW.session_id IS NULL OR json_extract(approval.linkage_json, '$.sessionId') = NEW.session_id)
                  AND (NEW.turn_id IS NULL OR json_extract(approval.linkage_json, '$.turnId') = NEW.turn_id)
                  AND (SELECT COUNT(*) FROM json_each(approval.linkage_json)) =
                    1 + CASE WHEN NEW.session_id IS NULL THEN 0 ELSE 1 END + CASE WHEN NEW.turn_id IS NULL THEN 0 ELSE 1 END
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(approval.linkage_json) linkage_field
                    WHERE linkage_field.key NOT IN ('workspaceId', 'sessionId', 'turnId')
                  )
              )
            BEGIN SELECT RAISE(ABORT, 'mesh capability activation binding, approval, health, lease, or cap invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_intent_guard
            BEFORE INSERT ON mesh_capability_invocation_intents
            WHEN julianday(NEW.deadline_at) IS NULL
              OR NEW.deadline_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR NOT EXISTS (
              SELECT 1 FROM mesh_capability_activations activation
              JOIN mesh_capability_manifest_entries entry
                ON entry.workspace_id = activation.workspace_id AND entry.node_id = activation.node_id
               AND entry.publisher_generation = activation.publisher_generation
               AND entry.manifest_sha256 = activation.manifest_sha256
               AND entry.capability_id = activation.capability_id
              JOIN mesh_capability_publisher_health health
                ON health.workspace_id = activation.workspace_id AND health.node_id = activation.node_id
               AND health.publisher_generation = activation.publisher_generation
              JOIN mesh_capability_publishers publisher
                ON publisher.workspace_id = activation.workspace_id AND publisher.node_id = activation.node_id
               AND publisher.publisher_generation = activation.publisher_generation
              JOIN mesh_nodes node ON node.node_id = activation.node_id
              JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
              WHERE activation.workspace_id = NEW.workspace_id AND activation.activation_id = NEW.activation_id
                AND activation.capability_id = NEW.capability_id AND activation.node_id = NEW.node_id
                AND activation.activation_revision = (
                  SELECT MAX(latest.activation_revision) FROM mesh_capability_activations latest
                  WHERE latest.workspace_id = activation.workspace_id AND latest.capability_id = activation.capability_id
                )
                AND activation.publisher_generation = NEW.publisher_generation
                AND activation.activation_revision = NEW.activation_revision
                AND activation.health_generation = NEW.health_generation
                AND activation.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                AND activation.manifest_sha256 = NEW.manifest_sha256
                AND activation.entry_sha256 = NEW.entry_sha256
                AND activation.descriptor_sha256 = NEW.descriptor_sha256
                AND activation.permission_envelope_sha256 = NEW.permission_envelope_sha256
                AND julianday(NEW.deadline_at) <= julianday('now')
                  + CAST(json_extract(entry.canonical_json, '$.descriptor.resourceLimits.timeoutMs') AS REAL) / 86400000.0
                AND NOT EXISTS (SELECT 1 FROM mesh_capability_activation_revocations revoked
                                WHERE revoked.workspace_id = activation.workspace_id AND revoked.activation_id = activation.activation_id)
                AND NOT EXISTS (SELECT 1 FROM mesh_capability_manifests child
                                WHERE child.workspace_id = activation.workspace_id AND child.node_id = activation.node_id
                                  AND child.publisher_generation = activation.publisher_generation
                                  AND child.supersedes_manifest_sha256 = activation.manifest_sha256)
                AND health.health_generation = activation.health_generation AND health.status = 'online'
                AND health.publication_lease_fencing_token = activation.publication_lease_fencing_token
                AND publisher.publication_lease_fencing_token = activation.publication_lease_fencing_token
                AND health.publication_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                AND activation.publisher_generation = (SELECT MAX(current.publisher_generation)
                  FROM mesh_capability_publishers current
                  WHERE current.workspace_id = activation.workspace_id AND current.node_id = activation.node_id)
                AND node.status = 'online'
                AND (publisher.mtls_required = 0 OR (
                  node.tls_fingerprint = health.tls_fingerprint
                  AND publisher.tls_fingerprint = health.tls_fingerprint
                ))
                AND lease.holder_node_id = activation.node_id
                AND lease.fencing_token = activation.publication_lease_fencing_token
                AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability invocation intent is not currently callable'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_settlement_guard
            BEFORE INSERT ON mesh_capability_invocation_settlements
            WHEN NOT EXISTS (
              SELECT 1 FROM mesh_capability_invocation_intents intent
              JOIN mesh_capability_publishers publisher
                ON publisher.workspace_id = intent.workspace_id AND publisher.node_id = intent.node_id
               AND publisher.publisher_generation = intent.publisher_generation
              WHERE intent.workspace_id = NEW.workspace_id AND intent.invocation_id = NEW.invocation_id
                AND intent.publisher_generation = NEW.publisher_generation
                AND intent.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                AND publisher.publication_lease_fencing_token = NEW.publication_lease_fencing_token
                AND intent.publisher_generation = (
                  SELECT MAX(current.publisher_generation) FROM mesh_capability_publishers current
                  WHERE current.workspace_id = intent.workspace_id AND current.node_id = intent.node_id
                )
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability settlement generation binding violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_publishers_no_update BEFORE UPDATE ON mesh_capability_publishers BEGIN SELECT RAISE(ABORT, 'mesh capability publisher generations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_publishers_no_delete BEFORE DELETE ON mesh_capability_publishers BEGIN SELECT RAISE(ABORT, 'mesh capability publisher generations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_health_no_delete BEFORE DELETE ON mesh_capability_publisher_health BEGIN SELECT RAISE(ABORT, 'mesh capability health records cannot be deleted'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_manifests_no_update BEFORE UPDATE ON mesh_capability_manifests BEGIN SELECT RAISE(ABORT, 'mesh capability manifests are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_manifests_no_delete BEFORE DELETE ON mesh_capability_manifests BEGIN SELECT RAISE(ABORT, 'mesh capability manifests are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_entries_no_update BEFORE UPDATE ON mesh_capability_manifest_entries BEGIN SELECT RAISE(ABORT, 'mesh capability entries are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_entries_no_delete BEFORE DELETE ON mesh_capability_manifest_entries BEGIN SELECT RAISE(ABORT, 'mesh capability entries are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_activations_no_update BEFORE UPDATE ON mesh_capability_activations BEGIN SELECT RAISE(ABORT, 'mesh capability activations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_activations_no_delete BEFORE DELETE ON mesh_capability_activations BEGIN SELECT RAISE(ABORT, 'mesh capability activations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_revocations_no_update BEFORE UPDATE ON mesh_capability_activation_revocations BEGIN SELECT RAISE(ABORT, 'mesh capability revocations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_revocations_no_delete BEFORE DELETE ON mesh_capability_activation_revocations BEGIN SELECT RAISE(ABORT, 'mesh capability revocations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_intents_no_update BEFORE UPDATE ON mesh_capability_invocation_intents BEGIN SELECT RAISE(ABORT, 'mesh capability invocation intents are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_intents_no_delete BEFORE DELETE ON mesh_capability_invocation_intents BEGIN SELECT RAISE(ABORT, 'mesh capability invocation intents are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_settlements_no_update BEFORE UPDATE ON mesh_capability_invocation_settlements BEGIN SELECT RAISE(ABORT, 'mesh capability invocation settlements are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_settlements_no_delete BEFORE DELETE ON mesh_capability_invocation_settlements BEGIN SELECT RAISE(ABORT, 'mesh capability invocation settlements are immutable'); END;
          `);
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

export const __sqliteInternals = {
  migrate,
  addColumnIfMissing,
  createSqliteSchemaBlueprintFromDatabase,
  applySchemaMigrationForTest,
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

function backfillSkillAggregateRevisions(db: DatabaseSync): void {
  const runtimeSources: string[] = [];
  if (tableExists(db, "skill_lifecycle")) {
    runtimeSources.push(`
      SELECT skill_id, created_at, updated_at
      FROM skill_lifecycle
      WHERE length(TRIM(created_at)) > 0 AND length(TRIM(updated_at)) > 0
    `);
  }
  if (tableExists(db, "skill_state")) {
    runtimeSources.push(`
      SELECT skill_id, updated_at AS created_at, updated_at
      FROM skill_state
      WHERE length(TRIM(updated_at)) > 0
    `);
  }
  if (runtimeSources.length > 0) {
    db.exec(`
      INSERT OR IGNORE INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      )
      SELECT 'runtime_skill', TRIM(source.skill_id), 1, MIN(source.created_at), MAX(source.updated_at)
      FROM (${runtimeSources.join(" UNION ALL ")}) AS source
      WHERE length(TRIM(source.skill_id)) BETWEEN 1 AND 256
      GROUP BY TRIM(source.skill_id);
    `);
  }
  if (tableExists(db, "candidate_skill_versions")) {
    db.exec(`
      INSERT OR IGNORE INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      )
      SELECT 'candidate_skill', TRIM(candidate_id), 1, MIN(created_at), MAX(updated_at)
      FROM candidate_skill_versions
      WHERE length(TRIM(candidate_id)) BETWEEN 1 AND 256
        AND length(TRIM(created_at)) > 0
        AND length(TRIM(updated_at)) > 0
      GROUP BY TRIM(candidate_id);
    `);
  }
  if (tableExists(db, "system_settings")) {
    db.exec(`
      INSERT OR IGNORE INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      )
      SELECT 'activation_policy', 'global', 1, updated_at, updated_at
      FROM system_settings
      WHERE setting_key = 'skill_activation_policy_v1'
        AND length(TRIM(updated_at)) > 0;
    `);
  }
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return Boolean(row);
}
