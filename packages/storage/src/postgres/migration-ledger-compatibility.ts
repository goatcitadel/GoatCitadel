import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AppliedMigrationLedgerRow } from "../migration-ledger-validation.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration } from "./migrations.js";

export const DEFAULT_POSTGRES_MIGRATIONS_TABLE = "schema_migrations";
const HISTORY_REPAIR_VERSION = 47;
const LEGACY_COMPOUND_VERSION = 124;
const CANONICAL_COMPOUND_VERSION = 129;
const LEGACY_COMPOUND_NAME = "compound_engineering_foundation";
const LEGACY_COMPOUND_RUNTIME_SHA256 = "32ef1642dd77337d9f0d7d54196ebec23b1447fa6793791323d387949f314018";

const HISTORICAL_LEDGER_ALIASES = [
  {
    version: 32,
    canonicalName: "state_validation_quarantine",
    legacyName: "cron_jobs_workdir_and_context_from",
  },
  {
    version: 33,
    canonicalName: "cron_jobs_workdir_context_from_run_output_run_id",
    legacyName: "cron_jobs_last_run_output_and_run_id",
  },
] as const;

const CANONICAL_HISTORY_REPAIR_MIGRATIONS = HISTORICAL_LEDGER_ALIASES.map((alias) =>
  POSTGRES_MIGRATIONS.find((migration) => migration.version === alias.version),
).concat(POSTGRES_MIGRATIONS.find((migration) => migration.version === HISTORY_REPAIR_VERSION));

export type LegacyCompoundV124LedgerClassification = "none" | "exact-candidate" | "invalid-candidate";

/**
 * Catalog proof for the short-lived branch build that shipped compound engineering as
 * PostgreSQL v124. The migration was atomic; this fingerprint proves its complete DDL is
 * present and that none of the canonical v124-v128 effects have already been mixed in.
 */
