/* eslint-disable max-lines */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { canonicalJsonString, clampInt } from "@goatcitadel/contracts";
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
import { createGovernedLifecycleSchema } from "./sqlite/governed-lifecycle-schema.js";

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
  db.function("gc_sha256", { deterministic: true }, (value) =>
    value === null ? null : createHash("sha256").update(String(value), "utf8").digest("hex"),
  );
  db.function("gc_canonical_json", { deterministic: true }, (value) => {
    if (value === null) return null;
    try {
      return canonicalJsonString(JSON.parse(String(value)));
    } catch {
      return null;
    }
  });
  db.function("gc_js_trim", { deterministic: true }, (value) => (value === null ? null : String(value).trim()));
  db.function("gc_unicode_scalar_length", { deterministic: true }, (value) => {
    if (value === null) return null;
    let count = 0;
    for (const scalar of String(value)) {
      const codePoint = scalar.codePointAt(0)!;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
      count += 1;
    }
    return count;
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
  try {
    migrate(db);
  } catch (error) {
    // Close the handle so a failed migration does not keep the database file locked;
    // on Windows a leaked handle turns later cleanup into EPERM noise that masks the
    // migration error itself.
    try {
      db.close();
    } catch {
      // Best-effort cleanup: surface the migration failure, not the close failure.
    }
    throw error;
  }
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
      {
        version: 169,
        name: "mesh_capability_node_admission_authority",
        up: (db) => {
          if (
            !tableExists(db, "workspaces") ||
            !tableExists(db, "mesh_nodes") ||
            !tableExists(db, "mesh_join_tokens") ||
            !tableExists(db, "mesh_capability_publishers")
          ) {
            return;
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS mesh_capability_node_admissions (
              workspace_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              admission_generation INTEGER NOT NULL CHECK(typeof(admission_generation) = 'integer' AND admission_generation > 0),
              join_token_sha256 TEXT NOT NULL UNIQUE CHECK(length(join_token_sha256) = 64 AND join_token_sha256 NOT GLOB '*[^0-9a-f]*'),
              mtls_required INTEGER NOT NULL CHECK(mtls_required IN (0, 1)),
              tls_fingerprint TEXT,
              admitted_by_actor_id TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              admitted_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, node_id, admission_generation),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
              FOREIGN KEY(node_id) REFERENCES mesh_nodes(node_id) ON DELETE RESTRICT,
              FOREIGN KEY(join_token_sha256) REFERENCES mesh_join_tokens(token_hash) ON DELETE RESTRICT,
              CHECK(mtls_required = 0 OR (tls_fingerprint IS NOT NULL AND length(TRIM(tls_fingerprint)) > 0))
            );

            CREATE TABLE IF NOT EXISTS mesh_capability_node_admission_revocations (
              workspace_id TEXT NOT NULL,
              node_id TEXT NOT NULL,
              admission_generation INTEGER NOT NULL CHECK(typeof(admission_generation) = 'integer' AND admission_generation > 0),
              reason TEXT NOT NULL,
              revoked_by_actor_id TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              revoked_at TEXT NOT NULL,
              PRIMARY KEY(workspace_id, node_id, admission_generation),
              UNIQUE(workspace_id, idempotency_key),
              FOREIGN KEY(workspace_id, node_id, admission_generation)
                REFERENCES mesh_capability_node_admissions(workspace_id, node_id, admission_generation) ON DELETE RESTRICT
            );

            CREATE INDEX IF NOT EXISTS idx_mesh_capability_node_admissions_current
              ON mesh_capability_node_admissions(workspace_id, node_id, admission_generation DESC);

            DROP TRIGGER IF EXISTS trg_mesh_capability_publishers_insert_guard;
            CREATE TRIGGER trg_mesh_capability_publishers_insert_guard
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

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_node_admissions_insert_guard
            BEFORE INSERT ON mesh_capability_node_admissions
            WHEN
              NEW.admission_generation <> 1 + COALESCE((
                SELECT MAX(prior.admission_generation) FROM mesh_capability_node_admissions prior
                WHERE prior.workspace_id = NEW.workspace_id AND prior.node_id = NEW.node_id
              ), 0)
              OR (
                NEW.admission_generation > 1 AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = NEW.workspace_id AND revoked.node_id = NEW.node_id
                    AND revoked.admission_generation = NEW.admission_generation - 1
                )
              )
              OR NOT EXISTS (
                SELECT 1 FROM mesh_join_tokens token
                WHERE token.token_hash = NEW.join_token_sha256
                  AND token.used_at IS NOT NULL AND token.used_by_node_id = NEW.node_id
              )
              OR NOT EXISTS (
                SELECT 1 FROM mesh_nodes node
                WHERE node.node_id = NEW.node_id AND node.status = 'online'
                  AND node.tls_fingerprint IS NEW.tls_fingerprint
              )
              OR (
                SELECT COUNT(*) FROM mesh_capability_node_admissions active
                WHERE active.workspace_id = NEW.workspace_id
                  AND active.admission_generation = (
                    SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                    WHERE current.workspace_id = active.workspace_id AND current.node_id = active.node_id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                    WHERE revoked.workspace_id = active.workspace_id AND revoked.node_id = active.node_id
                      AND revoked.admission_generation = active.admission_generation
                  )
              ) >= 16
            BEGIN SELECT RAISE(ABORT, 'mesh capability node admission generation, token, identity, or workspace cap invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_node_admission_revocations_insert_guard
            BEFORE INSERT ON mesh_capability_node_admission_revocations
            WHEN NOT EXISTS (
              SELECT 1 FROM mesh_capability_node_admissions admission
              WHERE admission.workspace_id = NEW.workspace_id AND admission.node_id = NEW.node_id
                AND admission.admission_generation = NEW.admission_generation
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
            ) OR EXISTS (
              SELECT 1 FROM mesh_capability_publishers publisher
              LEFT JOIN mesh_capability_publisher_health health
                ON health.workspace_id = publisher.workspace_id AND health.node_id = publisher.node_id
               AND health.publisher_generation = publisher.publisher_generation
              WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                AND publisher.admission_generation = NEW.admission_generation
                AND (health.status IS NULL OR health.status NOT IN ('offline', 'revoked'))
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability node admission revocation requires the current generation and terminal publisher health'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_publishers_admission_authority
            BEFORE INSERT ON mesh_capability_publishers
            WHEN NOT EXISTS (
              SELECT 1 FROM mesh_capability_node_admissions admission
              WHERE admission.workspace_id = NEW.workspace_id AND admission.node_id = NEW.node_id
                AND admission.admission_generation = NEW.admission_generation
                AND admission.mtls_required = NEW.mtls_required
                AND admission.tls_fingerprint IS NEW.tls_fingerprint
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation
                )
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability publisher lacks current workspace-scoped node admission authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_manifests_admission_authority
            BEFORE INSERT ON mesh_capability_manifests
            WHEN NOT EXISTS (
              SELECT 1 FROM mesh_capability_publishers publisher
              JOIN mesh_capability_node_admissions admission
                ON admission.workspace_id = publisher.workspace_id AND admission.node_id = publisher.node_id
               AND admission.admission_generation = publisher.admission_generation
              WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                AND publisher.publisher_generation = NEW.publisher_generation
                AND publisher.admission_generation = NEW.admission_generation
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation
                )
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability manifest lacks current workspace-scoped node admission authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_activations_admission_authority
            BEFORE INSERT ON mesh_capability_activations
            WHEN NOT EXISTS (
              SELECT 1 FROM mesh_capability_publishers publisher
              JOIN mesh_capability_node_admissions admission
                ON admission.workspace_id = publisher.workspace_id AND admission.node_id = publisher.node_id
               AND admission.admission_generation = publisher.admission_generation
              WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                AND publisher.publisher_generation = NEW.publisher_generation
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation
                )
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability activation lacks current workspace-scoped node admission authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_intents_admission_authority
            BEFORE INSERT ON mesh_capability_invocation_intents
            WHEN NOT EXISTS (
              SELECT 1 FROM mesh_capability_publishers publisher
              JOIN mesh_capability_node_admissions admission
                ON admission.workspace_id = publisher.workspace_id AND admission.node_id = publisher.node_id
               AND admission.admission_generation = publisher.admission_generation
              WHERE publisher.workspace_id = NEW.workspace_id AND publisher.node_id = NEW.node_id
                AND publisher.publisher_generation = NEW.publisher_generation
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation
                )
            )
            BEGIN SELECT RAISE(ABORT, 'mesh capability invocation intent lacks current workspace-scoped node admission authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_node_admissions_no_update BEFORE UPDATE ON mesh_capability_node_admissions BEGIN SELECT RAISE(ABORT, 'mesh capability node admissions are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_node_admissions_no_delete BEFORE DELETE ON mesh_capability_node_admissions BEGIN SELECT RAISE(ABORT, 'mesh capability node admissions are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_node_admission_revocations_no_update BEFORE UPDATE ON mesh_capability_node_admission_revocations BEGIN SELECT RAISE(ABORT, 'mesh capability node admission revocations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_mesh_capability_node_admission_revocations_no_delete BEFORE DELETE ON mesh_capability_node_admission_revocations BEGIN SELECT RAISE(ABORT, 'mesh capability node admission revocations are immutable'); END;
          `);
        },
      },
      {
        version: 170,
        name: "remote_worker_admission_foundation",
        up: (db) => {
          if (!tableExists(db, "workspaces")) return;
          db.exec(`
            CREATE TABLE IF NOT EXISTS remote_worker_bootstrap_requests (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
              worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
              node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
              target_worker_generation INTEGER NOT NULL CHECK(typeof(target_worker_generation) = 'integer' AND target_worker_generation > 0),
              worker_label TEXT NOT NULL CHECK(length(worker_label) BETWEEN 1 AND 160),
              platform TEXT NOT NULL CHECK(platform IN ('windows', 'linux', 'darwin')),
              architecture TEXT NOT NULL CHECK(architecture IN ('x64', 'arm64')),
              runtime_manifest_json TEXT NOT NULL CHECK(json_valid(runtime_manifest_json) AND length(CAST(runtime_manifest_json AS BLOB)) <= 524288),
              runtime_manifest_sha256 TEXT NOT NULL CHECK(length(runtime_manifest_sha256) = 64 AND runtime_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              allowed_workspace_count INTEGER NOT NULL CHECK(typeof(allowed_workspace_count) = 'integer' AND allowed_workspace_count BETWEEN 1 AND 16),
              workspace_ceiling_sha256 TEXT NOT NULL CHECK(length(workspace_ceiling_sha256) = 64 AND workspace_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'),
              capability_class_count INTEGER NOT NULL CHECK(typeof(capability_class_count) = 'integer' AND capability_class_count BETWEEN 1 AND 9),
              capability_ceiling_sha256 TEXT NOT NULL CHECK(length(capability_ceiling_sha256) = 64 AND capability_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'),
              bootstrap_secret_sha256 TEXT NOT NULL UNIQUE CHECK(length(bootstrap_secret_sha256) = 64 AND bootstrap_secret_sha256 NOT GLOB '*[^0-9a-f]*'),
              expires_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') = expires_at
              ),
              created_by_actor_id TEXT NOT NULL CHECK(length(created_by_actor_id) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
              ),
              PRIMARY KEY(registry_workspace_id, bootstrap_id),
              UNIQUE(registry_workspace_id, idempotency_key),
              FOREIGN KEY(registry_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
              CHECK((
                (CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER)) * 1000
                + CAST(substr(expires_at, 21, 3) AS INTEGER)
                - CAST(substr(created_at, 21, 3) AS INTEGER)
              ) BETWEEN 1000 AND 600000),
              CHECK(json_extract(runtime_manifest_json, '$.payload.schemaVersion') = 'goatcitadel.remote-worker-runtime-manifest.v1'),
              CHECK(json_extract(runtime_manifest_json, '$.payload.protocolVersion') = 'goatcitadel.remote-worker.v1'),
              CHECK(json_extract(runtime_manifest_json, '$.payload.platform') = platform),
              CHECK(json_extract(runtime_manifest_json, '$.payload.architecture') = architecture),
              CHECK(json_extract(runtime_manifest_json, '$.payload.installedTreeFileCount') BETWEEN 1 AND 10000),
              CHECK(json_extract(runtime_manifest_json, '$.signatureAlgorithm') = 'ed25519')
            );

            CREATE TABLE IF NOT EXISTS remote_worker_bootstrap_allowed_workspaces (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
              allowed_workspace_id TEXT NOT NULL CHECK(length(allowed_workspace_id) BETWEEN 1 AND 256),
              PRIMARY KEY(registry_workspace_id, bootstrap_id, allowed_workspace_id),
              FOREIGN KEY(registry_workspace_id, bootstrap_id)
                REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT,
              FOREIGN KEY(allowed_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS remote_worker_bootstrap_capability_classes (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
              capability_class TEXT NOT NULL CHECK(capability_class IN (
                'durable_compute', 'gateway_inference', 'governed_tool', 'governed_code',
                'artifact_stage', 'trusted_verification', 'device_camera', 'device_location',
                'device_notification'
              )),
              PRIMARY KEY(registry_workspace_id, bootstrap_id, capability_class),
              FOREIGN KEY(registry_workspace_id, bootstrap_id)
                REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS remote_worker_generations (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
              node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
              worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
              bootstrap_id TEXT NOT NULL CHECK(length(bootstrap_id) BETWEEN 1 AND 256),
              public_key_spki_sha256 TEXT NOT NULL CHECK(length(public_key_spki_sha256) = 64 AND public_key_spki_sha256 NOT GLOB '*[^0-9a-f]*'),
              client_certificate_sha256 TEXT NOT NULL CHECK(length(client_certificate_sha256) = 64 AND client_certificate_sha256 NOT GLOB '*[^0-9a-f]*'),
              transport_identity_source TEXT NOT NULL CHECK(transport_identity_source IN ('native_mtls', 'trusted_terminator')),
              transport_trust_anchor_sha256 TEXT NOT NULL CHECK(length(transport_trust_anchor_sha256) = 64 AND transport_trust_anchor_sha256 NOT GLOB '*[^0-9a-f]*'),
              transport_verification_receipt_sha256 TEXT NOT NULL CHECK(length(transport_verification_receipt_sha256) = 64 AND transport_verification_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
              proof_of_possession_receipt_sha256 TEXT NOT NULL CHECK(length(proof_of_possession_receipt_sha256) = 64 AND proof_of_possession_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
              download_verification_receipt_sha256 TEXT NOT NULL CHECK(length(download_verification_receipt_sha256) = 64 AND download_verification_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
              installed_tree_attestation_sha256 TEXT NOT NULL CHECK(length(installed_tree_attestation_sha256) = 64 AND installed_tree_attestation_sha256 NOT GLOB '*[^0-9a-f]*'),
              installed_tree_verification_receipt_sha256 TEXT NOT NULL CHECK(length(installed_tree_verification_receipt_sha256) = 64 AND installed_tree_verification_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
              runtime_manifest_sha256 TEXT NOT NULL CHECK(length(runtime_manifest_sha256) = 64 AND runtime_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              workspace_ceiling_sha256 TEXT NOT NULL CHECK(length(workspace_ceiling_sha256) = 64 AND workspace_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'),
              capability_ceiling_sha256 TEXT NOT NULL CHECK(length(capability_ceiling_sha256) = 64 AND capability_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'),
              exchange_idempotency_key TEXT NOT NULL CHECK(length(exchange_idempotency_key) BETWEEN 1 AND 512),
              exchange_request_sha256 TEXT NOT NULL CHECK(length(exchange_request_sha256) = 64 AND exchange_request_sha256 NOT GLOB '*[^0-9a-f]*'),
              admitted_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at, '+0 days') = admitted_at
              ),
              PRIMARY KEY(registry_workspace_id, worker_id, worker_generation),
              UNIQUE(registry_workspace_id, bootstrap_id),
              UNIQUE(registry_workspace_id, exchange_idempotency_key),
              FOREIGN KEY(registry_workspace_id, bootstrap_id)
                REFERENCES remote_worker_bootstrap_requests(registry_workspace_id, bootstrap_id) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS remote_worker_runtime_credentials (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
              worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
              credential_generation INTEGER NOT NULL CHECK(typeof(credential_generation) = 'integer' AND credential_generation > 0),
              credential_id TEXT NOT NULL CHECK(length(credential_id) BETWEEN 1 AND 256),
              purpose TEXT NOT NULL CHECK(purpose = 'worker_runtime'),
              token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
              transport_verification_receipt_sha256 TEXT NOT NULL CHECK(length(transport_verification_receipt_sha256) = 64 AND transport_verification_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
              proof_of_possession_receipt_sha256 TEXT NOT NULL CHECK(length(proof_of_possession_receipt_sha256) = 64 AND proof_of_possession_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
              claims_json TEXT NOT NULL CHECK(json_valid(claims_json) AND length(CAST(claims_json AS BLOB)) <= 16384),
              claims_sha256 TEXT NOT NULL CHECK(length(claims_sha256) = 64 AND claims_sha256 NOT GLOB '*[^0-9a-f]*'),
              issuance_proof_sha256 TEXT NOT NULL CHECK(length(issuance_proof_sha256) = 64 AND issuance_proof_sha256 NOT GLOB '*[^0-9a-f]*'),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              issued_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', issued_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at, '+0 days') = issued_at
              ),
              expires_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') = expires_at
              ),
              PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, credential_generation),
              UNIQUE(registry_workspace_id, credential_id),
              UNIQUE(registry_workspace_id, worker_id, worker_generation, idempotency_key),
              FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
                REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT,
              CHECK((
                (CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', issued_at) AS INTEGER)) * 1000
                + CAST(substr(expires_at, 21, 3) AS INTEGER)
                - CAST(substr(issued_at, 21, 3) AS INTEGER)
              ) BETWEEN 1000 AND 900000)
            );

            CREATE TABLE IF NOT EXISTS remote_worker_generation_controls (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
              worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
              control_revision INTEGER NOT NULL CHECK(typeof(control_revision) = 'integer' AND control_revision BETWEEN 1 AND 2),
              action TEXT NOT NULL CHECK(action IN ('quarantine', 'revoke')),
              reason_code TEXT NOT NULL CHECK(
                length(reason_code) BETWEEN 1 AND 128
                AND reason_code NOT GLOB '*[^a-z0-9._-]*'
                AND substr(reason_code, 1, 1) GLOB '[a-z0-9]'
                AND substr(reason_code, -1, 1) GLOB '[a-z0-9]'
              ),
              reason_sha256 TEXT NOT NULL CHECK(length(reason_sha256) = 64 AND reason_sha256 NOT GLOB '*[^0-9a-f]*'),
              actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
              ),
              PRIMARY KEY(registry_workspace_id, worker_id, worker_generation, control_revision),
              UNIQUE(registry_workspace_id, idempotency_key),
              FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
                REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT
            );

            CREATE INDEX IF NOT EXISTS idx_remote_worker_bootstraps_worker_target
              ON remote_worker_bootstrap_requests(registry_workspace_id, worker_id, target_worker_generation, expires_at);
            CREATE INDEX IF NOT EXISTS idx_remote_worker_generations_current
              ON remote_worker_generations(registry_workspace_id, worker_id, worker_generation DESC);
            CREATE INDEX IF NOT EXISTS idx_remote_worker_credentials_current
              ON remote_worker_runtime_credentials(registry_workspace_id, worker_id, worker_generation, credential_generation DESC);
            CREATE INDEX IF NOT EXISTS idx_remote_worker_controls_current
              ON remote_worker_generation_controls(registry_workspace_id, worker_id, worker_generation, control_revision DESC);

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_bootstrap_insert_guard
            BEFORE INSERT ON remote_worker_bootstrap_requests
            WHEN
              json(NEW.runtime_manifest_json) <> NEW.runtime_manifest_json
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(NEW.runtime_manifest_json)) <> 5
              OR (SELECT COUNT(DISTINCT root.key) FROM json_each(NEW.runtime_manifest_json) root) <> 5
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.runtime_manifest_json) root
                WHERE root.key NOT IN (
                  'payload', 'payloadSha256', 'signatureAlgorithm', 'signerKeyId', 'signatureBase64Url'
                )
              )
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.payload'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(NEW.runtime_manifest_json, '$.payload')) <> 10
              OR (
                SELECT COUNT(DISTINCT payload.key) FROM json_each(NEW.runtime_manifest_json, '$.payload') payload
              ) <> 10
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.runtime_manifest_json, '$.payload') payload
                WHERE payload.key NOT IN (
                  'schemaVersion', 'protocolVersion', 'bundleSha256', 'dependencyLockSha256',
                  'vendorTreeSha256', 'launcherSha256', 'installedTreeManifestSha256',
                  'installedTreeFileCount', 'platform', 'architecture'
                )
              )
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.payloadSha256'), '') <> 'text'
              OR length(json_extract(NEW.runtime_manifest_json, '$.payloadSha256')) <> 64
              OR json_extract(NEW.runtime_manifest_json, '$.payloadSha256') GLOB '*[^0-9a-f]*'
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.signatureAlgorithm'), '') <> 'text'
              OR json_extract(NEW.runtime_manifest_json, '$.signatureAlgorithm') <> 'ed25519'
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.signerKeyId'), '') <> 'text'
              OR length(json_extract(NEW.runtime_manifest_json, '$.signerKeyId')) NOT BETWEEN 1 AND 256
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.signatureBase64Url'), '') <> 'text'
              OR length(json_extract(NEW.runtime_manifest_json, '$.signatureBase64Url')) <> 86
              OR json_extract(NEW.runtime_manifest_json, '$.signatureBase64Url') GLOB '*[^A-Za-z0-9_-]*'
              OR substr(json_extract(NEW.runtime_manifest_json, '$.signatureBase64Url'), -1, 1) NOT IN ('A', 'Q', 'g', 'w')
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.payload.installedTreeFileCount'), '') <> 'integer'
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.payload.schemaVersion'), '') <> 'text'
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.payload.protocolVersion'), '') <> 'text'
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.payload.platform'), '') <> 'text'
              OR COALESCE(json_type(NEW.runtime_manifest_json, '$.payload.architecture'), '') <> 'text'
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.runtime_manifest_json, '$.payload') payload
                WHERE payload.key IN (
                  'bundleSha256', 'dependencyLockSha256', 'vendorTreeSha256',
                  'launcherSha256', 'installedTreeManifestSha256'
                ) AND (
                  payload.type <> 'text' OR length(payload.value) <> 64 OR payload.value GLOB '*[^0-9a-f]*'
                )
              )
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+0 days') IS NULL
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+0 days') <> NEW.created_at
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at, '+0 days') IS NULL
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at, '+0 days') <> NEW.expires_at
              OR ABS(
                (CAST(strftime('%s', NEW.created_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER)) * 1000
                + CAST(substr(NEW.created_at, 21, 3) AS INTEGER)
                - CAST(substr(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 21, 3) AS INTEGER)
              ) > 1000
              OR NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              OR NEW.target_worker_generation <> 1 + COALESCE((
                SELECT MAX(generation.worker_generation) FROM remote_worker_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.worker_id = NEW.worker_id
              ), 0)
              OR (
                NEW.target_worker_generation > 1 AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_generation_controls control
                  WHERE control.registry_workspace_id = NEW.registry_workspace_id
                    AND control.worker_id = NEW.worker_id
                    AND control.worker_generation = NEW.target_worker_generation - 1
                    AND control.action = 'revoke'
                )
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_bootstrap_requests active
                WHERE active.registry_workspace_id = NEW.registry_workspace_id
                  AND active.worker_id = NEW.worker_id
                  AND active.target_worker_generation = NEW.target_worker_generation
                  AND active.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND NOT EXISTS (
                    SELECT 1 FROM remote_worker_generations consumed
                    WHERE consumed.registry_workspace_id = active.registry_workspace_id
                      AND consumed.bootstrap_id = active.bootstrap_id
                  )
              )
              OR (
                NEW.target_worker_generation > 1 AND EXISTS (
                  SELECT 1 FROM remote_worker_generations prior
                  WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                    AND prior.worker_id = NEW.worker_id
                    AND prior.worker_generation = NEW.target_worker_generation - 1
                    AND prior.node_id <> NEW.node_id
                )
              )
            BEGIN SELECT RAISE(ABORT, 'remote worker bootstrap invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_allowed_workspace_insert_guard
            BEFORE INSERT ON remote_worker_bootstrap_allowed_workspaces
            WHEN
              NOT EXISTS (
                SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
                WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
                  AND bootstrap.bootstrap_id = NEW.bootstrap_id
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.bootstrap_id = NEW.bootstrap_id
              )
              OR (
                SELECT COUNT(*) FROM remote_worker_bootstrap_allowed_workspaces current
                WHERE current.registry_workspace_id = NEW.registry_workspace_id
                  AND current.bootstrap_id = NEW.bootstrap_id
              ) >= 16
              OR (
                NEW.allowed_workspace_id <> NEW.registry_workspace_id AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_bootstrap_allowed_workspaces registry_scope
                  WHERE registry_scope.registry_workspace_id = NEW.registry_workspace_id
                    AND registry_scope.bootstrap_id = NEW.bootstrap_id
                    AND registry_scope.allowed_workspace_id = NEW.registry_workspace_id
                )
              )
            BEGIN SELECT RAISE(ABORT, 'remote worker bootstrap workspace ceiling invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_capability_class_insert_guard
            BEFORE INSERT ON remote_worker_bootstrap_capability_classes
            WHEN
              NOT EXISTS (
                SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
                WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
                  AND bootstrap.bootstrap_id = NEW.bootstrap_id
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.bootstrap_id = NEW.bootstrap_id
              )
              OR (
                SELECT COUNT(*) FROM remote_worker_bootstrap_capability_classes current
                WHERE current.registry_workspace_id = NEW.registry_workspace_id
                  AND current.bootstrap_id = NEW.bootstrap_id
              ) >= 9
            BEGIN SELECT RAISE(ABORT, 'remote worker bootstrap capability ceiling invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_generation_insert_guard
            BEFORE INSERT ON remote_worker_generations
            WHEN
              strftime('%Y-%m-%dT%H:%M:%fZ', NEW.admitted_at, '+0 days') IS NULL
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.admitted_at, '+0 days') <> NEW.admitted_at
              OR ABS(
                (CAST(strftime('%s', NEW.admitted_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER)) * 1000
                + CAST(substr(NEW.admitted_at, 21, 3) AS INTEGER)
                - CAST(substr(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 21, 3) AS INTEGER)
              ) > 1000
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_bootstrap_requests bootstrap
                WHERE bootstrap.registry_workspace_id = NEW.registry_workspace_id
                  AND bootstrap.bootstrap_id = NEW.bootstrap_id
                  AND bootstrap.worker_id = NEW.worker_id
                  AND bootstrap.node_id = NEW.node_id
                  AND bootstrap.target_worker_generation = NEW.worker_generation
                  AND bootstrap.runtime_manifest_sha256 = NEW.runtime_manifest_sha256
                  AND bootstrap.workspace_ceiling_sha256 = NEW.workspace_ceiling_sha256
                  AND bootstrap.capability_ceiling_sha256 = NEW.capability_ceiling_sha256
                  AND bootstrap.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND bootstrap.allowed_workspace_count = (
                    SELECT COUNT(*) FROM remote_worker_bootstrap_allowed_workspaces scope
                    WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                      AND scope.bootstrap_id = bootstrap.bootstrap_id
                  )
                  AND EXISTS (
                    SELECT 1 FROM remote_worker_bootstrap_allowed_workspaces registry_scope
                    WHERE registry_scope.registry_workspace_id = bootstrap.registry_workspace_id
                      AND registry_scope.bootstrap_id = bootstrap.bootstrap_id
                      AND registry_scope.allowed_workspace_id = bootstrap.registry_workspace_id
                  )
                  AND bootstrap.capability_class_count = (
                    SELECT COUNT(*) FROM remote_worker_bootstrap_capability_classes scope
                    WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                      AND scope.bootstrap_id = bootstrap.bootstrap_id
                  )
              )
              OR NEW.worker_generation <> 1 + COALESCE((
                SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                WHERE current.registry_workspace_id = NEW.registry_workspace_id
                  AND current.worker_id = NEW.worker_id
              ), 0)
              OR (
                NEW.worker_generation > 1 AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_generation_controls control
                  WHERE control.registry_workspace_id = NEW.registry_workspace_id
                    AND control.worker_id = NEW.worker_id
                    AND control.worker_generation = NEW.worker_generation - 1
                    AND control.action = 'revoke'
                )
              )
              OR (
                NEW.worker_generation > 1 AND EXISTS (
                  SELECT 1 FROM remote_worker_generations prior
                  WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                    AND prior.worker_id = NEW.worker_id
                    AND prior.worker_generation = NEW.worker_generation - 1
                    AND (
                      prior.public_key_spki_sha256 = NEW.public_key_spki_sha256
                      OR prior.client_certificate_sha256 = NEW.client_certificate_sha256
                      OR prior.installed_tree_attestation_sha256 = NEW.installed_tree_attestation_sha256
                    )
                )
              )
            BEGIN SELECT RAISE(ABORT, 'remote worker generation invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_credential_insert_guard
            BEFORE INSERT ON remote_worker_runtime_credentials
            WHEN
              strftime('%Y-%m-%dT%H:%M:%fZ', NEW.issued_at, '+0 days') IS NULL
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.issued_at, '+0 days') <> NEW.issued_at
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at, '+0 days') IS NULL
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.expires_at, '+0 days') <> NEW.expires_at
              OR ABS(
                (CAST(strftime('%s', NEW.issued_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER)) * 1000
                + CAST(substr(NEW.issued_at, 21, 3) AS INTEGER)
                - CAST(substr(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 21, 3) AS INTEGER)
              ) > 1000
              OR NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              OR json(NEW.claims_json) <> NEW.claims_json
              OR COALESCE(json_type(NEW.claims_json, '$'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(NEW.claims_json)) <> 11
              OR (SELECT COUNT(DISTINCT claim.key) FROM json_each(NEW.claims_json) claim) <> 11
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.claims_json) claim
                WHERE claim.key NOT IN (
                  'schemaVersion', 'protocolVersion', 'purpose', 'routeAccessClass',
                  'registryWorkspaceId', 'workerId', 'workerGeneration', 'allowedWorkspaceIds',
                  'workspaceCeilingSha256', 'capabilityClasses', 'capabilityCeilingSha256'
                )
              )
              OR json_type(NEW.claims_json, '$.schemaVersion') <> 'text'
              OR json_extract(NEW.claims_json, '$.schemaVersion') <> 'goatcitadel.remote-worker-runtime-credential-claims.v1'
              OR json_type(NEW.claims_json, '$.protocolVersion') <> 'text'
              OR json_extract(NEW.claims_json, '$.protocolVersion') <> 'goatcitadel.remote-worker.v1'
              OR json_type(NEW.claims_json, '$.purpose') <> 'text'
              OR json_extract(NEW.claims_json, '$.purpose') <> 'worker_runtime'
              OR json_type(NEW.claims_json, '$.routeAccessClass') <> 'text'
              OR json_extract(NEW.claims_json, '$.routeAccessClass') <> 'remote-worker'
              OR json_type(NEW.claims_json, '$.registryWorkspaceId') <> 'text'
              OR json_extract(NEW.claims_json, '$.registryWorkspaceId') <> NEW.registry_workspace_id
              OR json_type(NEW.claims_json, '$.workerId') <> 'text'
              OR json_extract(NEW.claims_json, '$.workerId') <> NEW.worker_id
              OR json_type(NEW.claims_json, '$.workerGeneration') <> 'integer'
              OR json_extract(NEW.claims_json, '$.workerGeneration') <> NEW.worker_generation
              OR json_type(NEW.claims_json, '$.allowedWorkspaceIds') <> 'array'
              OR json_array_length(NEW.claims_json, '$.allowedWorkspaceIds') <> (
                SELECT COUNT(DISTINCT value) FROM json_each(NEW.claims_json, '$.allowedWorkspaceIds')
              )
              OR json_type(NEW.claims_json, '$.workspaceCeilingSha256') <> 'text'
              OR length(json_extract(NEW.claims_json, '$.workspaceCeilingSha256')) <> 64
              OR json_extract(NEW.claims_json, '$.workspaceCeilingSha256') GLOB '*[^0-9a-f]*'
              OR json_type(NEW.claims_json, '$.capabilityClasses') <> 'array'
              OR json_array_length(NEW.claims_json, '$.capabilityClasses') <> (
                SELECT COUNT(DISTINCT value) FROM json_each(NEW.claims_json, '$.capabilityClasses')
              )
              OR json_type(NEW.claims_json, '$.capabilityCeilingSha256') <> 'text'
              OR length(json_extract(NEW.claims_json, '$.capabilityCeilingSha256')) <> 64
              OR json_extract(NEW.claims_json, '$.capabilityCeilingSha256') GLOB '*[^0-9a-f]*'
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.worker_id = NEW.worker_id
                  AND generation.worker_generation = NEW.worker_generation
                  AND generation.workspace_ceiling_sha256 = json_extract(NEW.claims_json, '$.workspaceCeilingSha256')
                  AND generation.capability_ceiling_sha256 = json_extract(NEW.claims_json, '$.capabilityCeilingSha256')
                  AND generation.worker_generation = (
                    SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                    WHERE current.registry_workspace_id = generation.registry_workspace_id
                      AND current.worker_id = generation.worker_id
                  )
              )
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_generations generation
                JOIN remote_worker_bootstrap_requests bootstrap
                  ON bootstrap.registry_workspace_id = generation.registry_workspace_id
                 AND bootstrap.bootstrap_id = generation.bootstrap_id
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.worker_id = NEW.worker_id
                  AND generation.worker_generation = NEW.worker_generation
                  AND json_array_length(NEW.claims_json, '$.allowedWorkspaceIds') = bootstrap.allowed_workspace_count
                  AND json_array_length(NEW.claims_json, '$.capabilityClasses') = bootstrap.capability_class_count
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(NEW.claims_json, '$.allowedWorkspaceIds') claim_workspace
                    WHERE claim_workspace.type <> 'text' OR NOT EXISTS (
                      SELECT 1 FROM remote_worker_bootstrap_allowed_workspaces scope
                      WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                        AND scope.bootstrap_id = bootstrap.bootstrap_id
                        AND scope.allowed_workspace_id = claim_workspace.value
                    )
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(NEW.claims_json, '$.capabilityClasses') claim_capability
                    WHERE claim_capability.type <> 'text' OR NOT EXISTS (
                      SELECT 1 FROM remote_worker_bootstrap_capability_classes scope
                      WHERE scope.registry_workspace_id = bootstrap.registry_workspace_id
                        AND scope.bootstrap_id = bootstrap.bootstrap_id
                        AND scope.capability_class = claim_capability.value
                    )
                  )
              )
              OR (
                NEW.credential_generation = 1 AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_generations generation
                  WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                    AND generation.worker_id = NEW.worker_id
                    AND generation.worker_generation = NEW.worker_generation
                    AND generation.exchange_idempotency_key = NEW.idempotency_key
                    AND generation.exchange_request_sha256 = NEW.request_sha256
                    AND generation.transport_verification_receipt_sha256 = NEW.transport_verification_receipt_sha256
                    AND generation.proof_of_possession_receipt_sha256 = NEW.proof_of_possession_receipt_sha256
                )
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_generation_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id
                  AND control.worker_id = NEW.worker_id
                  AND control.worker_generation = NEW.worker_generation
              )
              OR NEW.credential_generation <> 1 + COALESCE((
                SELECT MAX(current.credential_generation) FROM remote_worker_runtime_credentials current
                WHERE current.registry_workspace_id = NEW.registry_workspace_id
                  AND current.worker_id = NEW.worker_id
                  AND current.worker_generation = NEW.worker_generation
              ), 0)
              OR (
                NEW.credential_generation > 1 AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_runtime_credentials prior
                  WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                    AND prior.worker_id = NEW.worker_id
                    AND prior.worker_generation = NEW.worker_generation
                    AND prior.credential_generation = NEW.credential_generation - 1
                    AND prior.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    AND prior.claims_json = NEW.claims_json
                    AND prior.claims_sha256 = NEW.claims_sha256
                    AND prior.transport_verification_receipt_sha256 <> NEW.transport_verification_receipt_sha256
                    AND prior.proof_of_possession_receipt_sha256 <> NEW.proof_of_possession_receipt_sha256
                )
              )
            BEGIN SELECT RAISE(ABORT, 'remote worker runtime credential invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_control_insert_guard
            BEFORE INSERT ON remote_worker_generation_controls
            WHEN
              strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+0 days') IS NULL
              OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '+0 days') <> NEW.created_at
              OR ABS(
                (CAST(strftime('%s', NEW.created_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER)) * 1000
                + CAST(substr(NEW.created_at, 21, 3) AS INTEGER)
                - CAST(substr(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 21, 3) AS INTEGER)
              ) > 1000
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.worker_id = NEW.worker_id
                  AND generation.worker_generation = NEW.worker_generation
                  AND generation.worker_generation = (
                    SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                    WHERE current.registry_workspace_id = generation.registry_workspace_id
                      AND current.worker_id = generation.worker_id
                  )
              )
              OR (
                NEW.control_revision = 1 AND EXISTS (
                  SELECT 1 FROM remote_worker_generation_controls prior
                  WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                    AND prior.worker_id = NEW.worker_id
                    AND prior.worker_generation = NEW.worker_generation
                )
              )
              OR (
                NEW.control_revision = 2 AND (
                  NEW.action <> 'revoke'
                  OR NOT EXISTS (
                    SELECT 1 FROM remote_worker_generation_controls prior
                    WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                      AND prior.worker_id = NEW.worker_id
                      AND prior.worker_generation = NEW.worker_generation
                      AND prior.control_revision = 1
                      AND prior.action = 'quarantine'
                  )
                )
              )
              OR NEW.control_revision NOT IN (1, 2)
            BEGIN SELECT RAISE(ABORT, 'remote worker generation control invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_bootstraps_no_update BEFORE UPDATE ON remote_worker_bootstrap_requests BEGIN SELECT RAISE(ABORT, 'remote worker bootstraps are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_bootstraps_no_delete BEFORE DELETE ON remote_worker_bootstrap_requests BEGIN SELECT RAISE(ABORT, 'remote worker bootstraps are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_allowed_workspaces_no_update BEFORE UPDATE ON remote_worker_bootstrap_allowed_workspaces BEGIN SELECT RAISE(ABORT, 'remote worker workspace ceilings are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_allowed_workspaces_no_delete BEFORE DELETE ON remote_worker_bootstrap_allowed_workspaces BEGIN SELECT RAISE(ABORT, 'remote worker workspace ceilings are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_capability_classes_no_update BEFORE UPDATE ON remote_worker_bootstrap_capability_classes BEGIN SELECT RAISE(ABORT, 'remote worker capability ceilings are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_capability_classes_no_delete BEFORE DELETE ON remote_worker_bootstrap_capability_classes BEGIN SELECT RAISE(ABORT, 'remote worker capability ceilings are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_generations_no_update BEFORE UPDATE ON remote_worker_generations BEGIN SELECT RAISE(ABORT, 'remote worker generations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_generations_no_delete BEFORE DELETE ON remote_worker_generations BEGIN SELECT RAISE(ABORT, 'remote worker generations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_credentials_no_update BEFORE UPDATE ON remote_worker_runtime_credentials BEGIN SELECT RAISE(ABORT, 'remote worker credentials are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_credentials_no_delete BEFORE DELETE ON remote_worker_runtime_credentials BEGIN SELECT RAISE(ABORT, 'remote worker credentials are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_controls_no_update BEFORE UPDATE ON remote_worker_generation_controls BEGIN SELECT RAISE(ABORT, 'remote worker controls are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_controls_no_delete BEFORE DELETE ON remote_worker_generation_controls BEGIN SELECT RAISE(ABORT, 'remote worker controls are immutable'); END;
          `);
        },
      },
      {
        version: 171,
        name: "remote_worker_assignment_foundation",
        up: (db) => {
          if (
            !tableExists(db, "workspaces") ||
            !tableExists(db, "durable_runs") ||
            !tableExists(db, "tasks") ||
            !tableExists(db, "chat_session_meta") ||
            !tableExists(db, "chat_turn_traces") ||
            !tableExists(db, "remote_worker_generations") ||
            !tableExists(db, "mesh_capability_node_admissions")
          ) {
            return;
          }
          db.exec(`
            CREATE TABLE IF NOT EXISTS remote_worker_assignments (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
              execution_workspace_id TEXT NOT NULL CHECK(length(execution_workspace_id) BETWEEN 1 AND 256),
              durable_run_id TEXT NOT NULL CHECK(length(durable_run_id) BETWEEN 1 AND 256),
              task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 256),
              session_id TEXT CHECK(session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
              turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
              manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB)) <= 32768),
              manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_by_actor_id TEXT NOT NULL CHECK(length(created_by_actor_id) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
              ),
              PRIMARY KEY(registry_workspace_id, assignment_id),
              UNIQUE(registry_workspace_id, idempotency_key),
              FOREIGN KEY(registry_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
              FOREIGN KEY(execution_workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
              FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id) ON DELETE RESTRICT,
              FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE RESTRICT,
              FOREIGN KEY(session_id) REFERENCES chat_session_meta(session_id) ON DELETE RESTRICT,
              FOREIGN KEY(turn_id) REFERENCES chat_turn_traces(turn_id) ON DELETE RESTRICT,
              CHECK((session_id IS NULL) = (turn_id IS NULL)),
              CHECK(json_extract(manifest_json, '$.schemaVersion') = 'goatcitadel.remote-worker-assignment-manifest.v1'),
              CHECK(json_extract(manifest_json, '$.protocolVersion') = 'goatcitadel.remote-worker.v1'),
              CHECK(json_extract(manifest_json, '$.registryWorkspaceId') = registry_workspace_id),
              CHECK(json_extract(manifest_json, '$.executionWorkspaceId') = execution_workspace_id),
              CHECK(json_extract(manifest_json, '$.durableRunId') = durable_run_id),
              CHECK(json_extract(manifest_json, '$.taskId') = task_id),
              CHECK(json_extract(manifest_json, '$.sessionId') IS session_id),
              CHECK(json_extract(manifest_json, '$.turnId') IS turn_id),
              CHECK(json_extract(manifest_json, '$.leaseTtlSeconds') BETWEEN 1 AND 900),
              CHECK(json_extract(manifest_json, '$.maxEventCount') BETWEEN 1 AND 10000),
              CHECK(json_extract(manifest_json, '$.maxEventBytes') BETWEEN 1 AND 65536),
              CHECK(json_extract(manifest_json, '$.eventLowWatermark') BETWEEN 0 AND 9999),
              CHECK(json_extract(manifest_json, '$.eventHighWatermark') BETWEEN 1 AND 10000),
              CHECK(json_extract(manifest_json, '$.eventLowWatermark') < json_extract(manifest_json, '$.eventHighWatermark')),
              CHECK(json_extract(manifest_json, '$.eventHighWatermark') <= json_extract(manifest_json, '$.maxEventCount')),
              CHECK(json_extract(manifest_json, '$.maxOutputBytes') BETWEEN 1 AND 8388608),
              CHECK(json_extract(manifest_json, '$.maxArtifactBytes') BETWEEN 1 AND 67108864)
            );

            CREATE TABLE IF NOT EXISTS remote_worker_assignment_generations (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
              assignment_generation INTEGER NOT NULL CHECK(typeof(assignment_generation) = 'integer' AND assignment_generation > 0),
              execution_workspace_id TEXT NOT NULL CHECK(length(execution_workspace_id) BETWEEN 1 AND 256),
              worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 256),
              worker_generation INTEGER NOT NULL CHECK(typeof(worker_generation) = 'integer' AND worker_generation > 0),
              node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 256),
              node_admission_generation INTEGER NOT NULL CHECK(typeof(node_admission_generation) = 'integer' AND node_admission_generation > 0),
              runtime_manifest_sha256 TEXT NOT NULL CHECK(length(runtime_manifest_sha256) = 64 AND runtime_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
              workspace_ceiling_sha256 TEXT NOT NULL CHECK(length(workspace_ceiling_sha256) = 64 AND workspace_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'),
              capability_ceiling_sha256 TEXT NOT NULL CHECK(length(capability_ceiling_sha256) = 64 AND capability_ceiling_sha256 NOT GLOB '*[^0-9a-f]*'),
              dispatch_owner_id TEXT NOT NULL CHECK(length(dispatch_owner_id) BETWEEN 1 AND 256),
              durable_run_attempt INTEGER NOT NULL CHECK(typeof(durable_run_attempt) = 'integer' AND durable_run_attempt > 0),
              dispatch_authority_json TEXT NOT NULL CHECK(json_valid(dispatch_authority_json) AND length(CAST(dispatch_authority_json AS BLOB)) <= 8192),
              dispatch_authority_sha256 TEXT NOT NULL CHECK(length(dispatch_authority_sha256) = 64 AND dispatch_authority_sha256 NOT GLOB '*[^0-9a-f]*'),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              started_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+0 days') = started_at
              ),
              PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation),
              UNIQUE(registry_workspace_id, idempotency_key),
              FOREIGN KEY(registry_workspace_id, assignment_id)
                REFERENCES remote_worker_assignments(registry_workspace_id, assignment_id) ON DELETE RESTRICT,
              FOREIGN KEY(registry_workspace_id, worker_id, worker_generation)
                REFERENCES remote_worker_generations(registry_workspace_id, worker_id, worker_generation) ON DELETE RESTRICT,
              FOREIGN KEY(execution_workspace_id, node_id, node_admission_generation)
                REFERENCES mesh_capability_node_admissions(workspace_id, node_id, admission_generation) ON DELETE RESTRICT,
              CHECK(json_extract(dispatch_authority_json, '$.schemaVersion') = 'goatcitadel.remote-worker-assignment-dispatch-authority.v1'),
              CHECK(json_extract(dispatch_authority_json, '$.dispatchOwnerId') = dispatch_owner_id),
              CHECK(json_extract(dispatch_authority_json, '$.durableRunAttempt') = durable_run_attempt)
            );

            CREATE TABLE IF NOT EXISTS remote_worker_assignment_leases (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
              assignment_generation INTEGER NOT NULL CHECK(typeof(assignment_generation) = 'integer' AND assignment_generation > 0),
              lease_revision INTEGER NOT NULL CHECK(typeof(lease_revision) = 'integer' AND lease_revision > 0),
              lease_token_sha256 TEXT NOT NULL UNIQUE CHECK(length(lease_token_sha256) = 64 AND lease_token_sha256 NOT GLOB '*[^0-9a-f]*'),
              worker_sent_through INTEGER NOT NULL CHECK(typeof(worker_sent_through) = 'integer' AND worker_sent_through BETWEEN 0 AND 10000),
              server_acknowledged_through INTEGER NOT NULL CHECK(typeof(server_acknowledged_through) = 'integer' AND server_acknowledged_through BETWEEN 0 AND 10000),
              parent_dispatch_authority_json TEXT NOT NULL CHECK(json_valid(parent_dispatch_authority_json) AND length(CAST(parent_dispatch_authority_json AS BLOB)) <= 8192),
              parent_dispatch_authority_sha256 TEXT NOT NULL CHECK(length(parent_dispatch_authority_sha256) = 64 AND parent_dispatch_authority_sha256 NOT GLOB '*[^0-9a-f]*'),
              heartbeat_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', heartbeat_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', heartbeat_at, '+0 days') = heartbeat_at
              ),
              expires_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') = expires_at
              ),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, lease_revision),
              UNIQUE(registry_workspace_id, idempotency_key),
              FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
                REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
              CHECK(server_acknowledged_through <= worker_sent_through),
              CHECK(json_extract(parent_dispatch_authority_json, '$.schemaVersion') = 'goatcitadel.remote-worker-assignment-dispatch-authority.v1')
            );

            CREATE TABLE IF NOT EXISTS remote_worker_assignment_controls (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
              assignment_generation INTEGER NOT NULL CHECK(typeof(assignment_generation) = 'integer' AND assignment_generation > 0),
              control_revision INTEGER NOT NULL CHECK(typeof(control_revision) = 'integer' AND control_revision > 0),
              action TEXT NOT NULL CHECK(action IN ('cancel_requested', 'generation_abandoned', 'recovery_exhausted')),
              expected_lease_revision INTEGER NOT NULL CHECK(typeof(expected_lease_revision) = 'integer' AND expected_lease_revision > 0),
              reason_code TEXT NOT NULL CHECK(
                length(reason_code) BETWEEN 1 AND 128
                AND reason_code NOT GLOB '*[^a-z0-9._-]*'
                AND substr(reason_code, 1, 1) GLOB '[a-z0-9]'
                AND substr(reason_code, -1, 1) GLOB '[a-z0-9]'
              ),
              reason_sha256 TEXT NOT NULL CHECK(length(reason_sha256) = 64 AND reason_sha256 NOT GLOB '*[^0-9a-f]*'),
              actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              created_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
              ),
              PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, control_revision),
              UNIQUE(registry_workspace_id, idempotency_key),
              UNIQUE(registry_workspace_id, assignment_id, assignment_generation, action),
              FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
                REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT
            );

            CREATE TABLE IF NOT EXISTS remote_worker_assignment_events (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
              assignment_generation INTEGER NOT NULL CHECK(typeof(assignment_generation) = 'integer' AND assignment_generation > 0),
              sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence BETWEEN 1 AND 10000),
              event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 256),
              event_type TEXT NOT NULL CHECK(event_type IN (
                'status', 'tool_progress', 'model_progress', 'approval_wait',
                'diagnostic', 'transcript_delta', 'terminal_output'
              )),
              payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536),
              payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
              previous_event_sha256 TEXT NOT NULL CHECK(length(previous_event_sha256) = 64 AND previous_event_sha256 NOT GLOB '*[^0-9a-f]*'),
              event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'),
              worker_sent_through INTEGER NOT NULL CHECK(typeof(worker_sent_through) = 'integer' AND worker_sent_through BETWEEN sequence AND 10000),
              received_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', received_at, '+0 days') = received_at
              ),
              PRIMARY KEY(registry_workspace_id, assignment_id, assignment_generation, sequence),
              UNIQUE(registry_workspace_id, event_id),
              UNIQUE(registry_workspace_id, event_sha256),
              FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
                REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
              CHECK(json_extract(payload_json, '$.schemaVersion') = 'goatcitadel.remote-worker-assignment-event.v1')
            );

            CREATE TABLE IF NOT EXISTS remote_worker_assignment_settlements (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
              assignment_generation INTEGER NOT NULL CHECK(typeof(assignment_generation) = 'integer' AND assignment_generation > 0),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.remote-worker-assignment-settlement.v1'),
              outcome TEXT NOT NULL CHECK(outcome IN ('completed', 'failed', 'cancelled')),
              origin TEXT NOT NULL CHECK(origin IN ('worker', 'gateway_recovery')),
              gateway_actor_id TEXT CHECK(gateway_actor_id IS NULL OR length(gateway_actor_id) BETWEEN 1 AND 256),
              recovery_evidence_sha256 TEXT CHECK(recovery_evidence_sha256 IS NULL OR (length(recovery_evidence_sha256) = 64 AND recovery_evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
              final_event_sequence INTEGER NOT NULL CHECK(typeof(final_event_sequence) = 'integer' AND final_event_sequence BETWEEN 0 AND 10000),
              final_event_sha256 TEXT NOT NULL CHECK(length(final_event_sha256) = 64 AND final_event_sha256 NOT GLOB '*[^0-9a-f]*'),
              result_sha256 TEXT CHECK(result_sha256 IS NULL OR (length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*')),
              output_manifest_sha256 TEXT CHECK(output_manifest_sha256 IS NULL OR (length(output_manifest_sha256) = 64 AND output_manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
              failure_sha256 TEXT CHECK(failure_sha256 IS NULL OR (length(failure_sha256) = 64 AND failure_sha256 NOT GLOB '*[^0-9a-f]*')),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              settled_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', settled_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', settled_at, '+0 days') = settled_at
              ),
              PRIMARY KEY(registry_workspace_id, assignment_id),
              UNIQUE(registry_workspace_id, idempotency_key),
              FOREIGN KEY(registry_workspace_id, assignment_id, assignment_generation)
                REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
              CHECK(
                (outcome = 'completed' AND result_sha256 IS NOT NULL AND output_manifest_sha256 IS NOT NULL AND failure_sha256 IS NULL)
                OR (outcome = 'failed' AND result_sha256 IS NULL AND output_manifest_sha256 IS NULL AND failure_sha256 IS NOT NULL)
                OR (outcome = 'cancelled' AND result_sha256 IS NULL AND output_manifest_sha256 IS NULL AND failure_sha256 IS NULL)
              ),
              CHECK(
                (origin = 'worker' AND gateway_actor_id IS NULL AND recovery_evidence_sha256 IS NULL)
                OR (origin = 'gateway_recovery' AND gateway_actor_id IS NOT NULL AND recovery_evidence_sha256 IS NOT NULL)
              )
            );

            CREATE TABLE IF NOT EXISTS remote_worker_assignment_materializations (
              registry_workspace_id TEXT NOT NULL CHECK(length(registry_workspace_id) BETWEEN 1 AND 256),
              assignment_id TEXT NOT NULL CHECK(length(assignment_id) BETWEEN 1 AND 256),
              materialization_id TEXT NOT NULL CHECK(length(materialization_id) BETWEEN 1 AND 256),
              schema_version TEXT NOT NULL CHECK(schema_version = 'goatcitadel.remote-worker-assignment-materialization.v1'),
              source_kind TEXT NOT NULL CHECK(source_kind IN ('event', 'settlement')),
              source_generation INTEGER NOT NULL CHECK(typeof(source_generation) = 'integer' AND source_generation > 0),
              source_sequence INTEGER CHECK(source_sequence IS NULL OR (typeof(source_sequence) = 'integer' AND source_sequence BETWEEN 1 AND 10000)),
              source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
              target_kind TEXT NOT NULL CHECK(target_kind IN ('chat_transcript', 'durable_run_result')),
              target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 256),
              target_sha256 TEXT NOT NULL CHECK(length(target_sha256) = 64 AND target_sha256 NOT GLOB '*[^0-9a-f]*'),
              target_owner_session_id TEXT CHECK(target_owner_session_id IS NULL OR length(target_owner_session_id) BETWEEN 1 AND 256),
              target_owner_turn_id TEXT CHECK(target_owner_turn_id IS NULL OR length(target_owner_turn_id) BETWEEN 1 AND 256),
              target_owner_durable_run_id TEXT CHECK(target_owner_durable_run_id IS NULL OR length(target_owner_durable_run_id) BETWEEN 1 AND 256),
              receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
              gateway_actor_id TEXT NOT NULL CHECK(length(gateway_actor_id) BETWEEN 1 AND 256),
              idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
              request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
              materialized_at TEXT NOT NULL CHECK(
                strftime('%Y-%m-%dT%H:%M:%fZ', materialized_at, '+0 days') IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', materialized_at, '+0 days') = materialized_at
              ),
              PRIMARY KEY(registry_workspace_id, assignment_id, materialization_id),
              UNIQUE(registry_workspace_id, idempotency_key),
              UNIQUE(registry_workspace_id, assignment_id, source_kind, source_generation, source_sequence, target_kind),
              FOREIGN KEY(registry_workspace_id, assignment_id)
                REFERENCES remote_worker_assignments(registry_workspace_id, assignment_id) ON DELETE RESTRICT,
              FOREIGN KEY(registry_workspace_id, assignment_id, source_generation)
                REFERENCES remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation) ON DELETE RESTRICT,
              CHECK(
                (source_kind = 'event' AND source_sequence IS NOT NULL AND target_kind = 'chat_transcript'
                  AND target_owner_session_id IS NOT NULL AND target_owner_turn_id IS NOT NULL
                  AND target_owner_durable_run_id IS NULL)
                OR (source_kind = 'settlement' AND source_sequence IS NULL AND target_kind = 'durable_run_result'
                  AND target_owner_session_id IS NULL AND target_owner_turn_id IS NULL
                  AND target_owner_durable_run_id IS NOT NULL)
              )
            );

            CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_generations_current
              ON remote_worker_assignment_generations(registry_workspace_id, assignment_id, assignment_generation DESC);
            CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_leases_current
              ON remote_worker_assignment_leases(registry_workspace_id, assignment_id, assignment_generation, lease_revision DESC);
            CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_events_chain
              ON remote_worker_assignment_events(registry_workspace_id, assignment_id, assignment_generation, sequence);
            CREATE INDEX IF NOT EXISTS idx_remote_worker_assignment_materializations_source
              ON remote_worker_assignment_materializations(registry_workspace_id, assignment_id, source_kind, source_generation, source_sequence);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_worker_assignment_materializations_event_once
              ON remote_worker_assignment_materializations(
                registry_workspace_id, assignment_id, source_generation, source_sequence, target_kind
              ) WHERE source_kind = 'event';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_worker_assignment_materializations_settlement_once
              ON remote_worker_assignment_materializations(
                registry_workspace_id, assignment_id, source_generation, target_kind
              ) WHERE source_kind = 'settlement';

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignments_insert_guard
            BEFORE INSERT ON remote_worker_assignments
            WHEN
              json(NEW.manifest_json) <> NEW.manifest_json
              OR COALESCE(json_type(NEW.manifest_json, '$'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(NEW.manifest_json)) <>
                CASE WHEN NEW.session_id IS NULL THEN 20 ELSE 22 END
              OR (SELECT COUNT(*) FROM json_each(NEW.manifest_json)) <>
                (SELECT COUNT(DISTINCT field.key) FROM json_each(NEW.manifest_json) field)
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.manifest_json) field
                WHERE field.key NOT IN (
                  'schemaVersion', 'protocolVersion', 'registryWorkspaceId', 'executionWorkspaceId',
                  'durableRunId', 'taskId', 'sessionId', 'turnId', 'capabilityProfileSha256',
                  'contextSnapshotSha256', 'toolEffectPostureSha256', 'pathJailSha256',
                  'parentContextSha256', 'requiredCapabilityClasses', 'deadlineAt', 'leaseTtlSeconds',
                  'maxEventCount', 'maxEventBytes', 'eventLowWatermark', 'eventHighWatermark',
                  'maxOutputBytes', 'maxArtifactBytes'
                )
              )
              OR (
                NEW.session_id IS NULL
                AND (json_type(NEW.manifest_json, '$.sessionId') IS NOT NULL
                  OR json_type(NEW.manifest_json, '$.turnId') IS NOT NULL)
              )
              OR (
                NEW.session_id IS NOT NULL
                AND (COALESCE(json_type(NEW.manifest_json, '$.sessionId'), '') <> 'text'
                  OR COALESCE(json_type(NEW.manifest_json, '$.turnId'), '') <> 'text')
              )
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.manifest_json) field
                WHERE (
                  field.key IN (
                    'schemaVersion', 'protocolVersion', 'registryWorkspaceId', 'executionWorkspaceId',
                    'durableRunId', 'taskId', 'sessionId', 'turnId', 'capabilityProfileSha256',
                    'contextSnapshotSha256', 'toolEffectPostureSha256', 'pathJailSha256',
                    'parentContextSha256', 'deadlineAt'
                  )
                  AND field.type <> 'text'
                ) OR (
                  field.key IN (
                    'leaseTtlSeconds', 'maxEventCount', 'maxEventBytes', 'eventLowWatermark',
                    'eventHighWatermark', 'maxOutputBytes', 'maxArtifactBytes'
                  )
                  AND field.type <> 'integer'
                )
              )
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.manifest_json) field
                WHERE field.key IN (
                  'capabilityProfileSha256', 'contextSnapshotSha256', 'toolEffectPostureSha256',
                  'pathJailSha256', 'parentContextSha256'
                ) AND (
                  length(field.value) <> 64 OR field.value GLOB '*[^0-9a-f]*'
                )
              )
              OR COALESCE(json_type(NEW.manifest_json, '$.requiredCapabilityClasses'), '') <> 'array'
              OR json_array_length(json_extract(NEW.manifest_json, '$.requiredCapabilityClasses')) NOT BETWEEN 1 AND 9
              OR NOT EXISTS (
                SELECT 1 FROM json_each(NEW.manifest_json, '$.requiredCapabilityClasses') capability
                WHERE capability.value = 'durable_compute'
              )
              OR EXISTS (
                SELECT 1 FROM json_each(NEW.manifest_json, '$.requiredCapabilityClasses') capability
                WHERE capability.type <> 'text' OR capability.value NOT IN (
                  'durable_compute', 'gateway_inference', 'governed_tool', 'governed_code',
                  'artifact_stage', 'trusted_verification', 'device_camera', 'device_location', 'device_notification'
                )
              )
              OR json_array_length(json_extract(NEW.manifest_json, '$.requiredCapabilityClasses')) <> (
                SELECT COUNT(DISTINCT capability.value)
                FROM json_each(NEW.manifest_json, '$.requiredCapabilityClasses') capability
              )
              OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(NEW.manifest_json, '$.deadlineAt'), '+0 days') IS NULL
              OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(NEW.manifest_json, '$.deadlineAt'), '+0 days')
                <> json_extract(NEW.manifest_json, '$.deadlineAt')
              OR json_extract(NEW.manifest_json, '$.deadlineAt') <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              OR COALESCE(json_type(NEW.manifest_json, '$.parentContextSha256'), '') <> 'text'
              OR length(json_extract(NEW.manifest_json, '$.parentContextSha256')) <> 64
              OR json_extract(NEW.manifest_json, '$.parentContextSha256') GLOB '*[^0-9a-f]*'
              OR NOT EXISTS (
                SELECT 1 FROM tasks task
                WHERE task.task_id = NEW.task_id AND task.workspace_id = NEW.execution_workspace_id
                  AND task.deleted_at IS NULL
              )
              OR (NEW.session_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM chat_session_meta session
                JOIN chat_turn_traces turn ON turn.turn_id = NEW.turn_id AND turn.session_id = session.session_id
                WHERE session.session_id = NEW.session_id AND session.workspace_id = NEW.execution_workspace_id
              ))
              OR NOT EXISTS (
                SELECT 1 FROM durable_runs run
                WHERE run.run_id = NEW.durable_run_id
                  AND json_valid(run.metadata_json)
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContextSha256')
                    = json_extract(NEW.manifest_json, '$.parentContextSha256')
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.schemaVersion')
                    = 'goatcitadel.remote-worker-assignment-parent-context.v1'
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.executionWorkspaceId')
                    = NEW.execution_workspace_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.durableRunId')
                    = NEW.durable_run_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.taskId') = NEW.task_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.sessionId') IS NEW.session_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.turnId') IS NEW.turn_id
              )
              OR abs((julianday(NEW.created_at) - julianday('now')) * 86400.0) > 1.0
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment manifest or database-clock invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_generation_insert_guard
            BEFORE INSERT ON remote_worker_assignment_generations
            WHEN
              NEW.assignment_generation <> 1 + COALESCE((
                SELECT MAX(prior.assignment_generation) FROM remote_worker_assignment_generations prior
                WHERE prior.registry_workspace_id = NEW.registry_workspace_id AND prior.assignment_id = NEW.assignment_id
              ), 0)
              OR (NEW.assignment_generation > 1 AND NOT EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
                  AND control.assignment_generation = NEW.assignment_generation - 1
                  AND control.action = 'generation_abandoned'
              ))
              OR (NEW.assignment_generation > 1 AND EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls cancelled
                WHERE cancelled.registry_workspace_id = NEW.registry_workspace_id
                  AND cancelled.assignment_id = NEW.assignment_id
                  AND cancelled.assignment_generation = NEW.assignment_generation - 1
                  AND cancelled.action = 'cancel_requested'
              ))
              OR EXISTS (
                SELECT 1 FROM remote_worker_assignment_settlements settlement
                WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
              )
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_assignments assignment
                JOIN durable_runs run ON run.run_id = assignment.durable_run_id
                JOIN remote_worker_generations worker
                  ON worker.registry_workspace_id = NEW.registry_workspace_id AND worker.worker_id = NEW.worker_id
                 AND worker.worker_generation = NEW.worker_generation AND worker.node_id = NEW.node_id
                JOIN remote_worker_bootstrap_requests bootstrap
                  ON bootstrap.registry_workspace_id = worker.registry_workspace_id AND bootstrap.bootstrap_id = worker.bootstrap_id
                JOIN remote_worker_bootstrap_allowed_workspaces scope
                  ON scope.registry_workspace_id = bootstrap.registry_workspace_id AND scope.bootstrap_id = bootstrap.bootstrap_id
                 AND scope.allowed_workspace_id = assignment.execution_workspace_id
                JOIN mesh_capability_node_admissions admission
                  ON admission.workspace_id = assignment.execution_workspace_id AND admission.node_id = NEW.node_id
                 AND admission.admission_generation = NEW.node_admission_generation
                WHERE assignment.registry_workspace_id = NEW.registry_workspace_id
                  AND assignment.assignment_id = NEW.assignment_id
                  AND assignment.execution_workspace_id = NEW.execution_workspace_id
                  AND worker.runtime_manifest_sha256 = NEW.runtime_manifest_sha256
                  AND worker.workspace_ceiling_sha256 = NEW.workspace_ceiling_sha256
                  AND worker.capability_ceiling_sha256 = NEW.capability_ceiling_sha256
                  AND worker.worker_generation = (
                    SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                    WHERE current.registry_workspace_id = worker.registry_workspace_id AND current.worker_id = worker.worker_id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM remote_worker_generation_controls worker_control
                    WHERE worker_control.registry_workspace_id = worker.registry_workspace_id
                      AND worker_control.worker_id = worker.worker_id
                      AND worker_control.worker_generation = worker.worker_generation
                  )
                  AND admission.admission_generation = (
                    SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                    WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                    WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                      AND revoked.admission_generation = admission.admission_generation
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(assignment.manifest_json, '$.requiredCapabilityClasses') required
                    WHERE NOT EXISTS (
                      SELECT 1 FROM remote_worker_bootstrap_capability_classes granted
                      WHERE granted.registry_workspace_id = bootstrap.registry_workspace_id
                        AND granted.bootstrap_id = bootstrap.bootstrap_id AND granted.capability_class = required.value
                    )
                  )
                  AND EXISTS (
                    SELECT 1 FROM tasks task
                    WHERE task.task_id = assignment.task_id
                      AND task.workspace_id = assignment.execution_workspace_id
                      AND task.deleted_at IS NULL
                  )
                  AND (
                    (assignment.session_id IS NULL AND assignment.turn_id IS NULL)
                    OR EXISTS (
                      SELECT 1 FROM chat_session_meta session
                      JOIN chat_turn_traces turn ON turn.session_id = session.session_id
                      WHERE session.session_id = assignment.session_id
                        AND session.workspace_id = assignment.execution_workspace_id
                        AND turn.turn_id = assignment.turn_id
                    )
                  )
                  AND json_valid(run.metadata_json)
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContextSha256')
                    = json_extract(assignment.manifest_json, '$.parentContextSha256')
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.executionWorkspaceId')
                    = assignment.execution_workspace_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.durableRunId')
                    = assignment.durable_run_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.taskId') = assignment.task_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.sessionId') IS assignment.session_id
                  AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.turnId') IS assignment.turn_id
                  AND (SELECT COUNT(*) FROM json_each(run.metadata_json, '$.remoteWorkerAssignmentParentContext'))
                    = CASE WHEN assignment.session_id IS NULL THEN 4 ELSE 6 END
                  AND run.status = 'running' AND run.attempt_count = NEW.durable_run_attempt
                  AND run.lease_owner_id = NEW.dispatch_owner_id
                  AND run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND json_extract(NEW.dispatch_authority_json, '$.durableRunId') = run.run_id
                  AND json_extract(NEW.dispatch_authority_json, '$.durableRunVersion') = run.version
                  AND json_extract(NEW.dispatch_authority_json, '$.durableRunLeaseExpiresAt') = run.lease_expires_at
              )
              OR json(NEW.dispatch_authority_json) <> NEW.dispatch_authority_json
              OR abs((julianday(NEW.started_at) - julianday('now')) * 86400.0) > 1.0
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment generation lacks current dispatch, worker, or node authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_lease_insert_guard
            BEFORE INSERT ON remote_worker_assignment_leases
            WHEN
              NEW.lease_revision <> 1 + COALESCE((
                SELECT MAX(prior.lease_revision) FROM remote_worker_assignment_leases prior
                WHERE prior.registry_workspace_id = NEW.registry_workspace_id AND prior.assignment_id = NEW.assignment_id
                  AND prior.assignment_generation = NEW.assignment_generation
              ), 0)
              OR NEW.server_acknowledged_through <> COALESCE((
                SELECT MAX(event.sequence) FROM remote_worker_assignment_events event
                WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
                  AND event.assignment_generation = NEW.assignment_generation
              ), 0)
              OR NEW.worker_sent_through < NEW.server_acknowledged_through
              OR NEW.worker_sent_through < COALESCE((
                SELECT MAX(committed.worker_sent_through) FROM (
                  SELECT prior.worker_sent_through FROM remote_worker_assignment_leases prior
                  WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                    AND prior.assignment_id = NEW.assignment_id
                    AND prior.assignment_generation = NEW.assignment_generation
                  UNION ALL
                  SELECT event.worker_sent_through FROM remote_worker_assignment_events event
                  WHERE event.registry_workspace_id = NEW.registry_workspace_id
                    AND event.assignment_id = NEW.assignment_id
                    AND event.assignment_generation = NEW.assignment_generation
                ) committed
              ), 0)
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_assignment_generations generation
                JOIN remote_worker_assignments assignment
                  ON assignment.registry_workspace_id = generation.registry_workspace_id
                 AND assignment.assignment_id = generation.assignment_id
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.assignment_id = NEW.assignment_id
                  AND generation.assignment_generation = NEW.assignment_generation
                  AND generation.assignment_generation = (
                    SELECT MAX(current.assignment_generation) FROM remote_worker_assignment_generations current
                    WHERE current.registry_workspace_id = generation.registry_workspace_id
                      AND current.assignment_id = generation.assignment_id
                  )
                  AND NEW.worker_sent_through <= json_extract(assignment.manifest_json, '$.maxEventCount')
                  AND NEW.expires_at <= json_extract(assignment.manifest_json, '$.deadlineAt')
                  AND (julianday(NEW.expires_at) - julianday(NEW.heartbeat_at)) * 86400.0
                    BETWEEN 0.999 AND json_extract(assignment.manifest_json, '$.leaseTtlSeconds') + 0.001
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_assignment_settlements settlement
                WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
                  AND control.assignment_generation = NEW.assignment_generation
                  AND control.action IN ('cancel_requested', 'generation_abandoned', 'recovery_exhausted')
              )
              OR NEW.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              OR abs((julianday(NEW.heartbeat_at) - julianday('now')) * 86400.0) > 1.0
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment lease revision or database-clock invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_control_insert_guard
            BEFORE INSERT ON remote_worker_assignment_controls
            WHEN
              NEW.control_revision <> 1 + COALESCE((
                SELECT MAX(prior.control_revision) FROM remote_worker_assignment_controls prior
                WHERE prior.registry_workspace_id = NEW.registry_workspace_id AND prior.assignment_id = NEW.assignment_id
                  AND prior.assignment_generation = NEW.assignment_generation
              ), 0)
              OR NEW.control_revision <> 1
              OR NEW.assignment_generation <> COALESCE((
                SELECT MAX(generation.assignment_generation) FROM remote_worker_assignment_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.assignment_id = NEW.assignment_id
              ), 0)
              OR NEW.expected_lease_revision <> COALESCE((
                SELECT MAX(lease.lease_revision) FROM remote_worker_assignment_leases lease
                WHERE lease.registry_workspace_id = NEW.registry_workspace_id AND lease.assignment_id = NEW.assignment_id
                  AND lease.assignment_generation = NEW.assignment_generation
              ), 0)
              OR (NEW.action IN ('generation_abandoned', 'recovery_exhausted') AND EXISTS (
                SELECT 1 FROM remote_worker_assignment_leases lease
                WHERE lease.registry_workspace_id = NEW.registry_workspace_id AND lease.assignment_id = NEW.assignment_id
                  AND lease.assignment_generation = NEW.assignment_generation
                  AND lease.lease_revision = NEW.expected_lease_revision
                  AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              ))
              OR EXISTS (
                SELECT 1 FROM remote_worker_assignment_settlements settlement
                WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
              )
              OR abs((julianday(NEW.created_at) - julianday('now')) * 86400.0) > 1.0
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment control revision or recovery invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_event_insert_guard
            BEFORE INSERT ON remote_worker_assignment_events
            WHEN
              NEW.sequence <> 1 + COALESCE((
                SELECT MAX(prior.sequence) FROM remote_worker_assignment_events prior
                WHERE prior.registry_workspace_id = NEW.registry_workspace_id AND prior.assignment_id = NEW.assignment_id
                  AND prior.assignment_generation = NEW.assignment_generation
              ), 0)
              OR NEW.previous_event_sha256 <> COALESCE((
                SELECT prior.event_sha256 FROM remote_worker_assignment_events prior
                WHERE prior.registry_workspace_id = NEW.registry_workspace_id AND prior.assignment_id = NEW.assignment_id
                  AND prior.assignment_generation = NEW.assignment_generation AND prior.sequence = NEW.sequence - 1
              ), '0000000000000000000000000000000000000000000000000000000000000000')
              OR NEW.worker_sent_through < COALESCE((
                SELECT MAX(committed.worker_sent_through) FROM (
                  SELECT lease.worker_sent_through FROM remote_worker_assignment_leases lease
                  WHERE lease.registry_workspace_id = NEW.registry_workspace_id
                    AND lease.assignment_id = NEW.assignment_id
                    AND lease.assignment_generation = NEW.assignment_generation
                  UNION ALL
                  SELECT prior.worker_sent_through FROM remote_worker_assignment_events prior
                  WHERE prior.registry_workspace_id = NEW.registry_workspace_id
                    AND prior.assignment_id = NEW.assignment_id
                    AND prior.assignment_generation = NEW.assignment_generation
                ) committed
              ), 0)
              OR json(NEW.payload_json) <> NEW.payload_json
              OR COALESCE(json_type(NEW.payload_json, '$'), '') <> 'object'
              OR (SELECT COUNT(*) FROM json_each(NEW.payload_json)) <>
                (SELECT COUNT(DISTINCT field.key) FROM json_each(NEW.payload_json) field)
              OR COALESCE(json_type(NEW.payload_json, '$.schemaVersion'), '') <> 'text'
              OR json_extract(NEW.payload_json, '$.schemaVersion') <>
                'goatcitadel.remote-worker-assignment-event.v1'
              OR CASE NEW.event_type
                WHEN 'status' THEN (
                  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 3
                  AND COALESCE(json_type(NEW.payload_json, '$.phase'), '') = 'text'
                  AND json_extract(NEW.payload_json, '$.phase') IN ('accepted', 'running', 'waiting', 'finishing')
                  AND COALESCE(json_type(NEW.payload_json, '$.statusSha256'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.statusSha256')) = 64
                  AND json_extract(NEW.payload_json, '$.statusSha256') NOT GLOB '*[^0-9a-f]*'
                )
                WHEN 'tool_progress' THEN (
                  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) BETWEEN 4 AND 6
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(NEW.payload_json) field
                    WHERE field.key NOT IN (
                      'schemaVersion', 'toolRunId', 'phase', 'toolNameSha256', 'argsSha256', 'resultSha256'
                    )
                  )
                  AND COALESCE(json_type(NEW.payload_json, '$.toolRunId'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.toolRunId')) BETWEEN 1 AND 256
                  AND COALESCE(json_type(NEW.payload_json, '$.phase'), '') = 'text'
                  AND json_extract(NEW.payload_json, '$.phase') IN (
                    'requested', 'running', 'waiting_approval', 'completed', 'failed'
                  )
                  AND COALESCE(json_type(NEW.payload_json, '$.toolNameSha256'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.toolNameSha256')) = 64
                  AND json_extract(NEW.payload_json, '$.toolNameSha256') NOT GLOB '*[^0-9a-f]*'
                  AND (
                    json_type(NEW.payload_json, '$.argsSha256') IS NULL
                    OR (
                      json_type(NEW.payload_json, '$.argsSha256') = 'text'
                      AND length(json_extract(NEW.payload_json, '$.argsSha256')) = 64
                      AND json_extract(NEW.payload_json, '$.argsSha256') NOT GLOB '*[^0-9a-f]*'
                    )
                  )
                  AND (
                    json_type(NEW.payload_json, '$.resultSha256') IS NULL
                    OR (
                      json_type(NEW.payload_json, '$.resultSha256') = 'text'
                      AND length(json_extract(NEW.payload_json, '$.resultSha256')) = 64
                      AND json_extract(NEW.payload_json, '$.resultSha256') NOT GLOB '*[^0-9a-f]*'
                    )
                  )
                )
                WHEN 'model_progress' THEN (
                  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 5
                  AND COALESCE(json_type(NEW.payload_json, '$.inferenceRequestId'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.inferenceRequestId')) BETWEEN 1 AND 256
                  AND COALESCE(json_type(NEW.payload_json, '$.inferenceAttempt'), '') = 'integer'
                  AND json_extract(NEW.payload_json, '$.inferenceAttempt') BETWEEN 1 AND 9007199254740991
                  AND COALESCE(json_type(NEW.payload_json, '$.phase'), '') = 'text'
                  AND json_extract(NEW.payload_json, '$.phase') IN ('requested', 'streaming', 'completed', 'failed')
                  AND COALESCE(json_type(NEW.payload_json, '$.modelIntentSha256'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.modelIntentSha256')) = 64
                  AND json_extract(NEW.payload_json, '$.modelIntentSha256') NOT GLOB '*[^0-9a-f]*'
                )
                WHEN 'approval_wait' THEN (
                  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 4
                  AND COALESCE(json_type(NEW.payload_json, '$.approvalId'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.approvalId')) BETWEEN 1 AND 256
                  AND COALESCE(json_type(NEW.payload_json, '$.approvalKind'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.approvalKind')) BETWEEN 1 AND 128
                  AND json_extract(NEW.payload_json, '$.approvalKind') NOT GLOB '*[^a-z0-9._-]*'
                  AND substr(json_extract(NEW.payload_json, '$.approvalKind'), 1, 1) GLOB '[a-z0-9]'
                  AND substr(json_extract(NEW.payload_json, '$.approvalKind'), -1, 1) GLOB '[a-z0-9]'
                  AND COALESCE(json_type(NEW.payload_json, '$.riskLevelSha256'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.riskLevelSha256')) = 64
                  AND json_extract(NEW.payload_json, '$.riskLevelSha256') NOT GLOB '*[^0-9a-f]*'
                )
                WHEN 'diagnostic' THEN (
                  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 4
                  AND COALESCE(json_type(NEW.payload_json, '$.severity'), '') = 'text'
                  AND json_extract(NEW.payload_json, '$.severity') IN ('info', 'warning', 'error')
                  AND COALESCE(json_type(NEW.payload_json, '$.code'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.code')) BETWEEN 1 AND 128
                  AND json_extract(NEW.payload_json, '$.code') NOT GLOB '*[^a-z0-9._-]*'
                  AND substr(json_extract(NEW.payload_json, '$.code'), 1, 1) GLOB '[a-z0-9]'
                  AND substr(json_extract(NEW.payload_json, '$.code'), -1, 1) GLOB '[a-z0-9]'
                  AND COALESCE(json_type(NEW.payload_json, '$.detailSha256'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.detailSha256')) = 64
                  AND json_extract(NEW.payload_json, '$.detailSha256') NOT GLOB '*[^0-9a-f]*'
                )
                WHEN 'transcript_delta' THEN (
                  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 3
                  AND COALESCE(json_type(NEW.payload_json, '$.role'), '') = 'text'
                  AND json_extract(NEW.payload_json, '$.role') = 'assistant'
                  AND COALESCE(json_type(NEW.payload_json, '$.text'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.text')) BETWEEN 1 AND 16384
                  AND length(CAST(json_extract(NEW.payload_json, '$.text') AS BLOB)) BETWEEN 1 AND 65536
                )
                WHEN 'terminal_output' THEN (
                  (SELECT COUNT(*) FROM json_each(NEW.payload_json)) = 4
                  AND COALESCE(json_type(NEW.payload_json, '$.stream'), '') = 'text'
                  AND json_extract(NEW.payload_json, '$.stream') IN ('stdout', 'stderr')
                  AND COALESCE(json_type(NEW.payload_json, '$.chunkSha256'), '') = 'text'
                  AND length(json_extract(NEW.payload_json, '$.chunkSha256')) = 64
                  AND json_extract(NEW.payload_json, '$.chunkSha256') NOT GLOB '*[^0-9a-f]*'
                  AND COALESCE(json_type(NEW.payload_json, '$.byteLength'), '') = 'integer'
                  AND json_extract(NEW.payload_json, '$.byteLength') BETWEEN 1 AND 65536
                )
                ELSE 0
              END IS NOT 1
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_assignments assignment
                JOIN remote_worker_assignment_generations generation
                  ON generation.registry_workspace_id = assignment.registry_workspace_id
                 AND generation.assignment_id = assignment.assignment_id
                JOIN remote_worker_assignment_leases lease
                  ON lease.registry_workspace_id = generation.registry_workspace_id
                 AND lease.assignment_id = generation.assignment_id
                 AND lease.assignment_generation = generation.assignment_generation
                WHERE assignment.registry_workspace_id = NEW.registry_workspace_id
                  AND assignment.assignment_id = NEW.assignment_id
                  AND generation.assignment_generation = NEW.assignment_generation
                  AND generation.assignment_generation = (
                    SELECT MAX(current.assignment_generation) FROM remote_worker_assignment_generations current
                    WHERE current.registry_workspace_id = generation.registry_workspace_id
                      AND current.assignment_id = generation.assignment_id
                  )
                  AND lease.lease_revision = (
                    SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
                    WHERE current.registry_workspace_id = lease.registry_workspace_id
                      AND current.assignment_id = lease.assignment_id
                      AND current.assignment_generation = lease.assignment_generation
                  )
                  AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  AND NEW.sequence <= json_extract(assignment.manifest_json, '$.maxEventCount')
                  AND NEW.worker_sent_through <= json_extract(assignment.manifest_json, '$.maxEventCount')
                  AND COALESCE((
                    SELECT SUM(length(CAST(committed.payload_json AS BLOB)))
                    FROM remote_worker_assignment_events committed
                    WHERE committed.registry_workspace_id = NEW.registry_workspace_id
                      AND committed.assignment_id = NEW.assignment_id
                      AND committed.assignment_generation = NEW.assignment_generation
                  ), 0) + length(CAST(NEW.payload_json AS BLOB))
                    <= json_extract(assignment.manifest_json, '$.maxEventBytes')
                  AND COALESCE((
                    SELECT SUM(CASE
                      WHEN committed.event_type = 'terminal_output'
                        THEN CAST(json_extract(committed.payload_json, '$.byteLength') AS INTEGER)
                      WHEN committed.event_type = 'transcript_delta'
                        THEN length(CAST(json_extract(committed.payload_json, '$.text') AS BLOB))
                      ELSE 0
                    END)
                    FROM remote_worker_assignment_events committed
                    WHERE committed.registry_workspace_id = NEW.registry_workspace_id
                      AND committed.assignment_id = NEW.assignment_id
                      AND committed.assignment_generation = NEW.assignment_generation
                  ), 0) + CASE
                    WHEN NEW.event_type = 'terminal_output'
                      THEN CAST(json_extract(NEW.payload_json, '$.byteLength') AS INTEGER)
                    WHEN NEW.event_type = 'transcript_delta'
                      THEN length(CAST(json_extract(NEW.payload_json, '$.text') AS BLOB))
                    ELSE 0
                  END <= json_extract(assignment.manifest_json, '$.maxOutputBytes')
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
                  AND control.assignment_generation = NEW.assignment_generation
                  AND control.action IN ('cancel_requested', 'generation_abandoned', 'recovery_exhausted')
              )
              OR EXISTS (
                SELECT 1 FROM remote_worker_assignment_settlements settlement
                WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
              )
              OR abs((julianday(NEW.received_at) - julianday('now')) * 86400.0) > 1.0
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment event chain, lease, or ceiling invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_settlement_insert_guard
            BEFORE INSERT ON remote_worker_assignment_settlements
            WHEN
              NEW.assignment_generation <> COALESCE((
                SELECT MAX(generation.assignment_generation) FROM remote_worker_assignment_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id AND generation.assignment_id = NEW.assignment_id
              ), 0)
              OR NEW.final_event_sequence <> COALESCE((
                SELECT MAX(event.sequence) FROM remote_worker_assignment_events event
                WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
                  AND event.assignment_generation = NEW.assignment_generation
              ), 0)
              OR NEW.final_event_sha256 <> COALESCE((
                SELECT event.event_sha256 FROM remote_worker_assignment_events event
                WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
                  AND event.assignment_generation = NEW.assignment_generation AND event.sequence = NEW.final_event_sequence
              ), '0000000000000000000000000000000000000000000000000000000000000000')
              OR (NEW.origin = 'worker' AND NOT EXISTS (
                SELECT 1 FROM remote_worker_assignment_leases lease
                WHERE lease.registry_workspace_id = NEW.registry_workspace_id AND lease.assignment_id = NEW.assignment_id
                  AND lease.assignment_generation = NEW.assignment_generation
                  AND lease.lease_revision = (
                    SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
                    WHERE current.registry_workspace_id = lease.registry_workspace_id
                      AND current.assignment_id = lease.assignment_id
                      AND current.assignment_generation = lease.assignment_generation
                  )
                  AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              ))
              OR (NEW.outcome = 'cancelled' AND NOT EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
                  AND control.assignment_generation = NEW.assignment_generation AND control.action = 'cancel_requested'
              ))
              OR (NEW.outcome IN ('completed', 'failed') AND EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
                  AND control.assignment_generation = NEW.assignment_generation AND control.action = 'cancel_requested'
              ))
              OR (NEW.origin = 'gateway_recovery' AND NOT EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id AND control.assignment_id = NEW.assignment_id
                  AND control.assignment_generation = NEW.assignment_generation
                  AND control.request_sha256 = NEW.recovery_evidence_sha256
                  AND (
                    (NEW.outcome = 'cancelled' AND control.action = 'cancel_requested')
                    OR (NEW.outcome IN ('completed', 'failed') AND control.action IN ('generation_abandoned', 'recovery_exhausted'))
                  )
              ))
              OR abs((julianday(NEW.settled_at) - julianday('now')) * 86400.0) > 1.0
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment settlement winner, chain, or lease invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_materialization_insert_guard
            BEFORE INSERT ON remote_worker_assignment_materializations
            WHEN
              (NEW.source_kind = 'event' AND NOT EXISTS (
                SELECT 1 FROM remote_worker_assignment_events event
                WHERE event.registry_workspace_id = NEW.registry_workspace_id AND event.assignment_id = NEW.assignment_id
                  AND event.assignment_generation = NEW.source_generation AND event.sequence = NEW.source_sequence
                  AND event.event_sha256 = NEW.source_sha256 AND event.event_type = 'transcript_delta'
              ))
              OR (NEW.source_kind = 'settlement' AND NOT EXISTS (
                SELECT 1 FROM remote_worker_assignment_settlements settlement
                WHERE settlement.registry_workspace_id = NEW.registry_workspace_id AND settlement.assignment_id = NEW.assignment_id
                  AND settlement.assignment_generation = NEW.source_generation AND settlement.request_sha256 = NEW.source_sha256
              ))
              OR NEW.source_generation <> COALESCE((
                SELECT MAX(generation.assignment_generation) FROM remote_worker_assignment_generations generation
                WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                  AND generation.assignment_id = NEW.assignment_id
              ), 0)
              OR EXISTS (
                SELECT 1 FROM remote_worker_assignment_controls control
                WHERE control.registry_workspace_id = NEW.registry_workspace_id
                  AND control.assignment_id = NEW.assignment_id
                  AND control.assignment_generation = NEW.source_generation
                  AND control.action IN ('generation_abandoned', 'recovery_exhausted')
              )
              OR NOT EXISTS (
                SELECT 1 FROM remote_worker_assignments assignment
                WHERE assignment.registry_workspace_id = NEW.registry_workspace_id
                  AND assignment.assignment_id = NEW.assignment_id
                  AND (
                    (NEW.source_kind = 'event'
                      AND assignment.session_id = NEW.target_owner_session_id
                      AND assignment.turn_id = NEW.target_owner_turn_id)
                    OR (NEW.source_kind = 'settlement'
                      AND assignment.durable_run_id = NEW.target_owner_durable_run_id)
                  )
              )
              OR abs((julianday(NEW.materialized_at) - julianday('now')) * 86400.0) > 1.0
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment materialization source or database-clock invariant violated'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_leases_live_authority
            BEFORE INSERT ON remote_worker_assignment_leases
            WHEN NOT EXISTS (
              SELECT 1 FROM remote_worker_assignment_generations generation
              JOIN remote_worker_assignments assignment
                ON assignment.registry_workspace_id = generation.registry_workspace_id
               AND assignment.assignment_id = generation.assignment_id
              JOIN remote_worker_generations worker
                ON worker.registry_workspace_id = generation.registry_workspace_id
               AND worker.worker_id = generation.worker_id
               AND worker.worker_generation = generation.worker_generation
              JOIN mesh_capability_node_admissions admission
                ON admission.workspace_id = generation.execution_workspace_id
               AND admission.node_id = generation.node_id
               AND admission.admission_generation = generation.node_admission_generation
              JOIN durable_runs run ON run.run_id = assignment.durable_run_id
              WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                AND generation.assignment_id = NEW.assignment_id
                AND generation.assignment_generation = NEW.assignment_generation
                AND worker.worker_generation = (
                  SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                  WHERE current.registry_workspace_id = worker.registry_workspace_id AND current.worker_id = worker.worker_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_generation_controls controlled
                  WHERE controlled.registry_workspace_id = worker.registry_workspace_id
                    AND controlled.worker_id = worker.worker_id
                    AND controlled.worker_generation = worker.worker_generation
                )
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation
                )
                AND EXISTS (
                  SELECT 1 FROM tasks task
                  WHERE task.task_id = assignment.task_id
                    AND task.workspace_id = assignment.execution_workspace_id
                    AND task.deleted_at IS NULL
                )
                AND (
                  (assignment.session_id IS NULL AND assignment.turn_id IS NULL)
                  OR EXISTS (
                    SELECT 1 FROM chat_session_meta session
                    JOIN chat_turn_traces turn ON turn.session_id = session.session_id
                    WHERE session.session_id = assignment.session_id
                      AND session.workspace_id = assignment.execution_workspace_id
                      AND turn.turn_id = assignment.turn_id
                  )
                )
                AND json_valid(run.metadata_json)
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContextSha256')
                  = json_extract(assignment.manifest_json, '$.parentContextSha256')
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.executionWorkspaceId')
                  = assignment.execution_workspace_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.durableRunId')
                  = assignment.durable_run_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.taskId') = assignment.task_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.sessionId') IS assignment.session_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.turnId') IS assignment.turn_id
                AND (SELECT COUNT(*) FROM json_each(run.metadata_json, '$.remoteWorkerAssignmentParentContext'))
                  = CASE WHEN assignment.session_id IS NULL THEN 4 ELSE 6 END
                AND run.status = 'running'
                AND run.attempt_count = generation.durable_run_attempt
                AND run.lease_owner_id = generation.dispatch_owner_id
                AND json_extract(NEW.parent_dispatch_authority_json, '$.durableRunId') = assignment.durable_run_id
                AND json_extract(NEW.parent_dispatch_authority_json, '$.durableRunAttempt') = generation.durable_run_attempt
                AND json_extract(NEW.parent_dispatch_authority_json, '$.dispatchOwnerId') = generation.dispatch_owner_id
                AND run.version = json_extract(NEW.parent_dispatch_authority_json, '$.durableRunVersion')
                AND run.lease_expires_at = json_extract(NEW.parent_dispatch_authority_json, '$.durableRunLeaseExpiresAt')
                AND NEW.expires_at <= run.lease_expires_at
                AND run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment lease lacks current worker, node, or parent dispatch authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_events_live_authority
            BEFORE INSERT ON remote_worker_assignment_events
            WHEN NOT EXISTS (
              SELECT 1 FROM remote_worker_assignment_generations generation
              JOIN remote_worker_assignments assignment
                ON assignment.registry_workspace_id = generation.registry_workspace_id
               AND assignment.assignment_id = generation.assignment_id
              JOIN remote_worker_generations worker
                ON worker.registry_workspace_id = generation.registry_workspace_id
               AND worker.worker_id = generation.worker_id
               AND worker.worker_generation = generation.worker_generation
              JOIN mesh_capability_node_admissions admission
                ON admission.workspace_id = generation.execution_workspace_id
               AND admission.node_id = generation.node_id
               AND admission.admission_generation = generation.node_admission_generation
              JOIN remote_worker_assignment_leases lease
                ON lease.registry_workspace_id = generation.registry_workspace_id
               AND lease.assignment_id = generation.assignment_id
               AND lease.assignment_generation = generation.assignment_generation
              JOIN durable_runs run ON run.run_id = assignment.durable_run_id
              WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                AND generation.assignment_id = NEW.assignment_id
                AND generation.assignment_generation = NEW.assignment_generation
                AND worker.worker_generation = (
                  SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                  WHERE current.registry_workspace_id = worker.registry_workspace_id AND current.worker_id = worker.worker_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_generation_controls controlled
                  WHERE controlled.registry_workspace_id = worker.registry_workspace_id
                    AND controlled.worker_id = worker.worker_id
                    AND controlled.worker_generation = worker.worker_generation
                )
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
                AND lease.lease_revision = (
                  SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
                  WHERE current.registry_workspace_id = lease.registry_workspace_id
                    AND current.assignment_id = lease.assignment_id
                    AND current.assignment_generation = lease.assignment_generation
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation
                )
                AND EXISTS (
                  SELECT 1 FROM tasks task
                  WHERE task.task_id = assignment.task_id
                    AND task.workspace_id = assignment.execution_workspace_id
                    AND task.deleted_at IS NULL
                )
                AND (
                  (assignment.session_id IS NULL AND assignment.turn_id IS NULL)
                  OR EXISTS (
                    SELECT 1 FROM chat_session_meta session
                    JOIN chat_turn_traces turn ON turn.session_id = session.session_id
                    WHERE session.session_id = assignment.session_id
                      AND session.workspace_id = assignment.execution_workspace_id
                      AND turn.turn_id = assignment.turn_id
                  )
                )
                AND json_valid(run.metadata_json)
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContextSha256')
                  = json_extract(assignment.manifest_json, '$.parentContextSha256')
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.executionWorkspaceId')
                  = assignment.execution_workspace_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.durableRunId')
                  = assignment.durable_run_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.taskId') = assignment.task_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.sessionId') IS assignment.session_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.turnId') IS assignment.turn_id
                AND (SELECT COUNT(*) FROM json_each(run.metadata_json, '$.remoteWorkerAssignmentParentContext'))
                  = CASE WHEN assignment.session_id IS NULL THEN 4 ELSE 6 END
                AND run.status = 'running'
                AND run.attempt_count = generation.durable_run_attempt
                AND run.lease_owner_id = generation.dispatch_owner_id
                AND run.version = json_extract(lease.parent_dispatch_authority_json, '$.durableRunVersion')
                AND run.lease_expires_at = json_extract(lease.parent_dispatch_authority_json, '$.durableRunLeaseExpiresAt')
                AND run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment event lacks current worker, node, or parent dispatch authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_settlements_live_authority
            BEFORE INSERT ON remote_worker_assignment_settlements
            WHEN NEW.origin = 'worker' AND NOT EXISTS (
              SELECT 1 FROM remote_worker_assignment_generations generation
              JOIN remote_worker_assignments assignment
                ON assignment.registry_workspace_id = generation.registry_workspace_id
               AND assignment.assignment_id = generation.assignment_id
              JOIN remote_worker_generations worker
                ON worker.registry_workspace_id = generation.registry_workspace_id
               AND worker.worker_id = generation.worker_id
               AND worker.worker_generation = generation.worker_generation
              JOIN mesh_capability_node_admissions admission
                ON admission.workspace_id = generation.execution_workspace_id
               AND admission.node_id = generation.node_id
               AND admission.admission_generation = generation.node_admission_generation
              JOIN remote_worker_assignment_leases lease
                ON lease.registry_workspace_id = generation.registry_workspace_id
               AND lease.assignment_id = generation.assignment_id
               AND lease.assignment_generation = generation.assignment_generation
              JOIN durable_runs run ON run.run_id = assignment.durable_run_id
              WHERE generation.registry_workspace_id = NEW.registry_workspace_id
                AND generation.assignment_id = NEW.assignment_id
                AND generation.assignment_generation = NEW.assignment_generation
                AND worker.worker_generation = (
                  SELECT MAX(current.worker_generation) FROM remote_worker_generations current
                  WHERE current.registry_workspace_id = worker.registry_workspace_id AND current.worker_id = worker.worker_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM remote_worker_generation_controls controlled
                  WHERE controlled.registry_workspace_id = worker.registry_workspace_id
                    AND controlled.worker_id = worker.worker_id
                    AND controlled.worker_generation = worker.worker_generation
                )
                AND admission.admission_generation = (
                  SELECT MAX(current.admission_generation) FROM mesh_capability_node_admissions current
                  WHERE current.workspace_id = admission.workspace_id AND current.node_id = admission.node_id
                )
                AND lease.lease_revision = (
                  SELECT MAX(current.lease_revision) FROM remote_worker_assignment_leases current
                  WHERE current.registry_workspace_id = lease.registry_workspace_id
                    AND current.assignment_id = lease.assignment_id
                    AND current.assignment_generation = lease.assignment_generation
                )
                AND NOT EXISTS (
                  SELECT 1 FROM mesh_capability_node_admission_revocations revoked
                  WHERE revoked.workspace_id = admission.workspace_id AND revoked.node_id = admission.node_id
                    AND revoked.admission_generation = admission.admission_generation
                )
                AND EXISTS (
                  SELECT 1 FROM tasks task
                  WHERE task.task_id = assignment.task_id
                    AND task.workspace_id = assignment.execution_workspace_id
                    AND task.deleted_at IS NULL
                )
                AND (
                  (assignment.session_id IS NULL AND assignment.turn_id IS NULL)
                  OR EXISTS (
                    SELECT 1 FROM chat_session_meta session
                    JOIN chat_turn_traces turn ON turn.session_id = session.session_id
                    WHERE session.session_id = assignment.session_id
                      AND session.workspace_id = assignment.execution_workspace_id
                      AND turn.turn_id = assignment.turn_id
                  )
                )
                AND json_valid(run.metadata_json)
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContextSha256')
                  = json_extract(assignment.manifest_json, '$.parentContextSha256')
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.executionWorkspaceId')
                  = assignment.execution_workspace_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.durableRunId')
                  = assignment.durable_run_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.taskId') = assignment.task_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.sessionId') IS assignment.session_id
                AND json_extract(run.metadata_json, '$.remoteWorkerAssignmentParentContext.turnId') IS assignment.turn_id
                AND (SELECT COUNT(*) FROM json_each(run.metadata_json, '$.remoteWorkerAssignmentParentContext'))
                  = CASE WHEN assignment.session_id IS NULL THEN 4 ELSE 6 END
                AND run.status = 'running'
                AND run.attempt_count = generation.durable_run_attempt
                AND run.lease_owner_id = generation.dispatch_owner_id
                AND run.version = json_extract(lease.parent_dispatch_authority_json, '$.durableRunVersion')
                AND run.lease_expires_at = json_extract(lease.parent_dispatch_authority_json, '$.durableRunLeaseExpiresAt')
                AND run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            BEGIN SELECT RAISE(ABORT, 'remote worker assignment settlement lacks current worker, node, or parent dispatch authority'); END;

            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignments_no_update BEFORE UPDATE ON remote_worker_assignments BEGIN SELECT RAISE(ABORT, 'remote worker assignments are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignments_no_delete BEFORE DELETE ON remote_worker_assignments BEGIN SELECT RAISE(ABORT, 'remote worker assignments are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_generations_no_update BEFORE UPDATE ON remote_worker_assignment_generations BEGIN SELECT RAISE(ABORT, 'remote worker assignment generations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_generations_no_delete BEFORE DELETE ON remote_worker_assignment_generations BEGIN SELECT RAISE(ABORT, 'remote worker assignment generations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_leases_no_update BEFORE UPDATE ON remote_worker_assignment_leases BEGIN SELECT RAISE(ABORT, 'remote worker assignment leases are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_leases_no_delete BEFORE DELETE ON remote_worker_assignment_leases BEGIN SELECT RAISE(ABORT, 'remote worker assignment leases are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_controls_no_update BEFORE UPDATE ON remote_worker_assignment_controls BEGIN SELECT RAISE(ABORT, 'remote worker assignment controls are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_controls_no_delete BEFORE DELETE ON remote_worker_assignment_controls BEGIN SELECT RAISE(ABORT, 'remote worker assignment controls are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_events_no_update BEFORE UPDATE ON remote_worker_assignment_events BEGIN SELECT RAISE(ABORT, 'remote worker assignment events are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_events_no_delete BEFORE DELETE ON remote_worker_assignment_events BEGIN SELECT RAISE(ABORT, 'remote worker assignment events are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_settlements_no_update BEFORE UPDATE ON remote_worker_assignment_settlements BEGIN SELECT RAISE(ABORT, 'remote worker assignment settlements are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_settlements_no_delete BEFORE DELETE ON remote_worker_assignment_settlements BEGIN SELECT RAISE(ABORT, 'remote worker assignment settlements are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_materializations_no_update BEFORE UPDATE ON remote_worker_assignment_materializations BEGIN SELECT RAISE(ABORT, 'remote worker assignment materializations are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS trg_remote_worker_assignment_materializations_no_delete BEFORE DELETE ON remote_worker_assignment_materializations BEGIN SELECT RAISE(ABORT, 'remote worker assignment materializations are immutable'); END;
          `);
        },
      },
      {
        version: 172,
        name: "session_control_foundation",
        up: (db) => {
          if (!tableExists(db, "chat_session_meta")) {
            return;
          }
          createSessionControlFoundationSchema(db);
        },
      },
      {
        version: 173,
        name: "session_control_lifecycle_and_mutation_admission",
        up: (db) => {
          if (!tableExists(db, "chat_session_meta") || !tableExists(db, "chat_session_control_grants")) {
            throw new Error(
              "SQLite migration 173 requires chat_session_meta and chat_session_control_grants predecessors",
            );
          }
          createSessionControlLifecycleAndAdmissionSchema(db);
        },
      },
      {
        version: 174,
        name: "durable_heartbeat_occurrence_authority",
        up: (db) => {
          if (
            !tableExists(db, "chat_session_mutation_admissions") ||
            !tableExists(db, "chat_turn_mutation_admission_durable_bindings") ||
            !tableExists(db, "session_autonomy_prefs")
          ) {
            throw new Error(
              "SQLite migration 174 requires mutation admission, durable binding, and autonomy preference predecessors",
            );
          }
          createDurableHeartbeatOccurrenceSchema(db);
        },
      },
      {
        version: 175,
        name: "governed_lifecycle_foundation",
        up: (db) => {
          // Repair-only sparse databases (see the HX-407 sparse parity proof)
          // skip additive foundations whose logical parents are absent instead
          // of inventing them; fresh chains always carry the migration-161
          // Journey/approval predecessors before 175 runs.
          if (!tableExists(db, "governance_journey_events") || !tableExists(db, "approvals")) {
            return;
          }
          createGovernedLifecycleSchema(db);
        },
      },
    ],
  },
];

const SCHEMA_MIGRATIONS = createSqliteMigrationRegistry(SCHEMA_MIGRATION_GROUPS);

function createDurableHeartbeatOccurrenceSchema(db: DatabaseSync): void {
  upgradeSessionControlEventsForHeartbeatPreemption(db);
  db.exec(`
    CREATE TABLE chat_heartbeat_occurrences (
      occurrence_id TEXT PRIMARY KEY CHECK(length(occurrence_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      admission_id TEXT NOT NULL UNIQUE CHECK(length(admission_id) BETWEEN 1 AND 256),
      admission_request_sha256 TEXT NOT NULL CHECK(
        length(admission_request_sha256) = 64 AND admission_request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      admission_idempotency_key TEXT NOT NULL CHECK(length(admission_idempotency_key) BETWEEN 1 AND 512),
      admission_correlation_id TEXT NOT NULL CHECK(length(admission_correlation_id) BETWEEN 1 AND 256),
      runtime_owner_id TEXT NOT NULL CHECK(length(runtime_owner_id) BETWEEN 1 AND 256),
      system_actor_id TEXT NOT NULL CHECK(system_actor_id = 'system-heartbeat'),
      admission_material_sha256 TEXT NOT NULL CHECK(
        length(admission_material_sha256) = 64 AND admission_material_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      evaluated_policy_sha256 TEXT NOT NULL CHECK(
        length(evaluated_policy_sha256) = 64 AND evaluated_policy_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      frozen_request_sha256 TEXT NOT NULL CHECK(
        length(frozen_request_sha256) = 64 AND frozen_request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      frozen_objective_sha256 TEXT NOT NULL CHECK(
        length(frozen_objective_sha256) = 64 AND frozen_objective_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      claim_sha256 TEXT NOT NULL UNIQUE CHECK(
        length(claim_sha256) = 64 AND claim_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      aggregate_revision INTEGER NOT NULL CHECK(typeof(aggregate_revision) = 'integer' AND aggregate_revision > 0),
      controller_generation INTEGER NOT NULL CHECK(typeof(controller_generation) = 'integer' AND controller_generation > 0),
      prior_last_proactive_at TEXT CHECK(
        prior_last_proactive_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', prior_last_proactive_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', prior_last_proactive_at, '+0 days') = prior_last_proactive_at
        )
      ),
      prior_last_proactive_run_id TEXT CHECK(
        prior_last_proactive_run_id IS NULL OR length(prior_last_proactive_run_id) BETWEEN 1 AND 256
      ),
      heartbeat_interval_seconds INTEGER NOT NULL CHECK(
        typeof(heartbeat_interval_seconds) = 'integer' AND heartbeat_interval_seconds BETWEEN 900 AND 86400
      ),
      cooldown_seconds INTEGER NOT NULL CHECK(
        typeof(cooldown_seconds) = 'integer' AND cooldown_seconds BETWEEN 0 AND 3600
      ),
      idle_floor_seconds INTEGER NOT NULL CHECK(
        typeof(idle_floor_seconds) = 'integer' AND idle_floor_seconds BETWEEN 0 AND 86400
      ),
      observed_session_activity_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', observed_session_activity_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_session_activity_at, '+0 days') = observed_session_activity_at
      ),
      user_message_id TEXT NOT NULL UNIQUE CHECK(length(user_message_id) BETWEEN 1 AND 256),
      assistant_message_id TEXT NOT NULL UNIQUE CHECK(length(assistant_message_id) BETWEEN 1 AND 256),
      turn_id TEXT NOT NULL UNIQUE CHECK(length(turn_id) BETWEEN 1 AND 256),
      expected_durable_run_id TEXT NOT NULL UNIQUE CHECK(length(expected_durable_run_id) BETWEEN 1 AND 256),
      durable_run_id TEXT UNIQUE CHECK(durable_run_id IS NULL OR length(durable_run_id) BETWEEN 1 AND 256),
      capability_profile_id TEXT UNIQUE CHECK(
        capability_profile_id IS NULL OR length(capability_profile_id) BETWEEN 1 AND 256
      ),
      capability_profile_hash TEXT CHECK(
        capability_profile_hash IS NULL OR (
          length(capability_profile_hash) = 64 AND capability_profile_hash NOT GLOB '*[^0-9a-f]*'
        )
      ),
      state TEXT NOT NULL CHECK(state IN ('admitted', 'durable_bound', 'terminal', 'abandoned')),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0),
      claimed_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+0 days') = claimed_at
      ),
      durable_bound_at TEXT CHECK(
        durable_bound_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', durable_bound_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', durable_bound_at, '+0 days') = durable_bound_at
        )
      ),
      terminal_at TEXT CHECK(
        terminal_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at, '+0 days') = terminal_at
        )
      ),
      abandoned_at TEXT CHECK(
        abandoned_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', abandoned_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', abandoned_at, '+0 days') = abandoned_at
        )
      ),
      terminal_status TEXT CHECK(
        terminal_status IS NULL OR terminal_status IN ('completed', 'failed', 'cancelled')
      ),
      terminal_handoff_sha256 TEXT CHECK(
        terminal_handoff_sha256 IS NULL OR (
          length(terminal_handoff_sha256) = 64 AND terminal_handoff_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      abandonment_reason TEXT CHECK(
        abandonment_reason IS NULL OR abandonment_reason IN ('admission_closed', 'authority_drift', 'lifecycle_drift')
      ),
      updated_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') = updated_at
      ),
      FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(capability_profile_id) REFERENCES chat_turn_capability_profiles(profile_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(admission_material_sha256 = frozen_request_sha256),
      CHECK((prior_last_proactive_at IS NULL) = (prior_last_proactive_run_id IS NULL)),
      CHECK(
        (state = 'admitted' AND durable_bound_at IS NULL AND terminal_at IS NULL AND abandoned_at IS NULL
          AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
          AND durable_run_id IS NULL AND capability_profile_id IS NULL AND capability_profile_hash IS NULL
          AND revision = 1 AND updated_at = claimed_at)
        OR (state = 'durable_bound' AND durable_bound_at IS NOT NULL AND terminal_at IS NULL AND abandoned_at IS NULL
          AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NULL
          AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
          AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
        OR (state = 'terminal' AND durable_bound_at IS NOT NULL AND terminal_at IS NOT NULL AND abandoned_at IS NULL
          AND terminal_status IS NOT NULL AND terminal_handoff_sha256 IS NOT NULL AND abandonment_reason IS NULL
          AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
          AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
        OR (state = 'abandoned' AND terminal_at IS NULL AND abandoned_at IS NOT NULL
          AND terminal_status IS NULL AND terminal_handoff_sha256 IS NULL AND abandonment_reason IS NOT NULL
          AND (
            (durable_bound_at IS NULL AND durable_run_id IS NULL
              AND capability_profile_id IS NULL AND capability_profile_hash IS NULL)
            OR (abandonment_reason = 'authority_drift' AND durable_bound_at IS NOT NULL
              AND durable_run_id IS NOT NULL AND durable_run_id = expected_durable_run_id
              AND capability_profile_id IS NOT NULL AND capability_profile_hash IS NOT NULL)
          ))
      )
    );

    CREATE UNIQUE INDEX idx_chat_heartbeat_occurrences_one_open
      ON chat_heartbeat_occurrences(session_id)
      WHERE state IN ('admitted', 'durable_bound');
    CREATE INDEX idx_chat_heartbeat_occurrences_recovery
      ON chat_heartbeat_occurrences(state, updated_at, occurrence_id);
    CREATE INDEX idx_chat_heartbeat_occurrences_session
      ON chat_heartbeat_occurrences(workspace_id, session_id, claimed_at, occurrence_id);

    CREATE TRIGGER trg_chat_heartbeat_occurrences_insert_guard
    BEFORE INSERT ON chat_heartbeat_occurrences
    WHEN NEW.state <> 'admitted'
      OR NEW.revision <> 1 OR NEW.updated_at <> NEW.claimed_at
      OR NEW.admission_material_sha256 <> NEW.frozen_request_sha256
      OR abs(julianday(NEW.claimed_at) - julianday('now')) * 86400.0 > 1.0
      OR NOT EXISTS (
        SELECT 1 FROM chat_session_mutation_admissions admission
        WHERE admission.admission_id = NEW.admission_id
          AND admission.workspace_id = NEW.workspace_id
          AND admission.session_id = NEW.session_id
          AND admission.session_incarnation_id = NEW.session_incarnation_id
          AND admission.turn_id = NEW.turn_id
          AND admission.runtime_owner_id = NEW.runtime_owner_id
          AND admission.actor_kind = 'system'
          AND admission.actor_id = NEW.system_actor_id
          AND admission.operation = 'chat_system_heartbeat'
          AND admission.material_sha256 = NEW.admission_material_sha256
          AND admission.request_sha256 = NEW.admission_request_sha256
          AND admission.idempotency_key = NEW.admission_idempotency_key
          AND admission.correlation_id = NEW.admission_correlation_id
          AND admission.aggregate_revision = NEW.aggregate_revision
          AND admission.controller_generation = NEW.controller_generation
          AND admission.status = 'active'
      )
      OR NOT EXISTS (
        SELECT 1 FROM session_autonomy_prefs prefs
        WHERE prefs.session_id = NEW.session_id
          AND prefs.last_proactive_at = NEW.claimed_at
          AND prefs.last_proactive_run_id = NEW.occurrence_id
      )
      OR EXISTS (
        SELECT 1 FROM chat_messages message
        WHERE message.message_id IN (NEW.user_message_id, NEW.assistant_message_id)
      )
    BEGIN SELECT RAISE(ABORT, 'heartbeat occurrence admission or cadence invariant violated'); END;

    CREATE TRIGGER trg_chat_heartbeat_occurrences_transition_guard
    BEFORE UPDATE ON chat_heartbeat_occurrences
    WHEN NEW.occurrence_id <> OLD.occurrence_id
      OR NEW.workspace_id <> OLD.workspace_id OR NEW.session_id <> OLD.session_id
      OR NEW.session_incarnation_id <> OLD.session_incarnation_id OR NEW.admission_id <> OLD.admission_id
      OR NEW.admission_request_sha256 <> OLD.admission_request_sha256
      OR NEW.admission_idempotency_key <> OLD.admission_idempotency_key
      OR NEW.admission_correlation_id <> OLD.admission_correlation_id
      OR NEW.runtime_owner_id <> OLD.runtime_owner_id OR NEW.system_actor_id <> OLD.system_actor_id
      OR NEW.admission_material_sha256 <> OLD.admission_material_sha256
      OR NEW.evaluated_policy_sha256 <> OLD.evaluated_policy_sha256
      OR NEW.frozen_request_sha256 <> OLD.frozen_request_sha256
      OR NEW.frozen_objective_sha256 <> OLD.frozen_objective_sha256
      OR NEW.claim_sha256 <> OLD.claim_sha256
      OR NEW.aggregate_revision <> OLD.aggregate_revision
      OR NEW.controller_generation <> OLD.controller_generation
      OR NEW.prior_last_proactive_at IS NOT OLD.prior_last_proactive_at
      OR NEW.prior_last_proactive_run_id IS NOT OLD.prior_last_proactive_run_id
      OR NEW.heartbeat_interval_seconds <> OLD.heartbeat_interval_seconds
      OR NEW.cooldown_seconds <> OLD.cooldown_seconds OR NEW.idle_floor_seconds <> OLD.idle_floor_seconds
      OR NEW.observed_session_activity_at <> OLD.observed_session_activity_at
      OR NEW.user_message_id <> OLD.user_message_id OR NEW.assistant_message_id <> OLD.assistant_message_id
      OR NEW.turn_id <> OLD.turn_id OR NEW.expected_durable_run_id <> OLD.expected_durable_run_id
      OR NEW.claimed_at <> OLD.claimed_at
      OR NEW.revision <> OLD.revision + 1
      OR NEW.updated_at < OLD.updated_at
      OR (
        abs(julianday(NEW.updated_at) - julianday('now')) * 86400.0 > 1.0
        AND NOT (
          NEW.state = 'abandoned' AND NEW.abandoned_at = NEW.updated_at
          AND EXISTS (
            SELECT 1
            FROM chat_session_control_events event_row
            JOIN chat_session_control_grants successor
              ON successor.workspace_id = event_row.workspace_id
              AND successor.session_id = event_row.session_id
              AND successor.generation = event_row.next_generation
            JOIN chat_session_mutation_admissions admission
              ON admission.admission_id = OLD.admission_id
            WHERE substr(event_row.idempotency_key, 1, 18) = 'heartbeat-preempt_'
              /* heartbeat preemption occurrence timestamp evidence */
              AND event_row.reason_code = 'heartbeat_preempted'
              AND event_row.workspace_id = OLD.workspace_id
              AND event_row.session_id = OLD.session_id
              AND event_row.previous_generation = OLD.controller_generation
              AND event_row.next_generation = OLD.controller_generation + 1
              AND event_row.previous_owner_kind = 'operator'
              AND event_row.next_owner_kind = 'operator'
              AND event_row.previous_lease_state = 'operator_active'
              AND event_row.next_lease_state = 'operator_active'
              AND event_row.request_id IS NULL
              AND event_row.actor_kind = 'operator'
              AND event_row.companion_session_id IS NULL
              AND event_row.device_grant_id IS NULL
              AND event_row.created_at = NEW.updated_at
              AND successor.is_current = 1
              AND successor.owner_kind = 'operator'
              AND successor.lease_state = 'operator_active'
              AND successor.transition_idempotency_key = event_row.idempotency_key
              AND successor.transition_request_sha256 = event_row.request_sha256
              AND successor.created_at = event_row.created_at
              AND successor.updated_at = event_row.created_at
              AND admission.status = 'cancelled'
              AND admission.closed_at = event_row.created_at
              AND ((OLD.state = 'admitted'
                AND NEW.abandonment_reason = 'admission_closed'
                AND admission.terminal_authority_kind = 'request_runtime'
                AND admission.terminal_control_event_id IS NULL
                AND admission.terminal_correlation_id = event_row.event_id)
              OR (OLD.state = 'durable_bound'
                AND NEW.abandonment_reason = 'authority_drift'
                AND admission.terminal_authority_kind = 'authority_superseded'
                AND admission.terminal_control_event_id = event_row.event_id))
              AND NOT EXISTS (
                SELECT 1 FROM chat_session_control_requests request_row
                WHERE request_row.workspace_id = event_row.workspace_id
                  AND request_row.session_id = event_row.session_id
                  AND request_row.requested_generation = event_row.previous_generation
                  AND request_row.status = 'pending'
              )
          )
        )
      )
      OR (OLD.state <> 'admitted' AND (
        NEW.durable_run_id IS NOT OLD.durable_run_id
        OR NEW.capability_profile_id IS NOT OLD.capability_profile_id
        OR NEW.capability_profile_hash IS NOT OLD.capability_profile_hash
      ))
      OR (OLD.state = 'admitted' AND NEW.state = 'durable_bound' AND (
        NEW.durable_run_id <> OLD.expected_durable_run_id
        OR NEW.durable_bound_at <> NEW.updated_at
        OR NOT EXISTS (
          SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
          WHERE binding.admission_id = OLD.admission_id AND binding.turn_id = OLD.turn_id
            AND binding.workspace_id = OLD.workspace_id AND binding.session_id = OLD.session_id
            AND binding.session_incarnation_id = OLD.session_incarnation_id
            AND binding.durable_run_id = OLD.expected_durable_run_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM chat_turn_capability_profile_incarnation_bindings profile_binding
          WHERE profile_binding.profile_id = NEW.capability_profile_id
            AND profile_binding.turn_id = OLD.turn_id
            AND profile_binding.profile_hash = NEW.capability_profile_hash
        )
        OR EXISTS (
          SELECT 1 FROM chat_messages message
          WHERE message.message_id IN (OLD.user_message_id, OLD.assistant_message_id)
        )
      ))
      OR (OLD.state = 'durable_bound' AND NEW.state = 'terminal' AND (
        NEW.durable_bound_at IS NOT OLD.durable_bound_at OR NEW.terminal_at <> NEW.updated_at
        OR NOT EXISTS (
          SELECT 1 FROM chat_session_mutation_admissions admission
          JOIN durable_runs run ON run.run_id = OLD.durable_run_id
          WHERE admission.admission_id = OLD.admission_id
            AND admission.status IN ('completed', 'cancelled')
            AND admission.terminal_authority_kind = 'durable_terminal'
            AND admission.terminal_durable_run_id = OLD.durable_run_id
            AND admission.terminal_durable_run_status = NEW.terminal_status
            AND run.status = NEW.terminal_status
        )
      ))
      OR (OLD.state = 'admitted' AND NEW.state = 'abandoned' AND (
        NEW.abandoned_at <> NEW.updated_at
        OR EXISTS (
          SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
          WHERE binding.admission_id = OLD.admission_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM chat_session_mutation_admissions admission
          WHERE admission.admission_id = OLD.admission_id AND admission.status <> 'active'
            AND (
              (NEW.abandonment_reason = 'admission_closed'
                AND admission.terminal_authority_kind IN ('expired_recovery', 'request_runtime'))
              OR (NEW.abandonment_reason = 'authority_drift'
                AND admission.terminal_authority_kind = 'authority_superseded')
              OR (NEW.abandonment_reason = 'lifecycle_drift'
                AND admission.terminal_authority_kind = 'lifecycle_delete')
            )
        )
      ))
      OR (OLD.state = 'durable_bound' AND NEW.state = 'abandoned' AND (
        NEW.abandoned_at <> NEW.updated_at OR NEW.abandonment_reason <> 'authority_drift'
        OR NEW.durable_bound_at IS NOT OLD.durable_bound_at
        OR NOT EXISTS (
          SELECT 1 FROM chat_turn_mutation_admission_durable_bindings binding
          WHERE binding.admission_id = OLD.admission_id AND binding.turn_id = OLD.turn_id
            AND binding.workspace_id = OLD.workspace_id AND binding.session_id = OLD.session_id
            AND binding.session_incarnation_id = OLD.session_incarnation_id
            AND binding.durable_run_id = OLD.durable_run_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM chat_session_mutation_admissions admission
          JOIN durable_runs run ON run.run_id = OLD.durable_run_id
          JOIN chat_session_control_events event_row
            ON event_row.event_id = admission.terminal_control_event_id
          WHERE admission.admission_id = OLD.admission_id
            AND admission.status = 'cancelled'
            AND admission.terminal_authority_kind = 'authority_superseded'
            AND event_row.reason_code = 'heartbeat_preempted'
            AND event_row.workspace_id = OLD.workspace_id AND event_row.session_id = OLD.session_id
            AND event_row.previous_generation = OLD.controller_generation
            AND event_row.next_generation = OLD.controller_generation + 1
            AND event_row.previous_owner_kind = 'operator' AND event_row.next_owner_kind = 'operator'
            AND event_row.previous_lease_state = 'operator_active'
            AND event_row.next_lease_state = 'operator_active'
            AND event_row.actor_kind = 'operator'
            AND run.workflow_key = 'chat.turn.execute' AND run.status = 'cancelled'
            AND run.lease_owner_id IS NULL AND run.lease_expires_at IS NULL
            AND run.lease_heartbeat_at IS NULL AND run.finished_at = NEW.updated_at
        )
      ))
      OR NOT (
        (OLD.state = 'admitted' AND NEW.state IN ('durable_bound', 'abandoned'))
        OR (OLD.state = 'durable_bound' AND NEW.state IN ('terminal', 'abandoned'))
      )
    BEGIN SELECT RAISE(ABORT, 'heartbeat occurrence transition invariant violated'); END;

    CREATE TRIGGER trg_chat_heartbeat_occurrences_terminal_evidence_guard
    BEFORE UPDATE ON chat_heartbeat_occurrences
    WHEN OLD.state = 'durable_bound' AND NEW.state = 'terminal' AND NOT EXISTS (
      SELECT 1
      FROM durable_runs run
      JOIN chat_turn_traces trace ON trace.turn_id = OLD.turn_id
      WHERE run.run_id = OLD.durable_run_id
        AND run.workflow_key = 'chat.turn.execute'
        AND run.status = NEW.terminal_status
        AND run.status IN ('completed', 'failed', 'cancelled')
        AND run.lease_owner_id IS NULL AND run.lease_expires_at IS NULL
        AND json_valid(run.payload_json) AND json_valid(run.metadata_json)
        AND json_type(run.metadata_json, '$') = 'object'
        AND json_type(run.metadata_json, '$.autonomousAdmission') = 'object'
        AND (
          SELECT COUNT(*) FROM json_each(run.metadata_json, '$.autonomousAdmission')
        ) = 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.metadata_json, '$.autonomousAdmission') admission_seal_field
          WHERE admission_seal_field.key NOT IN ('material', 'materialSha256')
        )
        AND json_type(run.metadata_json, '$.autonomousAdmission.material') = 'object'
        AND (
          SELECT COUNT(*) FROM json_each(run.metadata_json, '$.autonomousAdmission.material')
        ) = 8
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.metadata_json, '$.autonomousAdmission.material') autonomous_material_field
          WHERE autonomous_material_field.key NOT IN (
            'version', 'identity', 'sessionId', 'objectiveSha256', 'autonomous',
            'admission', 'capability', 'cronAdmission'
          )
        )
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.version')
          = 'chat.autonomous.admission.v1'
        AND json_extract(run.metadata_json, '$.autonomousAdmission.materialSha256')
          = gc_sha256(gc_canonical_json(json_extract(
            run.metadata_json, '$.autonomousAdmission.material'
          )))
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.identity.userMessageId')
          = json_extract(run.payload_json, '$.userMessageId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.identity.assistantMessageId')
          = json_extract(run.payload_json, '$.assistantMessageId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.identity.turnId') = OLD.turn_id
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.identity.durableRunId') = run.run_id
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.sessionId') = OLD.session_id
        AND json_type(run.metadata_json, '$.objective') = 'text'
        AND json_extract(run.metadata_json, '$.objective') = json_extract(run.payload_json, '$.request.content')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.objectiveSha256')
          = gc_sha256(json_quote(json_extract(run.metadata_json, '$.objective')))
        AND json_type(run.metadata_json, '$.autonomousAdmission.material.autonomous') = 'object'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.metadata_json,
            '$.autonomousAdmission.material.autonomous') autonomous_field
          WHERE autonomous_field.key NOT IN (
            'kind', 'systemActorId', 'sourceRunId', 'reason', 'deliverMode',
            'deliveryChannel', 'profilePosture', 'commitmentId'
          )
        )
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.autonomous.kind') = 'heartbeat'
        AND json_extract(run.metadata_json,
          '$.autonomousAdmission.material.autonomous.systemActorId') = 'system-heartbeat'
        AND json_extract(run.metadata_json,
          '$.autonomousAdmission.material.autonomous.deliverMode') = 'on_notify'
        AND json_type(run.metadata_json,
          '$.autonomousAdmission.material.autonomous.sourceRunId') = 'text'
        AND length(json_extract(run.metadata_json,
          '$.autonomousAdmission.material.autonomous.sourceRunId')) BETWEEN 1 AND 256
        AND json_type(run.metadata_json,
          '$.autonomousAdmission.material.autonomous.reason') = 'text'
        AND length(json_extract(run.metadata_json,
          '$.autonomousAdmission.material.autonomous.reason')) BETWEEN 1 AND 4096
        AND json(json_extract(run.metadata_json, '$.autonomous'))
          = json(json_extract(run.metadata_json, '$.autonomousAdmission.material.autonomous'))
        AND json_extract(run.payload_json, '$.requestActor.actorKind') = 'system'
        AND json_extract(run.payload_json, '$.requestActor.actorId') = 'system-heartbeat'
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.admission.admissionId')
          = json_extract(run.payload_json, '$.admissionId')
        AND json_extract(run.metadata_json,
          '$.autonomousAdmission.material.admission.sessionIncarnationId')
          = json_extract(run.payload_json, '$.sessionIncarnationId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.admission.workspaceId')
          = json_extract(run.payload_json, '$.workspaceId')
        AND json_extract(run.metadata_json,
          '$.autonomousAdmission.material.admission.admissionMaterialSha256')
          = json_extract(run.payload_json, '$.admissionMaterialSha256')
        AND json_extract(run.metadata_json,
          '$.autonomousAdmission.material.admission.effectiveRequestMaterialSha256')
          = json_extract(run.payload_json, '$.effectiveRequestMaterialSha256')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileId')
          = json_extract(run.payload_json, '$.capabilityProfileId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileHash')
          = json_extract(run.payload_json, '$.capabilityProfileHash')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileId')
          = json_extract(run.metadata_json, '$.capabilityProfileId')
        AND json_extract(run.metadata_json, '$.autonomousAdmission.material.capability.profileHash')
          = json_extract(run.metadata_json, '$.capabilityProfileHash')
        AND json_type(run.metadata_json, '$.autonomousAdmission.material.capability.snapshotId') = 'text'
        AND length(json_extract(run.metadata_json,
          '$.autonomousAdmission.material.capability.snapshotId')) BETWEEN 1 AND 256
        AND json_type(run.metadata_json, '$.autonomousAdmission.material.cronAdmission') = 'null'
        AND json_type(run.metadata_json, '$.chatTurnRuntimeAuthority') = 'object'
        AND json_type(run.metadata_json, '$.chatTurnRuntimeAuthority.material') = 'object'
        AND (
          SELECT COUNT(*) FROM json_each(run.metadata_json, '$.chatTurnRuntimeAuthority')
        ) = 2
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.metadata_json, '$.chatTurnRuntimeAuthority') authority_field
          WHERE authority_field.key NOT IN ('material', 'materialSha256')
        )
        AND (
          SELECT COUNT(*) FROM json_each(run.metadata_json, '$.chatTurnRuntimeAuthority.material')
        ) = CASE run.status WHEN 'completed' THEN 14 ELSE 13 END
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.metadata_json, '$.chatTurnRuntimeAuthority.material') material_field
          WHERE material_field.key NOT IN (
            'version', 'runId', 'turnId', 'transitionKind', 'durableStatus', 'traceStatus',
            'transitionAt', 'postCommitGenerationId', 'postCommitEligibility', 'waitForEvent',
            'terminalOutput', 'linkedFinalization', 'requiredFinalizers', 'heartbeatDecisionReceipt'
          )
        )
        AND (
          (run.status = 'completed'
            AND json_type(run.metadata_json,
              '$.chatTurnRuntimeAuthority.material.heartbeatDecisionReceipt') = 'object')
          OR (run.status IN ('failed', 'cancelled')
            AND json_type(run.metadata_json,
              '$.chatTurnRuntimeAuthority.material.heartbeatDecisionReceipt') IS NULL)
        )
        AND json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.materialSha256')
          = gc_sha256(gc_canonical_json(json_extract(
              run.metadata_json, '$.chatTurnRuntimeAuthority.material'
            )))
        AND json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.version')
          = 'chat.turn.runtime-authority.v1'
        AND json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.runId') = run.run_id
        AND json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.turnId') = OLD.turn_id
        AND json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.durableStatus') = run.status
        AND json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.traceStatus') = trace.status
        AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(
              run.metadata_json, '$.chatTurnRuntimeAuthority.material.transitionAt'
            ), '+0 days')
          = json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.transitionAt')
        AND json_type(run.metadata_json,
          '$.chatTurnRuntimeAuthority.material.postCommitEligibility') = 'object'
        AND (
          SELECT COUNT(*) FROM json_each(
            run.metadata_json, '$.chatTurnRuntimeAuthority.material.postCommitEligibility'
          )
        ) = 4
        AND NOT EXISTS (
          SELECT 1 FROM json_each(
            run.metadata_json, '$.chatTurnRuntimeAuthority.material.postCommitEligibility'
          ) eligibility_field
          WHERE eligibility_field.key NOT IN (
            'version', 'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession'
          )
        )
        AND json_extract(run.metadata_json,
          '$.chatTurnRuntimeAuthority.material.postCommitEligibility.version') = 1
        AND json_type(run.metadata_json,
          '$.chatTurnRuntimeAuthority.material.postCommitEligibility.autonomyEnabledAtParentSettlement') = 'false'
        AND json_type(run.metadata_json,
          '$.chatTurnRuntimeAuthority.material.postCommitEligibility.evalIntegrityTurn') = 'false'
        AND json_type(run.metadata_json,
          '$.chatTurnRuntimeAuthority.material.postCommitEligibility.humanSession') = 'false'
        AND json_type(run.metadata_json, '$.chatTurnRuntimeAuthority.material.waitForEvent') = 'null'
        AND json_type(run.metadata_json, '$.waitForEvent') IS NULL
        AND json_type(run.metadata_json, '$.linkedFinalizationPending') IS NULL
        AND json_type(run.metadata_json, '$.autonomousChatPostCommitPending') IS NULL
        AND json_type(run.metadata_json, '$.generalChatPostCommitPending') IS NULL
        AND trace.session_id = OLD.session_id
        AND trace.user_message_id = json_extract(run.payload_json, '$.userMessageId')
        AND trace.assistant_message_id = json_extract(run.payload_json, '$.assistantMessageId')
        AND NOT EXISTS (
          SELECT 1 FROM chat_messages heartbeat_input
          WHERE heartbeat_input.message_id = trace.user_message_id
        )
        AND json_valid(trace.durable_json)
        AND json_extract(trace.durable_json, '$.runId') = run.run_id
        AND json_extract(trace.durable_json, '$.status') = run.status
        AND json_extract(trace.durable_json, '$.checkpointKind') = CASE run.status
          WHEN 'completed' THEN 'run_completed'
          WHEN 'failed' THEN 'run_failed'
          ELSE 'run_cancelled'
        END
        AND (
          (run.status = 'completed' AND trace.status = 'completed')
          OR (run.status IN ('failed', 'cancelled') AND trace.status = run.status)
        )
        AND EXISTS (
          SELECT 1
          FROM durable_checkpoints checkpoint
          WHERE checkpoint.checkpoint_id = (
              SELECT latest.checkpoint_id
              FROM durable_checkpoints latest
              WHERE latest.run_id = run.run_id
                AND latest.checkpoint_kind = CASE run.status
                  WHEN 'completed' THEN 'run_completed'
                  WHEN 'failed' THEN 'run_failed'
                  ELSE 'run_cancelled'
                END
              ORDER BY latest.created_at DESC, latest.checkpoint_id DESC LIMIT 1
            )
            AND json_valid(checkpoint.state_json)
            AND json_type(checkpoint.state_json, '$.chatTurnRuntimeAuthority') = 'object'
            AND json(json_extract(checkpoint.state_json, '$.chatTurnRuntimeAuthority'))
              = json(json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority'))
            AND (
              (run.status = 'completed'
                AND json_type(run.metadata_json, '$.heartbeatDecisionReceipt') = 'object'
                AND json_type(checkpoint.state_json, '$.heartbeatDecisionReceipt') = 'object'
                AND json_type(run.metadata_json, '$.heartbeatDecisionRawOutput') = 'text'
                AND json_type(checkpoint.state_json, '$.heartbeatDecisionRawOutput') = 'text'
                AND json(json_extract(run.metadata_json, '$.heartbeatDecisionReceipt'))
                  = json(json_extract(run.metadata_json,
                    '$.chatTurnRuntimeAuthority.material.heartbeatDecisionReceipt'))
                AND json(json_extract(checkpoint.state_json, '$.heartbeatDecisionReceipt'))
                  = json(json_extract(run.metadata_json, '$.heartbeatDecisionReceipt'))
                AND json_extract(checkpoint.state_json, '$.heartbeatDecisionRawOutput')
                  = json_extract(run.metadata_json, '$.heartbeatDecisionRawOutput')
                AND (
                  SELECT COUNT(*) FROM json_each(run.metadata_json, '$.heartbeatDecisionReceipt')
                ) = 6
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(run.metadata_json, '$.heartbeatDecisionReceipt') receipt_field
                  WHERE receipt_field.key NOT IN (
                    'version', 'occurrenceId', 'claimSha256', 'rawOutputSha256',
                    'notify', 'normalizedMessageSha256'
                  )
                )
                AND json_extract(run.metadata_json, '$.heartbeatDecisionReceipt.version') = 1
                AND json_extract(run.metadata_json, '$.heartbeatDecisionReceipt.occurrenceId') = OLD.occurrence_id
                AND json_extract(run.metadata_json, '$.heartbeatDecisionReceipt.claimSha256') = OLD.claim_sha256
                AND json_extract(run.metadata_json, '$.heartbeatDecisionReceipt.rawOutputSha256')
                  = gc_sha256(json_extract(run.metadata_json, '$.heartbeatDecisionRawOutput'))
                AND json_valid(json_extract(run.metadata_json, '$.heartbeatDecisionRawOutput'))
                AND json_type(json_extract(run.metadata_json, '$.heartbeatDecisionRawOutput'), '$') = 'object'
                AND (
                  (json_type(run.metadata_json, '$.heartbeatDecisionReceipt.notify') = 'false'
                    AND json_type(run.metadata_json,
                      '$.heartbeatDecisionReceipt.normalizedMessageSha256') = 'null'
                    AND (
                      SELECT COUNT(*) FROM json_each(
                        json_extract(run.metadata_json, '$.heartbeatDecisionRawOutput')
                      )
                    ) = 1
                    AND json_type(json_extract(run.metadata_json,
                      '$.heartbeatDecisionRawOutput'), '$.notify') = 'false')
                  OR
                  (json_type(run.metadata_json, '$.heartbeatDecisionReceipt.notify') = 'true'
                    AND json_type(run.metadata_json,
                      '$.heartbeatDecisionReceipt.normalizedMessageSha256') = 'text'
                    AND (
                      SELECT COUNT(*) FROM json_each(
                        json_extract(run.metadata_json, '$.heartbeatDecisionRawOutput')
                      )
                    ) = 2
                    AND NOT EXISTS (
                      SELECT 1 FROM json_each(
                        json_extract(run.metadata_json, '$.heartbeatDecisionRawOutput')
                      ) raw_field
                      WHERE raw_field.key NOT IN ('message', 'notify')
                    )
                    AND json_type(json_extract(run.metadata_json,
                      '$.heartbeatDecisionRawOutput'), '$.notify') = 'true'
                    AND json_type(json_extract(run.metadata_json,
                      '$.heartbeatDecisionRawOutput'), '$.message') = 'text'
                    AND gc_unicode_scalar_length(gc_js_trim(json_extract(json_extract(
                      run.metadata_json, '$.heartbeatDecisionRawOutput'), '$.message'))) BETWEEN 1 AND 4000
                    AND json_extract(run.metadata_json,
                      '$.heartbeatDecisionReceipt.normalizedMessageSha256')
                      = gc_sha256(gc_js_trim(json_extract(json_extract(run.metadata_json,
                        '$.heartbeatDecisionRawOutput'), '$.message'))))
                ))
              OR
              (run.status IN ('failed', 'cancelled')
                AND json_type(run.metadata_json, '$.heartbeatDecisionReceipt') IS NULL
                AND json_type(run.metadata_json, '$.heartbeatDecisionRawOutput') IS NULL
                AND json_type(checkpoint.state_json, '$.heartbeatDecisionReceipt') IS NULL
                AND json_type(checkpoint.state_json, '$.heartbeatDecisionRawOutput') IS NULL)
            )
            AND (
              (run.status = 'completed'
                AND (
                  (json_type(run.metadata_json, '$.heartbeatDecisionReceipt.notify') = 'true'
                    AND json_extract(checkpoint.state_json, '$.assistantMessageId')
                      = json_extract(run.payload_json, '$.assistantMessageId')
                    AND json_extract(checkpoint.state_json, '$.outputText')
                      = json_extract(run.metadata_json, '$.outputText')
                    AND json_extract(checkpoint.state_json, '$.outputSummary')
                      = json_extract(run.metadata_json, '$.outputSummary'))
                  OR
                  (json_type(run.metadata_json, '$.heartbeatDecisionReceipt.notify') = 'false'
                    AND json_type(checkpoint.state_json, '$.assistantMessageId') IS NULL
                    AND json_type(checkpoint.state_json, '$.outputText') IS NULL
                    AND json_type(checkpoint.state_json, '$.outputSummary') IS NULL)
                ))
              OR (run.status IN ('failed', 'cancelled')
                AND json_type(checkpoint.state_json, '$.assistantMessageId') IS NULL
                AND json_type(checkpoint.state_json, '$.outputText') IS NULL
                AND json_type(checkpoint.state_json, '$.outputSummary') IS NULL)
            )
        )
        AND (
          (json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.transitionKind')
              = 'linked_finalization'
            AND run.status = 'failed'
            AND json(json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.requiredFinalizers'))
              = json('["linked","general"]')
            AND json_type(run.metadata_json, '$.chatTurnRuntimeAuthority.material.linkedFinalization') = 'object'
            AND json_type(run.metadata_json, '$.linkedFinalization') = 'object'
            AND json_extract(run.metadata_json, '$.linkedFinalization.finalizationId')
              = json_extract(run.metadata_json,
                '$.chatTurnRuntimeAuthority.material.linkedFinalization.finalizationId')
            AND json_extract(run.metadata_json, '$.linkedFinalization.requestedAt')
              = json_extract(run.metadata_json,
                '$.chatTurnRuntimeAuthority.material.linkedFinalization.requestedAt')
            AND json_extract(run.metadata_json, '$.linkedFinalization.reasonSha256')
              = json_extract(run.metadata_json,
                '$.chatTurnRuntimeAuthority.material.linkedFinalization.reasonSha256')
            AND json_type(run.metadata_json, '$.chatTurnRuntimeAuthority.material.terminalOutput') = 'null'
            AND json_type(run.metadata_json, '$.autonomousChatPostCommit') IS NULL)
          OR
          (json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.transitionKind') = 'terminal'
            AND json_type(run.metadata_json, '$.chatTurnRuntimeAuthority.material.linkedFinalization') = 'null'
            AND json_type(run.metadata_json, '$.linkedFinalization') IS NULL
            AND (
              (run.status = 'completed'
                AND json_type(run.metadata_json, '$.autonomousChatPostCommit') = 'object'
                AND json(json_extract(run.metadata_json,
                  '$.chatTurnRuntimeAuthority.material.requiredFinalizers')) = json('["autonomous","general"]')
                AND json_extract(run.metadata_json, '$.autonomousChatPostCommit.generationId')
                  = json_extract(run.metadata_json,
                    '$.chatTurnRuntimeAuthority.material.postCommitGenerationId')
                AND json_extract(run.metadata_json, '$.autonomousChatPostCommit.requestedAt')
                  = json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.transitionAt')
                AND json_type(run.metadata_json, '$.autonomousChatPostCommit.completedAt') = 'text'
                AND json_type(run.metadata_json, '$.autonomousChatPostCommit.heartbeatCleanup') = 'object'
                AND (
                  SELECT COUNT(*) FROM json_each(
                    run.metadata_json, '$.autonomousChatPostCommit.heartbeatCleanup'
                  )
                ) = 1
                AND json_extract(run.metadata_json,
                  '$.autonomousChatPostCommit.heartbeatCleanup.status') = 'not_required'
                AND (
                  (json_type(run.metadata_json, '$.heartbeatDecisionReceipt.notify') = 'false'
                    AND json_type(run.metadata_json,
                      '$.chatTurnRuntimeAuthority.material.terminalOutput') = 'null'
                    AND json_type(run.metadata_json, '$.outputText') IS NULL
                    AND json_type(run.metadata_json, '$.finalOutput') IS NULL
                    AND json_type(run.metadata_json, '$.outputSummary') IS NULL
                    AND json_type(run.metadata_json, '$.finalSummary') IS NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM chat_messages message
                      WHERE message.message_id = json_extract(run.payload_json, '$.assistantMessageId')
                    ))
                  OR
                  (json_type(run.metadata_json, '$.heartbeatDecisionReceipt.notify') = 'true'
                    AND json_type(run.metadata_json,
                      '$.chatTurnRuntimeAuthority.material.terminalOutput') = 'object'
                    AND (
                      SELECT COUNT(*) FROM json_each(
                        run.metadata_json, '$.chatTurnRuntimeAuthority.material.terminalOutput'
                      )
                    ) = 3
                    AND NOT EXISTS (
                      SELECT 1 FROM json_each(
                        run.metadata_json, '$.chatTurnRuntimeAuthority.material.terminalOutput'
                      ) output_field
                      WHERE output_field.key NOT IN (
                        'assistantMessageId', 'outputTextSha256', 'outputSummarySha256'
                      )
                    )
                    AND json_type(run.metadata_json, '$.outputText') = 'text'
                    AND json_type(run.metadata_json, '$.outputSummary') = 'text'
                    AND json_extract(run.metadata_json, '$.outputText')
                      = gc_js_trim(json_extract(json_extract(run.metadata_json,
                        '$.heartbeatDecisionRawOutput'), '$.message'))
                    AND json_extract(run.metadata_json,
                      '$.chatTurnRuntimeAuthority.material.terminalOutput.assistantMessageId')
                      = json_extract(run.payload_json, '$.assistantMessageId')
                    AND json_extract(run.metadata_json,
                      '$.chatTurnRuntimeAuthority.material.terminalOutput.outputTextSha256')
                      = gc_sha256(json_quote(json_extract(run.metadata_json, '$.outputText')))
                    AND json_extract(run.metadata_json,
                      '$.chatTurnRuntimeAuthority.material.terminalOutput.outputSummarySha256')
                      = gc_sha256(json_quote(json_extract(run.metadata_json, '$.outputSummary')))
                    AND json_extract(run.metadata_json, '$.finalOutput')
                      = json_extract(run.metadata_json, '$.outputText')
                    AND json_extract(run.metadata_json, '$.finalSummary')
                      = json_extract(run.metadata_json, '$.outputSummary')
                    AND EXISTS (
                      SELECT 1 FROM chat_messages message
                      WHERE message.message_id = json_extract(run.payload_json, '$.assistantMessageId')
                        AND message.session_id = OLD.session_id
                        AND message.role = 'assistant' AND message.actor_type = 'system'
                        AND message.actor_id = 'system-heartbeat'
                        AND message.content = json_extract(run.metadata_json, '$.outputText')
                    ))
                ))
              OR
              (run.status IN ('failed', 'cancelled')
                AND json_type(run.metadata_json, '$.chatTurnRuntimeAuthority.material.terminalOutput') = 'null'
                AND json_type(run.metadata_json, '$.outputText') IS NULL
                AND json_type(run.metadata_json, '$.finalOutput') IS NULL
                AND json_type(run.metadata_json, '$.outputSummary') IS NULL
                AND json_type(run.metadata_json, '$.finalSummary') IS NULL
                AND json_type(run.metadata_json, '$.autonomousChatPostCommit') IS NULL
                AND json(json_extract(run.metadata_json,
                  '$.chatTurnRuntimeAuthority.material.requiredFinalizers')) = json('["general"]'))
            ))
        )
        AND json_type(run.metadata_json, '$.generalChatPostCommit') = 'object'
        AND json_extract(run.metadata_json, '$.generalChatPostCommit.generationId')
          = json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.postCommitGenerationId')
        AND json_extract(run.metadata_json, '$.generalChatPostCommit.traceStatus') = trace.status
        AND json_extract(run.metadata_json, '$.generalChatPostCommit.requestedAt')
          = json_extract(run.metadata_json, '$.chatTurnRuntimeAuthority.material.transitionAt')
        AND json(json_extract(run.metadata_json, '$.generalChatPostCommit.postCommitEligibility'))
          = json(json_extract(run.metadata_json,
            '$.chatTurnRuntimeAuthority.material.postCommitEligibility'))
        AND json_extract(run.metadata_json, '$.generalChatPostCommit.parentLocalEffectsStatus') = 'settled'
        AND json_type(run.metadata_json, '$.generalChatPostCommit.parentLocalEffectsSettledAt') = 'text'
        AND json_type(run.metadata_json, '$.generalChatPostCommit.completedEffects') = 'array'
        AND json_type(run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds') = 'object'
        AND json_type(run.metadata_json, '$.generalChatPostCommit.durableEffectOutcomes') = 'object'
        AND json_array_length(run.metadata_json, '$.generalChatPostCommit.completedEffects') = 0
        AND (
          SELECT COUNT(*) FROM json_each(
            run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds'
          )
        ) = 0
        AND (
          SELECT COUNT(*) FROM json_each(
            run.metadata_json, '$.generalChatPostCommit.durableEffectOutcomes'
          )
        ) = 0
        AND json_extract(run.metadata_json, '$.generalChatPostCommit.childOutcomeAuthority')
          = 'child_durable_runs'
        AND json_extract(run.metadata_json, '$.generalChatPostCommit.settlementStatus')
          IN ('completed', 'settled_with_failures')
        AND json_type(run.metadata_json, '$.generalChatPostCommit.completedAt') = 'text'
        AND (
          SELECT COUNT(*) FROM json_each(
            run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds'
          )
        ) = (
          SELECT COUNT(DISTINCT child_id.value) FROM json_each(
            run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds'
          ) child_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds') effect_run
          LEFT JOIN json_each(run.metadata_json, '$.generalChatPostCommit.durableEffectOutcomes') effect_outcome
            ON effect_outcome.key = effect_run.key
          LEFT JOIN durable_runs child_run ON child_run.run_id = effect_run.value
          LEFT JOIN chat_session_mutation_admissions child_admission
            ON child_admission.admission_id = json_extract(child_run.payload_json, '$.childAdmission.admissionId')
          WHERE effect_run.key NOT IN ('background_review', 'commitments', 'memory_maintenance')
            OR effect_run.type <> 'text'
            OR effect_outcome.key IS NULL OR effect_outcome.type <> 'object'
            OR json_extract(effect_outcome.value, '$.runId') <> effect_run.value
            OR child_run.run_id IS NULL OR child_run.workflow_key <> 'chat.post_commit.effect'
            OR child_run.status NOT IN ('completed', 'failed', 'cancelled', 'dead_lettered')
            OR child_run.status <> json_extract(effect_outcome.value, '$.status')
            OR child_run.lease_owner_id IS NOT NULL OR child_run.lease_expires_at IS NOT NULL
            OR json_extract(child_run.payload_json, '$.parentRunId') <> run.run_id
            OR json_extract(child_run.payload_json, '$.postCommitGenerationId')
              <> json_extract(run.metadata_json, '$.generalChatPostCommit.generationId')
            OR json_extract(child_run.payload_json, '$.effect') <> effect_run.key
            OR child_admission.admission_id IS NULL
            OR child_admission.status <> CASE child_run.status
              WHEN 'completed' THEN 'completed' ELSE 'cancelled' END
            OR child_admission.terminal_authority_kind <> 'post_commit_child_stage'
            OR child_admission.terminal_durable_run_id <> child_run.run_id
            OR child_admission.terminal_durable_run_status <> 'running'
            OR child_admission.terminal_durable_lease_owner_id IS NULL
            OR child_admission.terminal_durable_attempt_count IS NULL
            OR child_admission.terminal_durable_run_version IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(run.metadata_json, '$.generalChatPostCommit.durableEffectOutcomes') effect_outcome
          LEFT JOIN json_each(run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds') effect_run
            ON effect_run.key = effect_outcome.key
          WHERE effect_run.key IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM durable_runs omitted_child
          WHERE omitted_child.workflow_key = 'chat.post_commit.effect'
            AND json_extract(omitted_child.payload_json, '$.parentRunId') = run.run_id
            AND json_extract(omitted_child.payload_json, '$.postCommitGenerationId')
              = json_extract(run.metadata_json, '$.generalChatPostCommit.generationId')
            AND NOT EXISTS (
              SELECT 1 FROM json_each(
                run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds'
              ) admitted_child WHERE admitted_child.value = omitted_child.run_id
            )
        )
        AND json_type(run.metadata_json, '$.chatTurnAdmissionHandoff') = 'object'
        AND (
          SELECT COUNT(*) FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff')
        ) = 10
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff') marker_field
          WHERE marker_field.key NOT IN (
            'version', 'admissionId', 'sessionIncarnationId', 'turnId', 'parentRunId',
            'postCommitGenerationId', 'parentLocalEffectsStatus', 'childRunIds',
            'childRunIdsSha256', 'committedAt'
          )
        )
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.version') = 1
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.admissionId') = OLD.admission_id
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.sessionIncarnationId')
          = OLD.session_incarnation_id
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.turnId') = OLD.turn_id
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.parentRunId') = run.run_id
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.postCommitGenerationId')
          = json_extract(run.metadata_json, '$.generalChatPostCommit.generationId')
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.parentLocalEffectsStatus') = 'settled'
        AND json_type(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds') = 'array'
        AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIdsSha256')
          = gc_sha256(gc_canonical_json(json_extract(
              run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds'
            )))
        AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(
              run.metadata_json, '$.chatTurnAdmissionHandoff.committedAt'
            ), '+0 days')
          = json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.committedAt')
        AND (
          SELECT COUNT(*) FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds')
        ) = (
          SELECT COUNT(*) FROM json_each(
            run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds'
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds') marker_child
          WHERE marker_child.type <> 'text' OR EXISTS (
            SELECT 1
            FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds') prior_marker_child
            WHERE CAST(prior_marker_child.key AS INTEGER) < CAST(marker_child.key AS INTEGER)
              AND prior_marker_child.value >= marker_child.value
          ) OR NOT EXISTS (
            SELECT 1 FROM json_each(
              run.metadata_json, '$.generalChatPostCommit.durableEffectRunIds'
            ) effect_run WHERE effect_run.value = marker_child.value
          )
        )
    )
    BEGIN SELECT RAISE(ABORT, 'heartbeat occurrence terminal runtime evidence invariant violated'); END;

    CREATE TRIGGER trg_chat_heartbeat_occurrences_no_delete
    BEFORE DELETE ON chat_heartbeat_occurrences
    BEGIN SELECT RAISE(ABORT, 'heartbeat occurrences are append/transition-only'); END;
  `);
  replaceSessionControlAuthRevokeGuards(db);
  upgradeSessionMutationAdmissionGuardForHeartbeatReclaim(db);
}

function upgradeSessionControlEventsForHeartbeatPreemption(db: DatabaseSync): void {
  const tableName = "chat_session_control_events";
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { sql?: unknown }
    | undefined;
  if (typeof table?.sql !== "string") {
    throw new Error("SQLite migration 174 requires the session-control event ledger");
  }
  if (table.sql.includes("heartbeat_preempted")) return;
  const upgradedTableSql = table.sql.replace(
    "'session_reactivated', 'mutation_denied'",
    "'session_reactivated', 'mutation_denied', 'heartbeat_preempted'",
  );
  if (upgradedTableSql === table.sql || !upgradedTableSql.includes("heartbeat_preempted")) {
    throw new Error("SQLite migration 174 could not widen the session-control event reason check");
  }
  const indexes = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = @tableName AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all({ tableName }) as Array<{ sql: string }>;
  const triggers = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = @tableName AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all({ tableName }) as Array<{ sql: string }>;
  db.exec(`PRAGMA legacy_alter_table = ON;`);
  try {
    db.exec(`ALTER TABLE chat_session_control_events RENAME TO chat_session_control_events_hx411_old;`);
    db.exec(upgradedTableSql);
    db.exec(`INSERT INTO chat_session_control_events SELECT * FROM chat_session_control_events_hx411_old;`);
    db.exec(`DROP TABLE chat_session_control_events_hx411_old;`);
  } finally {
    db.exec(`PRAGMA legacy_alter_table = OFF;`);
  }
  for (const row of indexes) db.exec(row.sql);
  for (const row of triggers) db.exec(row.sql);

  db.exec(`
    CREATE TRIGGER trg_chat_session_control_events_heartbeat_preempted_guard
    BEFORE INSERT ON chat_session_control_events
    WHEN NEW.reason_code = 'heartbeat_preempted' AND NOT (
      NEW.request_id IS NULL
      AND NEW.previous_generation IS NOT NULL
      AND NEW.next_generation = NEW.previous_generation + 1
      AND NEW.previous_owner_kind = 'operator' AND NEW.next_owner_kind = 'operator'
      AND NEW.previous_lease_state = 'operator_active' AND NEW.next_lease_state = 'operator_active'
      AND NEW.actor_kind = 'operator'
      AND NEW.companion_session_id IS NULL AND NEW.device_grant_id IS NULL
      AND NEW.event_sequence = COALESCE((
        SELECT MAX(prior_event.event_sequence) + 1
        FROM chat_session_control_events prior_event
        WHERE prior_event.session_id = NEW.session_id
      ), 1)
      AND EXISTS (
        SELECT 1 FROM chat_session_control_grants prior
        WHERE prior.workspace_id = NEW.workspace_id AND prior.session_id = NEW.session_id
          AND prior.generation = NEW.previous_generation
          AND prior.owner_kind = 'operator' AND prior.lease_state = 'operator_active'
          AND prior.is_current = 1 AND prior.terminal_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM chat_session_control_grants successor
        WHERE successor.workspace_id = NEW.workspace_id AND successor.session_id = NEW.session_id
          AND successor.generation = NEW.next_generation
      )
    )
    BEGIN SELECT RAISE(ABORT, 'heartbeat preemption event invariant violated'); END;

    CREATE TRIGGER trg_chat_session_control_grants_heartbeat_preempted_guard
    BEFORE INSERT ON chat_session_control_grants
    WHEN NEW.owner_kind = 'operator' AND EXISTS (
      SELECT 1 FROM chat_session_control_grants prior
      WHERE prior.session_id = NEW.session_id AND prior.workspace_id = NEW.workspace_id
        AND prior.generation = NEW.generation - 1
        AND prior.owner_kind = 'operator' AND prior.lease_state = 'superseded'
    ) AND NOT EXISTS (
      SELECT 1 FROM chat_session_control_events event_row
      WHERE event_row.workspace_id = NEW.workspace_id AND event_row.session_id = NEW.session_id
        AND event_row.previous_generation = NEW.generation - 1
        AND event_row.next_generation = NEW.generation
        AND event_row.previous_owner_kind = 'operator' AND event_row.next_owner_kind = 'operator'
        AND event_row.previous_lease_state = 'operator_active'
        AND event_row.next_lease_state = 'operator_active'
        AND event_row.reason_code = 'heartbeat_preempted' AND event_row.actor_kind = 'operator'
        AND event_row.request_id IS NULL AND event_row.companion_session_id IS NULL
        AND event_row.device_grant_id IS NULL
        AND event_row.idempotency_key = NEW.transition_idempotency_key
        AND event_row.request_sha256 = NEW.transition_request_sha256
        AND event_row.created_at = NEW.created_at AND NEW.updated_at = NEW.created_at
    )
    BEGIN SELECT RAISE(ABORT, 'operator heartbeat-preemption generation lacks its exact event'); END;
  `);
}

function upgradeSessionMutationAdmissionGuardForHeartbeatReclaim(db: DatabaseSync): void {
  const triggerName = "trg_chat_session_mutation_admissions_update_guard";
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(triggerName) as
    | { sql?: unknown }
    | undefined;
  if (typeof row?.sql !== "string") {
    throw new Error("SQLite migration 174 requires the mutation-admission update guard");
  }
  let upgradedSql = row.sql;
  const anchor = `        OR (NEW.status = 'active' AND OLD.status = 'active'
          AND OLD.runtime_lease_relinquished_at IS NULL
          AND NEW.runtime_lease_relinquished_at IS NOT NULL`;
  const heartbeatReclaim = `        OR (NEW.status = 'active' AND OLD.status = 'active'
          /* heartbeat occurrence request-runtime reclaim */
          AND OLD.admission_kind = 'turn_write'
          AND OLD.actor_kind = 'system' AND OLD.actor_id = 'system-heartbeat'
          AND OLD.operation = 'chat_system_heartbeat'
          AND OLD.runtime_lease_relinquished_at IS NULL
          AND julianday(OLD.runtime_lease_expires_at) <= julianday(NEW.runtime_last_heartbeat_at)
          AND NEW.runtime_lease_relinquished_at IS NULL
          AND NEW.runtime_lease_revision = OLD.runtime_lease_revision + 1
          AND NEW.runtime_last_heartbeat_at >= OLD.runtime_last_heartbeat_at
          AND NEW.runtime_lease_expires_at = strftime(
            '%Y-%m-%dT%H:%M:%fZ', NEW.runtime_last_heartbeat_at, '+60 seconds'
          )
          AND NEW.closed_at IS OLD.closed_at AND NEW.terminal_actor_id IS OLD.terminal_actor_id
          AND NEW.terminal_event_id IS OLD.terminal_event_id
          AND NEW.terminal_idempotency_key IS OLD.terminal_idempotency_key
          AND NEW.terminal_correlation_id IS OLD.terminal_correlation_id
          AND NOT EXISTS (
            SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
            WHERE durable_binding.admission_id = OLD.admission_id
          )
          AND EXISTS (
            SELECT 1 FROM chat_heartbeat_occurrences occurrence
            WHERE occurrence.admission_id = OLD.admission_id
              AND occurrence.workspace_id = OLD.workspace_id
              AND occurrence.session_id = OLD.session_id
              AND occurrence.session_incarnation_id = OLD.session_incarnation_id
              AND occurrence.turn_id = OLD.turn_id
              AND occurrence.runtime_owner_id = OLD.runtime_owner_id
              AND occurrence.system_actor_id = OLD.actor_id
              AND occurrence.admission_material_sha256 = OLD.material_sha256
              AND occurrence.frozen_request_sha256 = OLD.material_sha256
              AND occurrence.admission_request_sha256 = OLD.request_sha256
              AND occurrence.admission_idempotency_key = OLD.idempotency_key
              AND occurrence.admission_correlation_id = OLD.correlation_id
              AND occurrence.aggregate_revision = OLD.aggregate_revision
              AND occurrence.controller_generation = OLD.controller_generation
              AND occurrence.state = 'admitted'
          ))
`;
  if (!upgradedSql.includes("heartbeat occurrence request-runtime reclaim")) {
    if (!upgradedSql.includes(anchor)) {
      throw new Error("SQLite migration 174 could not locate the mutation-admission guard upgrade anchor");
    }
    upgradedSql = upgradedSql.replace(anchor, `${heartbeatReclaim}${anchor}`);
  }
  const terminalEffectsAnchor = `                  AND (
                    SELECT COUNT(DISTINCT local_effect.value)
                    FROM json_each(run.metadata_json, '$.generalChatPostCommit.completedEffects') local_effect
                    WHERE typeof(local_effect.value) = 'text'
                      AND local_effect.value IN ('capability_gap', 'realtime', 'agent_end')
                  ) = 3`;
  const heartbeatTerminalEffects = `                  AND (
                    (
                      SELECT COUNT(DISTINCT local_effect.value)
                      FROM json_each(run.metadata_json, '$.generalChatPostCommit.completedEffects') local_effect
                      WHERE typeof(local_effect.value) = 'text'
                        AND local_effect.value IN ('capability_gap', 'realtime', 'agent_end')
                    ) = 3
                    OR (
                      /* heartbeat occurrence durable-terminal zero-effect handoff */
                      OLD.actor_kind = 'system' AND OLD.actor_id = 'system-heartbeat'
                      AND OLD.operation = 'chat_system_heartbeat'
                      AND json_array_length(
                        run.metadata_json, '$.generalChatPostCommit.completedEffects'
                      ) = 0
                      AND EXISTS (
                        SELECT 1 FROM chat_heartbeat_occurrences heartbeat_occurrence
                        WHERE heartbeat_occurrence.admission_id = OLD.admission_id
                          AND heartbeat_occurrence.workspace_id = OLD.workspace_id
                          AND heartbeat_occurrence.session_id = OLD.session_id
                          AND heartbeat_occurrence.session_incarnation_id = OLD.session_incarnation_id
                          AND heartbeat_occurrence.turn_id = OLD.turn_id
                          AND heartbeat_occurrence.durable_run_id = run.run_id
                          AND heartbeat_occurrence.state = 'durable_bound'
                          AND heartbeat_occurrence.controller_generation = OLD.controller_generation
                          AND heartbeat_occurrence.aggregate_revision = OLD.aggregate_revision
                          AND heartbeat_occurrence.admission_material_sha256 = OLD.material_sha256
                          AND heartbeat_occurrence.frozen_request_sha256 = OLD.material_sha256
                          AND json_extract(run.payload_json, '$.heartbeatOccurrenceId')
                            = heartbeat_occurrence.occurrence_id
                          AND json_extract(run.payload_json, '$.heartbeatClaimSha256')
                            = heartbeat_occurrence.claim_sha256
                      )
                    )
                  )`;
  if (!upgradedSql.includes("heartbeat occurrence durable-terminal zero-effect handoff")) {
    if (!upgradedSql.includes(terminalEffectsAnchor)) {
      throw new Error("SQLite migration 174 could not locate the durable-terminal effects guard anchor");
    }
    upgradedSql = upgradedSql.replace(terminalEffectsAnchor, heartbeatTerminalEffects);
  }
  const terminalClockAnchor = "AND abs((julianday(NEW.closed_at) - julianday('now')) * 86400.0) <= 1.0";
  const heartbeatTerminalClock = `AND (
            abs((julianday(NEW.closed_at) - julianday('now')) * 86400.0) <= 1.0
            OR EXISTS (
              SELECT 1
              FROM chat_session_control_events event_row
              JOIN chat_session_control_grants successor
                ON successor.workspace_id = event_row.workspace_id
                AND successor.session_id = event_row.session_id
                AND successor.generation = event_row.next_generation
              JOIN chat_heartbeat_occurrences occurrence
                ON occurrence.admission_id = OLD.admission_id
              WHERE substr(event_row.idempotency_key, 1, 18) = 'heartbeat-preempt_'
                /* heartbeat preemption terminal timestamp evidence */
                AND event_row.reason_code = 'heartbeat_preempted'
                AND event_row.workspace_id = OLD.workspace_id
                AND event_row.session_id = OLD.session_id
                AND event_row.previous_generation = OLD.controller_generation
                AND event_row.next_generation = OLD.controller_generation + 1
                AND event_row.previous_owner_kind = 'operator'
                AND event_row.next_owner_kind = 'operator'
                AND event_row.previous_lease_state = 'operator_active'
                AND event_row.next_lease_state = 'operator_active'
                AND event_row.request_id IS NULL
                AND event_row.actor_kind = 'operator'
                AND event_row.companion_session_id IS NULL
                AND event_row.device_grant_id IS NULL
                AND event_row.created_at = NEW.closed_at
                AND successor.is_current = 1
                AND successor.owner_kind = 'operator'
                AND successor.lease_state = 'operator_active'
                AND successor.transition_idempotency_key = event_row.idempotency_key
                AND successor.transition_request_sha256 = event_row.request_sha256
                AND successor.created_at = event_row.created_at
                AND successor.updated_at = event_row.created_at
                AND occurrence.workspace_id = OLD.workspace_id
                AND occurrence.session_id = OLD.session_id
                AND occurrence.controller_generation = OLD.controller_generation
                AND occurrence.state IN ('admitted', 'durable_bound')
                AND OLD.actor_kind = 'system'
                AND OLD.actor_id = 'system-heartbeat'
                AND OLD.operation = 'chat_system_heartbeat'
                AND ((occurrence.state = 'admitted'
                  AND NEW.terminal_authority_kind = 'request_runtime'
                  AND NEW.terminal_control_event_id IS NULL
                  AND NEW.terminal_correlation_id = event_row.event_id)
                OR (occurrence.state = 'durable_bound'
                  AND NEW.terminal_authority_kind = 'authority_superseded'
                  AND NEW.terminal_control_event_id = event_row.event_id))
                AND NOT EXISTS (
                  SELECT 1 FROM chat_session_control_requests request_row
                  WHERE request_row.workspace_id = event_row.workspace_id
                    AND request_row.session_id = event_row.session_id
                    AND request_row.requested_generation = event_row.previous_generation
                    AND request_row.status = 'pending'
                )
            )
          )`;
  if (!upgradedSql.includes("heartbeat preemption terminal timestamp evidence")) {
    if (!upgradedSql.includes(terminalClockAnchor)) {
      throw new Error("SQLite migration 174 could not locate the terminal clock guard anchor");
    }
    upgradedSql = upgradedSql.replace(terminalClockAnchor, heartbeatTerminalClock);
  }
  if (upgradedSql === row.sql) return;
  db.exec(`DROP TRIGGER ${triggerName};`);
  db.exec(upgradedSql);
}

function createSessionControlLifecycleAndAdmissionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE gc_session_control_lifecycle_preflight (
      ok INTEGER NOT NULL CHECK(ok = 1)
    );
    INSERT INTO gc_session_control_lifecycle_preflight(ok)
    SELECT CASE WHEN
      EXISTS (
        SELECT 1
        FROM chat_session_meta meta
        LEFT JOIN chat_session_control_grants control
          ON control.session_id = meta.session_id AND control.is_current = 1
        WHERE control.session_id IS NULL OR control.workspace_id <> meta.workspace_id
      )
      OR EXISTS (
        SELECT 1
        FROM chat_session_control_grants control
        LEFT JOIN chat_session_meta meta ON meta.session_id = control.session_id
        WHERE control.is_current = 1
          AND (meta.session_id IS NULL OR meta.workspace_id <> control.workspace_id)
      )
      OR EXISTS (
        SELECT session_id
        FROM chat_session_control_grants
        WHERE is_current = 1
        GROUP BY session_id
        HAVING COUNT(*) <> 1
      )
    THEN 0 ELSE 1 END;
    DROP TABLE gc_session_control_lifecycle_preflight;
  `);

  addColumnIfMissingIfTableExists(db, "chat_session_meta", "lifecycle_intent_id", "TEXT");
  addColumnIfMissingIfTableExists(db, "chat_session_meta", "deletion_intent_id", "TEXT");

  db.exec(`
    CREATE TABLE chat_session_control_auth_revoke_operations (
      idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      binding_kind TEXT NOT NULL CHECK(binding_kind IN ('companion_session', 'device_grant')),
      binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 256),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
      correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
      target_count INTEGER NOT NULL CHECK(typeof(target_count) = 'integer' AND target_count >= 0),
      session_count INTEGER NOT NULL CHECK(typeof(session_count) = 'integer' AND session_count >= 0),
      event_set_sha256 TEXT NOT NULL CHECK(length(event_set_sha256) = 64 AND event_set_sha256 NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+0 days') = occurred_at
      ),
      FOREIGN KEY(idempotency_key) REFERENCES chat_session_control_auth_revoke_receipts(idempotency_key)
        DEFERRABLE INITIALLY DEFERRED,
      CHECK(
        (target_count = 0 AND session_count = 0
          AND event_set_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
        OR (target_count > 0 AND session_count BETWEEN 1 AND target_count)
      )
    );

    CREATE TABLE chat_session_control_auth_revoke_operation_targets (
      operation_idempotency_key TEXT NOT NULL,
      target_index INTEGER NOT NULL CHECK(typeof(target_index) = 'integer' AND target_index >= 0),
      target_kind TEXT NOT NULL CHECK(target_kind IN ('pending_request', 'current_grant')),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      request_id TEXT,
      generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0),
      control_revision INTEGER NOT NULL CHECK(typeof(control_revision) = 'integer' AND control_revision > 0),
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('operator', 'external_companion')),
      lease_state TEXT NOT NULL CHECK(lease_state IN ('operator_active', 'external_live', 'external_stale')),
      event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 256),
      event_sequence INTEGER NOT NULL CHECK(typeof(event_sequence) = 'integer' AND event_sequence > 0),
      event_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(event_idempotency_key) BETWEEN 1 AND 512),
      event_reason_code TEXT NOT NULL CHECK(event_reason_code IN ('auth_revoked', 'mutation_denied', 'request_expired')),
      PRIMARY KEY(operation_idempotency_key, target_index),
      UNIQUE(operation_idempotency_key, target_kind, session_id, request_id, generation),
      FOREIGN KEY(operation_idempotency_key)
        REFERENCES chat_session_control_auth_revoke_operations(idempotency_key) ON DELETE RESTRICT,
      CHECK((target_kind = 'pending_request' AND request_id IS NOT NULL)
        OR (target_kind = 'current_grant' AND owner_kind = 'external_companion'))
    );
    CREATE INDEX idx_chat_session_control_auth_revoke_targets_session
      ON chat_session_control_auth_revoke_operation_targets(operation_idempotency_key, session_id, target_index);

    CREATE TABLE chat_session_lifecycle_intents (
      intent_id TEXT PRIMARY KEY CHECK(length(intent_id) BETWEEN 1 AND 256),
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      intent_kind TEXT NOT NULL CHECK(intent_kind IN ('initialize', 'reactivate', 'delete')),
      expected_generation INTEGER CHECK(expected_generation IS NULL OR (typeof(expected_generation) = 'integer' AND expected_generation > 0)),
      next_generation INTEGER NOT NULL CHECK(typeof(next_generation) = 'integer' AND next_generation > 0),
      expected_revision INTEGER CHECK(expected_revision IS NULL OR (typeof(expected_revision) = 'integer' AND expected_revision > 0)),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'system')),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
      event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      UNIQUE(workspace_id, session_id, intent_kind, next_generation),
      CHECK(
        (intent_kind = 'initialize' AND expected_generation IS NULL AND next_generation = 1
          AND expected_revision IS NULL AND actor_kind = 'system')
        OR (intent_kind = 'reactivate' AND expected_generation IS NOT NULL
          AND next_generation = expected_generation + 1 AND expected_revision IS NULL)
        OR (intent_kind = 'delete' AND expected_generation IS NOT NULL
          AND next_generation = expected_generation AND expected_revision IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session_lifecycle_intents_session
      ON chat_session_lifecycle_intents(session_id, next_generation, intent_kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_meta_lifecycle_intent
      ON chat_session_meta(lifecycle_intent_id) WHERE lifecycle_intent_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_meta_deletion_intent
      ON chat_session_meta(deletion_intent_id) WHERE deletion_intent_id IS NOT NULL;

    CREATE TABLE chat_session_mutation_admissions (
      admission_id TEXT PRIMARY KEY CHECK(length(admission_id) BETWEEN 1 AND 256),
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      turn_id TEXT UNIQUE CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
      runtime_owner_id TEXT CHECK(runtime_owner_id IS NULL OR length(runtime_owner_id) BETWEEN 1 AND 256),
      runtime_last_heartbeat_at TEXT CHECK(
        runtime_last_heartbeat_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', runtime_last_heartbeat_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', runtime_last_heartbeat_at, '+0 days') = runtime_last_heartbeat_at
        )
      ),
      runtime_lease_expires_at TEXT CHECK(
        runtime_lease_expires_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', runtime_lease_expires_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', runtime_lease_expires_at, '+0 days') = runtime_lease_expires_at
        )
      ),
      runtime_lease_revision INTEGER CHECK(
        runtime_lease_revision IS NULL OR (typeof(runtime_lease_revision) = 'integer' AND runtime_lease_revision > 0)
      ),
      runtime_lease_relinquished_at TEXT CHECK(
        runtime_lease_relinquished_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', runtime_lease_relinquished_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', runtime_lease_relinquished_at, '+0 days') = runtime_lease_relinquished_at
        )
      ),
      admission_kind TEXT NOT NULL CHECK(admission_kind IN ('synchronous', 'turn_write')),
      aggregate_revision INTEGER NOT NULL CHECK(typeof(aggregate_revision) = 'integer' AND aggregate_revision > 0),
      controller_generation INTEGER NOT NULL CHECK(typeof(controller_generation) = 'integer' AND controller_generation > 0),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'external_companion', 'system')),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      material_sha256 TEXT NOT NULL CHECK(length(material_sha256) = 64 AND material_sha256 NOT GLOB '*[^0-9a-f]*'),
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled')),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
      admit_event_id TEXT NOT NULL UNIQUE CHECK(length(admit_event_id) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      closed_at TEXT CHECK(
        closed_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 days') IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at, '+0 days') = closed_at
        )
      ),
      terminal_actor_id TEXT,
      terminal_event_id TEXT UNIQUE,
      terminal_idempotency_key TEXT UNIQUE,
      terminal_correlation_id TEXT,
      terminal_authority_kind TEXT CHECK(terminal_authority_kind IS NULL OR terminal_authority_kind IN (
        'synchronous', 'request_runtime', 'durable_run', 'durable_terminal', 'expired_recovery',
        'lifecycle_delete', 'authority_superseded', 'post_commit_child_stage'
      )),
      terminal_runtime_owner_id TEXT CHECK(
        terminal_runtime_owner_id IS NULL OR length(terminal_runtime_owner_id) BETWEEN 1 AND 256
      ),
      terminal_runtime_lease_revision INTEGER CHECK(
        terminal_runtime_lease_revision IS NULL
          OR (typeof(terminal_runtime_lease_revision) = 'integer' AND terminal_runtime_lease_revision > 0)
      ),
      terminal_durable_run_id TEXT CHECK(
        terminal_durable_run_id IS NULL OR length(terminal_durable_run_id) BETWEEN 1 AND 256
      ),
      terminal_durable_lease_owner_id TEXT CHECK(
        terminal_durable_lease_owner_id IS NULL OR length(terminal_durable_lease_owner_id) BETWEEN 1 AND 256
      ),
      terminal_durable_attempt_count INTEGER CHECK(
        terminal_durable_attempt_count IS NULL
          OR (typeof(terminal_durable_attempt_count) = 'integer' AND terminal_durable_attempt_count >= 0)
      ),
      terminal_durable_run_version INTEGER CHECK(
        terminal_durable_run_version IS NULL
          OR (typeof(terminal_durable_run_version) = 'integer' AND terminal_durable_run_version > 0)
      ),
      terminal_durable_run_status TEXT CHECK(
        terminal_durable_run_status IS NULL OR terminal_durable_run_status IN (
          'running', 'completed', 'failed', 'cancelled', 'dead_lettered'
        )
      ),
      terminal_lifecycle_intent_id TEXT CHECK(
        terminal_lifecycle_intent_id IS NULL OR length(terminal_lifecycle_intent_id) BETWEEN 1 AND 256
      ),
      terminal_control_event_id TEXT CHECK(
        terminal_control_event_id IS NULL OR length(terminal_control_event_id) BETWEEN 1 AND 256
      ),
      CHECK(
        (status = 'active' AND closed_at IS NULL AND terminal_actor_id IS NULL AND terminal_event_id IS NULL
          AND terminal_idempotency_key IS NULL AND terminal_correlation_id IS NULL)
        OR (status IN ('completed', 'cancelled') AND closed_at IS NOT NULL
          AND length(terminal_actor_id) BETWEEN 1 AND 256 AND length(terminal_event_id) BETWEEN 1 AND 256
          AND length(terminal_idempotency_key) BETWEEN 1 AND 512
          AND length(terminal_correlation_id) BETWEEN 1 AND 256)
      ),
      CHECK((admission_kind = 'turn_write' AND turn_id IS NOT NULL
          AND runtime_owner_id IS NOT NULL AND runtime_last_heartbeat_at IS NOT NULL
          AND runtime_lease_expires_at IS NOT NULL AND runtime_lease_revision IS NOT NULL
          AND runtime_lease_expires_at > runtime_last_heartbeat_at)
        OR (admission_kind = 'synchronous' AND turn_id IS NULL
          AND runtime_owner_id IS NULL AND runtime_last_heartbeat_at IS NULL
          AND runtime_lease_expires_at IS NULL AND runtime_lease_revision IS NULL
          AND runtime_lease_relinquished_at IS NULL)),
      CHECK(
        (status = 'active' AND terminal_authority_kind IS NULL
          AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
          AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
          AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
          AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
          AND terminal_control_event_id IS NULL)
        OR (status IN ('completed', 'cancelled') AND (
          (terminal_authority_kind = 'synchronous'
            AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
            AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
            AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
            AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
            AND terminal_control_event_id IS NULL)
          OR (terminal_authority_kind IN ('request_runtime', 'expired_recovery')
            AND terminal_runtime_owner_id IS NOT NULL AND terminal_runtime_lease_revision IS NOT NULL
            AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
            AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
            AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
            AND terminal_control_event_id IS NULL)
          OR (terminal_authority_kind = 'durable_run'
            AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
            AND terminal_durable_run_id IS NOT NULL AND terminal_durable_lease_owner_id IS NOT NULL
            AND terminal_durable_attempt_count IS NOT NULL AND terminal_durable_run_version IS NOT NULL
            AND terminal_durable_run_status = 'running' AND terminal_lifecycle_intent_id IS NULL
            AND terminal_control_event_id IS NULL)
          OR (terminal_authority_kind = 'durable_terminal'
            AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
            AND terminal_durable_run_id IS NOT NULL AND terminal_durable_lease_owner_id IS NULL
            AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NOT NULL
            AND terminal_durable_run_status IN ('completed', 'failed', 'cancelled', 'dead_lettered')
            AND terminal_lifecycle_intent_id IS NULL AND terminal_control_event_id IS NULL)
          OR (terminal_authority_kind = 'lifecycle_delete'
            AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
            AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
            AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
            AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NOT NULL
            AND terminal_control_event_id IS NULL)
          OR (terminal_authority_kind = 'authority_superseded'
            AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
            AND terminal_durable_run_id IS NULL AND terminal_durable_lease_owner_id IS NULL
            AND terminal_durable_attempt_count IS NULL AND terminal_durable_run_version IS NULL
            AND terminal_durable_run_status IS NULL AND terminal_lifecycle_intent_id IS NULL
            AND terminal_control_event_id IS NOT NULL)
          OR (terminal_authority_kind = 'post_commit_child_stage'
            AND terminal_runtime_owner_id IS NULL AND terminal_runtime_lease_revision IS NULL
            AND terminal_durable_run_id IS NOT NULL AND terminal_durable_lease_owner_id IS NOT NULL
            AND terminal_durable_attempt_count IS NOT NULL AND terminal_durable_run_version IS NOT NULL
            AND terminal_durable_run_status = 'running' AND terminal_lifecycle_intent_id IS NULL
            AND terminal_control_event_id IS NULL)
        ))
      )
    );
    CREATE UNIQUE INDEX idx_chat_session_mutation_admissions_one_active_turn
      ON chat_session_mutation_admissions(session_id)
      WHERE admission_kind = 'turn_write' AND status = 'active';
    CREATE INDEX idx_chat_session_mutation_admissions_active
      ON chat_session_mutation_admissions(workspace_id, session_id, status, created_at, admission_id);

    CREATE TABLE chat_session_mutation_admission_events (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 256),
      admission_id TEXT NOT NULL,
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 256),
      runtime_owner_id TEXT CHECK(runtime_owner_id IS NULL OR length(runtime_owner_id) BETWEEN 1 AND 256),
      runtime_lease_revision INTEGER CHECK(
        runtime_lease_revision IS NULL OR (typeof(runtime_lease_revision) = 'integer' AND runtime_lease_revision > 0)
      ),
      event_sequence INTEGER NOT NULL CHECK(event_sequence IN (1, 2)),
      event_type TEXT NOT NULL CHECK(event_type IN ('admitted', 'completed', 'cancelled')),
      admission_kind TEXT NOT NULL CHECK(admission_kind IN ('synchronous', 'turn_write')),
      aggregate_revision INTEGER NOT NULL CHECK(typeof(aggregate_revision) = 'integer' AND aggregate_revision > 0),
      controller_generation INTEGER NOT NULL CHECK(typeof(controller_generation) = 'integer' AND controller_generation > 0),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'external_companion', 'system')),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      material_sha256 TEXT NOT NULL CHECK(length(material_sha256) = 64 AND material_sha256 NOT GLOB '*[^0-9a-f]*'),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
      terminal_authority_kind TEXT,
      terminal_runtime_owner_id TEXT,
      terminal_runtime_lease_revision INTEGER,
      terminal_durable_run_id TEXT,
      terminal_durable_lease_owner_id TEXT,
      terminal_durable_attempt_count INTEGER,
      terminal_durable_run_version INTEGER,
      terminal_durable_run_status TEXT,
      terminal_lifecycle_intent_id TEXT,
      terminal_control_event_id TEXT,
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      UNIQUE(admission_id, event_sequence),
      FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_chat_session_mutation_admission_events_admission
      ON chat_session_mutation_admission_events(admission_id, event_sequence);
  `);

  createChatTurnSessionIncarnationBindingSchema(db);
  createSessionControlLifecycleAndAdmissionTriggers(db);
  replaceSessionControlAuthRevokeGuards(db);
}

function createChatTurnSessionIncarnationBindingSchema(db: DatabaseSync): void {
  if (!tableExists(db, "chat_turn_capability_profiles")) {
    return;
  }
  if (tableExists(db, "chat_routed_context_snapshots")) {
    db.exec(`
      CREATE TEMP TABLE gc_chat_turn_profile_snapshot_preflight (
        ok INTEGER NOT NULL CHECK(ok = 1)
      );
      INSERT INTO gc_chat_turn_profile_snapshot_preflight(ok)
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM chat_routed_context_snapshots snapshot
        LEFT JOIN chat_turn_capability_profiles profile
          ON profile.profile_id = snapshot.capability_profile_id
        WHERE profile.profile_id IS NULL
          OR profile.turn_id <> snapshot.turn_id
          OR profile.session_id <> snapshot.session_id
          OR profile.workspace_id <> snapshot.workspace_id
          OR profile.profile_hash <> snapshot.capability_profile_hash
      ) THEN 0 ELSE 1 END;
      DROP TABLE gc_chat_turn_profile_snapshot_preflight;
    `);
  }
  db.exec(`
    CREATE TABLE chat_turn_session_incarnation_bindings (
      turn_id TEXT PRIMARY KEY CHECK(length(turn_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      admission_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(admission_id IS NOT NULL
        OR session_incarnation_id = 'legacy-session-incarnation:' || session_id)
    );
    CREATE INDEX idx_chat_turn_session_incarnation_bindings_session
      ON chat_turn_session_incarnation_bindings(workspace_id, session_id, session_incarnation_id, turn_id);

    INSERT INTO chat_turn_session_incarnation_bindings (
      turn_id, workspace_id, session_id, session_incarnation_id, admission_id, created_at
    )
    SELECT turn_id, workspace_id, session_id,
      'legacy-session-incarnation:' || session_id, NULL, created_at
    FROM chat_turn_capability_profiles;

    CREATE TABLE chat_turn_capability_profile_incarnation_bindings (
      profile_id TEXT PRIMARY KEY CHECK(length(profile_id) BETWEEN 1 AND 256),
      turn_id TEXT NOT NULL UNIQUE CHECK(length(turn_id) BETWEEN 1 AND 256),
      profile_hash TEXT NOT NULL CHECK(
        length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL,
      FOREIGN KEY(turn_id) REFERENCES chat_turn_session_incarnation_bindings(turn_id)
        ON DELETE RESTRICT,
      FOREIGN KEY(profile_id) REFERENCES chat_turn_capability_profiles(profile_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );

    INSERT INTO chat_turn_capability_profile_incarnation_bindings (
      profile_id, turn_id, profile_hash, created_at
    )
    SELECT profile_id, turn_id, profile_hash, created_at
    FROM chat_turn_capability_profiles;

    CREATE TABLE chat_turn_mutation_admission_durable_bindings (
      admission_id TEXT PRIMARY KEY CHECK(length(admission_id) BETWEEN 1 AND 256),
      turn_id TEXT NOT NULL UNIQUE CHECK(length(turn_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      durable_run_id TEXT NOT NULL UNIQUE CHECK(length(durable_run_id) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL,
      FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE RESTRICT,
      FOREIGN KEY(turn_id) REFERENCES chat_turn_session_incarnation_bindings(turn_id) ON DELETE RESTRICT,
      FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE chat_turn_user_input_continuation_seals (
      seal_id TEXT PRIMARY KEY CHECK(length(seal_id) BETWEEN 1 AND 256),
      version INTEGER NOT NULL CHECK(version = 1),
      admission_id TEXT NOT NULL CHECK(length(admission_id) BETWEEN 1 AND 256),
      session_incarnation_id TEXT NOT NULL CHECK(length(session_incarnation_id) BETWEEN 1 AND 320),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 256),
      durable_run_id TEXT NOT NULL CHECK(length(durable_run_id) BETWEEN 1 AND 256),
      prompt_id TEXT NOT NULL CHECK(length(prompt_id) BETWEEN 1 AND 256),
      event_key TEXT NOT NULL CHECK(event_key = 'chat.user_input.resolved'),
      correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
      resume_record_sha256 TEXT NOT NULL CHECK(
        length(resume_record_sha256) = 64 AND resume_record_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      responder_actor_id TEXT NOT NULL CHECK(length(responder_actor_id) BETWEEN 1 AND 256),
      responder_auth_actor_source TEXT NOT NULL CHECK(responder_auth_actor_source IN (
        'none', 'token', 'basic', 'loopback', 'sse', 'device', 'companion', 'a2a_peer'
      )),
      waiting_run_version INTEGER NOT NULL CHECK(waiting_run_version > 0),
      queued_run_version INTEGER NOT NULL CHECK(queued_run_version = waiting_run_version + 1),
      resolved_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+0 days') = resolved_at
      ),
      material_sha256 TEXT NOT NULL CHECK(
        length(material_sha256) = 64 AND material_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      UNIQUE(admission_id, durable_run_id, prompt_id),
      UNIQUE(durable_run_id, prompt_id),
      CHECK(correlation_id = prompt_id),
      FOREIGN KEY(admission_id) REFERENCES chat_session_mutation_admissions(admission_id) ON DELETE RESTRICT,
      FOREIGN KEY(turn_id) REFERENCES chat_turn_session_incarnation_bindings(turn_id) ON DELETE RESTRICT,
      FOREIGN KEY(durable_run_id) REFERENCES durable_runs(run_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_chat_turn_user_input_continuation_seals_run
      ON chat_turn_user_input_continuation_seals(durable_run_id, prompt_id);

    CREATE TRIGGER trg_chat_turn_session_incarnation_bindings_insert_guard
    BEFORE INSERT ON chat_turn_session_incarnation_bindings
    WHEN NEW.admission_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM chat_session_mutation_admissions admission
      WHERE admission.admission_id = NEW.admission_id AND admission.status = 'active'
        AND admission.admission_kind = 'turn_write'
        AND admission.turn_id = NEW.turn_id
        AND admission.workspace_id = NEW.workspace_id AND admission.session_id = NEW.session_id
        AND admission.session_incarnation_id = NEW.session_incarnation_id
    )
    BEGIN SELECT RAISE(ABORT, 'chat turn session incarnation authority invariant violated'); END;

    CREATE TRIGGER trg_chat_turn_session_incarnation_bindings_no_update
    BEFORE UPDATE ON chat_turn_session_incarnation_bindings
    BEGIN SELECT RAISE(ABORT, 'chat turn session incarnation bindings are append-only'); END;
    CREATE TRIGGER trg_chat_turn_session_incarnation_bindings_no_delete
    BEFORE DELETE ON chat_turn_session_incarnation_bindings
    BEGIN SELECT RAISE(ABORT, 'chat turn session incarnation bindings are append-only'); END;

    CREATE TRIGGER trg_chat_turn_mutation_admission_durable_bindings_insert_guard
    BEFORE INSERT ON chat_turn_mutation_admission_durable_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM chat_session_mutation_admissions admission
      JOIN chat_turn_session_incarnation_bindings binding
        ON binding.admission_id = admission.admission_id AND binding.turn_id = admission.turn_id
      JOIN durable_runs run ON run.run_id = NEW.durable_run_id
      WHERE admission.admission_id = NEW.admission_id
        AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
        AND admission.runtime_lease_relinquished_at IS NULL
        AND julianday(admission.runtime_lease_expires_at) > julianday('now')
        AND admission.turn_id = NEW.turn_id
        AND admission.workspace_id = NEW.workspace_id AND admission.session_id = NEW.session_id
        AND admission.session_incarnation_id = NEW.session_incarnation_id
        AND binding.workspace_id = NEW.workspace_id AND binding.session_id = NEW.session_id
        AND binding.session_incarnation_id = NEW.session_incarnation_id
        AND run.workflow_key = 'chat.turn.execute'
        AND run.status IN ('queued', 'running', 'waiting', 'paused')
        AND json_valid(run.payload_json) = 1
        AND json_extract(run.payload_json, '$.version') = 'chat.turn.execute.v2'
        AND json_extract(run.payload_json, '$.admissionId') = admission.admission_id
        AND json_extract(run.payload_json, '$.sessionIncarnationId') = admission.session_incarnation_id
        AND json_extract(run.payload_json, '$.admissionMaterialSha256') = admission.material_sha256
        AND json_extract(run.payload_json, '$.workspaceId') = admission.workspace_id
        AND json_type(run.payload_json, '$.admissionAggregateRevision') = 'integer'
        AND json_extract(run.payload_json, '$.admissionAggregateRevision') = admission.aggregate_revision
        AND json_type(run.payload_json, '$.admissionControllerGeneration') = 'integer'
        AND json_extract(run.payload_json, '$.admissionControllerGeneration') = admission.controller_generation
        AND json_extract(run.payload_json, '$.sessionId') = admission.session_id
        AND json_extract(run.payload_json, '$.turnId') = admission.turn_id
    )
    BEGIN SELECT RAISE(ABORT, 'chat turn durable admission binding authority invariant violated'); END;

    CREATE TRIGGER trg_chat_turn_mutation_admission_durable_bindings_no_update
    BEFORE UPDATE ON chat_turn_mutation_admission_durable_bindings
    BEGIN SELECT RAISE(ABORT, 'chat turn durable admission bindings are append-only'); END;
    CREATE TRIGGER trg_chat_turn_mutation_admission_durable_bindings_no_delete
    BEFORE DELETE ON chat_turn_mutation_admission_durable_bindings
    BEGIN SELECT RAISE(ABORT, 'chat turn durable admission bindings are append-only'); END;

    CREATE TRIGGER trg_chat_turn_user_input_continuation_seals_insert_guard
    BEFORE INSERT ON chat_turn_user_input_continuation_seals
    WHEN abs(julianday(NEW.resolved_at) - julianday('now')) * 86400.0 > 1.0
      OR NOT EXISTS (
        SELECT 1
        FROM chat_session_mutation_admissions admission
        JOIN chat_turn_mutation_admission_durable_bindings durable_binding
          ON durable_binding.admission_id = admission.admission_id
        JOIN durable_runs run ON run.run_id = durable_binding.durable_run_id
        JOIN chat_turn_traces trace ON trace.turn_id = admission.turn_id
        WHERE admission.admission_id = NEW.admission_id
          AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
          AND admission.session_incarnation_id = NEW.session_incarnation_id
          AND admission.workspace_id = NEW.workspace_id
          AND admission.session_id = NEW.session_id
          AND admission.turn_id = NEW.turn_id
          AND durable_binding.durable_run_id = NEW.durable_run_id
          AND run.workflow_key = 'chat.turn.execute' AND run.status = 'waiting'
          AND run.version = NEW.waiting_run_version
          AND trace.session_id = NEW.session_id AND trace.status = 'waiting_for_user_input'
          AND json_valid(trace.pending_user_input_json) = 1
          AND json_extract(trace.pending_user_input_json, '$.promptId') = NEW.prompt_id
          AND json_extract(trace.pending_user_input_json, '$.turnId') = NEW.turn_id
      )
    BEGIN SELECT RAISE(ABORT, 'chat turn user-input continuation seal authority invariant violated'); END;
    CREATE TRIGGER trg_chat_turn_user_input_continuation_seals_no_update
    BEFORE UPDATE ON chat_turn_user_input_continuation_seals
    BEGIN SELECT RAISE(ABORT, 'chat turn user-input continuation seals are append-only'); END;
    CREATE TRIGGER trg_chat_turn_user_input_continuation_seals_no_delete
    BEFORE DELETE ON chat_turn_user_input_continuation_seals
    BEGIN SELECT RAISE(ABORT, 'chat turn user-input continuation seals are append-only'); END;

    CREATE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_insert_guard
    BEFORE INSERT ON chat_turn_capability_profile_incarnation_bindings
    WHEN NOT EXISTS (
      SELECT 1
      FROM chat_turn_session_incarnation_bindings binding
      JOIN chat_session_mutation_admissions admission
        ON admission.admission_id = binding.admission_id
      WHERE binding.turn_id = NEW.turn_id
        AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
        AND admission.turn_id = NEW.turn_id
        AND admission.workspace_id = binding.workspace_id
        AND admission.session_id = binding.session_id
        AND admission.session_incarnation_id = binding.session_incarnation_id
    )
    BEGIN SELECT RAISE(ABORT, 'chat turn capability profile binding authority invariant violated'); END;

    CREATE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_no_update
    BEFORE UPDATE ON chat_turn_capability_profile_incarnation_bindings
    BEGIN SELECT RAISE(ABORT, 'chat turn capability profile incarnation bindings are append-only'); END;
    CREATE TRIGGER trg_chat_turn_capability_profile_incarnation_bindings_no_delete
    BEFORE DELETE ON chat_turn_capability_profile_incarnation_bindings
    BEGIN SELECT RAISE(ABORT, 'chat turn capability profile incarnation bindings are append-only'); END;

    CREATE TRIGGER trg_chat_turn_capability_profiles_incarnation_insert_guard
    BEFORE INSERT ON chat_turn_capability_profiles
    WHEN NOT EXISTS (
      SELECT 1
      FROM chat_turn_capability_profile_incarnation_bindings profile_binding
      JOIN chat_turn_session_incarnation_bindings binding
        ON binding.turn_id = profile_binding.turn_id
      JOIN chat_session_mutation_admissions admission
        ON admission.admission_id = binding.admission_id
      WHERE binding.turn_id = NEW.turn_id
        AND profile_binding.profile_id = NEW.profile_id
        AND profile_binding.profile_hash = NEW.profile_hash
        AND profile_binding.created_at = NEW.created_at
        AND binding.workspace_id = NEW.workspace_id AND binding.session_id = NEW.session_id
        AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
        AND admission.turn_id = NEW.turn_id
        AND admission.workspace_id = binding.workspace_id
        AND admission.session_id = binding.session_id
        AND admission.session_incarnation_id = binding.session_incarnation_id
    )
    BEGIN SELECT RAISE(ABORT, 'chat turn capability profile requires a frozen session incarnation'); END;
  `);

  if (tableExists(db, "chat_routed_context_snapshots")) {
    db.exec(`
      CREATE TRIGGER trg_chat_routed_context_snapshots_incarnation_insert_guard
      BEFORE INSERT ON chat_routed_context_snapshots
      WHEN NOT EXISTS (
        SELECT 1
        FROM chat_turn_capability_profiles profile
        JOIN chat_turn_capability_profile_incarnation_bindings profile_binding
          ON profile_binding.profile_id = profile.profile_id AND profile_binding.turn_id = profile.turn_id
        JOIN chat_turn_session_incarnation_bindings binding
          ON binding.turn_id = profile.turn_id
        JOIN chat_session_mutation_admissions admission
          ON admission.admission_id = binding.admission_id
        WHERE profile.profile_id = NEW.capability_profile_id
          AND profile.profile_hash = NEW.capability_profile_hash
          AND profile.turn_id = NEW.turn_id AND profile.session_id = NEW.session_id
          AND profile.workspace_id = NEW.workspace_id
          AND profile_binding.profile_hash = NEW.capability_profile_hash
          AND binding.session_id = NEW.session_id AND binding.workspace_id = NEW.workspace_id
          AND admission.status = 'active' AND admission.admission_kind = 'turn_write'
          AND admission.turn_id = NEW.turn_id
          AND admission.workspace_id = binding.workspace_id
          AND admission.session_id = binding.session_id
          AND admission.session_incarnation_id = binding.session_incarnation_id
      )
      BEGIN SELECT RAISE(ABORT, 'chat routed context snapshot requires an exact incarnation-bound profile'); END;
    `);
  }
}

function createSessionControlLifecycleAndAdmissionTriggers(db: DatabaseSync): void {
  db.exec(`
    CREATE TRIGGER trg_chat_session_control_auth_revoke_operations_insert_guard
    BEFORE INSERT ON chat_session_control_auth_revoke_operations
    WHEN julianday(NEW.occurred_at) IS NULL
      OR abs((julianday(NEW.occurred_at) - julianday('now')) * 86400.0) > 1.0
      OR EXISTS (
        SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
        WHERE receipt.idempotency_key = NEW.idempotency_key
      )
      OR EXISTS (
        SELECT 1 FROM chat_session_control_events event_row
        WHERE event_row.request_sha256 = NEW.request_sha256
           OR event_row.idempotency_key = NEW.idempotency_key
      )
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke operation invariant violated'); END;
    CREATE TRIGGER trg_chat_session_control_auth_revoke_operations_no_update
    BEFORE UPDATE ON chat_session_control_auth_revoke_operations
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke operations are immutable'); END;
    CREATE TRIGGER trg_chat_session_control_auth_revoke_operations_no_delete
    BEFORE DELETE ON chat_session_control_auth_revoke_operations
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke operations are immutable'); END;

    CREATE TRIGGER trg_chat_session_control_auth_revoke_targets_insert_guard
    BEFORE INSERT ON chat_session_control_auth_revoke_operation_targets
    WHEN NOT EXISTS (
      SELECT 1
      FROM chat_session_control_auth_revoke_operations operation
      WHERE operation.idempotency_key = NEW.operation_idempotency_key
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
          WHERE receipt.idempotency_key = operation.idempotency_key
        )
        AND NEW.target_index < operation.target_count
        AND NEW.event_sequence = 1 + COALESCE((
          SELECT MAX(event_sequence) FROM chat_session_control_events event_row
          WHERE event_row.session_id = NEW.session_id
        ), 0) + (
          SELECT COUNT(*) FROM chat_session_control_auth_revoke_operation_targets prior_target
          WHERE prior_target.operation_idempotency_key = NEW.operation_idempotency_key
            AND prior_target.session_id = NEW.session_id
        )
        AND (
          (NEW.target_kind = 'pending_request'
            AND NEW.event_reason_code IN ('mutation_denied', 'request_expired')
            AND EXISTS (
              SELECT 1
              FROM chat_session_control_requests request_row
              JOIN chat_session_control_grants control
                ON control.session_id = request_row.session_id AND control.is_current = 1
              WHERE request_row.request_id = NEW.request_id
                AND request_row.status = 'pending'
                AND request_row.workspace_id = NEW.workspace_id
                AND request_row.session_id = NEW.session_id
                AND control.workspace_id = NEW.workspace_id
                AND control.generation = NEW.generation
                AND control.control_revision = NEW.control_revision
                AND control.owner_kind = NEW.owner_kind
                AND control.lease_state = NEW.lease_state
                AND ((operation.binding_kind = 'companion_session'
                      AND request_row.companion_session_id = operation.binding_id)
                  OR (operation.binding_kind = 'device_grant'
                      AND request_row.device_grant_id = operation.binding_id))
                AND ((request_row.expires_at <= operation.occurred_at
                      AND NEW.event_reason_code = 'request_expired')
                  OR (request_row.expires_at > operation.occurred_at
                      AND NEW.event_reason_code = 'mutation_denied'))
            ))
          OR (NEW.target_kind = 'current_grant' AND NEW.event_reason_code = 'auth_revoked'
            AND EXISTS (
              SELECT 1 FROM chat_session_control_grants control
              WHERE control.session_id = NEW.session_id AND control.workspace_id = NEW.workspace_id
                AND control.generation = NEW.generation AND control.control_revision = NEW.control_revision
                AND control.is_current = 1 AND control.owner_kind = 'external_companion'
                AND control.lease_state = NEW.lease_state
                AND control.request_id = NEW.request_id
                AND ((operation.binding_kind = 'companion_session'
                      AND control.companion_session_id = operation.binding_id)
                  OR (operation.binding_kind = 'device_grant'
                      AND control.device_grant_id = operation.binding_id))
            ))
        )
    )
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke target invariant violated'); END;
    CREATE TRIGGER trg_chat_session_control_auth_revoke_targets_no_update
    BEFORE UPDATE ON chat_session_control_auth_revoke_operation_targets
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke operation targets are immutable'); END;
    CREATE TRIGGER trg_chat_session_control_auth_revoke_targets_no_delete
    BEFORE DELETE ON chat_session_control_auth_revoke_operation_targets
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke operation targets are immutable'); END;

    CREATE TRIGGER trg_chat_session_lifecycle_intents_insert_guard
    BEFORE INSERT ON chat_session_lifecycle_intents
    WHEN julianday(NEW.created_at) IS NULL
      OR abs((julianday(NEW.created_at) - julianday('now')) * 86400.0) > 1.0
      OR (NEW.intent_kind IN ('initialize', 'reactivate') AND NEW.session_incarnation_id <> NEW.intent_id)
      OR (NEW.intent_kind = 'delete' AND NOT EXISTS (
        SELECT 1 FROM chat_session_meta meta
        JOIN chat_session_control_grants control
          ON control.session_id = meta.session_id AND control.is_current = 1
        WHERE meta.session_id = NEW.session_id AND meta.workspace_id = NEW.workspace_id
          AND meta.revision = NEW.expected_revision AND meta.deletion_intent_id IS NULL
          AND NEW.session_incarnation_id = COALESCE(meta.lifecycle_intent_id, 'legacy-session-incarnation:' || meta.session_id)
          AND control.workspace_id = NEW.workspace_id AND control.generation = NEW.expected_generation
          AND control.owner_kind = 'operator' AND control.lease_state = 'operator_active'
      ))
      OR EXISTS (SELECT 1 FROM chat_session_control_events WHERE idempotency_key = NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT, 'chat session lifecycle intent invariant violated'); END;
    CREATE TRIGGER trg_chat_session_lifecycle_intents_no_update
    BEFORE UPDATE ON chat_session_lifecycle_intents
    BEGIN SELECT RAISE(ABORT, 'chat session lifecycle intents are immutable'); END;
    CREATE TRIGGER trg_chat_session_lifecycle_intents_no_delete
    BEFORE DELETE ON chat_session_lifecycle_intents
    BEGIN SELECT RAISE(ABORT, 'chat session lifecycle intents are immutable'); END;

    CREATE TRIGGER trg_chat_session_meta_lifecycle_insert_guard
    BEFORE INSERT ON chat_session_meta
    WHEN NEW.lifecycle_intent_id IS NULL OR NEW.deletion_intent_id IS NOT NULL OR NOT EXISTS (
      SELECT 1
      FROM chat_session_lifecycle_intents intent
      WHERE intent.intent_id = NEW.lifecycle_intent_id
        AND intent.workspace_id = NEW.workspace_id AND intent.session_id = NEW.session_id
        AND intent.intent_kind IN ('initialize', 'reactivate')
        AND intent.session_incarnation_id = intent.intent_id
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_events event_row
          WHERE event_row.idempotency_key = intent.idempotency_key
        )
        AND (
          (intent.intent_kind = 'initialize' AND intent.next_generation = 1
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id
            ))
          OR (intent.intent_kind = 'reactivate'
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_grants current_row
              WHERE current_row.session_id = NEW.session_id AND current_row.is_current = 1
            )
            AND (SELECT MAX(prior.generation) FROM chat_session_control_grants prior
                 WHERE prior.session_id = NEW.session_id) = intent.expected_generation
            AND EXISTS (
              SELECT 1 FROM chat_session_control_grants terminal
              WHERE terminal.session_id = NEW.session_id AND terminal.generation = intent.expected_generation
                AND terminal.workspace_id = NEW.workspace_id AND terminal.is_current = 0
                AND terminal.owner_kind = 'operator' AND terminal.lease_state = 'deleted'
            ))
        )
    )
    BEGIN SELECT RAISE(ABORT, 'chat session metadata requires an exact lifecycle intent'); END;

    CREATE TRIGGER trg_chat_session_meta_lifecycle_after_insert
    AFTER INSERT ON chat_session_meta
    BEGIN
      INSERT INTO chat_session_control_grants (
        workspace_id, session_id, generation, is_current, owner_kind, lease_state,
        requested_capabilities_json, requested_capabilities_sha256,
        effective_capabilities_json, effective_capabilities_sha256,
        control_revision, transition_idempotency_key, transition_request_sha256,
        created_at, updated_at
      )
      SELECT intent.workspace_id, intent.session_id, intent.next_generation, 1, 'operator', 'operator_active',
        '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        1, intent.idempotency_key, intent.request_sha256, intent.created_at, intent.created_at
      FROM chat_session_lifecycle_intents intent WHERE intent.intent_id = NEW.lifecycle_intent_id;

      INSERT INTO chat_session_control_events (
        event_id, workspace_id, session_id, event_sequence, request_id,
        previous_generation, next_generation, previous_owner_kind, next_owner_kind,
        previous_lease_state, next_lease_state, reason_code, actor_kind, actor_id,
        companion_session_id, device_grant_id, idempotency_key, request_sha256,
        correlation_id, created_at
      )
      SELECT intent.event_id, intent.workspace_id, intent.session_id,
        COALESCE((SELECT MAX(event_sequence) + 1 FROM chat_session_control_events
                  WHERE session_id = intent.session_id), 1),
        NULL, intent.expected_generation, intent.next_generation,
        CASE WHEN intent.intent_kind = 'reactivate' THEN 'operator' ELSE NULL END,
        'operator', CASE WHEN intent.intent_kind = 'reactivate' THEN 'deleted' ELSE NULL END,
        'operator_active',
        CASE WHEN intent.intent_kind = 'initialize' THEN 'session_initialized' ELSE 'session_reactivated' END,
        intent.actor_kind, intent.actor_id, NULL, NULL, intent.idempotency_key,
        intent.request_sha256, intent.correlation_id, intent.created_at
      FROM chat_session_lifecycle_intents intent WHERE intent.intent_id = NEW.lifecycle_intent_id;
    END;

    CREATE TRIGGER trg_chat_session_meta_workspace_and_intent_update_guard
    BEFORE UPDATE ON chat_session_meta
    WHEN NEW.workspace_id <> OLD.workspace_id
      OR NEW.lifecycle_intent_id IS NOT OLD.lifecycle_intent_id
      OR (NEW.deletion_intent_id IS NOT OLD.deletion_intent_id AND NOT (
        OLD.deletion_intent_id IS NULL AND NEW.deletion_intent_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM chat_session_lifecycle_intents intent
          JOIN chat_session_control_grants control
            ON control.session_id = OLD.session_id AND control.is_current = 1
          WHERE intent.intent_id = NEW.deletion_intent_id
            AND intent.intent_kind = 'delete'
            AND intent.workspace_id = OLD.workspace_id AND intent.session_id = OLD.session_id
            AND intent.session_incarnation_id = COALESCE(OLD.lifecycle_intent_id, 'legacy-session-incarnation:' || OLD.session_id)
            AND intent.expected_revision = OLD.revision
            AND intent.expected_generation = control.generation
            AND control.workspace_id = OLD.workspace_id AND control.owner_kind = 'operator'
            AND control.lease_state = 'operator_active'
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_events event_row
              WHERE event_row.idempotency_key = intent.idempotency_key
            )
        )
      ))
    BEGIN SELECT RAISE(ABORT, 'chat session workspace is immutable and lifecycle intent replacement is restricted'); END;

    CREATE TRIGGER trg_chat_session_control_operator_generation_lifecycle_guard
    BEFORE INSERT ON chat_session_control_grants
    WHEN NEW.owner_kind = 'operator'
      AND (
        NOT EXISTS (SELECT 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id)
        OR EXISTS (
          SELECT 1 FROM chat_session_control_grants prior
          WHERE prior.session_id = NEW.session_id
            AND prior.generation = (SELECT MAX(generation) FROM chat_session_control_grants WHERE session_id = NEW.session_id)
            AND prior.lease_state = 'deleted'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM chat_session_meta meta
        JOIN chat_session_lifecycle_intents intent ON intent.intent_id = meta.lifecycle_intent_id
        WHERE meta.session_id = NEW.session_id AND meta.workspace_id = NEW.workspace_id
          AND intent.session_id = NEW.session_id AND intent.workspace_id = NEW.workspace_id
          AND intent.intent_kind IN ('initialize', 'reactivate')
          AND intent.next_generation = NEW.generation
          AND intent.idempotency_key = NEW.transition_idempotency_key
          AND intent.request_sha256 = NEW.transition_request_sha256
      )
    BEGIN SELECT RAISE(ABORT, 'operator generation requires exact lifecycle intent'); END;

    CREATE TRIGGER trg_chat_session_mutation_admissions_insert_guard
    BEFORE INSERT ON chat_session_mutation_admissions
    WHEN NEW.status <> 'active'
      OR julianday(NEW.created_at) IS NULL
      OR abs((julianday(NEW.created_at) - julianday('now')) * 86400.0) > 1.0
      OR (NEW.admission_kind = 'turn_write' AND (
        NEW.runtime_lease_revision <> 1
        OR NEW.runtime_lease_relinquished_at IS NOT NULL
        OR NEW.runtime_last_heartbeat_at <> NEW.created_at
        OR abs((julianday(NEW.runtime_last_heartbeat_at) - julianday('now')) * 86400.0) > 1.0
        OR abs((julianday(NEW.runtime_lease_expires_at) - julianday('now')) * 86400.0 - 60.0) > 1.0
      ))
      OR NOT EXISTS (
        SELECT 1 FROM chat_session_meta meta
        JOIN chat_session_control_grants control
          ON control.session_id = meta.session_id AND control.is_current = 1
        WHERE meta.session_id = NEW.session_id AND meta.workspace_id = NEW.workspace_id
          AND meta.revision = NEW.aggregate_revision AND meta.deletion_intent_id IS NULL
          AND NEW.session_incarnation_id = COALESCE(meta.lifecycle_intent_id, 'legacy-session-incarnation:' || meta.session_id)
          AND control.workspace_id = NEW.workspace_id
          AND control.generation = NEW.controller_generation
          AND ((NEW.actor_kind IN ('operator', 'system')
                AND control.owner_kind = 'operator' AND control.lease_state = 'operator_active')
            OR (NEW.actor_kind = 'external_companion'
                AND control.owner_kind = 'external_companion' AND control.lease_state = 'external_live'
                AND control.companion_session_id = NEW.actor_id))
      )
    BEGIN SELECT RAISE(ABORT, 'session mutation admission authority invariant violated'); END;

    CREATE TRIGGER trg_chat_session_mutation_admissions_after_insert
    AFTER INSERT ON chat_session_mutation_admissions
    BEGIN
      INSERT INTO chat_session_mutation_admission_events (
        event_id, admission_id, session_incarnation_id, workspace_id, session_id, turn_id,
        runtime_owner_id, runtime_lease_revision,
        event_sequence, event_type,
        admission_kind, aggregate_revision, controller_generation, actor_kind, actor_id,
        operation, material_sha256, idempotency_key, request_sha256, correlation_id,
        terminal_authority_kind, terminal_runtime_owner_id, terminal_runtime_lease_revision,
        terminal_durable_run_id, terminal_durable_lease_owner_id, terminal_durable_attempt_count,
        terminal_durable_run_version, terminal_durable_run_status, terminal_lifecycle_intent_id,
        terminal_control_event_id,
        created_at
      ) VALUES (
        NEW.admit_event_id, NEW.admission_id, NEW.session_incarnation_id,
        NEW.workspace_id, NEW.session_id, NEW.turn_id,
        NEW.runtime_owner_id, NEW.runtime_lease_revision, 1, 'admitted',
        NEW.admission_kind, NEW.aggregate_revision, NEW.controller_generation, NEW.actor_kind, NEW.actor_id,
        NEW.operation, NEW.material_sha256, NEW.idempotency_key, NEW.request_sha256,
        NEW.correlation_id,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NEW.created_at
      );
    END;

    CREATE TRIGGER trg_chat_session_mutation_admissions_update_guard
    BEFORE UPDATE ON chat_session_mutation_admissions
    WHEN NEW.admission_id <> OLD.admission_id OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.session_id <> OLD.session_id OR NEW.session_incarnation_id <> OLD.session_incarnation_id
      OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.runtime_owner_id IS NOT OLD.runtime_owner_id
      OR NEW.admission_kind <> OLD.admission_kind
      OR NEW.aggregate_revision <> OLD.aggregate_revision
      OR NEW.controller_generation <> OLD.controller_generation
      OR NEW.actor_kind <> OLD.actor_kind OR NEW.actor_id <> OLD.actor_id
      OR NEW.operation <> OLD.operation OR NEW.material_sha256 <> OLD.material_sha256
      OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_sha256 <> OLD.request_sha256
      OR NEW.correlation_id <> OLD.correlation_id OR NEW.admit_event_id <> OLD.admit_event_id
      OR NEW.created_at <> OLD.created_at OR OLD.status <> 'active'
      OR NOT (
        (NEW.status = 'active' AND OLD.status = 'active'
          AND OLD.runtime_lease_relinquished_at IS NULL
          AND julianday(OLD.runtime_lease_expires_at) > julianday('now')
          AND NEW.runtime_lease_relinquished_at IS NULL
          AND NEW.runtime_lease_revision = OLD.runtime_lease_revision + 1
          AND NEW.runtime_last_heartbeat_at >= OLD.runtime_last_heartbeat_at
          AND abs((julianday(NEW.runtime_last_heartbeat_at) - julianday('now')) * 86400.0) <= 1.0
          AND abs((julianday(NEW.runtime_lease_expires_at) - julianday('now')) * 86400.0 - 60.0) <= 1.0
          AND NEW.closed_at IS OLD.closed_at AND NEW.terminal_actor_id IS OLD.terminal_actor_id
          AND NEW.terminal_event_id IS OLD.terminal_event_id
          AND NEW.terminal_idempotency_key IS OLD.terminal_idempotency_key
          AND NEW.terminal_correlation_id IS OLD.terminal_correlation_id
          AND NOT EXISTS (
            SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
            WHERE durable_binding.admission_id = OLD.admission_id
          ))
        OR (NEW.status = 'active' AND OLD.status = 'active'
          AND OLD.runtime_lease_relinquished_at IS NULL
          AND NEW.runtime_lease_relinquished_at IS NOT NULL
          AND abs((julianday(NEW.runtime_lease_relinquished_at) - julianday('now')) * 86400.0) <= 1.0
          AND NEW.runtime_lease_revision = OLD.runtime_lease_revision + 1
          AND NEW.runtime_last_heartbeat_at = OLD.runtime_last_heartbeat_at
          AND NEW.runtime_lease_expires_at = OLD.runtime_lease_expires_at
          AND NEW.closed_at IS OLD.closed_at AND NEW.terminal_actor_id IS OLD.terminal_actor_id
          AND NEW.terminal_event_id IS OLD.terminal_event_id
          AND NEW.terminal_idempotency_key IS OLD.terminal_idempotency_key
          AND NEW.terminal_correlation_id IS OLD.terminal_correlation_id
          AND EXISTS (
            SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
            WHERE durable_binding.admission_id = OLD.admission_id
              AND durable_binding.turn_id = OLD.turn_id
              AND durable_binding.session_incarnation_id = OLD.session_incarnation_id
          ))
        OR (NEW.status IN ('completed', 'cancelled')
          AND NEW.runtime_last_heartbeat_at IS OLD.runtime_last_heartbeat_at
          AND NEW.runtime_lease_expires_at IS OLD.runtime_lease_expires_at
          AND NEW.runtime_lease_revision IS OLD.runtime_lease_revision
          AND NEW.runtime_lease_relinquished_at IS OLD.runtime_lease_relinquished_at
          AND julianday(NEW.closed_at) IS NOT NULL
          AND abs((julianday(NEW.closed_at) - julianday('now')) * 86400.0) <= 1.0
          AND (
            (OLD.admission_kind = 'synchronous' AND NEW.terminal_authority_kind = 'synchronous')
            OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'request_runtime'
              AND OLD.runtime_lease_relinquished_at IS NULL
              AND julianday(OLD.runtime_lease_expires_at) > julianday('now')
              AND NEW.terminal_runtime_owner_id = OLD.runtime_owner_id
              AND NEW.terminal_runtime_lease_revision = OLD.runtime_lease_revision
              AND NOT EXISTS (
                SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                WHERE durable_binding.admission_id = OLD.admission_id
              ))
            OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'expired_recovery'
              AND NEW.status = 'cancelled'
              AND OLD.runtime_lease_relinquished_at IS NULL
              AND julianday(OLD.runtime_lease_expires_at) <= julianday('now')
              AND NEW.terminal_runtime_owner_id = OLD.runtime_owner_id
              AND NEW.terminal_runtime_lease_revision = OLD.runtime_lease_revision
              AND NOT EXISTS (
                SELECT 1 FROM chat_turn_mutation_admission_durable_bindings durable_binding
                WHERE durable_binding.admission_id = OLD.admission_id
              ))
            OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'durable_run'
              AND EXISTS (
                SELECT 1
                FROM chat_turn_mutation_admission_durable_bindings durable_binding
                JOIN durable_runs run ON run.run_id = durable_binding.durable_run_id
                WHERE durable_binding.admission_id = OLD.admission_id
                  AND durable_binding.turn_id = OLD.turn_id
                  AND durable_binding.workspace_id = OLD.workspace_id
                  AND durable_binding.session_id = OLD.session_id
                  AND durable_binding.session_incarnation_id = OLD.session_incarnation_id
                  AND run.run_id = NEW.terminal_durable_run_id
                  AND run.workflow_key = 'chat.turn.execute' AND run.status = 'running'
                  AND run.lease_owner_id = NEW.terminal_durable_lease_owner_id
                  AND run.attempt_count = NEW.terminal_durable_attempt_count
                  AND run.version = NEW.terminal_durable_run_version
                  AND julianday(run.lease_expires_at) > julianday('now')
                  AND json_valid(run.payload_json) = 1
                  AND json_extract(run.payload_json, '$.version') = 'chat.turn.execute.v2'
                  AND json_extract(run.payload_json, '$.admissionId') = OLD.admission_id
                  AND json_extract(run.payload_json, '$.sessionIncarnationId') = OLD.session_incarnation_id
                  AND json_extract(run.payload_json, '$.admissionMaterialSha256') = OLD.material_sha256
                  AND json_extract(run.payload_json, '$.workspaceId') = OLD.workspace_id
                  AND json_extract(run.payload_json, '$.admissionAggregateRevision') = OLD.aggregate_revision
                  AND json_extract(run.payload_json, '$.admissionControllerGeneration') = OLD.controller_generation
                  AND json_extract(run.payload_json, '$.sessionId') = OLD.session_id
                  AND json_extract(run.payload_json, '$.turnId') = OLD.turn_id
              ))
            OR (OLD.admission_kind = 'turn_write' AND NEW.terminal_authority_kind = 'durable_terminal'
              AND EXISTS (
                SELECT 1
                FROM chat_turn_mutation_admission_durable_bindings durable_binding
                JOIN durable_runs run ON run.run_id = durable_binding.durable_run_id
                WHERE durable_binding.admission_id = OLD.admission_id
                  AND durable_binding.turn_id = OLD.turn_id
                  AND durable_binding.workspace_id = OLD.workspace_id
                  AND durable_binding.session_id = OLD.session_id
                  AND durable_binding.session_incarnation_id = OLD.session_incarnation_id
                  AND run.run_id = NEW.terminal_durable_run_id
                  AND run.workflow_key = 'chat.turn.execute'
                  AND run.status = NEW.terminal_durable_run_status
                  AND run.status IN ('completed', 'failed', 'cancelled', 'dead_lettered')
                  AND ((run.status = 'completed' AND NEW.status = 'completed')
                    OR (run.status <> 'completed' AND NEW.status = 'cancelled'))
                  AND run.version = NEW.terminal_durable_run_version
                  AND run.lease_owner_id IS NULL AND run.lease_expires_at IS NULL
                  AND json_valid(run.payload_json) = 1
                  AND json_extract(run.payload_json, '$.version') = 'chat.turn.execute.v2'
                  AND json_extract(run.payload_json, '$.admissionId') = OLD.admission_id
                  AND json_extract(run.payload_json, '$.sessionIncarnationId') = OLD.session_incarnation_id
                  AND json_extract(run.payload_json, '$.admissionMaterialSha256') = OLD.material_sha256
                  AND json_extract(run.payload_json, '$.workspaceId') = OLD.workspace_id
                  AND json_extract(run.payload_json, '$.admissionAggregateRevision') = OLD.aggregate_revision
                  AND json_extract(run.payload_json, '$.admissionControllerGeneration') = OLD.controller_generation
                  AND json_extract(run.payload_json, '$.sessionId') = OLD.session_id
                  AND json_extract(run.payload_json, '$.turnId') = OLD.turn_id
                  AND json_valid(run.metadata_json) = 1
                  AND json_type(run.metadata_json, '$.linkedFinalizationPending') IS NULL
                  AND json_type(run.metadata_json, '$.autonomousChatPostCommitPending') IS NULL
                  AND json_type(run.metadata_json, '$.generalChatPostCommitPending') IS NULL
                  AND json_type(run.metadata_json, '$.chatTurnAdmissionHandoff') = 'object'
                  AND (
                    SELECT COUNT(*) FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff') marker_field
                  ) = 10
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff') marker_field
                    WHERE marker_field.key NOT IN (
                      'admissionId', 'childRunIds', 'childRunIdsSha256', 'committedAt',
                      'parentLocalEffectsStatus', 'parentRunId', 'postCommitGenerationId',
                      'sessionIncarnationId', 'turnId', 'version'
                    )
                  )
                  AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.version') = 1
                  AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.admissionId') = OLD.admission_id
                  AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.sessionIncarnationId')
                    = OLD.session_incarnation_id
                  AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.turnId') = OLD.turn_id
                  AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.parentRunId') = run.run_id
                  AND json_type(run.metadata_json, '$.chatTurnAdmissionHandoff.postCommitGenerationId') = 'text'
                  AND length(json_extract(
                    run.metadata_json, '$.chatTurnAdmissionHandoff.postCommitGenerationId'
                  )) > 0
                  AND json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.parentLocalEffectsStatus') = 'settled'
                  AND json_type(run.metadata_json, '$.generalChatPostCommit') = 'object'
                  AND json_extract(run.metadata_json, '$.generalChatPostCommit.generationId')
                    = json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.postCommitGenerationId')
                  AND json_extract(run.metadata_json, '$.generalChatPostCommit.parentLocalEffectsStatus') = 'settled'
                  AND json_type(run.metadata_json, '$.generalChatPostCommit.completedEffects') = 'array'
                  AND (
                    SELECT COUNT(DISTINCT local_effect.value)
                    FROM json_each(run.metadata_json, '$.generalChatPostCommit.completedEffects') local_effect
                    WHERE typeof(local_effect.value) = 'text'
                      AND local_effect.value IN ('capability_gap', 'realtime', 'agent_end')
                  ) = 3
                  AND json_type(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds') = 'array'
                  AND gc_sha256(json(json_extract(
                    run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds'
                  ))) = json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIdsSha256')
                  AND julianday(json_extract(
                    run.metadata_json, '$.chatTurnAdmissionHandoff.committedAt'
                  )) IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds') left_child
                    JOIN json_each(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds') right_child
                      ON CAST(left_child.key AS INTEGER) < CAST(right_child.key AS INTEGER)
                    WHERE typeof(left_child.value) <> 'text' OR typeof(right_child.value) <> 'text'
                      OR length(left_child.value) = 0 OR length(right_child.value) = 0
                      OR left_child.value >= right_child.value
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM json_each(run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds') marker_child
                    WHERE typeof(marker_child.value) <> 'text' OR NOT EXISTS (
                      SELECT 1
                      FROM durable_runs child_run
                      JOIN chat_session_mutation_admissions child_admission
                        ON child_admission.admission_id = json_extract(
                          child_run.payload_json, '$.childAdmission.admissionId'
                        )
                      WHERE child_run.run_id = marker_child.value
                        AND child_run.workflow_key = 'chat.post_commit.effect'
                        AND json_valid(child_run.payload_json) = 1
                        AND json_valid(child_run.metadata_json) = 1
                        AND json_extract(child_run.payload_json, '$.version') = 'chat.post_commit.effect.v2'
                        AND json_extract(child_run.payload_json, '$.parentRunId') = run.run_id
                        AND json_extract(child_run.payload_json, '$.postCommitGenerationId')
                          = json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.postCommitGenerationId')
                        AND json_extract(child_run.payload_json, '$.effect')
                          = json_extract(child_run.metadata_json, '$.effect')
                        AND json_type(child_run.payload_json, '$.effect') = 'text'
                        AND json_extract(child_run.payload_json, '$.effect') IN (
                          'commitments', 'background_review', 'memory_maintenance'
                        )
                        AND json_type(child_run.payload_json, '$.traceStatus') = 'text'
                        AND length(json_extract(child_run.payload_json, '$.traceStatus')) > 0
                        AND json_extract(child_run.payload_json, '$.parentRunId')
                          = json_extract(child_run.metadata_json, '$.parentRunId')
                        AND json_extract(child_run.payload_json, '$.postCommitGenerationId')
                          = json_extract(child_run.metadata_json, '$.postCommitGenerationId')
                        AND json(json_extract(child_run.payload_json, '$.childAdmission'))
                          = json(json_extract(child_run.metadata_json, '$.childAdmission'))
                        AND json(json_extract(child_run.payload_json, '$.postCommitEligibility'))
                          = json(json_extract(child_run.metadata_json, '$.postCommitEligibility'))
                        AND json_extract(child_run.metadata_json, '$.workspaceId') = OLD.workspace_id
                        AND json_extract(child_run.metadata_json, '$.sessionId') = OLD.session_id
                        AND json_extract(child_run.metadata_json, '$.turnId') = OLD.turn_id
                        AND json_type(child_run.payload_json, '$.childAdmission') = 'object'
                        AND (
                          SELECT COUNT(*) FROM json_each(
                            child_run.payload_json, '$.childAdmission'
                          ) child_admission_field
                        ) = 10
                        AND NOT EXISTS (
                          SELECT 1 FROM json_each(
                            child_run.payload_json, '$.childAdmission'
                          ) child_admission_field
                          WHERE child_admission_field.key NOT IN (
                            'actorId', 'actorKind', 'admissionId', 'aggregateRevision',
                            'controllerGeneration', 'materialSha256', 'operation', 'sessionId',
                            'sessionIncarnationId', 'workspaceId'
                          )
                        )
                        AND json_type(child_run.payload_json, '$.childAdmission.aggregateRevision') = 'integer'
                        AND json_type(child_run.payload_json, '$.childAdmission.controllerGeneration') = 'integer'
                        AND child_admission.admission_id = json_extract(
                          child_run.payload_json, '$.childAdmission.admissionId'
                        )
                        AND child_admission.session_incarnation_id = json_extract(
                          child_run.payload_json, '$.childAdmission.sessionIncarnationId'
                        )
                        AND child_admission.workspace_id = json_extract(
                          child_run.payload_json, '$.childAdmission.workspaceId'
                        )
                        AND child_admission.session_id = json_extract(
                          child_run.payload_json, '$.childAdmission.sessionId'
                        )
                        AND child_admission.aggregate_revision = json_extract(
                          child_run.payload_json, '$.childAdmission.aggregateRevision'
                        )
                        AND child_admission.controller_generation = json_extract(
                          child_run.payload_json, '$.childAdmission.controllerGeneration'
                        )
                        AND child_admission.actor_kind = json_extract(
                          child_run.payload_json, '$.childAdmission.actorKind'
                        )
                        AND child_admission.actor_id = json_extract(
                          child_run.payload_json, '$.childAdmission.actorId'
                        )
                        AND child_admission.operation = json_extract(
                          child_run.payload_json, '$.childAdmission.operation'
                        )
                        AND child_admission.material_sha256 = json_extract(
                          child_run.payload_json, '$.childAdmission.materialSha256'
                        )
                        AND child_admission.aggregate_revision >= OLD.aggregate_revision
                        AND json_type(child_run.payload_json, '$.postCommitEligibility') = 'object'
                        AND (
                          SELECT COUNT(*) FROM json_each(
                            child_run.payload_json, '$.postCommitEligibility'
                          ) eligibility_field
                        ) = 4
                        AND NOT EXISTS (
                          SELECT 1 FROM json_each(
                            child_run.payload_json, '$.postCommitEligibility'
                          ) eligibility_field
                          WHERE eligibility_field.key NOT IN (
                            'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession', 'version'
                          )
                        )
                        AND json_type(child_run.payload_json, '$.postCommitEligibility.version') = 'integer'
                        AND json_extract(child_run.payload_json, '$.postCommitEligibility.version') = 1
                        AND json_type(
                          child_run.payload_json, '$.postCommitEligibility.autonomyEnabledAtParentSettlement'
                        ) IN ('true', 'false')
                        AND json_type(
                          child_run.payload_json, '$.postCommitEligibility.evalIntegrityTurn'
                        ) IN ('true', 'false')
                        AND json_type(
                          child_run.payload_json, '$.postCommitEligibility.humanSession'
                        ) IN ('true', 'false')
                        AND child_admission.admission_kind = 'synchronous'
                        AND child_admission.turn_id IS NULL
                        AND child_admission.session_incarnation_id = OLD.session_incarnation_id
                        AND child_admission.workspace_id = OLD.workspace_id
                        AND child_admission.session_id = OLD.session_id
                        AND child_admission.controller_generation = OLD.controller_generation
                        AND child_admission.actor_kind = OLD.actor_kind
                        AND child_admission.actor_id = OLD.actor_id
                        AND child_admission.operation = 'chat_post_commit_child'
                        AND child_admission.material_sha256 = gc_sha256(
                          '{"childRunId":' || json_quote(child_run.run_id)
                          || ',"effect":' || json_quote(json_extract(child_run.payload_json, '$.effect'))
                          || ',"operation":"chat_post_commit_child"'
                          || ',"parentRunId":' || json_quote(run.run_id)
                          || ',"postCommitEligibility":{"autonomyEnabledAtParentSettlement":'
                          || CASE json_type(
                            child_run.payload_json, '$.postCommitEligibility.autonomyEnabledAtParentSettlement'
                          ) WHEN 'true' THEN 'true' ELSE 'false' END
                          || ',"evalIntegrityTurn":' || CASE json_type(
                            child_run.payload_json, '$.postCommitEligibility.evalIntegrityTurn'
                          ) WHEN 'true' THEN 'true' ELSE 'false' END
                          || ',"humanSession":' || CASE json_type(
                            child_run.payload_json, '$.postCommitEligibility.humanSession'
                          ) WHEN 'true' THEN 'true' ELSE 'false' END
                          || ',"version":1}'
                          || ',"postCommitGenerationId":' || json_quote(json_extract(
                            run.metadata_json, '$.chatTurnAdmissionHandoff.postCommitGenerationId'
                          ))
                          || ',"sessionId":' || json_quote(OLD.session_id)
                          || ',"sessionIncarnationId":' || json_quote(OLD.session_incarnation_id)
                          || ',"sourceTurnId":' || json_quote(OLD.turn_id)
                          || ',"version":1'
                          || ',"workspaceId":' || json_quote(OLD.workspace_id) || '}'
                      )
                    )
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM durable_runs omitted_child
                    WHERE omitted_child.workflow_key = 'chat.post_commit.effect'
                      AND json_valid(omitted_child.payload_json) = 1
                      AND json_extract(omitted_child.payload_json, '$.version') = 'chat.post_commit.effect.v2'
                      AND json_extract(omitted_child.payload_json, '$.parentRunId') = run.run_id
                      AND json_extract(omitted_child.payload_json, '$.postCommitGenerationId')
                        = json_extract(run.metadata_json, '$.chatTurnAdmissionHandoff.postCommitGenerationId')
                      AND NOT EXISTS (
                        SELECT 1
                        FROM json_each(
                          run.metadata_json, '$.chatTurnAdmissionHandoff.childRunIds'
                        ) listed_child
                        WHERE listed_child.value = omitted_child.run_id
                      )
                  )
              ))
            OR (OLD.admission_kind = 'synchronous'
              AND NEW.terminal_authority_kind = 'post_commit_child_stage'
              AND NEW.terminal_actor_id = 'system:chat-post-commit-stage'
              AND NEW.terminal_correlation_id = NEW.terminal_durable_run_id
              AND EXISTS (
                SELECT 1 FROM durable_runs run
                WHERE run.run_id = NEW.terminal_durable_run_id
                  AND run.workflow_key = 'chat.post_commit.effect' AND run.status = 'running'
                  AND run.lease_owner_id = NEW.terminal_durable_lease_owner_id
                  AND run.attempt_count = NEW.terminal_durable_attempt_count
                  AND run.version = NEW.terminal_durable_run_version
                  AND julianday(run.lease_expires_at) > julianday('now')
                  AND json_valid(run.payload_json) = 1 AND json_valid(run.metadata_json) = 1
                  AND json_extract(run.payload_json, '$.version') = 'chat.post_commit.effect.v2'
                  AND json_type(run.payload_json, '$.effect') = 'text'
                  AND json_extract(run.payload_json, '$.effect') IN (
                    'commitments', 'background_review', 'memory_maintenance'
                  )
                  AND json_type(run.payload_json, '$.traceStatus') = 'text'
                  AND length(json_extract(run.payload_json, '$.traceStatus')) > 0
                  AND json_type(run.payload_json, '$.childAdmission') = 'object'
                  AND (
                    SELECT COUNT(*) FROM json_each(run.payload_json, '$.childAdmission') child_admission_field
                  ) = 10
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(run.payload_json, '$.childAdmission') child_admission_field
                    WHERE child_admission_field.key NOT IN (
                      'actorId', 'actorKind', 'admissionId', 'aggregateRevision',
                      'controllerGeneration', 'materialSha256', 'operation', 'sessionId',
                      'sessionIncarnationId', 'workspaceId'
                    )
                  )
                  AND json_extract(run.payload_json, '$.childAdmission.admissionId') = OLD.admission_id
                  AND json_extract(run.payload_json, '$.childAdmission.sessionIncarnationId')
                    = OLD.session_incarnation_id
                  AND json_extract(run.payload_json, '$.childAdmission.workspaceId') = OLD.workspace_id
                  AND json_extract(run.payload_json, '$.childAdmission.sessionId') = OLD.session_id
                  AND json_extract(run.payload_json, '$.childAdmission.aggregateRevision') = OLD.aggregate_revision
                  AND json_extract(run.payload_json, '$.childAdmission.controllerGeneration')
                    = OLD.controller_generation
                  AND json_extract(run.payload_json, '$.childAdmission.actorKind') = OLD.actor_kind
                  AND json_extract(run.payload_json, '$.childAdmission.actorId') = OLD.actor_id
                  AND json_extract(run.payload_json, '$.childAdmission.operation') = OLD.operation
                  AND json_extract(run.payload_json, '$.childAdmission.materialSha256') = OLD.material_sha256
                  AND json(json_extract(run.payload_json, '$.childAdmission'))
                    = json(json_extract(run.metadata_json, '$.childAdmission'))
                  AND json(json_extract(run.payload_json, '$.postCommitEligibility'))
                    = json(json_extract(run.metadata_json, '$.postCommitEligibility'))
                  AND json_type(run.payload_json, '$.postCommitEligibility') = 'object'
                  AND (
                    SELECT COUNT(*) FROM json_each(
                      run.payload_json, '$.postCommitEligibility'
                    ) eligibility_field
                  ) = 4
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(run.payload_json, '$.postCommitEligibility') eligibility_field
                    WHERE eligibility_field.key NOT IN (
                      'autonomyEnabledAtParentSettlement', 'evalIntegrityTurn', 'humanSession', 'version'
                    )
                  )
                  AND json_type(run.payload_json, '$.postCommitEligibility.version') = 'integer'
                  AND json_extract(run.payload_json, '$.postCommitEligibility.version') = 1
                  AND json_type(
                    run.payload_json, '$.postCommitEligibility.autonomyEnabledAtParentSettlement'
                  ) IN ('true', 'false')
                  AND json_type(run.payload_json, '$.postCommitEligibility.evalIntegrityTurn') IN ('true', 'false')
                  AND json_type(run.payload_json, '$.postCommitEligibility.humanSession') IN ('true', 'false')
                  AND json_extract(run.payload_json, '$.parentRunId')
                    = json_extract(run.metadata_json, '$.parentRunId')
                  AND json_extract(run.payload_json, '$.postCommitGenerationId')
                    = json_extract(run.metadata_json, '$.postCommitGenerationId')
                  AND json_extract(run.payload_json, '$.effect') = json_extract(run.metadata_json, '$.effect')
                  AND json_extract(run.metadata_json, '$.workspaceId') = OLD.workspace_id
                  AND json_extract(run.metadata_json, '$.sessionId') = OLD.session_id
                  AND json_type(run.metadata_json, '$.turnId') = 'text'
                  AND length(json_extract(run.metadata_json, '$.turnId')) > 0
                  AND OLD.material_sha256 = gc_sha256(
                    '{"childRunId":' || json_quote(run.run_id)
                    || ',"effect":' || json_quote(json_extract(run.payload_json, '$.effect'))
                    || ',"operation":"chat_post_commit_child"'
                    || ',"parentRunId":' || json_quote(json_extract(run.payload_json, '$.parentRunId'))
                    || ',"postCommitEligibility":{"autonomyEnabledAtParentSettlement":'
                    || CASE json_type(
                      run.payload_json, '$.postCommitEligibility.autonomyEnabledAtParentSettlement'
                    ) WHEN 'true' THEN 'true' ELSE 'false' END
                    || ',"evalIntegrityTurn":' || CASE json_type(
                      run.payload_json, '$.postCommitEligibility.evalIntegrityTurn'
                    ) WHEN 'true' THEN 'true' ELSE 'false' END
                    || ',"humanSession":' || CASE json_type(
                      run.payload_json, '$.postCommitEligibility.humanSession'
                    ) WHEN 'true' THEN 'true' ELSE 'false' END
                    || ',"version":1}'
                    || ',"postCommitGenerationId":' || json_quote(json_extract(
                      run.payload_json, '$.postCommitGenerationId'
                    ))
                    || ',"sessionId":' || json_quote(OLD.session_id)
                    || ',"sessionIncarnationId":' || json_quote(OLD.session_incarnation_id)
                    || ',"sourceTurnId":' || json_quote(json_extract(run.metadata_json, '$.turnId'))
                    || ',"version":1'
                    || ',"workspaceId":' || json_quote(OLD.workspace_id) || '}'
                  )
                  AND ((NEW.status = 'completed' AND (
                    (json_extract(run.payload_json, '$.effect') = 'commitments'
                      AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                        || run.run_id || ':commitments_write:allowed')
                    OR (json_extract(run.payload_json, '$.effect') = 'background_review'
                      AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                        || run.run_id || ':background_evidence:allowed')
                    OR (json_extract(run.payload_json, '$.effect') = 'memory_maintenance'
                      AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                        || run.run_id || ':memory_maintenance_evaluation:allowed')
                  )) OR (NEW.status = 'cancelled' AND (
                    (json_extract(run.payload_json, '$.effect') = 'commitments'
                      AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                        || run.run_id || ':commitments_write:late_blocked')
                    OR (json_extract(run.payload_json, '$.effect') = 'background_review'
                      AND NEW.terminal_idempotency_key IN (
                        'chat-post-commit-child-stage:v2:' || run.run_id || ':background_counter:late_blocked',
                        'chat-post-commit-child-stage:v2:' || run.run_id || ':background_evidence:late_blocked'
                      ))
                    OR (json_extract(run.payload_json, '$.effect') = 'memory_maintenance'
                      AND NEW.terminal_idempotency_key = 'chat-post-commit-child-stage:v2:'
                        || run.run_id || ':memory_maintenance_evaluation:late_blocked')
                  )))
              ))
            OR (NEW.terminal_authority_kind = 'lifecycle_delete'
              AND NEW.status = 'cancelled'
              AND EXISTS (
                SELECT 1 FROM chat_session_lifecycle_intents intent
                JOIN chat_session_meta meta ON meta.deletion_intent_id = intent.intent_id
                WHERE intent.intent_id = NEW.terminal_lifecycle_intent_id
                  AND intent.intent_kind = 'delete'
                  AND intent.workspace_id = OLD.workspace_id AND intent.session_id = OLD.session_id
                  AND intent.session_incarnation_id = OLD.session_incarnation_id
                  AND meta.workspace_id = OLD.workspace_id AND meta.session_id = OLD.session_id
                  AND intent.actor_id = NEW.terminal_actor_id
                  AND intent.correlation_id = NEW.terminal_correlation_id
                  AND intent.created_at = NEW.closed_at
                  AND NEW.terminal_idempotency_key = 'lifecycle:delete:admission:' || OLD.admission_id
              ))
            OR (NEW.terminal_authority_kind = 'authority_superseded'
              AND NEW.status = 'cancelled'
              AND NEW.terminal_actor_id = 'system:session-authority'
              AND NEW.terminal_correlation_id = NEW.terminal_control_event_id
              AND NEW.terminal_idempotency_key = 'admission:authority-superseded:'
                || OLD.admission_id || ':' || NEW.terminal_control_event_id
              AND EXISTS (
                SELECT 1
                FROM chat_session_meta meta
                JOIN chat_session_control_grants control
                  ON control.session_id = meta.session_id AND control.is_current = 1
                JOIN chat_session_control_events event_row
                  ON event_row.session_id = control.session_id
                  AND event_row.idempotency_key = control.transition_idempotency_key
                WHERE meta.session_id = OLD.session_id
                  AND control.workspace_id = meta.workspace_id
                  AND event_row.event_id = NEW.terminal_control_event_id
                  AND event_row.next_generation = control.generation
                  AND (
                    meta.workspace_id <> OLD.workspace_id
                    OR COALESCE(meta.lifecycle_intent_id, 'legacy-session-incarnation:' || meta.session_id)
                      <> OLD.session_incarnation_id
                    OR control.generation <> OLD.controller_generation
                    OR (OLD.actor_kind IN ('operator', 'system')
                      AND NOT (control.owner_kind = 'operator' AND control.lease_state = 'operator_active'))
                    OR (OLD.actor_kind = 'external_companion'
                      AND NOT (control.owner_kind = 'external_companion'
                        AND control.lease_state = 'external_live'
                        AND control.companion_session_id = OLD.actor_id))
                  )
              ))
          ))
      )
    BEGIN SELECT RAISE(ABORT, 'session mutation admission identity and material are immutable'); END;

    CREATE TRIGGER trg_chat_session_mutation_admissions_after_update
    AFTER UPDATE ON chat_session_mutation_admissions
    WHEN NEW.status <> OLD.status
    BEGIN
      INSERT INTO chat_session_mutation_admission_events (
        event_id, admission_id, session_incarnation_id, workspace_id, session_id, turn_id,
        runtime_owner_id, runtime_lease_revision,
        event_sequence, event_type,
        admission_kind, aggregate_revision, controller_generation, actor_kind, actor_id,
        operation, material_sha256, idempotency_key, request_sha256, correlation_id,
        terminal_authority_kind, terminal_runtime_owner_id, terminal_runtime_lease_revision,
        terminal_durable_run_id, terminal_durable_lease_owner_id, terminal_durable_attempt_count,
        terminal_durable_run_version, terminal_durable_run_status, terminal_lifecycle_intent_id,
        terminal_control_event_id,
        created_at
      ) VALUES (
        NEW.terminal_event_id, NEW.admission_id, NEW.session_incarnation_id,
        NEW.workspace_id, NEW.session_id, NEW.turn_id,
        NEW.runtime_owner_id, NEW.runtime_lease_revision, 2, NEW.status,
        NEW.admission_kind, NEW.aggregate_revision, NEW.controller_generation, NEW.actor_kind,
        NEW.terminal_actor_id, NEW.operation, NEW.material_sha256, NEW.terminal_idempotency_key,
        NEW.request_sha256, NEW.terminal_correlation_id,
        NEW.terminal_authority_kind, NEW.terminal_runtime_owner_id, NEW.terminal_runtime_lease_revision,
        NEW.terminal_durable_run_id, NEW.terminal_durable_lease_owner_id, NEW.terminal_durable_attempt_count,
        NEW.terminal_durable_run_version, NEW.terminal_durable_run_status, NEW.terminal_lifecycle_intent_id,
        NEW.terminal_control_event_id,
        NEW.closed_at
      );
    END;
    CREATE TRIGGER trg_chat_session_mutation_admissions_no_delete
    BEFORE DELETE ON chat_session_mutation_admissions
    BEGIN SELECT RAISE(ABORT, 'session mutation admissions are durable'); END;
    CREATE TRIGGER trg_chat_session_mutation_admission_events_no_update
    BEFORE UPDATE ON chat_session_mutation_admission_events
    BEGIN SELECT RAISE(ABORT, 'session mutation admission events are append-only'); END;
    CREATE TRIGGER trg_chat_session_mutation_admission_events_no_delete
    BEFORE DELETE ON chat_session_mutation_admission_events
    BEGIN SELECT RAISE(ABORT, 'session mutation admission events are append-only'); END;

    CREATE TRIGGER trg_chat_session_meta_lifecycle_delete_guard
    BEFORE DELETE ON chat_session_meta
    WHEN NOT EXISTS (
      SELECT 1
      FROM chat_session_lifecycle_intents intent
      JOIN chat_session_control_grants terminal
        ON terminal.session_id = OLD.session_id AND terminal.generation = intent.expected_generation
      JOIN chat_session_control_events event_row
        ON event_row.session_id = OLD.session_id AND event_row.idempotency_key = intent.idempotency_key
      WHERE intent.intent_id = OLD.deletion_intent_id AND intent.intent_kind = 'delete'
        AND intent.workspace_id = OLD.workspace_id AND intent.session_id = OLD.session_id
        AND intent.session_incarnation_id = COALESCE(OLD.lifecycle_intent_id, 'legacy-session-incarnation:' || OLD.session_id)
        AND intent.expected_revision = OLD.revision
        AND terminal.workspace_id = OLD.workspace_id AND terminal.is_current = 0
        AND terminal.owner_kind = 'operator' AND terminal.lease_state = 'deleted'
        AND terminal.terminal_at = intent.created_at
        AND event_row.reason_code = 'session_deleted'
        AND event_row.previous_generation = intent.expected_generation
        AND event_row.next_generation = intent.expected_generation
        AND event_row.created_at = intent.created_at
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_grants current_row
          WHERE current_row.session_id = OLD.session_id AND current_row.is_current = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_requests request_row
          WHERE request_row.session_id = OLD.session_id AND request_row.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_mutation_admissions admission
          WHERE admission.session_id = OLD.session_id AND admission.status = 'active'
        )
    )
    BEGIN SELECT RAISE(ABORT, 'chat session metadata delete requires terminal lifecycle evidence'); END;
  `);
}

function replaceSessionControlAuthRevokeGuards(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER trg_chat_session_control_requests_transition_guard;
    CREATE TRIGGER trg_chat_session_control_requests_transition_guard
    BEFORE UPDATE ON chat_session_control_requests
    WHEN OLD.status <> 'pending'
      OR NEW.request_id <> OLD.request_id OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.session_id <> OLD.session_id OR NEW.companion_session_id <> OLD.companion_session_id
      OR NEW.device_grant_id <> OLD.device_grant_id OR NEW.client_instance_id <> OLD.client_instance_id
      OR NEW.principal_purpose <> OLD.principal_purpose OR NEW.token_sha256 <> OLD.token_sha256
      OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
      OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
      OR NEW.requested_generation <> OLD.requested_generation OR NEW.idempotency_key <> OLD.idempotency_key
      OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.expires_at <> OLD.expires_at
      OR NEW.created_at <> OLD.created_at OR NEW.status = 'pending'
      OR julianday(NEW.decided_at) IS NULL
      OR (
        abs((julianday(NEW.decided_at) - julianday('now')) * 86400.0) > 1.0
        AND NOT EXISTS (
          SELECT 1
          FROM chat_session_control_auth_revoke_operation_targets target
          JOIN chat_session_control_auth_revoke_operations operation
            ON operation.idempotency_key = target.operation_idempotency_key
          WHERE target.target_kind = 'pending_request' AND target.request_id = OLD.request_id
            AND target.workspace_id = OLD.workspace_id AND target.session_id = OLD.session_id
            AND operation.occurred_at = NEW.decided_at
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_events event_row
          WHERE substr(event_row.idempotency_key, 1, 26) = 'heartbeat-preempt-request_'
            AND event_row.workspace_id = OLD.workspace_id
            AND event_row.session_id = OLD.session_id
            AND event_row.request_id = OLD.request_id
            AND event_row.previous_generation = OLD.requested_generation
            AND event_row.next_generation = OLD.requested_generation
            AND event_row.previous_owner_kind = 'operator'
            AND event_row.next_owner_kind = 'operator'
            AND event_row.previous_lease_state = 'operator_active'
            AND event_row.next_lease_state = 'operator_active'
            AND event_row.reason_code = NEW.decision_reason_code
            AND ((NEW.status = 'expired' AND event_row.reason_code = 'request_expired')
              OR (NEW.status = 'cancelled' AND event_row.reason_code = 'request_cancelled'))
            AND event_row.actor_kind = 'operator'
            AND event_row.actor_id = NEW.decided_by_actor_id
            AND event_row.companion_session_id = OLD.companion_session_id
            AND event_row.device_grant_id = OLD.device_grant_id
            AND event_row.created_at = NEW.decided_at
        )
      )
    BEGIN SELECT RAISE(ABORT, 'session control request transition invariant violated'); END;

    DROP TRIGGER trg_chat_session_control_grants_update_guard;
    CREATE TRIGGER trg_chat_session_control_grants_update_guard
    BEFORE UPDATE ON chat_session_control_grants
    WHEN OLD.is_current <> 1 OR OLD.terminal_at IS NOT NULL
      OR NEW.workspace_id <> OLD.workspace_id OR NEW.session_id <> OLD.session_id
      OR NEW.generation <> OLD.generation OR NEW.owner_kind <> OLD.owner_kind
      OR NEW.request_id IS NOT OLD.request_id OR NEW.companion_session_id IS NOT OLD.companion_session_id
      OR NEW.device_grant_id IS NOT OLD.device_grant_id OR NEW.client_instance_id IS NOT OLD.client_instance_id
      OR NEW.principal_purpose IS NOT OLD.principal_purpose
      OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
      OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
      OR NEW.effective_capabilities_json <> OLD.effective_capabilities_json
      OR NEW.effective_capabilities_sha256 <> OLD.effective_capabilities_sha256
      OR NEW.token_sha256 IS NOT OLD.token_sha256 OR NEW.token_expires_at IS NOT OLD.token_expires_at
      OR NEW.transition_idempotency_key <> OLD.transition_idempotency_key
      OR NEW.transition_request_sha256 <> OLD.transition_request_sha256 OR NEW.created_at <> OLD.created_at
      OR NEW.control_revision <> OLD.control_revision + 1 OR NEW.updated_at < OLD.updated_at
      OR julianday(NEW.updated_at) IS NULL
      OR (
        abs((julianday(NEW.updated_at) - julianday('now')) * 86400.0) > 1.0
        AND NOT EXISTS (
          SELECT 1
          FROM chat_session_control_auth_revoke_operation_targets target
          JOIN chat_session_control_auth_revoke_operations operation
            ON operation.idempotency_key = target.operation_idempotency_key
          WHERE target.target_kind = 'current_grant'
            AND target.workspace_id = OLD.workspace_id AND target.session_id = OLD.session_id
            AND target.generation = OLD.generation AND target.control_revision = OLD.control_revision
            AND operation.occurred_at = NEW.updated_at AND NEW.terminal_at = operation.occurred_at
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_events event_row
          WHERE substr(event_row.idempotency_key, 1, 18) = 'heartbeat-preempt_'
            AND event_row.workspace_id = OLD.workspace_id
            AND event_row.session_id = OLD.session_id
            AND event_row.request_id IS NULL
            AND event_row.previous_generation = OLD.generation
            AND event_row.next_generation = OLD.generation + 1
            AND event_row.previous_owner_kind = 'operator'
            AND event_row.next_owner_kind = 'operator'
            AND event_row.previous_lease_state = 'operator_active'
            AND event_row.next_lease_state = 'operator_active'
            AND event_row.reason_code = 'heartbeat_preempted'
            AND event_row.actor_kind = 'operator'
            AND event_row.companion_session_id IS NULL
            AND event_row.device_grant_id IS NULL
            AND event_row.created_at = NEW.updated_at
            AND NEW.terminal_at = NEW.updated_at
        )
      )
      OR NOT (
        (OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_live' AND NEW.terminal_at IS NULL
          AND NEW.last_heartbeat_at >= OLD.last_heartbeat_at
          AND julianday(NEW.last_heartbeat_at) IS NOT NULL
          AND julianday(NEW.lease_expires_at) IS NOT NULL
          AND julianday(NEW.reconnect_expires_at) IS NOT NULL
          AND abs((julianday(NEW.last_heartbeat_at) - julianday('now')) * 86400.0) <= 1.0
          AND abs((julianday(NEW.lease_expires_at) - julianday('now')) * 86400.0 - 60.0) <= 1.0
          AND abs((julianday(NEW.reconnect_expires_at) - julianday('now')) * 86400.0 - 300.0) <= 1.0)
        OR (OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_stale' AND NEW.terminal_at IS NULL
          AND NEW.last_heartbeat_at = OLD.last_heartbeat_at AND NEW.lease_expires_at = OLD.lease_expires_at
          AND NEW.reconnect_expires_at = OLD.reconnect_expires_at)
        OR (NEW.is_current = 0 AND NEW.lease_state IN ('released', 'revoked', 'superseded', 'deleted')
          AND NEW.terminal_at = NEW.updated_at AND NEW.last_heartbeat_at IS OLD.last_heartbeat_at
          AND NEW.lease_expires_at IS OLD.lease_expires_at AND NEW.reconnect_expires_at IS OLD.reconnect_expires_at)
      )
    BEGIN SELECT RAISE(ABORT, 'session control current generation transition invariant violated'); END;

    DROP TRIGGER trg_chat_session_control_events_insert_guard;
    CREATE TRIGGER trg_chat_session_control_events_insert_guard
    BEFORE INSERT ON chat_session_control_events
    WHEN (NEW.request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM chat_session_control_requests request_row
      WHERE request_row.request_id = NEW.request_id
        AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
        AND request_row.companion_session_id = NEW.companion_session_id
        AND request_row.device_grant_id = NEW.device_grant_id
    )) OR (
      (
        EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_operations operation
          WHERE operation.request_sha256 = NEW.request_sha256
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key
            )
        )
        OR EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_operations operation
          WHERE operation.idempotency_key = NEW.idempotency_key
        )
        OR EXISTS (
          SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
          WHERE target.event_idempotency_key = NEW.idempotency_key
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM chat_session_control_auth_revoke_operation_targets target
        JOIN chat_session_control_auth_revoke_operations operation
          ON operation.idempotency_key = target.operation_idempotency_key
        WHERE target.event_id = NEW.event_id
          AND target.event_sequence = NEW.event_sequence
          AND target.event_idempotency_key = NEW.idempotency_key
          AND target.event_reason_code = NEW.reason_code
          AND target.workspace_id = NEW.workspace_id AND target.session_id = NEW.session_id
          AND operation.request_sha256 = NEW.request_sha256
          AND operation.correlation_id = NEW.correlation_id
          AND operation.actor_id = NEW.actor_id AND NEW.actor_kind = 'system'
          AND operation.occurred_at = NEW.created_at
          AND NOT EXISTS (
            SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
            WHERE receipt.idempotency_key = operation.idempotency_key
          )
          AND (
            (target.target_kind = 'pending_request' AND NEW.request_id = target.request_id
              AND NEW.previous_generation = target.generation AND NEW.next_generation = target.generation
              AND NEW.previous_owner_kind = target.owner_kind AND NEW.next_owner_kind = target.owner_kind
              AND NEW.previous_lease_state = target.lease_state AND NEW.next_lease_state = target.lease_state)
            OR (target.target_kind = 'current_grant' AND NEW.request_id = target.request_id
              AND NEW.previous_generation = target.generation AND NEW.next_generation = target.generation + 1
              AND NEW.previous_owner_kind = 'external_companion' AND NEW.next_owner_kind = 'operator'
              AND NEW.previous_lease_state = target.lease_state AND NEW.next_lease_state = 'operator_active')
          )
      )
    )
    BEGIN SELECT RAISE(ABORT, 'session control event request or auth operation invariant violated'); END;

    DROP TRIGGER trg_chat_session_control_auth_revoke_receipts_insert_guard;
    CREATE TRIGGER trg_chat_session_control_auth_revoke_receipts_insert_guard
    BEFORE INSERT ON chat_session_control_auth_revoke_receipts
    WHEN NOT EXISTS (
      SELECT 1
      FROM chat_session_control_auth_revoke_operations operation
      WHERE operation.idempotency_key = NEW.idempotency_key
        AND operation.request_sha256 = NEW.request_sha256
        AND operation.binding_kind = NEW.binding_kind AND operation.binding_id = NEW.binding_id
        AND operation.actor_id = NEW.actor_id AND operation.correlation_id = NEW.correlation_id
        AND operation.target_count = NEW.target_count AND operation.session_count = NEW.session_count
        AND operation.event_set_sha256 = NEW.event_set_sha256
        AND operation.occurred_at = NEW.created_at
        AND (SELECT COUNT(*) FROM chat_session_control_auth_revoke_operation_targets target
             WHERE target.operation_idempotency_key = operation.idempotency_key) = operation.target_count
        AND (SELECT COUNT(DISTINCT target.workspace_id || char(0) || target.session_id)
             FROM chat_session_control_auth_revoke_operation_targets target
             WHERE target.operation_idempotency_key = operation.idempotency_key) = operation.session_count
        AND NOT EXISTS (
          SELECT 1
          FROM chat_session_control_auth_revoke_operation_targets target
          LEFT JOIN chat_session_control_events event_row
            ON event_row.event_id = target.event_id
            AND event_row.event_sequence = target.event_sequence
            AND event_row.idempotency_key = target.event_idempotency_key
            AND event_row.reason_code = target.event_reason_code
            AND event_row.workspace_id = target.workspace_id AND event_row.session_id = target.session_id
            AND event_row.request_sha256 = operation.request_sha256
            AND event_row.correlation_id = operation.correlation_id
            AND event_row.actor_kind = 'system' AND event_row.actor_id = operation.actor_id
            AND event_row.created_at = operation.occurred_at
          WHERE target.operation_idempotency_key = operation.idempotency_key
            AND event_row.event_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_events event_row
          WHERE event_row.request_sha256 = operation.request_sha256
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_auth_revoke_operation_targets target
              WHERE target.operation_idempotency_key = operation.idempotency_key
                AND target.event_id = event_row.event_id
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM chat_session_control_auth_revoke_operation_targets target
          WHERE target.operation_idempotency_key = operation.idempotency_key
            AND (
              (target.target_kind = 'pending_request' AND NOT EXISTS (
                SELECT 1 FROM chat_session_control_requests request_row
                WHERE request_row.request_id = target.request_id
                  AND request_row.status IN ('cancelled', 'expired')
                  AND request_row.decided_at = operation.occurred_at
                  AND request_row.decided_by_actor_id = operation.actor_id
              ))
              OR (target.target_kind = 'current_grant' AND (
                NOT EXISTS (
                  SELECT 1 FROM chat_session_control_grants prior
                  WHERE prior.session_id = target.session_id AND prior.generation = target.generation
                    AND prior.is_current = 0 AND prior.lease_state = 'revoked'
                    AND prior.control_revision = target.control_revision + 1
                    AND prior.updated_at = operation.occurred_at AND prior.terminal_at = operation.occurred_at
                )
                OR NOT EXISTS (
                  SELECT 1 FROM chat_session_control_grants successor
                  WHERE successor.session_id = target.session_id AND successor.generation = target.generation + 1
                    AND successor.workspace_id = target.workspace_id AND successor.is_current = 1
                    AND successor.owner_kind = 'operator' AND successor.lease_state = 'operator_active'
                    AND successor.transition_idempotency_key = target.event_idempotency_key
                    AND successor.transition_request_sha256 = operation.request_sha256
                    AND successor.created_at = operation.occurred_at AND successor.updated_at = operation.occurred_at
                )
              ))
            )
        )
    )
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke receipt invariant violated'); END;
  `);

  replaceSessionControlGrantInsertGuard(db);
}

function replaceSessionControlGrantInsertGuard(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER trg_chat_session_control_grants_insert_guard;
    CREATE TRIGGER trg_chat_session_control_grants_insert_guard
    BEFORE INSERT ON chat_session_control_grants
    WHEN NEW.is_current <> 1
      OR EXISTS (
        SELECT 1 FROM chat_session_control_grants prior
        WHERE prior.session_id = NEW.session_id AND prior.workspace_id <> NEW.workspace_id
      )
      OR (NOT EXISTS (SELECT 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id)
        AND NEW.generation <> 1)
      OR (EXISTS (SELECT 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id)
        AND NEW.generation <> (
          SELECT MAX(prior.generation) + 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id
        ))
      OR (NEW.owner_kind = 'external_companion' AND NOT EXISTS (
        SELECT 1
        FROM chat_session_control_requests request_row
        JOIN chat_session_control_tokens token_row ON token_row.token_sha256 = NEW.token_sha256
        WHERE request_row.request_id = NEW.request_id
          AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
          AND request_row.companion_session_id = NEW.companion_session_id
          AND request_row.device_grant_id = NEW.device_grant_id
          AND request_row.client_instance_id = NEW.client_instance_id
          AND request_row.principal_purpose = NEW.principal_purpose
          AND request_row.requested_capabilities_json = NEW.requested_capabilities_json
          AND request_row.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
          AND request_row.status = 'activated' AND request_row.decision_reason_code = 'handoff'
          AND request_row.activated_generation = request_row.requested_generation + 1
          AND request_row.activated_generation <= NEW.generation
          AND token_row.workspace_id = NEW.workspace_id AND token_row.session_id = NEW.session_id
          AND ((NEW.generation = request_row.activated_generation AND NEW.token_sha256 = request_row.token_sha256)
            OR (NEW.generation > request_row.activated_generation AND EXISTS (
              SELECT 1 FROM chat_session_control_grants prior
              WHERE prior.workspace_id = NEW.workspace_id AND prior.session_id = NEW.session_id
                AND prior.generation = NEW.generation - 1 AND prior.owner_kind = 'external_companion'
                AND prior.request_id = NEW.request_id
                AND prior.companion_session_id = NEW.companion_session_id
                AND prior.device_grant_id = NEW.device_grant_id
                AND prior.client_instance_id = NEW.client_instance_id
                AND prior.principal_purpose = NEW.principal_purpose
                AND prior.requested_capabilities_json = NEW.requested_capabilities_json
                AND prior.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
                AND prior.effective_capabilities_json = NEW.effective_capabilities_json
                AND prior.effective_capabilities_sha256 = NEW.effective_capabilities_sha256
            )))
          AND ((NEW.requested_capabilities_json = '["send"]' AND NEW.effective_capabilities_json = '["send"]')
            OR (NEW.requested_capabilities_json = '["send","read"]'
              AND NEW.effective_capabilities_json IN ('["send"]', '["send","read"]')))
      ))
      OR (NEW.owner_kind = 'external_companion' AND NOT EXISTS (
        SELECT 1
        FROM companion_sessions companion_session
        JOIN auth_device_grants device_grant ON device_grant.grant_id = companion_session.grant_id
        JOIN auth_device_requests device_request ON device_request.request_id = device_grant.request_id
        WHERE companion_session.session_id = NEW.companion_session_id
          AND companion_session.grant_id = NEW.device_grant_id
          AND companion_session.principal_purpose = NEW.principal_purpose
          AND device_grant.principal_purpose = NEW.principal_purpose
          AND device_request.principal_purpose = NEW.principal_purpose
          AND NEW.principal_purpose = 'session_control_client'
          AND companion_session.revoked_at IS NULL AND device_grant.revoked_at IS NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', companion_session.refresh_token_expires_at, '+0 days')
            IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', companion_session.refresh_token_expires_at, '+0 days')
            = companion_session.refresh_token_expires_at
          AND companion_session.refresh_token_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND (device_grant.expires_at IS NULL OR (
            strftime('%Y-%m-%dT%H:%M:%fZ', device_grant.expires_at, '+0 days') IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', device_grant.expires_at, '+0 days') = device_grant.expires_at
            AND device_grant.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ))
      ))
      OR julianday(NEW.created_at) IS NULL
      OR julianday(NEW.updated_at) IS NULL
      OR (
        (abs((julianday(NEW.created_at) - julianday('now')) * 86400.0) > 1.0
          OR abs((julianday(NEW.updated_at) - julianday('now')) * 86400.0) > 1.0)
        AND NOT EXISTS (
          SELECT 1
          FROM chat_session_control_auth_revoke_operation_targets target
          JOIN chat_session_control_auth_revoke_operations operation
            ON operation.idempotency_key = target.operation_idempotency_key
          WHERE target.target_kind = 'current_grant'
            AND target.workspace_id = NEW.workspace_id AND target.session_id = NEW.session_id
            AND target.generation + 1 = NEW.generation
            AND target.event_idempotency_key = NEW.transition_idempotency_key
            AND operation.request_sha256 = NEW.transition_request_sha256
            AND operation.occurred_at = NEW.created_at AND operation.occurred_at = NEW.updated_at
            AND NEW.owner_kind = 'operator' AND NEW.lease_state = 'operator_active'
            AND NOT EXISTS (
              SELECT 1 FROM chat_session_control_auth_revoke_receipts receipt
              WHERE receipt.idempotency_key = operation.idempotency_key
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat_session_control_events event_row
          WHERE substr(event_row.idempotency_key, 1, 18) = 'heartbeat-preempt_'
            AND event_row.workspace_id = NEW.workspace_id
            AND event_row.session_id = NEW.session_id
            AND event_row.request_id IS NULL
            AND event_row.previous_generation = NEW.generation - 1
            AND event_row.next_generation = NEW.generation
            AND event_row.previous_owner_kind = 'operator'
            AND event_row.next_owner_kind = 'operator'
            AND event_row.previous_lease_state = 'operator_active'
            AND event_row.next_lease_state = 'operator_active'
            AND event_row.reason_code = 'heartbeat_preempted'
            AND event_row.actor_kind = 'operator'
            AND event_row.companion_session_id IS NULL
            AND event_row.device_grant_id IS NULL
            AND event_row.idempotency_key = NEW.transition_idempotency_key
            AND event_row.request_sha256 = NEW.transition_request_sha256
            AND event_row.created_at = NEW.created_at
            AND NEW.updated_at = NEW.created_at
        )
      )
      OR (NEW.owner_kind = 'external_companion' AND (
        julianday(NEW.token_expires_at) IS NULL
        OR julianday(NEW.last_heartbeat_at) IS NULL
        OR julianday(NEW.lease_expires_at) IS NULL
        OR julianday(NEW.reconnect_expires_at) IS NULL
        OR abs((julianday(NEW.token_expires_at) - julianday('now')) * 86400.0 - 900.0) > 1.0
        OR abs((julianday(NEW.last_heartbeat_at) - julianday('now')) * 86400.0) > 1.0
        OR abs((julianday(NEW.lease_expires_at) - julianday('now')) * 86400.0 - 60.0) > 1.0
        OR abs((julianday(NEW.reconnect_expires_at) - julianday('now')) * 86400.0 - 300.0) > 1.0
      ))
    BEGIN SELECT RAISE(ABORT, 'session control generation, workspace, or database-clock invariant violated'); END;
  `);
}

function createSessionControlFoundationSchema(db: DatabaseSync): void {
  addColumnIfMissingIfTableExists(
    db,
    "auth_device_requests",
    "principal_purpose",
    "TEXT NOT NULL DEFAULT 'general_companion' CHECK(principal_purpose IN ('general_companion', 'session_control_client'))",
  );
  addColumnIfMissingIfTableExists(
    db,
    "auth_device_grants",
    "principal_purpose",
    "TEXT NOT NULL DEFAULT 'general_companion' CHECK(principal_purpose IN ('general_companion', 'session_control_client'))",
  );
  addColumnIfMissingIfTableExists(
    db,
    "companion_sessions",
    "principal_purpose",
    "TEXT NOT NULL DEFAULT 'general_companion' CHECK(principal_purpose IN ('general_companion', 'session_control_client'))",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_control_tokens (
      token_sha256 TEXT PRIMARY KEY CHECK(length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      first_request_id TEXT CHECK(first_request_id IS NULL OR length(first_request_id) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      )
    );

    CREATE TABLE IF NOT EXISTS chat_session_control_requests (
      request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      companion_session_id TEXT NOT NULL CHECK(length(companion_session_id) BETWEEN 1 AND 256),
      device_grant_id TEXT NOT NULL CHECK(length(device_grant_id) BETWEEN 1 AND 256),
      client_instance_id TEXT NOT NULL CHECK(length(client_instance_id) BETWEEN 1 AND 256),
      principal_purpose TEXT NOT NULL CHECK(principal_purpose = 'session_control_client'),
      token_sha256 TEXT NOT NULL,
      requested_capabilities_json TEXT NOT NULL CHECK(requested_capabilities_json IN ('["send"]', '["send","read"]')),
      requested_capabilities_sha256 TEXT NOT NULL CHECK(
        length(requested_capabilities_sha256) = 64 AND requested_capabilities_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      requested_generation INTEGER NOT NULL CHECK(
        typeof(requested_generation) = 'integer' AND requested_generation > 0
      ),
      status TEXT NOT NULL CHECK(status IN ('pending', 'rejected', 'expired', 'activated', 'cancelled')),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      expires_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, '+0 days') = expires_at
      ),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      decided_at TEXT CHECK(
        decided_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', decided_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', decided_at, '+0 days') = decided_at
        )
      ),
      decided_by_actor_id TEXT CHECK(decided_by_actor_id IS NULL OR length(decided_by_actor_id) BETWEEN 1 AND 256),
      decision_reason_code TEXT CHECK(
        decision_reason_code IS NULL OR decision_reason_code IN (
          'request_rejected', 'request_expired', 'request_cancelled', 'handoff'
        )
      ),
      activated_generation INTEGER CHECK(
        activated_generation IS NULL OR (typeof(activated_generation) = 'integer' AND activated_generation > 1)
      ),
      CHECK(
        (requested_capabilities_json = '["send"]'
          AND requested_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c')
        OR (requested_capabilities_json = '["send","read"]'
          AND requested_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')
      ),
      FOREIGN KEY(token_sha256) REFERENCES chat_session_control_tokens(token_sha256) ON DELETE RESTRICT,
      CHECK(expires_at > created_at),
      CHECK(
        (status = 'pending' AND decided_at IS NULL AND decided_by_actor_id IS NULL
          AND decision_reason_code IS NULL AND activated_generation IS NULL)
        OR (status = 'activated' AND decided_at IS NOT NULL AND decided_at < expires_at
          AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'handoff'
          AND activated_generation = requested_generation + 1)
        OR (status = 'rejected' AND decided_at IS NOT NULL AND decided_at < expires_at
          AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_rejected'
          AND activated_generation IS NULL)
        OR (status = 'cancelled' AND decided_at IS NOT NULL AND decided_at < expires_at
          AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_cancelled'
          AND activated_generation IS NULL)
        OR (status = 'expired' AND decided_at IS NOT NULL AND decided_at >= expires_at
          AND decided_by_actor_id IS NOT NULL AND decision_reason_code = 'request_expired'
          AND activated_generation IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_chat_session_control_requests_session_status
      ON chat_session_control_requests(session_id, status, created_at, request_id);
    CREATE INDEX IF NOT EXISTS idx_chat_session_control_requests_companion_status
      ON chat_session_control_requests(companion_session_id, status, created_at);

    CREATE TABLE IF NOT EXISTS chat_session_control_grants (
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0),
      is_current INTEGER NOT NULL CHECK(typeof(is_current) = 'integer' AND is_current IN (0, 1)),
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('operator', 'external_companion')),
      lease_state TEXT NOT NULL CHECK(lease_state IN (
        'operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted'
      )),
      request_id TEXT,
      companion_session_id TEXT,
      device_grant_id TEXT,
      client_instance_id TEXT,
      principal_purpose TEXT,
      requested_capabilities_json TEXT NOT NULL CHECK(
        requested_capabilities_json IN ('[]', '["send"]', '["send","read"]')
      ),
      requested_capabilities_sha256 TEXT NOT NULL CHECK(
        length(requested_capabilities_sha256) = 64 AND requested_capabilities_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      effective_capabilities_json TEXT NOT NULL CHECK(
        effective_capabilities_json IN ('[]', '["send"]', '["send","read"]')
      ),
      effective_capabilities_sha256 TEXT NOT NULL CHECK(
        length(effective_capabilities_sha256) = 64 AND effective_capabilities_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      token_sha256 TEXT,
      token_expires_at TEXT,
      last_heartbeat_at TEXT,
      lease_expires_at TEXT,
      reconnect_expires_at TEXT,
      control_revision INTEGER NOT NULL CHECK(typeof(control_revision) = 'integer' AND control_revision > 0),
      transition_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(transition_idempotency_key) BETWEEN 1 AND 512),
      transition_request_sha256 TEXT NOT NULL CHECK(
        length(transition_request_sha256) = 64 AND transition_request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      updated_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0 days') = updated_at
      ),
      terminal_at TEXT CHECK(
        terminal_at IS NULL OR (
          strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at, '+0 days') IS NOT NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', terminal_at, '+0 days') = terminal_at
        )
      ),
      CHECK(
        (requested_capabilities_json = '[]'
          AND requested_capabilities_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
        OR (requested_capabilities_json = '["send"]'
          AND requested_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c')
        OR (requested_capabilities_json = '["send","read"]'
          AND requested_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')
      ),
      CHECK(
        (effective_capabilities_json = '[]'
          AND effective_capabilities_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
        OR (effective_capabilities_json = '["send"]'
          AND effective_capabilities_sha256 = '700f7799ef50095f9d008c356de23c0eb9562ec753f282f2f060079da99c2d2c')
        OR (effective_capabilities_json = '["send","read"]'
          AND effective_capabilities_sha256 = 'e58895e823b5a1618273223b24cd04ca99b2f30171b687fade8ef74a27df7a14')
      ),
      PRIMARY KEY(session_id, generation),
      FOREIGN KEY(request_id) REFERENCES chat_session_control_requests(request_id) ON DELETE RESTRICT,
      FOREIGN KEY(token_sha256) REFERENCES chat_session_control_tokens(token_sha256) ON DELETE RESTRICT,
      CHECK(updated_at >= created_at),
      CHECK(
        (is_current = 1 AND terminal_at IS NULL AND lease_state IN ('operator_active', 'external_live', 'external_stale'))
        OR (is_current = 0 AND terminal_at IS NOT NULL AND lease_state IN ('released', 'revoked', 'superseded', 'deleted'))
      ),
      CHECK(
        (owner_kind = 'operator' AND request_id IS NULL AND companion_session_id IS NULL
          AND device_grant_id IS NULL AND client_instance_id IS NULL AND principal_purpose IS NULL
          AND requested_capabilities_json = '[]' AND effective_capabilities_json = '[]'
          AND token_sha256 IS NULL AND token_expires_at IS NULL AND last_heartbeat_at IS NULL
          AND lease_expires_at IS NULL AND reconnect_expires_at IS NULL)
        OR (owner_kind = 'external_companion' AND generation >= 2 AND request_id IS NOT NULL
          AND length(companion_session_id) BETWEEN 1 AND 256 AND length(device_grant_id) BETWEEN 1 AND 256
          AND length(client_instance_id) BETWEEN 1 AND 256 AND principal_purpose = 'session_control_client'
          AND requested_capabilities_json IN ('["send"]', '["send","read"]')
          AND effective_capabilities_json IN ('["send"]', '["send","read"]')
          AND token_sha256 IS NOT NULL AND token_expires_at IS NOT NULL AND last_heartbeat_at IS NOT NULL
          AND lease_expires_at IS NOT NULL AND reconnect_expires_at IS NOT NULL
          AND lease_expires_at > last_heartbeat_at AND reconnect_expires_at > lease_expires_at)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_control_grants_one_current
      ON chat_session_control_grants(session_id) WHERE is_current = 1;
    CREATE INDEX IF NOT EXISTS idx_chat_session_control_grants_workspace_current
      ON chat_session_control_grants(workspace_id, is_current, updated_at DESC, session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_session_control_grants_companion_current
      ON chat_session_control_grants(companion_session_id, is_current, session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_session_control_grants_device_current
      ON chat_session_control_grants(device_grant_id, is_current, session_id);

    CREATE TABLE IF NOT EXISTS chat_session_control_events (
      event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 256),
      workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
      event_sequence INTEGER NOT NULL CHECK(typeof(event_sequence) = 'integer' AND event_sequence > 0),
      request_id TEXT,
      previous_generation INTEGER CHECK(
        previous_generation IS NULL OR (typeof(previous_generation) = 'integer' AND previous_generation > 0)
      ),
      next_generation INTEGER NOT NULL CHECK(typeof(next_generation) = 'integer' AND next_generation > 0),
      previous_owner_kind TEXT CHECK(previous_owner_kind IS NULL OR previous_owner_kind IN ('operator', 'external_companion')),
      next_owner_kind TEXT CHECK(next_owner_kind IS NULL OR next_owner_kind IN ('operator', 'external_companion')),
      previous_lease_state TEXT CHECK(previous_lease_state IS NULL OR previous_lease_state IN (
        'operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted'
      )),
      next_lease_state TEXT NOT NULL CHECK(next_lease_state IN (
        'operator_active', 'external_live', 'external_stale', 'released', 'revoked', 'superseded', 'deleted'
      )),
      reason_code TEXT NOT NULL CHECK(reason_code IN (
        'session_initialized', 'request_created', 'request_rejected', 'request_expired', 'request_cancelled',
        'handoff', 'heartbeat', 'lease_stale', 'reconnect', 'identity_revoked', 'release',
        'operator_revoke', 'emergency_takeover', 'auth_revoked', 'session_deleted',
        'session_reactivated', 'mutation_denied'
      )),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('operator', 'external_companion', 'system')),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
      companion_session_id TEXT CHECK(companion_session_id IS NULL OR length(companion_session_id) BETWEEN 1 AND 256),
      device_grant_id TEXT CHECK(device_grant_id IS NULL OR length(device_grant_id) BETWEEN 1 AND 256),
      idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      FOREIGN KEY(request_id) REFERENCES chat_session_control_requests(request_id) ON DELETE RESTRICT,
      UNIQUE(session_id, event_sequence),
      CHECK(
        (reason_code = 'session_initialized' AND previous_generation IS NULL AND previous_owner_kind IS NULL
          AND previous_lease_state IS NULL AND next_generation = 1 AND next_owner_kind = 'operator'
          AND next_lease_state = 'operator_active' AND actor_kind = 'system')
        OR (reason_code <> 'session_initialized' AND previous_generation IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_session_created
      ON chat_session_control_events(session_id, event_sequence);
    CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_workspace_created
      ON chat_session_control_events(workspace_id, created_at DESC, event_id);
    CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_companion_created
      ON chat_session_control_events(companion_session_id, created_at DESC, event_id);
    CREATE INDEX IF NOT EXISTS idx_chat_session_control_events_request_sha256
      ON chat_session_control_events(request_sha256, workspace_id, session_id, event_sequence);

    CREATE TABLE IF NOT EXISTS chat_session_control_auth_revoke_receipts (
      idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 512),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      binding_kind TEXT NOT NULL CHECK(binding_kind IN ('companion_session', 'device_grant')),
      binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 256),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 256),
      correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
      target_count INTEGER NOT NULL CHECK(typeof(target_count) = 'integer' AND target_count >= 0),
      session_count INTEGER NOT NULL CHECK(typeof(session_count) = 'integer' AND session_count >= 0),
      event_set_sha256 TEXT NOT NULL CHECK(
        length(event_set_sha256) = 64 AND event_set_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL CHECK(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+0 days') = created_at
      ),
      CHECK(
        (target_count = 0 AND session_count = 0
          AND event_set_sha256 = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
        OR (target_count > 0 AND session_count BETWEEN 1 AND target_count)
      )
    );

    CREATE TRIGGER IF NOT EXISTS trg_auth_device_requests_principal_purpose_immutable
    BEFORE UPDATE ON auth_device_requests
    WHEN NEW.principal_purpose <> OLD.principal_purpose
    BEGIN SELECT RAISE(ABORT, 'auth device request principal purpose is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_auth_device_grants_principal_purpose_guard
    BEFORE INSERT ON auth_device_grants
    WHEN NOT EXISTS (
      SELECT 1 FROM auth_device_requests request_row
      WHERE request_row.request_id = NEW.request_id
        AND request_row.principal_purpose = NEW.principal_purpose
    )
    BEGIN SELECT RAISE(ABORT, 'auth device grant principal purpose must match its request'); END;
    CREATE TRIGGER IF NOT EXISTS trg_auth_device_grants_principal_purpose_immutable
    BEFORE UPDATE ON auth_device_grants
    WHEN NEW.request_id <> OLD.request_id
      OR NEW.principal_purpose <> OLD.principal_purpose
      OR NOT EXISTS (
        SELECT 1 FROM auth_device_requests request_row
        WHERE request_row.request_id = NEW.request_id
          AND request_row.principal_purpose = NEW.principal_purpose
      )
    BEGIN SELECT RAISE(ABORT, 'auth device grant parent and principal purpose are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_companion_sessions_principal_purpose_guard
    BEFORE INSERT ON companion_sessions
    WHEN NOT EXISTS (
      SELECT 1 FROM auth_device_grants grant_row
      WHERE grant_row.grant_id = NEW.grant_id
        AND grant_row.principal_purpose = NEW.principal_purpose
    )
    BEGIN SELECT RAISE(ABORT, 'companion session principal purpose must match its grant'); END;
    CREATE TRIGGER IF NOT EXISTS trg_companion_sessions_principal_purpose_immutable
    BEFORE UPDATE ON companion_sessions
    WHEN NEW.grant_id <> OLD.grant_id
      OR NEW.principal_purpose <> OLD.principal_purpose
      OR NOT EXISTS (
        SELECT 1 FROM auth_device_grants grant_row
        WHERE grant_row.grant_id = NEW.grant_id
          AND grant_row.principal_purpose = NEW.principal_purpose
      )
    BEGIN SELECT RAISE(ABORT, 'companion session parent and principal purpose are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_tokens_no_update
    BEFORE UPDATE ON chat_session_control_tokens
    BEGIN SELECT RAISE(ABORT, 'session control token hashes are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_tokens_no_delete
    BEFORE DELETE ON chat_session_control_tokens
    BEGIN SELECT RAISE(ABORT, 'session control token hashes are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_tokens_insert_guard
    BEFORE INSERT ON chat_session_control_tokens
    WHEN NOT EXISTS (
      SELECT 1 FROM chat_session_control_grants grant_row
      WHERE grant_row.workspace_id = NEW.workspace_id AND grant_row.session_id = NEW.session_id
    )
    BEGIN SELECT RAISE(ABORT, 'session control token binding invariant violated'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_requests_insert_guard
    BEFORE INSERT ON chat_session_control_requests
    WHEN NEW.status <> 'pending'
      OR NOT EXISTS (
        SELECT 1 FROM chat_session_control_tokens token_row
        WHERE token_row.token_sha256 = NEW.token_sha256
          AND token_row.workspace_id = NEW.workspace_id
          AND token_row.session_id = NEW.session_id
          AND token_row.first_request_id = NEW.request_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM chat_session_control_grants grant_row
        WHERE grant_row.workspace_id = NEW.workspace_id AND grant_row.session_id = NEW.session_id
          AND grant_row.generation = NEW.requested_generation AND grant_row.is_current = 1
          AND grant_row.owner_kind = 'operator' AND grant_row.lease_state = 'operator_active'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM companion_sessions companion_session
        JOIN auth_device_grants device_grant ON device_grant.grant_id = companion_session.grant_id
        JOIN auth_device_requests device_request ON device_request.request_id = device_grant.request_id
        WHERE companion_session.session_id = NEW.companion_session_id
          AND companion_session.grant_id = NEW.device_grant_id
          AND companion_session.principal_purpose = NEW.principal_purpose
          AND device_grant.principal_purpose = NEW.principal_purpose
          AND device_request.principal_purpose = NEW.principal_purpose
          AND NEW.principal_purpose = 'session_control_client'
          AND companion_session.revoked_at IS NULL AND device_grant.revoked_at IS NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', companion_session.refresh_token_expires_at, '+0 days')
            = companion_session.refresh_token_expires_at
          AND companion_session.refresh_token_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND (device_grant.expires_at IS NULL OR (
            strftime('%Y-%m-%dT%H:%M:%fZ', device_grant.expires_at, '+0 days') = device_grant.expires_at
            AND device_grant.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ))
      )
    BEGIN SELECT RAISE(ABORT, 'session control request binding invariant violated'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_requests_transition_guard
    BEFORE UPDATE ON chat_session_control_requests
    WHEN OLD.status <> 'pending'
      OR NEW.request_id <> OLD.request_id OR NEW.workspace_id <> OLD.workspace_id
      OR NEW.session_id <> OLD.session_id OR NEW.companion_session_id <> OLD.companion_session_id
      OR NEW.device_grant_id <> OLD.device_grant_id OR NEW.client_instance_id <> OLD.client_instance_id
      OR NEW.principal_purpose <> OLD.principal_purpose OR NEW.token_sha256 <> OLD.token_sha256
      OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
      OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
      OR NEW.requested_generation <> OLD.requested_generation OR NEW.idempotency_key <> OLD.idempotency_key
      OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.expires_at <> OLD.expires_at
      OR NEW.created_at <> OLD.created_at OR NEW.status = 'pending'
      OR abs((julianday(NEW.decided_at) - julianday('now')) * 86400.0) > 1.0
    BEGIN SELECT RAISE(ABORT, 'session control request transition invariant violated'); END;
    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_requests_no_delete
    BEFORE DELETE ON chat_session_control_requests
    BEGIN SELECT RAISE(ABORT, 'session control requests are durable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_grants_insert_guard
    BEFORE INSERT ON chat_session_control_grants
    WHEN NEW.is_current <> 1
      OR EXISTS (
        SELECT 1 FROM chat_session_control_grants prior
        WHERE prior.session_id = NEW.session_id AND prior.workspace_id <> NEW.workspace_id
      )
      OR (
        NOT EXISTS (SELECT 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id)
        AND NEW.generation <> 1
      )
      OR (
        EXISTS (SELECT 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id)
        AND NEW.generation <> (
          SELECT MAX(prior.generation) + 1 FROM chat_session_control_grants prior WHERE prior.session_id = NEW.session_id
        )
      )
      OR (NEW.owner_kind = 'external_companion' AND NOT EXISTS (
        SELECT 1
        FROM chat_session_control_requests request_row
        JOIN chat_session_control_tokens token_row ON token_row.token_sha256 = NEW.token_sha256
        WHERE request_row.request_id = NEW.request_id
          AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
          AND request_row.companion_session_id = NEW.companion_session_id
          AND request_row.device_grant_id = NEW.device_grant_id
          AND request_row.client_instance_id = NEW.client_instance_id
          AND request_row.principal_purpose = NEW.principal_purpose
          AND request_row.requested_capabilities_json = NEW.requested_capabilities_json
          AND request_row.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
          AND request_row.status = 'activated' AND request_row.decision_reason_code = 'handoff'
          AND request_row.activated_generation = request_row.requested_generation + 1
          AND request_row.activated_generation <= NEW.generation
          AND token_row.workspace_id = NEW.workspace_id AND token_row.session_id = NEW.session_id
          AND (
            (NEW.generation = request_row.activated_generation AND NEW.token_sha256 = request_row.token_sha256)
            OR (NEW.generation > request_row.activated_generation AND EXISTS (
              SELECT 1 FROM chat_session_control_grants prior
              WHERE prior.workspace_id = NEW.workspace_id AND prior.session_id = NEW.session_id
                AND prior.generation = NEW.generation - 1 AND prior.owner_kind = 'external_companion'
                AND prior.request_id = NEW.request_id
                AND prior.companion_session_id = NEW.companion_session_id
                AND prior.device_grant_id = NEW.device_grant_id
                AND prior.client_instance_id = NEW.client_instance_id
                AND prior.principal_purpose = NEW.principal_purpose
                AND prior.requested_capabilities_json = NEW.requested_capabilities_json
                AND prior.requested_capabilities_sha256 = NEW.requested_capabilities_sha256
                AND prior.effective_capabilities_json = NEW.effective_capabilities_json
                AND prior.effective_capabilities_sha256 = NEW.effective_capabilities_sha256
            ))
          )
          AND (
            (NEW.requested_capabilities_json = '["send"]' AND NEW.effective_capabilities_json = '["send"]')
            OR (NEW.requested_capabilities_json = '["send","read"]'
              AND NEW.effective_capabilities_json IN ('["send"]', '["send","read"]'))
          )
      ))
      OR (NEW.owner_kind = 'external_companion' AND NOT EXISTS (
        SELECT 1
        FROM companion_sessions companion_session
        JOIN auth_device_grants device_grant ON device_grant.grant_id = companion_session.grant_id
        JOIN auth_device_requests device_request ON device_request.request_id = device_grant.request_id
        WHERE companion_session.session_id = NEW.companion_session_id
          AND companion_session.grant_id = NEW.device_grant_id
          AND companion_session.principal_purpose = NEW.principal_purpose
          AND device_grant.principal_purpose = NEW.principal_purpose
          AND device_request.principal_purpose = NEW.principal_purpose
          AND NEW.principal_purpose = 'session_control_client'
          AND companion_session.revoked_at IS NULL AND device_grant.revoked_at IS NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', companion_session.refresh_token_expires_at, '+0 days')
            = companion_session.refresh_token_expires_at
          AND companion_session.refresh_token_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          AND (device_grant.expires_at IS NULL OR (
            strftime('%Y-%m-%dT%H:%M:%fZ', device_grant.expires_at, '+0 days') = device_grant.expires_at
            AND device_grant.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ))
      ))
      OR abs((julianday(NEW.created_at) - julianday('now')) * 86400.0) > 1.0
      OR abs((julianday(NEW.updated_at) - julianday('now')) * 86400.0) > 1.0
      OR (NEW.owner_kind = 'external_companion' AND (
        abs((julianday(NEW.token_expires_at) - julianday('now')) * 86400.0 - 900.0) > 1.0
        OR abs((julianday(NEW.last_heartbeat_at) - julianday('now')) * 86400.0) > 1.0
        OR abs((julianday(NEW.lease_expires_at) - julianday('now')) * 86400.0 - 60.0) > 1.0
        OR abs((julianday(NEW.reconnect_expires_at) - julianday('now')) * 86400.0 - 300.0) > 1.0
      ))
    BEGIN SELECT RAISE(ABORT, 'session control generation, workspace, or database-clock invariant violated'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_grants_update_guard
    BEFORE UPDATE ON chat_session_control_grants
    WHEN OLD.is_current <> 1 OR OLD.terminal_at IS NOT NULL
      OR NEW.workspace_id <> OLD.workspace_id OR NEW.session_id <> OLD.session_id
      OR NEW.generation <> OLD.generation OR NEW.owner_kind <> OLD.owner_kind
      OR NEW.request_id IS NOT OLD.request_id OR NEW.companion_session_id IS NOT OLD.companion_session_id
      OR NEW.device_grant_id IS NOT OLD.device_grant_id OR NEW.client_instance_id IS NOT OLD.client_instance_id
      OR NEW.principal_purpose IS NOT OLD.principal_purpose
      OR NEW.requested_capabilities_json <> OLD.requested_capabilities_json
      OR NEW.requested_capabilities_sha256 <> OLD.requested_capabilities_sha256
      OR NEW.effective_capabilities_json <> OLD.effective_capabilities_json
      OR NEW.effective_capabilities_sha256 <> OLD.effective_capabilities_sha256
      OR NEW.token_sha256 IS NOT OLD.token_sha256 OR NEW.token_expires_at IS NOT OLD.token_expires_at
      OR NEW.transition_idempotency_key <> OLD.transition_idempotency_key
      OR NEW.transition_request_sha256 <> OLD.transition_request_sha256 OR NEW.created_at <> OLD.created_at
      OR NEW.control_revision <> OLD.control_revision + 1 OR NEW.updated_at < OLD.updated_at
      OR abs((julianday(NEW.updated_at) - julianday('now')) * 86400.0) > 1.0
      OR NOT (
        (OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_live' AND NEW.terminal_at IS NULL
          AND NEW.last_heartbeat_at >= OLD.last_heartbeat_at
          AND abs((julianday(NEW.last_heartbeat_at) - julianday('now')) * 86400.0) <= 1.0
          AND abs((julianday(NEW.lease_expires_at) - julianday('now')) * 86400.0 - 60.0) <= 1.0
          AND abs((julianday(NEW.reconnect_expires_at) - julianday('now')) * 86400.0 - 300.0) <= 1.0)
        OR (OLD.owner_kind = 'external_companion' AND OLD.lease_state = 'external_live'
          AND NEW.is_current = 1 AND NEW.lease_state = 'external_stale' AND NEW.terminal_at IS NULL
          AND NEW.last_heartbeat_at = OLD.last_heartbeat_at AND NEW.lease_expires_at = OLD.lease_expires_at
          AND NEW.reconnect_expires_at = OLD.reconnect_expires_at)
        OR (NEW.is_current = 0 AND NEW.lease_state IN ('released', 'revoked', 'superseded', 'deleted')
          AND NEW.terminal_at = NEW.updated_at AND NEW.last_heartbeat_at IS OLD.last_heartbeat_at
          AND NEW.lease_expires_at IS OLD.lease_expires_at AND NEW.reconnect_expires_at IS OLD.reconnect_expires_at)
      )
    BEGIN SELECT RAISE(ABORT, 'session control current generation transition invariant violated'); END;
    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_grants_no_delete
    BEFORE DELETE ON chat_session_control_grants
    BEGIN SELECT RAISE(ABORT, 'session control grants are durable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_events_insert_guard
    BEFORE INSERT ON chat_session_control_events
    WHEN NEW.request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM chat_session_control_requests request_row
      WHERE request_row.request_id = NEW.request_id
        AND request_row.workspace_id = NEW.workspace_id AND request_row.session_id = NEW.session_id
        AND request_row.companion_session_id = NEW.companion_session_id
        AND request_row.device_grant_id = NEW.device_grant_id
    )
    BEGIN SELECT RAISE(ABORT, 'session control event request attribution invariant violated'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_events_no_update
    BEFORE UPDATE ON chat_session_control_events
    BEGIN SELECT RAISE(ABORT, 'session control events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_events_no_delete
    BEFORE DELETE ON chat_session_control_events
    BEGIN SELECT RAISE(ABORT, 'session control events are append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_auth_revoke_receipts_insert_guard
    BEFORE INSERT ON chat_session_control_auth_revoke_receipts
    WHEN abs((julianday(NEW.created_at) - julianday('now')) * 86400.0) > 1.0
      OR (
        SELECT COUNT(*) FROM chat_session_control_events event_row
        WHERE event_row.request_sha256 = NEW.request_sha256
      ) <> NEW.target_count
      OR (
        SELECT COUNT(DISTINCT event_row.workspace_id || char(0) || event_row.session_id)
        FROM chat_session_control_events event_row
        WHERE event_row.request_sha256 = NEW.request_sha256
      ) <> NEW.session_count
      OR (NEW.target_count > 0 AND NOT EXISTS (
        SELECT 1 FROM chat_session_control_events event_row
        WHERE event_row.request_sha256 = NEW.request_sha256
          AND event_row.idempotency_key = NEW.idempotency_key
      ))
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke receipt invariant violated'); END;
    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_auth_revoke_receipts_no_update
    BEFORE UPDATE ON chat_session_control_auth_revoke_receipts
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_chat_session_control_auth_revoke_receipts_no_delete
    BEFORE DELETE ON chat_session_control_auth_revoke_receipts
    BEGIN SELECT RAISE(ABORT, 'session control auth revoke receipts are immutable'); END;

    INSERT INTO chat_session_control_grants (
      workspace_id, session_id, generation, is_current, owner_kind, lease_state,
      requested_capabilities_json, requested_capabilities_sha256,
      effective_capabilities_json, effective_capabilities_sha256,
      control_revision, transition_idempotency_key, transition_request_sha256,
      created_at, updated_at
    )
    SELECT
      meta.workspace_id, meta.session_id, 1, 1, 'operator', 'operator_active',
      '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      '[]', '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      1, 'migration:172:' || meta.session_id,
      'b133aba1d745b01c28823f849c760975b6dbabae2f3e647ebdbe8fae58b96da9',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM chat_session_meta meta
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_session_control_grants grant_row WHERE grant_row.session_id = meta.session_id
    );

    INSERT INTO chat_session_control_events (
      event_id, workspace_id, session_id, event_sequence, request_id, previous_generation, next_generation,
      previous_owner_kind, next_owner_kind, previous_lease_state, next_lease_state,
      reason_code, actor_kind, actor_id, companion_session_id, device_grant_id,
      idempotency_key, request_sha256, correlation_id, created_at
    )
    SELECT
      'sce_' || lower(hex(randomblob(24))), meta.workspace_id, meta.session_id, 1, NULL, NULL, 1,
      NULL, 'operator', NULL, 'operator_active', 'session_initialized', 'system', 'system', NULL, NULL,
      'migration:172:event:' || meta.session_id,
      'b133aba1d745b01c28823f849c760975b6dbabae2f3e647ebdbe8fae58b96da9',
      'migration:172', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM chat_session_meta meta
    JOIN chat_session_control_grants grant_row
      ON grant_row.session_id = meta.session_id AND grant_row.generation = 1
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_session_control_events event_row WHERE event_row.session_id = meta.session_id
    );

    CREATE TEMP TABLE IF NOT EXISTS gc_session_control_backfill_guard (
      ok INTEGER NOT NULL CHECK(ok = 1)
    );
    DELETE FROM gc_session_control_backfill_guard;
    INSERT INTO gc_session_control_backfill_guard(ok)
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM chat_session_meta meta
      LEFT JOIN chat_session_control_grants grant_row
        ON grant_row.session_id = meta.session_id AND grant_row.is_current = 1
      WHERE grant_row.session_id IS NULL OR grant_row.workspace_id <> meta.workspace_id
        OR NOT EXISTS (
          SELECT 1 FROM chat_session_control_events event_row WHERE event_row.session_id = meta.session_id
        )
    ) THEN 0 ELSE 1 END;
    DROP TABLE gc_session_control_backfill_guard;
  `);
}

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