export const POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL = `
  WITH expected_table_columns(table_name, column_names) AS (
    VALUES
      ('prompt_retune_campaigns', ARRAY['campaign_id','pack_id','status','baseline_content_sha256','policy_hash','scoring_snapshot_json','test_codes_json','providers_json','execution_style','repeat_count','max_benchmark_runs','success_bar_json','noise_floor_json','baseline_metrics_json','active_pass_id','error','created_at','updated_at','finished_at']::pg_catalog.text[]),
      ('prompt_retune_passes', ARRAY['pass_id','campaign_id','kind','hypothesis','content_sha256','benchmark_run_ids_json','disposition','metrics_json','eligibility','notes','created_at','finished_at']::pg_catalog.text[]),
      ('structured_review_runs', ARRAY['review_run_id','source','status','root_path','reviewed_sha','diff_hash','changed_files_json','reviewer_roster_json','preflight_json','model_receipts_json','created_at','finished_at','error']::pg_catalog.text[]),
      ('structured_review_findings', ARRAY['finding_id','review_run_id','record_json','status','linked_task_id','fix_approval_id','created_at','updated_at']::pg_catalog.text[]),
      ('engineering_learnings', ARRAY['learning_id','workspace_id','project_id','status','title','fingerprint','record_json','source_run_id','supersedes_learning_id','created_at','updated_at']::pg_catalog.text[])
  ),
  expected_nullable_columns(table_name, column_name) AS (
    VALUES
      ('prompt_retune_campaigns','noise_floor_json'),
      ('prompt_retune_campaigns','baseline_metrics_json'),
      ('prompt_retune_campaigns','active_pass_id'),
      ('prompt_retune_campaigns','error'),
      ('prompt_retune_campaigns','finished_at'),
      ('prompt_retune_passes','metrics_json'),
      ('prompt_retune_passes','eligibility'),
      ('prompt_retune_passes','notes'),
      ('prompt_retune_passes','finished_at'),
      ('structured_review_runs','finished_at'),
      ('structured_review_runs','error'),
      ('structured_review_findings','linked_task_id'),
      ('structured_review_findings','fix_approval_id'),
      ('engineering_learnings','project_id'),
      ('engineering_learnings','supersedes_learning_id')
  ),
  expected_bigint_columns(table_name, column_name) AS (
    VALUES
      ('prompt_retune_campaigns','repeat_count'),
      ('prompt_retune_campaigns','max_benchmark_runs')
  ),
  actual_table_columns AS (
    SELECT columns.table_name::pg_catalog.text AS table_name,
           pg_catalog.array_agg(columns.column_name::pg_catalog.text ORDER BY columns.ordinal_position) AS column_names
    FROM information_schema.columns AS columns
    WHERE columns.table_schema OPERATOR(pg_catalog.=) pg_catalog.current_schema()
      AND columns.table_name IN (SELECT expected.table_name FROM expected_table_columns AS expected)
    GROUP BY columns.table_name
  ),
  expected_added_columns(table_name, column_name) AS (
    VALUES
      ('prompt_pack_benchmark_runs','pack_content_sha256'),
      ('prompt_pack_benchmark_runs','policy_hash'),
      ('prompt_pack_benchmark_runs','test_snapshot_json'),
      ('prompt_pack_benchmark_runs','test_snapshot_sha256'),
      ('prompt_pack_benchmark_runs','scoring_snapshot_json'),
      ('replay_regression_runs','baseline_benchmark_run_id'),
      ('chat_delegation_steps','work_result_json'),
      ('chat_delegation_steps','scope_control_json')
  ),
  expected_constraints(table_name, constraint_type, definition) AS (
    VALUES
      ('prompt_retune_campaigns','p','PRIMARY KEY (campaign_id)'),
      ('prompt_retune_passes','p','PRIMARY KEY (pass_id)'),
      ('prompt_retune_passes','f','FOREIGN KEY (campaign_id) REFERENCES prompt_retune_campaigns(campaign_id) ON DELETE CASCADE'),
      ('structured_review_runs','p','PRIMARY KEY (review_run_id)'),
      ('structured_review_findings','p','PRIMARY KEY (finding_id)'),
      ('structured_review_findings','f','FOREIGN KEY (review_run_id) REFERENCES structured_review_runs(review_run_id) ON DELETE CASCADE'),
      ('engineering_learnings','p','PRIMARY KEY (learning_id)')
  ),
  actual_constraints AS (
    SELECT relation.relname::pg_catalog.text AS table_name,
           constraint_record.contype::pg_catalog.text AS constraint_type,
           pg_catalog.pg_get_constraintdef(constraint_record.oid) AS definition
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS relation ON relation.oid OPERATOR(pg_catalog.=) constraint_record.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
    WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()
      AND relation.relname IN (SELECT expected.table_name FROM expected_table_columns AS expected)
  ),
  expected_indexes(index_name, table_name, is_unique, key_columns, descending_keys) AS (
    VALUES
      ('idx_prompt_retune_campaigns_pack_updated','prompt_retune_campaigns',FALSE,ARRAY['pack_id','updated_at']::pg_catalog.text[],ARRAY[FALSE,TRUE]::pg_catalog.bool[]),
      ('idx_prompt_retune_campaigns_status','prompt_retune_campaigns',FALSE,ARRAY['status','updated_at']::pg_catalog.text[],ARRAY[FALSE,FALSE]::pg_catalog.bool[]),
      ('idx_prompt_retune_passes_campaign_created','prompt_retune_passes',FALSE,ARRAY['campaign_id','created_at']::pg_catalog.text[],ARRAY[FALSE,FALSE]::pg_catalog.bool[]),
      ('idx_structured_review_runs_created','structured_review_runs',FALSE,ARRAY['created_at']::pg_catalog.text[],ARRAY[TRUE]::pg_catalog.bool[]),
      ('idx_structured_review_findings_run','structured_review_findings',FALSE,ARRAY['review_run_id','created_at']::pg_catalog.text[],ARRAY[FALSE,FALSE]::pg_catalog.bool[]),
      ('idx_structured_review_findings_status','structured_review_findings',FALSE,ARRAY['status','updated_at']::pg_catalog.text[],ARRAY[FALSE,TRUE]::pg_catalog.bool[]),
      ('idx_engineering_learnings_run_once','engineering_learnings',TRUE,ARRAY['workspace_id','source_run_id']::pg_catalog.text[],ARRAY[FALSE,FALSE]::pg_catalog.bool[]),
      ('idx_engineering_learnings_scope_status','engineering_learnings',FALSE,ARRAY['workspace_id','project_id','status','updated_at']::pg_catalog.text[],ARRAY[FALSE,FALSE,FALSE,TRUE]::pg_catalog.bool[]),
      ('idx_engineering_learnings_fingerprint','engineering_learnings',FALSE,ARRAY['workspace_id','fingerprint']::pg_catalog.text[],ARRAY[FALSE,FALSE]::pg_catalog.bool[])
  ),
  actual_indexes AS (
    SELECT index_relation.relname::pg_catalog.text AS index_name,
           table_relation.relname::pg_catalog.text AS table_name,
           index.indisunique AS is_unique,
           index.indisvalid,
           index.indisready,
           index.indpred IS NULL AS has_no_predicate,
           index.indexprs IS NULL AS has_no_expressions,
           ARRAY(
             SELECT pg_catalog.pg_get_indexdef(index.indexrelid, key_position, TRUE)
             FROM pg_catalog.generate_series(1, index.indnkeyatts) AS key_position
             ORDER BY key_position
           )::pg_catalog.text[] AS key_columns,
           ARRAY(
             SELECT (index.indoption[key_position - 1] OPERATOR(pg_catalog.&) 1) OPERATOR(pg_catalog.=) 1
             FROM pg_catalog.generate_series(1, index.indnkeyatts) AS key_position
             ORDER BY key_position
           )::pg_catalog.bool[] AS descending_keys
    FROM pg_catalog.pg_index AS index
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid OPERATOR(pg_catalog.=) index.indexrelid
    JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid OPERATOR(pg_catalog.=) index.indrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) table_relation.relnamespace
    WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()
      AND index_relation.relname IN (SELECT expected.index_name FROM expected_indexes AS expected)
  )
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM expected_table_columns AS expected
      LEFT JOIN actual_table_columns AS actual USING (table_name)
      WHERE actual.column_names IS DISTINCT FROM expected.column_names
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
      WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()
        AND relation.relname IN (SELECT expected.table_name FROM expected_table_columns AS expected)
        AND (relation.relkind IS DISTINCT FROM 'r' OR relation.relpersistence IS DISTINCT FROM 'p' OR relation.relowner IS DISTINCT FROM pg_catalog.to_regrole(CURRENT_USER)::pg_catalog.oid OR relation.relrowsecurity)
    )
    AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class AS relation JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema() AND relation.relname IN (SELECT expected.table_name FROM expected_table_columns AS expected)) OPERATOR(pg_catalog.=) 5
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.columns AS columns
      WHERE columns.table_schema OPERATOR(pg_catalog.=) pg_catalog.current_schema()
        AND columns.table_name IN (SELECT expected.table_name FROM expected_table_columns AS expected)
        AND (
          columns.data_type IS DISTINCT FROM CASE
            WHEN EXISTS (
              SELECT 1 FROM expected_bigint_columns AS expected
              WHERE expected.table_name OPERATOR(pg_catalog.=) columns.table_name
                AND expected.column_name OPERATOR(pg_catalog.=) columns.column_name
            ) THEN 'bigint'
            ELSE 'text'
          END
          OR columns.is_nullable IS DISTINCT FROM CASE
            WHEN EXISTS (
              SELECT 1 FROM expected_nullable_columns AS expected
              WHERE expected.table_name OPERATOR(pg_catalog.=) columns.table_name
                AND expected.column_name OPERATOR(pg_catalog.=) columns.column_name
            ) THEN 'YES'
            ELSE 'NO'
          END
          OR columns.column_default IS DISTINCT FROM CASE
            WHEN columns.table_name OPERATOR(pg_catalog.=) 'structured_review_runs'
              AND columns.column_name OPERATOR(pg_catalog.=) 'preflight_json'
            THEN '''{}''::text'
            ELSE NULL
          END
          OR columns.is_identity IS DISTINCT FROM 'NO'
          OR columns.is_generated IS DISTINCT FROM 'NEVER'
          OR columns.collation_name IS NOT NULL
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM expected_added_columns AS expected
      LEFT JOIN information_schema.columns AS actual
        ON actual.table_schema OPERATOR(pg_catalog.=) pg_catalog.current_schema()
       AND actual.table_name OPERATOR(pg_catalog.=) expected.table_name
       AND actual.column_name OPERATOR(pg_catalog.=) expected.column_name
      WHERE actual.column_name IS NULL
        OR actual.data_type IS DISTINCT FROM 'text'
        OR actual.is_nullable IS DISTINCT FROM 'YES'
        OR actual.column_default IS NOT NULL
        OR actual.is_identity IS DISTINCT FROM 'NO'
        OR actual.is_generated IS DISTINCT FROM 'NEVER'
        OR actual.collation_name IS NOT NULL
    )
    AND NOT EXISTS (SELECT * FROM expected_constraints EXCEPT SELECT * FROM actual_constraints)
    AND NOT EXISTS (SELECT * FROM actual_constraints EXCEPT SELECT * FROM expected_constraints)
    AND NOT EXISTS (
      SELECT 1
      FROM expected_indexes AS expected
      LEFT JOIN actual_indexes AS actual USING (index_name, table_name)
      WHERE actual.index_name IS NULL
         OR actual.is_unique IS DISTINCT FROM expected.is_unique
         OR actual.key_columns IS DISTINCT FROM expected.key_columns
         OR actual.descending_keys IS DISTINCT FROM expected.descending_keys
         OR NOT actual.indisvalid OR NOT actual.indisready OR NOT actual.has_no_predicate OR NOT actual.has_no_expressions
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policy
      JOIN pg_catalog.pg_class AS relation ON relation.oid OPERATOR(pg_catalog.=) policy.polrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
      WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()
        AND relation.relname IN (SELECT expected.table_name FROM expected_table_columns AS expected)
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid OPERATOR(pg_catalog.=) trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
      WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()
        AND relation.relname IN (SELECT expected.table_name FROM expected_table_columns AS expected)
        AND NOT trigger.tgisinternal
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
      WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()
        AND relation.relname IN ('chat_session_fork_manifests','notification_targets','notification_rules','notification_presence_leases','notification_events','notification_deliveries','chat_timers','chat_session_run_variable_bindings','personal_ops_note_revisions','document_patch_proposals')
    )
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns AS columns
      WHERE columns.table_schema OPERATOR(pg_catalog.=) pg_catalog.current_schema()
        AND ((columns.table_name OPERATOR(pg_catalog.=) 'prompt_packs' AND columns.column_name IN ('run_variable_schema_json','run_variable_schema_hash'))
          OR (columns.table_name OPERATOR(pg_catalog.=) 'prompt_pack_runs' AND columns.column_name OPERATOR(pg_catalog.=) 'run_variables_json')
          OR (columns.table_name OPERATOR(pg_catalog.=) 'personal_ops_notes' AND columns.column_name OPERATOR(pg_catalog.=) 'revision'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS constraint_record
      JOIN pg_catalog.pg_class AS relation ON relation.oid OPERATOR(pg_catalog.=) constraint_record.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid OPERATOR(pg_catalog.=) relation.relnamespace
      WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()
        AND constraint_record.conname OPERATOR(pg_catalog.=) 'chat_routed_context_snapshots_schema_version_v2_check'
    ) AS matches_expected
`;

export const POSTGRES_LEGACY_COMPOUND_V124_RELATION_LOCK_SQL = `
  LOCK TABLE
    prompt_pack_benchmark_runs,
    replay_regression_runs,
    chat_delegation_steps,
    prompt_retune_campaigns,
    prompt_retune_passes,
    structured_review_runs,
    structured_review_findings,
    engineering_learnings
  IN ACCESS SHARE MODE
`;

export const POSTGRES_HISTORY_REPAIR_TEMP_RELATION_PREFLIGHT_SQL =
  "SELECT pg_catalog.to_regclass('pg_temp.schema_migrations')::pg_catalog.text AS relation";
export const POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL =
  "SELECT pg_catalog.to_regclass('schema_migrations') OPERATOR(pg_catalog.=) " +
  "pg_catalog.to_regclass('pg_temp.schema_migrations') AS bridge_active";
export const POSTGRES_HISTORY_REPAIR_TEMP_VIEW_DROP_SQL = 'DROP VIEW pg_temp."schema_migrations"';
export const POSTGRES_MIGRATION_TEMP_OBJECT_PREFLIGHT_SQL =
  "SELECT (" +
  "SELECT relation.relname::pg_catalog.text " +
  "FROM pg_catalog.pg_class AS relation " +
  "WHERE relation.relnamespace OPERATOR(pg_catalog.=) pg_catalog.pg_my_temp_schema() " +
  "ORDER BY relation.oid LIMIT 1" +
  ") AS existing_temp_relation, (" +
  "SELECT type.typname::pg_catalog.text " +
  "FROM pg_catalog.pg_type AS type " +
  "WHERE type.typnamespace OPERATOR(pg_catalog.=) pg_catalog.pg_my_temp_schema() " +
  "ORDER BY type.oid LIMIT 1" +
  ") AS existing_temp_type";
export const POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL =
  "SELECT pg_catalog.pg_current_xact_id()::pg_catalog.text AS active_xid";
export const POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL =
  "SELECT pg_catalog.pg_try_advisory_xact_lock(" +
  "2147483000, pg_catalog.pg_backend_pid()) AS transaction_probe_acquired";
export const POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL =
  "SELECT EXISTS (" +
  "SELECT 1 FROM pg_catalog.pg_locks AS lock " +
  "WHERE lock.locktype::pg_catalog.text OPERATOR(pg_catalog.=) 'advisory'::pg_catalog.text " +
  "AND lock.pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid() " +
  "AND lock.classid OPERATOR(pg_catalog.=) 2147483000::pg_catalog.oid " +
  "AND lock.objid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()::pg_catalog.oid " +
  "AND lock.objsubid OPERATOR(pg_catalog.=) 2 " +
  "AND lock.mode::pg_catalog.text OPERATOR(pg_catalog.=) 'ExclusiveLock'::pg_catalog.text " +
  "AND lock.granted IS TRUE" +
  ") AS transaction_open, EXISTS (" +
  "SELECT 1 FROM pg_catalog.pg_locks AS lock " +
  "WHERE lock.locktype::pg_catalog.text OPERATOR(pg_catalog.=) 'advisory'::pg_catalog.text " +
  "AND lock.pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid() " +
  "AND lock.granted IS TRUE " +
  "AND NOT (" +
  "lock.classid OPERATOR(pg_catalog.=) 2147483000::pg_catalog.oid " +
  "AND lock.objid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()::pg_catalog.oid " +
  "AND lock.objsubid OPERATOR(pg_catalog.=) 2 " +
  "AND lock.mode::pg_catalog.text OPERATOR(pg_catalog.=) 'ExclusiveLock'::pg_catalog.text" +
  ")" +
  ") AS existing_advisory_lock";
export const POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL =
  "SELECT active_xid::pg_catalog.text AS active_xid " +
  "FROM pg_catalog.pg_snapshot_xip(pg_catalog.pg_current_snapshot()) AS active_xid " +
  "ORDER BY active_xid";
export const POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL =
  "SELECT namespace.nspname::pg_catalog.text AS current_schema_name, " +
  "namespace.oid::pg_catalog.text AS current_schema_oid, " +
  buildPostgresCurrentUserOwnsNamespaceExpression() +
  " AS current_schema_owned_by_current_user, " +
  buildPostgresCurrentSchemaHasExclusiveCreateExpression() +
  " AS current_schema_has_exclusive_create_authority, " +
  buildPostgresExistingUnownedRelationExpression() +
  " AS existing_unowned_relation, " +
  "namespace.oid OPERATOR(pg_catalog.=) pg_catalog.pg_my_temp_schema() OR " +
  "namespace.nspname OPERATOR(pg_catalog.~) '^pg_(toast_)?temp_[0-9]+$' AS current_schema_is_temp " +
  "FROM pg_catalog.pg_namespace AS namespace " +
  "WHERE namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()";

export class PostgresMigrationSessionContaminationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PostgresMigrationSessionContaminationError";
  }
}

export interface PostgresMigrationSchemaIdentity {
  name: string;
  oid: string;
}

export function buildPostgresMigrationLedgerTempShadowPreflightSql(parameter: string): string {
  return (
    "SELECT pg_catalog.to_regclass(" +
    `pg_catalog.concat('pg_temp.', pg_catalog.quote_ident(${parameter}::pg_catalog.text))` +
    ")::pg_catalog.text AS relation"
  );
}

export function parsePostgresMigrationActiveTransactionIds(rows: readonly unknown[]): string[] {
  const transactionIds = new Set<string>();
  for (const row of rows) {
    const activeXid =
      typeof row === "object" && row !== null && "active_xid" in row
        ? (row as { active_xid?: unknown }).active_xid
        : undefined;
    if (typeof activeXid !== "string" || !/^\d+$/.test(activeXid)) {
      throw new PostgresMigrationSessionContaminationError(
        "Postgres migration active-transaction preflight returned an invalid transaction id.",
      );
    }
    transactionIds.add(activeXid);
  }
  return [...transactionIds];
}

export function assertPostgresMigrationSessionIsIdle(row: unknown): void {
  const transactionOpen = readUnknownField(row, "transaction_open");
  const existingAdvisoryLock = readUnknownField(row, "existing_advisory_lock");
  if (transactionOpen === false && existingAdvisoryLock === false) {
    return;
  }
  if (transactionOpen === true) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration session was already inside a transaction before lock acquisition.",
    );
  }
  if (transactionOpen === false && existingAdvisoryLock === true) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration session already held an advisory lock before lock acquisition.",
    );
  }
  throw new PostgresMigrationSessionContaminationError(
    "Postgres migration transaction-state preflight returned an invalid result.",
  );
}

export function assertPostgresMigrationTransactionProbeAcquired(row: unknown): void {
  const acquired = readUnknownField(row, "transaction_probe_acquired");
  if (acquired === true) {
    return;
  }
  if (acquired === false) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction-state probe lock is held by another session.",
    );
  }
  throw new PostgresMigrationSessionContaminationError(
    "Postgres migration transaction-state probe returned an invalid acquisition result.",
  );
}

export function selectPostgresMigrationPreexistingTransactionIds(
  epochMarkerTransactionId: string,
  snapshotTransactionIds: readonly string[],
): string[] {
  const marker = parsePostgresTransactionId(epochMarkerTransactionId, "transaction-epoch barrier");
  const selected = new Set<string>();
  for (const snapshotTransactionId of snapshotTransactionIds) {
    const snapshot = parsePostgresTransactionId(snapshotTransactionId, "active-transaction snapshot");
    if (snapshot < marker) {
      selected.add(snapshotTransactionId);
    }
  }
  return [...selected];
}

export function buildPostgresMigrationTransactionDatabaseClassificationSql(parameter: string): string {
  return (
    "WITH observed_database AS MATERIALIZED (" +
    "SELECT activity.datid AS database_oid " +
    "FROM pg_catalog.pg_stat_activity AS activity " +
    `WHERE activity.backend_xid OPERATOR(pg_catalog.=) ((${parameter}::pg_catalog.xid8)::pg_catalog.xid) ` +
    "AND activity.datid IS NOT NULL " +
    "UNION ALL " +
    "SELECT database.oid AS database_oid " +
    "FROM pg_catalog.pg_prepared_xacts AS prepared " +
    "JOIN pg_catalog.pg_database AS database " +
    "ON database.datname OPERATOR(pg_catalog.=) prepared.database " +
    `WHERE prepared.transaction OPERATOR(pg_catalog.=) ((${parameter}::pg_catalog.xid8)::pg_catalog.xid)` +
    "), transaction_state AS MATERIALIZED (" +
    `SELECT pg_catalog.pg_xact_status(${parameter}::pg_catalog.xid8)::pg_catalog.text AS transaction_status` +
    "), observation AS (" +
    "SELECT pg_catalog.count(DISTINCT database_oid)::pg_catalog.text AS observed_database_count, " +
    "COALESCE(pg_catalog.bool_or(database_oid OPERATOR(pg_catalog.=) (" +
    "SELECT database.oid FROM pg_catalog.pg_database AS database " +
    "WHERE database.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()" +
    ")), false) AS current_database_observed " +
    "FROM observed_database" +
    ") " +
    "SELECT transaction_status, observed_database_count, current_database_observed " +
    "FROM transaction_state CROSS JOIN observation"
  );
}

export type PostgresMigrationTransactionDatabaseClassification = "complete" | "current" | "other" | "unknown";

export function classifyPostgresMigrationTransactionDatabase(
  row: unknown,
): PostgresMigrationTransactionDatabaseClassification {
  const status = readUnknownField(row, "transaction_status");
  const observedDatabaseCount = readUnknownField(row, "observed_database_count");
  const currentDatabaseObserved = readUnknownField(row, "current_database_observed");
  if (status === "committed" || status === "aborted") {
    return "complete";
  }
  if (
    status !== "in progress" ||
    (observedDatabaseCount !== "0" && observedDatabaseCount !== "1") ||
    typeof currentDatabaseObserved !== "boolean" ||
    (observedDatabaseCount === "0" && currentDatabaseObserved)
  ) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction database-classification probe returned an invalid result.",
    );
  }
  if (observedDatabaseCount === "0") {
    return "unknown";
  }
  return currentDatabaseObserved ? "current" : "other";
}

function parsePostgresTransactionId(value: string, source: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new PostgresMigrationSessionContaminationError(
      `Postgres migration ${source} returned an invalid transaction id.`,
    );
  }
  return BigInt(value);
}

function readUnknownField(row: unknown, field: string): unknown {
  return typeof row === "object" && row !== null && field in row ? (row as Record<string, unknown>)[field] : undefined;
}

export function assertPostgresMigrationLedgerNotShadowed(row: unknown, migrationsTable: string): void {
  const relation = readTempRelation(row);
  if (relation === null) {
    return;
  }
  throw new PostgresMigrationSessionContaminationError(
    `Postgres temporary relation ${JSON.stringify(relation)} shadows the configured migrations table ` +
      `${JSON.stringify(migrationsTable)} on the pinned session.`,
  );
}

export function assertPostgresMigrationSessionHasNoTempObjects(row: unknown): void {
  const relation = readNullableNonEmptyString(row, "existing_temp_relation");
  const type = readNullableNonEmptyString(row, "existing_temp_type");
  if (relation === null && type === null) {
    return;
  }
  const object = relation === null ? `type ${JSON.stringify(type)}` : `relation ${JSON.stringify(relation)}`;
  throw new PostgresMigrationSessionContaminationError(
    `Postgres temporary ${object} contaminates the pinned migration session.`,
  );
}

export function assertPostgresMigrationCurrentSchemaIsDurable(row: unknown): PostgresMigrationSchemaIdentity {
  const isTemp =
    typeof row === "object" && row !== null && "current_schema_is_temp" in row
      ? (row as { current_schema_is_temp?: unknown }).current_schema_is_temp
      : undefined;
  const currentSchemaName =
    typeof row === "object" && row !== null && "current_schema_name" in row
      ? (row as { current_schema_name?: unknown }).current_schema_name
      : undefined;
  if (isTemp === true) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres temporary current schema cannot own the migrations table or migration side effects.",
    );
  }
  if (
    isTemp === false &&
    typeof currentSchemaName === "string" &&
    currentSchemaName.length > 0 &&
    (currentSchemaName === "information_schema" || currentSchemaName.startsWith("pg_"))
  ) {
    throw new PostgresMigrationSessionContaminationError(
      `Postgres system schema ${JSON.stringify(currentSchemaName)} cannot own GoatCitadel migration state.`,
    );
  }
  const currentSchemaOid =
    typeof row === "object" && row !== null && "current_schema_oid" in row
      ? (row as { current_schema_oid?: unknown }).current_schema_oid
      : undefined;
  const currentSchemaOwnedByCurrentUser =
    typeof row === "object" && row !== null && "current_schema_owned_by_current_user" in row
      ? (row as { current_schema_owned_by_current_user?: unknown }).current_schema_owned_by_current_user
      : undefined;
  const currentSchemaHasExclusiveCreateAuthority =
    typeof row === "object" && row !== null && "current_schema_has_exclusive_create_authority" in row
      ? (row as { current_schema_has_exclusive_create_authority?: unknown })
          .current_schema_has_exclusive_create_authority
      : undefined;
  const existingUnownedRelation = readNullableNonEmptyString(row, "existing_unowned_relation");
  if (isTemp === false && currentSchemaOwnedByCurrentUser === false) {
    throw new PostgresMigrationSessionContaminationError(
      `Postgres migration role must own schema ${JSON.stringify(currentSchemaName)} directly or as the current ` +
        "database owner through pg_database_owner; delegated CREATE/USAGE grants are not sufficient.",
    );
  }
  if (isTemp === false && currentSchemaHasExclusiveCreateAuthority === false) {
    throw new PostgresMigrationSessionContaminationError(
      `Postgres migration schema ${JSON.stringify(currentSchemaName)} grants CREATE to another role or PUBLIC.`,
    );
  }
  if (isTemp === false && existingUnownedRelation !== null && existingUnownedRelation !== undefined) {
    throw new PostgresMigrationSessionContaminationError(
      `Postgres migration schema ${JSON.stringify(currentSchemaName)} contains relation ` +
        `${JSON.stringify(existingUnownedRelation)} owned by another role.`,
    );
  }
  if (
    isTemp === false &&
    currentSchemaOwnedByCurrentUser === true &&
    currentSchemaHasExclusiveCreateAuthority === true &&
    existingUnownedRelation === null &&
    typeof currentSchemaName === "string" &&
    currentSchemaName.length > 0 &&
    typeof currentSchemaOid === "string" &&
    /^\d+$/.test(currentSchemaOid)
  ) {
    return { name: currentSchemaName, oid: currentSchemaOid };
  }
  throw new PostgresMigrationSessionContaminationError(
    "Postgres migration current-schema preflight returned an invalid result.",
  );
}

export function buildPostgresMigrationSchemaIdentityCheckSql(parameter: string): string {
  return (
    "SELECT namespace.nspname::pg_catalog.text AS current_schema_name, " +
    "namespace.oid::pg_catalog.text AS current_schema_oid, " +
    buildPostgresCurrentUserOwnsNamespaceExpression() +
    " AS current_schema_owned_by_current_user, " +
    buildPostgresCurrentSchemaHasExclusiveCreateExpression() +
    " AS current_schema_has_exclusive_create_authority, " +
    buildPostgresExistingUnownedRelationExpression() +
    " AS existing_unowned_relation " +
    "FROM pg_catalog.pg_namespace AS namespace " +
    `WHERE namespace.nspname OPERATOR(pg_catalog.=) ${parameter}::pg_catalog.text ` +
    "AND namespace.nspname OPERATOR(pg_catalog.=) pg_catalog.current_schema()"
  );
}

function buildPostgresCurrentSchemaHasExclusiveCreateExpression(): string {
  return (
    "NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(" +
    "COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))) AS schema_acl " +
    "WHERE schema_acl.privilege_type::pg_catalog.text " +
    "OPERATOR(pg_catalog.=) 'CREATE'::pg_catalog.text " +
    "AND schema_acl.grantee OPERATOR(pg_catalog.<>) namespace.nspowner " +
    `AND schema_acl.grantee OPERATOR(pg_catalog.<>) ${buildPostgresCurrentUserOidExpression()})`
  );
}

function buildPostgresExistingUnownedRelationExpression(): string {
  return (
    "(SELECT relation.relname::pg_catalog.text FROM pg_catalog.pg_class AS relation " +
    "WHERE relation.relnamespace OPERATOR(pg_catalog.=) namespace.oid " +
    `AND relation.relowner OPERATOR(pg_catalog.<>) ${buildPostgresCurrentUserOidExpression()} ` +
    "AND relation.relowner OPERATOR(pg_catalog.<>) namespace.nspowner " +
    "ORDER BY relation.oid LIMIT 1)"
  );
}

function buildPostgresCurrentUserOwnsNamespaceExpression(): string {
  const currentUserOid = buildPostgresCurrentUserOidExpression();
  return (
    `(namespace.nspowner OPERATOR(pg_catalog.=) ${currentUserOid} OR (` +
    "pg_catalog.pg_get_userbyid(namespace.nspowner)::pg_catalog.text " +
    "OPERATOR(pg_catalog.=) 'pg_database_owner'::pg_catalog.text AND " +
    "(SELECT database.datdba FROM pg_catalog.pg_database AS database " +
    "WHERE database.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) " +
    `OPERATOR(pg_catalog.=) ${currentUserOid}))`
  );
}

function buildPostgresCurrentUserOidExpression(): string {
  return (
    "(SELECT role.oid FROM pg_catalog.pg_roles AS role " + "WHERE role.rolname OPERATOR(pg_catalog.=) CURRENT_USER)"
  );
}

export function assertPostgresMigrationSchemaIdentityMatches(
  row: unknown,
  expected: PostgresMigrationSchemaIdentity,
): void {
  const actualName =
    typeof row === "object" && row !== null && "current_schema_name" in row
      ? (row as { current_schema_name?: unknown }).current_schema_name
      : undefined;
  const actualOid =
    typeof row === "object" && row !== null && "current_schema_oid" in row
      ? (row as { current_schema_oid?: unknown }).current_schema_oid
      : undefined;
  const currentSchemaOwnedByCurrentUser =
    typeof row === "object" && row !== null && "current_schema_owned_by_current_user" in row
      ? (row as { current_schema_owned_by_current_user?: unknown }).current_schema_owned_by_current_user
      : undefined;
  const currentSchemaHasExclusiveCreateAuthority =
    typeof row === "object" && row !== null && "current_schema_has_exclusive_create_authority" in row
      ? (row as { current_schema_has_exclusive_create_authority?: unknown })
          .current_schema_has_exclusive_create_authority
      : undefined;
  const existingUnownedRelation = readNullableNonEmptyString(row, "existing_unowned_relation");
  if (existingUnownedRelation !== null && existingUnownedRelation !== undefined) {
    throw new PostgresMigrationSessionContaminationError(
      `Postgres migration schema ${JSON.stringify(expected.name)} gained relation ` +
        `${JSON.stringify(existingUnownedRelation)} owned by another role after preflight.`,
    );
  }
  if (
    actualName === expected.name &&
    actualOid === expected.oid &&
    currentSchemaOwnedByCurrentUser === true &&
    currentSchemaHasExclusiveCreateAuthority === true &&
    existingUnownedRelation === null
  ) {
    return;
  }
  throw new PostgresMigrationSessionContaminationError(
    `Postgres migration schema ${JSON.stringify(expected.name)} changed after preflight.`,
  );
}

export function buildPostgresQualifiedMigrationLedger(
  migrationSchema: PostgresMigrationSchemaIdentity,
  migrationsTable: string,
): string {
  return `${quotePostgresIdentifier(migrationSchema.name)}.${quotePostgresIdentifier(migrationsTable)}`;
}

export function buildPostgresMigrationLedgerGuardLockSql(qualifiedMigrationsTable: string): string {
  return `LOCK TABLE ${qualifiedMigrationsTable} IN ACCESS SHARE MODE`;
}

export function buildPostgresMigrationSetLocalSearchPathSql(parameter: string): string {
  return (
    "SELECT pg_catalog.set_config('search_path', " + `${parameter}::pg_catalog.text, TRUE) AS migration_search_path`
  );
}

export function buildPostgresMigrationSearchPath(
  currentSchema: PostgresMigrationSchemaIdentity,
  _historyRepairBridge: boolean,
): string {
  return quotePostgresIdentifier(currentSchema.name);
}

export function assertPostgresMigrationSearchPathConfigured(row: unknown, expected: string): void {
  const actual =
    typeof row === "object" && row !== null && "migration_search_path" in row
      ? (row as { migration_search_path?: unknown }).migration_search_path
      : undefined;
  if (actual === expected) {
    return;
  }
  throw new PostgresMigrationSessionContaminationError(
    "Postgres migration transaction did not establish the required local search path.",
  );
}

export interface PostgresMigrationLedgerCompatibilityResult {
  appliedRows: readonly AppliedMigrationLedgerRow[];
  requiresHistoryRepairValidation: boolean;
}

export function classifyLegacyCompoundV124Ledger(input: {
  definitions: readonly PostgresMigration[];
  appliedRows: readonly AppliedMigrationLedgerRow[];
}): LegacyCompoundV124LedgerClassification {
  const hasLegacyClaim = input.appliedRows.some(
    (row) => row.version === LEGACY_COMPOUND_VERSION && row.name === LEGACY_COMPOUND_NAME,
  );
  if (!hasLegacyClaim) {
    return "none";
  }

  const canonicalThroughCompound = POSTGRES_MIGRATIONS.filter(
    (migration) => migration.version <= CANONICAL_COMPOUND_VERSION,
  );
  const candidateThroughCompound = input.definitions.filter(
    (migration) => migration.version <= CANONICAL_COMPOUND_VERSION,
  );
  const definitionsMatch =
    candidateThroughCompound.length === canonicalThroughCompound.length &&
    canonicalThroughCompound.every((canonical, index) => {
      const candidate = candidateThroughCompound[index];
      return candidate !== undefined && hasExactCompleteMigrationDefinition(candidate, canonical);
    });
  const canonicalCompound = canonicalThroughCompound.find(
    (migration) => migration.version === CANONICAL_COMPOUND_VERSION,
  );
  const compoundHashMatches =
    canonicalCompound !== undefined &&
    createHash("sha256")
      .update(`atomic\n${canonicalCompound.sql.replace(/\r\n/g, "\n").trim()}`)
      .digest("hex") === LEGACY_COMPOUND_RUNTIME_SHA256;
  const ledgerMatches =
    input.appliedRows.length === LEGACY_COMPOUND_VERSION &&
    input.appliedRows.every((row, index) => {
      const expectedVersion = index + 1;
      if (expectedVersion === LEGACY_COMPOUND_VERSION) {
        return row.version === LEGACY_COMPOUND_VERSION && row.name === LEGACY_COMPOUND_NAME;
      }
      const canonical = canonicalThroughCompound[index];
      return canonical !== undefined && row.version === expectedVersion && row.name === canonical.name;
    });

  return definitionsMatch && compoundHashMatches && ledgerMatches ? "exact-candidate" : "invalid-candidate";
}

export function assertLegacyCompoundV124Catalog(row: unknown): void {
  const matchesExpected =
    typeof row === "object" && row !== null && "matches_expected" in row
      ? (row as { matches_expected?: unknown }).matches_expected
      : undefined;
  if (matchesExpected !== true) {
    throw new Error(
      "Postgres legacy compound-engineering v124 ledger repair was refused because the database catalog does not match the exact deployed migration state.",
    );
  }
}

export function buildPostgresLegacyCompoundLedgerRepairLockSql(qualifiedMigrationsTable: string): string {
  return `LOCK TABLE ${qualifiedMigrationsTable} IN SHARE ROW EXCLUSIVE MODE`;
}

export function buildPostgresLegacyCompoundLedgerRepairSql(
  qualifiedMigrationsTable: string,
  legacyNameParameter: string,
): string {
  return `
    UPDATE ${qualifiedMigrationsTable} AS ledger
    SET version = ${CANONICAL_COMPOUND_VERSION}
    WHERE ledger.version = ${LEGACY_COMPOUND_VERSION}
      AND ledger.name OPERATOR(pg_catalog.=) ${legacyNameParameter}::pg_catalog.text
      AND NOT EXISTS (
        SELECT 1 FROM ${qualifiedMigrationsTable} AS target
        WHERE target.version = ${CANONICAL_COMPOUND_VERSION}
      )
    RETURNING version, name, applied_at
  `;
}

export function assertLegacyCompoundV124LedgerRepairResult(rows: readonly unknown[]): void {
  const row = rows[0];
  const version =
    typeof row === "object" && row !== null && "version" in row
      ? Number((row as { version?: unknown }).version)
      : undefined;
  const name = typeof row === "object" && row !== null && "name" in row ? (row as { name?: unknown }).name : undefined;
  if (rows.length !== 1 || version !== CANONICAL_COMPOUND_VERSION || name !== LEGACY_COMPOUND_NAME) {
    throw new Error(
      "Postgres legacy compound-engineering v124 ledger repair did not update exactly one canonical row.",
    );
  }
}

export function normalizePostgresMigrationLedgerForHistoricalRepair(input: {
  definitions: readonly PostgresMigration[];
  appliedRows: readonly AppliedMigrationLedgerRow[];
}): PostgresMigrationLedgerCompatibilityResult {
  if (
    !hasCanonicalRepairDefinitions(input.definitions) ||
    input.appliedRows.some((row) => row.version === HISTORY_REPAIR_VERSION)
  ) {
    return unchanged(input.appliedRows);
  }

  const hasLegacyVersion32 = hasExactLegacyRow(input.appliedRows, HISTORICAL_LEDGER_ALIASES[0]);
  const hasLegacyVersion33 = hasExactLegacyRow(input.appliedRows, HISTORICAL_LEDGER_ALIASES[1]);
  if (!hasLegacyVersion32 && !hasLegacyVersion33) {
    return unchanged(input.appliedRows);
  }
  if (hasLegacyVersion33 && !hasLegacyVersion32) {
    return unchanged(input.appliedRows);
  }

  return {
    appliedRows: input.appliedRows.map((row) => {
      const alias = HISTORICAL_LEDGER_ALIASES.find(
        (candidate) => candidate.version === row.version && candidate.legacyName === row.name,
      );
      return alias ? { version: row.version, name: alias.canonicalName } : row;
    }),
    requiresHistoryRepairValidation: true,
  };
}

export function isPostgresHistoryRepairMigration(migration: PostgresMigration): boolean {
  const canonical = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === HISTORY_REPAIR_VERSION);
  return canonical !== undefined && hasExactMigrationDefinition(migration, canonical);
}

export function assertPostgresHistoryRepairRegistryIntegrity(definitions: readonly PostgresMigration[]): void {
  const canonicalRepair = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === HISTORY_REPAIR_VERSION);
  const candidateRepair = definitions.find((candidate) => candidate.version === HISTORY_REPAIR_VERSION);
  if (!canonicalRepair || !candidateRepair || hasExactMigrationDefinition(candidateRepair, canonicalRepair)) {
    return;
  }

  const claimsCanonicalRepair =
    candidateRepair.name === canonicalRepair.name ||
    candidateRepair.sql === canonicalRepair.sql ||
    HISTORICAL_LEDGER_ALIASES.every((alias) => {
      const canonical = POSTGRES_MIGRATIONS.find((migration) => migration.version === alias.version);
      return (
        canonical !== undefined && definitions.some((definition) => hasExactMigrationDefinition(definition, canonical))
      );
    });
  if (claimsCanonicalRepair) {
    throw new Error(
      "Postgres migration 47 must match the frozen canonical v47 definition when the registry claims its repair identity or cohort.",
    );
  }
}

export function requiresPostgresHistoryRepairLedgerBridge(
  migrationsTable: string,
  migration: PostgresMigration,
): boolean {
  return migrationsTable !== DEFAULT_POSTGRES_MIGRATIONS_TABLE && isPostgresHistoryRepairMigration(migration);
}

export function buildPostgresHistoryRepairTempViewSql(
  migrationsTable: string,
  migrationSchema?: PostgresMigrationSchemaIdentity,
): string {
  const source = migrationSchema
    ? buildPostgresQualifiedMigrationLedger(migrationSchema, migrationsTable)
    : quotePostgresIdentifier(migrationsTable);
  return 'CREATE TEMPORARY VIEW pg_temp."schema_migrations" AS ' + `SELECT version, name, applied_at FROM ${source}`;
}

export function assertPostgresHistoryRepairTempRelationAvailable(row: unknown): void {
  const relation = readTempRelation(row);
  if (relation === null) {
    return;
  }
  throw new PostgresMigrationSessionContaminationError(
    "Postgres migration 47 cannot bridge the configured migrations table because " +
      "pg_temp.schema_migrations already exists on the pinned session.",
  );
}

export function assertPostgresHistoryRepairTempViewOwnsResolution(row: unknown): void {
  const bridgeActive =
    typeof row === "object" && row !== null && "bridge_active" in row
      ? (row as { bridge_active?: unknown }).bridge_active
      : undefined;
  if (bridgeActive === true) {
    return;
  }
  if (bridgeActive === false || bridgeActive === null) {
    throw new Error(
      "Postgres migration 47 temporary ledger bridge does not own unqualified schema_migrations resolution.",
    );
  }
  throw new Error("Postgres migration 47 temporary-ledger resolution preflight returned an invalid result.");
}

export function quotePostgresIdentifier(value: string): string {
  if (value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > 63) {
    throw new Error(
      "Postgres migrations table must be a non-empty identifier without NUL characters and at most 63 UTF-8 bytes.",
    );
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function readTempRelation(row: unknown): string | null {
  const relation = readNullableNonEmptyString(row, "relation");
  if (relation !== undefined) return relation;
  throw new PostgresMigrationSessionContaminationError(
    "Postgres migration temporary-relation preflight returned an invalid relation result.",
  );
}

function readNullableNonEmptyString(row: unknown, key: string): string | null | undefined {
  const value =
    typeof row === "object" && row !== null && key in row ? (row as Record<string, unknown>)[key] : undefined;
  if (value === null || (typeof value === "string" && value.length > 0)) {
    return value;
  }
  return undefined;
}

function hasCanonicalRepairDefinitions(definitions: readonly PostgresMigration[]): boolean {
  return CANONICAL_HISTORY_REPAIR_MIGRATIONS.every(
    (canonical) =>
      canonical !== undefined && definitions.some((definition) => hasExactMigrationDefinition(definition, canonical)),
  );
}

function hasExactMigrationDefinition(left: PostgresMigration, right: PostgresMigration): boolean {
  return (
    left.version === right.version &&
    left.name === right.name &&
    left.sql === right.sql &&
    left.integritySha256 === right.integritySha256 &&
    left.batchedStatements === undefined &&
    right.batchedStatements === undefined
  );
}

function hasExactCompleteMigrationDefinition(left: PostgresMigration, right: PostgresMigration): boolean {
  if (
    left.version !== right.version ||
    left.name !== right.name ||
    left.sql !== right.sql ||
    left.integritySha256 !== right.integritySha256 ||
    (left.batchedStatements === undefined) !== (right.batchedStatements === undefined)
  ) {
    return false;
  }
  if (left.batchedStatements === undefined || right.batchedStatements === undefined) {
    return true;
  }
  return (
    left.batchedStatements.length === right.batchedStatements.length &&
    left.batchedStatements.every((statement, index) => {
      const canonicalStatement = right.batchedStatements?.[index];
      return (
        canonicalStatement !== undefined &&
        statement.name === canonicalStatement.name &&
        statement.sql === canonicalStatement.sql
      );
    })
  );
}

function hasExactLegacyRow(
  appliedRows: readonly AppliedMigrationLedgerRow[],
  alias: (typeof HISTORICAL_LEDGER_ALIASES)[number],
): boolean {
  return appliedRows.some((row) => row.version === alias.version && row.name === alias.legacyName);
}

function unchanged(appliedRows: readonly AppliedMigrationLedgerRow[]): PostgresMigrationLedgerCompatibilityResult {
  return {
    appliedRows,
    requiresHistoryRepairValidation: false,
  };
}
