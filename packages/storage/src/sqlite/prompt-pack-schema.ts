import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROMPT_PACK_POLICY_V2 } from "@goatcitadel/contracts";
import { hashPromptPackPolicyV2, stringifyPromptPackPolicyV2 } from "../prompt-pack-policy.js";

const DEFAULT_PROMPT_PACK_POLICY_V2_JSON = stringifyPromptPackPolicyV2(DEFAULT_PROMPT_PACK_POLICY_V2);
const DEFAULT_PROMPT_PACK_POLICY_V2_HASH = hashPromptPackPolicyV2(DEFAULT_PROMPT_PACK_POLICY_V2);

export interface SqlitePromptPackSchemaDeps {
  addColumnIfMissingIfTableExists: (db: DatabaseSync, tableName: string, columnName: string, columnSql: string) => void;
  tableExists: (db: DatabaseSync, tableName: string) => boolean;
}

export interface SqlitePromptPackSchemaBuilders {
  createPromptPackReadinessSchema: (db: DatabaseSync) => void;
  createPromptPackBenchmarkSchema: (db: DatabaseSync) => void;
  createPromptPackScoringV2Schema: (db: DatabaseSync) => void;
  ensurePromptPackBenchmarkDedupAudit: (db: DatabaseSync) => void;
  ensurePromptPackBenchmarkDedupRepair: (db: DatabaseSync) => void;
  runPromptPackBenchmarkDedupPass: (db: DatabaseSync) => void;
  repairPromptPackBenchmarkDedupWinners: (db: DatabaseSync) => void;
  comparePromptPackBenchmarkDedupRowsForTest: (left: Record<string, unknown>, right: Record<string, unknown>) => number;
  getPromptPackBenchmarkDedupCompletenessRankForTest: (row: Record<string, unknown>) => number;
  getPromptPackBenchmarkDedupTimestampForTest: (row: Record<string, unknown>) => number;
  getPromptPackBenchmarkDedupOrdinalForTest: (row: Record<string, unknown>) => number;
}

type PromptPackBenchmarkDedupRow = {
  rowid?: number;
  item_id: string;
  benchmark_run_id: string;
  pack_id: string;
  test_id: string;
  test_code: string;
  provider_id: string;
  model: string;
  run_id: string | null;
  score_id: string | null;
  auto_score_id: string | null;
  run_status: string;
  total_score: number | null;
  weighted_score: number | null;
  verdict: string | null;
  score_state: string | null;
  failure_signal: string | null;
  created_at: string | null;
  original_rowid?: number | null;
  source_created_at?: string | null;
  archived_at?: string | null;
};

export function createPromptPackSqliteSchemaBuilders(deps: SqlitePromptPackSchemaDeps): SqlitePromptPackSchemaBuilders {
  const { addColumnIfMissingIfTableExists, tableExists } = deps;

  function createPromptPackReadinessSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_delegation_runs (
        run_id TEXT PRIMARY KEY,
        parent_run_id TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_chat_delegation_runs_parent
        ON chat_delegation_runs(parent_run_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS chat_delegation_steps (
        step_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        label TEXT,
        step_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        summary TEXT,
        output TEXT,
        error TEXT,
        failure_guidance TEXT,
        durable_run_id TEXT,
        child_session_id TEXT,
        child_turn_id TEXT,
        citations_json TEXT,
        degraded_handoff_step_ids_json TEXT,
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
        policy_v2_json TEXT NOT NULL DEFAULT '${DEFAULT_PROMPT_PACK_POLICY_V2_JSON.replace(/'/g, "''")}',
        policy_v2_hash TEXT NOT NULL DEFAULT '${DEFAULT_PROMPT_PACK_POLICY_V2_HASH}',
        policy_v2_source TEXT NOT NULL DEFAULT 'inherited_default',
        content_sha256 TEXT,
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
        final_response_text TEXT,
        final_response_signals_json TEXT,
        derived_response_text TEXT,
        derived_response_signals_json TEXT,
        trace_json TEXT,
        citations_json TEXT,
        integrity_json TEXT,
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
        judge_json TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_pack_scores_pack_test
        ON prompt_pack_scores(pack_id, test_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS prompt_pack_auto_scores_v2 (
        auto_score_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        test_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        scoring_schema_version TEXT NOT NULL,
        scorer_version TEXT NOT NULL,
        judge_rubric_version TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        policy_source TEXT NOT NULL,
        score_state TEXT NOT NULL,
        auto_verdict TEXT NOT NULL,
        weighted_score REAL NOT NULL,
        judge_status TEXT NOT NULL,
        protocol_pass INTEGER NOT NULL DEFAULT 0,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_run_version
        ON prompt_pack_auto_scores_v2(run_id, scoring_schema_version, scorer_version, policy_hash);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_pack_test
        ON prompt_pack_auto_scores_v2(pack_id, test_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_run
        ON prompt_pack_auto_scores_v2(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_verdict
        ON prompt_pack_auto_scores_v2(auto_verdict, created_at DESC);

      CREATE TABLE IF NOT EXISTS prompt_pack_human_reviews_v2 (
        review_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        test_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        auto_score_id TEXT,
        reviewer_id TEXT NOT NULL,
        override_verdict TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_pack_human_reviews_v2_pack_test
        ON prompt_pack_human_reviews_v2(pack_id, test_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_human_reviews_v2_run
        ON prompt_pack_human_reviews_v2(run_id, created_at DESC);
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
        claimed_by_worker_id TEXT,
        claim_heartbeat_at TEXT,
        claim_expires_at TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_pack_started
        ON prompt_pack_benchmark_runs(pack_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_status
        ON prompt_pack_benchmark_runs(status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_claim
        ON prompt_pack_benchmark_runs(status, claim_expires_at ASC, started_at ASC);

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
        auto_score_id TEXT,
        run_status TEXT NOT NULL,
        total_score INTEGER,
        weighted_score REAL,
        verdict TEXT,
        score_state TEXT,
        failure_signal TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(benchmark_run_id) REFERENCES prompt_pack_benchmark_runs(benchmark_run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_run
        ON prompt_pack_benchmark_items(benchmark_run_id, created_at ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_unique
        ON prompt_pack_benchmark_items(benchmark_run_id, provider_id, model, test_id);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_model
        ON prompt_pack_benchmark_items(provider_id, model, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_test
        ON prompt_pack_benchmark_items(test_code, created_at DESC);
    `);
  }

  function createPromptPackScoringV2Schema(db: DatabaseSync): void {
    addColumnIfMissingIfTableExists(
      db,
      "prompt_packs",
      "policy_v2_json",
      `TEXT NOT NULL DEFAULT '${DEFAULT_PROMPT_PACK_POLICY_V2_JSON.replace(/'/g, "''")}'`,
    );
    addColumnIfMissingIfTableExists(
      db,
      "prompt_packs",
      "policy_v2_hash",
      `TEXT NOT NULL DEFAULT '${DEFAULT_PROMPT_PACK_POLICY_V2_HASH}'`,
    );
    addColumnIfMissingIfTableExists(
      db,
      "prompt_packs",
      "policy_v2_source",
      "TEXT NOT NULL DEFAULT 'inherited_default'",
    );
    addColumnIfMissingIfTableExists(db, "prompt_packs", "content_sha256", "TEXT");

    if (tableExists(db, "prompt_packs")) {
      db.exec(`
        UPDATE prompt_packs
        SET
          policy_v2_json = COALESCE(policy_v2_json, '${DEFAULT_PROMPT_PACK_POLICY_V2_JSON.replace(/'/g, "''")}'),
          policy_v2_hash = COALESCE(policy_v2_hash, '${DEFAULT_PROMPT_PACK_POLICY_V2_HASH}'),
          policy_v2_source = COALESCE(policy_v2_source, 'inherited_default');
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_pack_auto_scores_v2 (
        auto_score_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        test_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        scoring_schema_version TEXT NOT NULL,
        scorer_version TEXT NOT NULL,
        judge_rubric_version TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        policy_source TEXT NOT NULL,
        score_state TEXT NOT NULL,
        auto_verdict TEXT NOT NULL,
        weighted_score REAL NOT NULL,
        judge_status TEXT NOT NULL,
        protocol_pass INTEGER NOT NULL DEFAULT 0,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_run_version
        ON prompt_pack_auto_scores_v2(run_id, scoring_schema_version, scorer_version, policy_hash);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_pack_test
        ON prompt_pack_auto_scores_v2(pack_id, test_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_run
        ON prompt_pack_auto_scores_v2(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_auto_scores_v2_verdict
        ON prompt_pack_auto_scores_v2(auto_verdict, created_at DESC);

      CREATE TABLE IF NOT EXISTS prompt_pack_human_reviews_v2 (
        review_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        test_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        auto_score_id TEXT,
        reviewer_id TEXT NOT NULL,
        override_verdict TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_pack_human_reviews_v2_pack_test
        ON prompt_pack_human_reviews_v2(pack_id, test_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_pack_human_reviews_v2_run
        ON prompt_pack_human_reviews_v2(run_id, created_at DESC);
    `);

    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_items", "auto_score_id", "TEXT");
    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_items", "weighted_score", "REAL");
    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_items", "verdict", "TEXT");
    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_items", "score_state", "TEXT");
    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_runs", "claimed_by_worker_id", "TEXT");
    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_runs", "claim_heartbeat_at", "TEXT");
    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_runs", "claim_expires_at", "TEXT");
    ensurePromptPackBenchmarkDedupAudit(db);
    if (tableExists(db, "prompt_pack_benchmark_runs")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_runs_claim
          ON prompt_pack_benchmark_runs(status, claim_expires_at ASC, started_at ASC);
      `);
    }
  }

  function ensurePromptPackBenchmarkDedupAudit(db: DatabaseSync): void {
    if (!tableExists(db, "prompt_pack_benchmark_items")) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_pack_benchmark_item_dedup_audit (
        item_id TEXT PRIMARY KEY,
        benchmark_run_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        test_id TEXT NOT NULL,
        test_code TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        run_id TEXT,
        score_id TEXT,
        auto_score_id TEXT,
        run_status TEXT NOT NULL,
        total_score INTEGER,
        weighted_score REAL,
        verdict TEXT,
        score_state TEXT,
        failure_signal TEXT,
        original_rowid INTEGER NOT NULL,
        source_created_at TEXT,
        archived_at TEXT NOT NULL
      );
    `);
    addColumnIfMissingIfTableExists(db, "prompt_pack_benchmark_item_dedup_audit", "source_created_at", "TEXT");

    const duplicateCounts = getPromptPackBenchmarkDuplicateCounts(db);
    if (duplicateCounts.duplicateRowCount > 0) {
      // eslint-disable-next-line no-console
      console.warn("[goatcitadel] archiving duplicate prompt-pack benchmark items before unique-index migration", {
        duplicateGroupCount: duplicateCounts.duplicateGroupCount,
        duplicateRowCount: duplicateCounts.duplicateRowCount,
      });
    }

    runPromptPackBenchmarkDedupPass(db);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_pack_benchmark_items_unique
        ON prompt_pack_benchmark_items(benchmark_run_id, provider_id, model, test_id);
    `);
  }

  function ensurePromptPackBenchmarkDedupRepair(db: DatabaseSync): void {
    if (!tableExists(db, "prompt_pack_benchmark_items")) {
      return;
    }
    ensurePromptPackBenchmarkDedupAudit(db);
    repairPromptPackBenchmarkDedupWinners(db);
  }

  function getPromptPackBenchmarkDuplicateCounts(db: DatabaseSync): {
    duplicateGroupCount: number;
    duplicateRowCount: number;
  } {
    const duplicateCounts = db
      .prepare(
        `
          SELECT
            COUNT(*) AS duplicate_group_count,
            COALESCE(SUM(group_size - 1), 0) AS duplicate_row_count
          FROM (
            SELECT COUNT(*) AS group_size
            FROM prompt_pack_benchmark_items
            GROUP BY benchmark_run_id, provider_id, model, test_id
            HAVING COUNT(*) > 1
          )
        `,
      )
      .get() as
      | {
          duplicate_group_count?: number;
          duplicate_row_count?: number;
        }
      | undefined;

    return {
      duplicateGroupCount: Number(duplicateCounts?.duplicate_group_count ?? 0),
      duplicateRowCount: Number(duplicateCounts?.duplicate_row_count ?? 0),
    };
  }

  function runPromptPackBenchmarkDedupPass(db: DatabaseSync): void {
    const duplicateGroups = db
      .prepare(
        `
          SELECT benchmark_run_id, provider_id, model, test_id
          FROM prompt_pack_benchmark_items
          GROUP BY benchmark_run_id, provider_id, model, test_id
          HAVING COUNT(*) > 1
        `,
      )
      .all() as Array<{
      benchmark_run_id: string;
      provider_id: string;
      model: string;
      test_id: string;
    }>;

    if (duplicateGroups.length === 0) {
      return;
    }

    const selectLiveRows = db.prepare(
      `
        SELECT rowid, *
        FROM prompt_pack_benchmark_items
        WHERE benchmark_run_id = @benchmarkRunId
          AND provider_id = @providerId
          AND model = @model
          AND test_id = @testId
      `,
    );
    const insertAuditRow = db.prepare(
      `
        INSERT OR IGNORE INTO prompt_pack_benchmark_item_dedup_audit (
          item_id,
          benchmark_run_id,
          pack_id,
          test_id,
          test_code,
          provider_id,
          model,
          run_id,
          score_id,
          auto_score_id,
          run_status,
          total_score,
          weighted_score,
          verdict,
          score_state,
          failure_signal,
          original_rowid,
          source_created_at,
          archived_at
        ) VALUES (
          @item_id,
          @benchmark_run_id,
          @pack_id,
          @test_id,
          @test_code,
          @provider_id,
          @model,
          @run_id,
          @score_id,
          @auto_score_id,
          @run_status,
          @total_score,
          @weighted_score,
          @verdict,
          @score_state,
          @failure_signal,
          @original_rowid,
          @source_created_at,
          @archived_at
        )
      `,
    );
    const deleteLiveRow = db.prepare(`DELETE FROM prompt_pack_benchmark_items WHERE item_id = ?`);

    db.exec("SAVEPOINT prompt_pack_benchmark_dedup_pass");
    try {
      for (const group of duplicateGroups) {
        const rows = selectLiveRows.all({
          benchmarkRunId: group.benchmark_run_id,
          providerId: group.provider_id,
          model: group.model,
          testId: group.test_id,
        }) as PromptPackBenchmarkDedupRow[];
        if (rows.length < 2) {
          continue;
        }
        const winner = [...rows].sort(comparePromptPackBenchmarkDedupRows)[rows.length - 1]!;
        const archivedAt = new Date().toISOString();
        for (const row of rows) {
          if (row.item_id === winner.item_id) {
            continue;
          }
          insertAuditRow.run({
            item_id: row.item_id,
            benchmark_run_id: row.benchmark_run_id,
            pack_id: row.pack_id,
            test_id: row.test_id,
            test_code: row.test_code,
            provider_id: row.provider_id,
            model: row.model,
            run_id: row.run_id,
            score_id: row.score_id,
            auto_score_id: row.auto_score_id,
            run_status: row.run_status,
            total_score: row.total_score,
            weighted_score: row.weighted_score,
            verdict: row.verdict,
            score_state: row.score_state,
            failure_signal: row.failure_signal,
            original_rowid: Number(row.rowid ?? 0),
            source_created_at: row.created_at,
            archived_at: archivedAt,
          });
          deleteLiveRow.run(row.item_id);
        }
      }
      db.exec("RELEASE SAVEPOINT prompt_pack_benchmark_dedup_pass");
    } catch (error) {
      db.exec("ROLLBACK TO SAVEPOINT prompt_pack_benchmark_dedup_pass");
      db.exec("RELEASE SAVEPOINT prompt_pack_benchmark_dedup_pass");
      throw error;
    }
  }

  function repairPromptPackBenchmarkDedupWinners(db: DatabaseSync): void {
    if (!tableExists(db, "prompt_pack_benchmark_item_dedup_audit")) {
      return;
    }

    const liveRows = db
      .prepare(`SELECT rowid, * FROM prompt_pack_benchmark_items`)
      .all() as PromptPackBenchmarkDedupRow[];
    if (liveRows.length === 0) {
      return;
    }

    const selectArchivedRows = db.prepare(
      `
        SELECT
          item_id,
          benchmark_run_id,
          pack_id,
          test_id,
          test_code,
          provider_id,
          model,
          run_id,
          score_id,
          auto_score_id,
          run_status,
          total_score,
          weighted_score,
          verdict,
          score_state,
          failure_signal,
          original_rowid,
          source_created_at,
          archived_at
        FROM prompt_pack_benchmark_item_dedup_audit
        WHERE benchmark_run_id = @benchmarkRunId
          AND provider_id = @providerId
          AND model = @model
          AND test_id = @testId
      `,
    );
    const insertAuditRow = db.prepare(
      `
        INSERT OR IGNORE INTO prompt_pack_benchmark_item_dedup_audit (
          item_id,
          benchmark_run_id,
          pack_id,
          test_id,
          test_code,
          provider_id,
          model,
          run_id,
          score_id,
          auto_score_id,
          run_status,
          total_score,
          weighted_score,
          verdict,
          score_state,
          failure_signal,
          original_rowid,
          source_created_at,
          archived_at
        ) VALUES (
          @item_id,
          @benchmark_run_id,
          @pack_id,
          @test_id,
          @test_code,
          @provider_id,
          @model,
          @run_id,
          @score_id,
          @auto_score_id,
          @run_status,
          @total_score,
          @weighted_score,
          @verdict,
          @score_state,
          @failure_signal,
          @original_rowid,
          @source_created_at,
          @archived_at
        )
      `,
    );
    const deleteLiveRow = db.prepare(`DELETE FROM prompt_pack_benchmark_items WHERE item_id = ?`);
    const insertLiveRow = db.prepare(
      `
        INSERT OR REPLACE INTO prompt_pack_benchmark_items (
          item_id,
          benchmark_run_id,
          pack_id,
          test_id,
          test_code,
          provider_id,
          model,
          run_id,
          score_id,
          auto_score_id,
          run_status,
          total_score,
          weighted_score,
          verdict,
          score_state,
          failure_signal,
          created_at
        ) VALUES (
          @item_id,
          @benchmark_run_id,
          @pack_id,
          @test_id,
          @test_code,
          @provider_id,
          @model,
          @run_id,
          @score_id,
          @auto_score_id,
          @run_status,
          @total_score,
          @weighted_score,
          @verdict,
          @score_state,
          @failure_signal,
          @created_at
        )
      `,
    );
    const deleteArchivedRow = db.prepare(`DELETE FROM prompt_pack_benchmark_item_dedup_audit WHERE item_id = ?`);

    db.exec("SAVEPOINT prompt_pack_benchmark_dedup_repair");
    try {
      for (const liveRow of liveRows) {
        const archivedRows = selectArchivedRows.all({
          benchmarkRunId: liveRow.benchmark_run_id,
          providerId: liveRow.provider_id,
          model: liveRow.model,
          testId: liveRow.test_id,
        }) as PromptPackBenchmarkDedupRow[];
        if (archivedRows.length === 0) {
          continue;
        }
        const winner = [liveRow, ...archivedRows].sort(comparePromptPackBenchmarkDedupRows).at(-1);
        if (!winner || winner.item_id === liveRow.item_id) {
          continue;
        }
        const archivedAt = new Date().toISOString();
        insertAuditRow.run({
          item_id: liveRow.item_id,
          benchmark_run_id: liveRow.benchmark_run_id,
          pack_id: liveRow.pack_id,
          test_id: liveRow.test_id,
          test_code: liveRow.test_code,
          provider_id: liveRow.provider_id,
          model: liveRow.model,
          run_id: liveRow.run_id,
          score_id: liveRow.score_id,
          auto_score_id: liveRow.auto_score_id,
          run_status: liveRow.run_status,
          total_score: liveRow.total_score,
          weighted_score: liveRow.weighted_score,
          verdict: liveRow.verdict,
          score_state: liveRow.score_state,
          failure_signal: liveRow.failure_signal,
          original_rowid: Number(liveRow.rowid ?? 0),
          source_created_at: liveRow.created_at,
          archived_at: archivedAt,
        });
        deleteLiveRow.run(liveRow.item_id);
        insertLiveRow.run({
          item_id: winner.item_id,
          benchmark_run_id: winner.benchmark_run_id,
          pack_id: winner.pack_id,
          test_id: winner.test_id,
          test_code: winner.test_code,
          provider_id: winner.provider_id,
          model: winner.model,
          run_id: winner.run_id,
          score_id: winner.score_id,
          auto_score_id: winner.auto_score_id,
          run_status: winner.run_status,
          total_score: winner.total_score,
          weighted_score: winner.weighted_score,
          verdict: winner.verdict,
          score_state: winner.score_state,
          failure_signal: winner.failure_signal,
          created_at: winner.created_at ?? winner.source_created_at ?? liveRow.created_at ?? archivedAt,
        });
        deleteArchivedRow.run(winner.item_id);
      }
      db.exec("RELEASE SAVEPOINT prompt_pack_benchmark_dedup_repair");
    } catch (error) {
      db.exec("ROLLBACK TO SAVEPOINT prompt_pack_benchmark_dedup_repair");
      db.exec("RELEASE SAVEPOINT prompt_pack_benchmark_dedup_repair");
      throw error;
    }
  }

  function comparePromptPackBenchmarkDedupRows(
    left: PromptPackBenchmarkDedupRow,
    right: PromptPackBenchmarkDedupRow,
  ): number {
    const completenessDelta =
      getPromptPackBenchmarkDedupCompletenessRank(left) - getPromptPackBenchmarkDedupCompletenessRank(right);
    if (completenessDelta !== 0) {
      return completenessDelta;
    }
    const leftCreatedAt = getPromptPackBenchmarkDedupTimestamp(left);
    const rightCreatedAt = getPromptPackBenchmarkDedupTimestamp(right);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt < rightCreatedAt ? -1 : 1;
    }
    return getPromptPackBenchmarkDedupOrdinal(left) - getPromptPackBenchmarkDedupOrdinal(right);
  }

  function getPromptPackBenchmarkDedupCompletenessRank(row: PromptPackBenchmarkDedupRow): number {
    if (
      row.run_status === "completed" &&
      (row.auto_score_id ||
        row.score_id ||
        row.verdict ||
        row.score_state ||
        row.weighted_score !== null ||
        row.total_score !== null)
    ) {
      return 3;
    }
    if (row.run_status === "completed") {
      return 2;
    }
    if (row.run_status === "failed") {
      return 1;
    }
    return 0;
  }

  function getPromptPackBenchmarkDedupTimestamp(row: PromptPackBenchmarkDedupRow): number {
    const value = row.created_at ?? row.source_created_at;
    if (typeof value !== "string") {
      return Number.NEGATIVE_INFINITY;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }

  function getPromptPackBenchmarkDedupOrdinal(row: PromptPackBenchmarkDedupRow): number {
    if (typeof row.original_rowid === "number" && Number.isFinite(row.original_rowid)) {
      return row.original_rowid;
    }
    if (typeof row.rowid === "number" && Number.isFinite(row.rowid)) {
      return row.rowid;
    }
    return 0;
  }

  function comparePromptPackBenchmarkDedupRowsForTest(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): number {
    return comparePromptPackBenchmarkDedupRows(
      left as unknown as PromptPackBenchmarkDedupRow,
      right as unknown as PromptPackBenchmarkDedupRow,
    );
  }

  function getPromptPackBenchmarkDedupCompletenessRankForTest(row: Record<string, unknown>): number {
    return getPromptPackBenchmarkDedupCompletenessRank(row as unknown as PromptPackBenchmarkDedupRow);
  }

  function getPromptPackBenchmarkDedupTimestampForTest(row: Record<string, unknown>): number {
    return getPromptPackBenchmarkDedupTimestamp(row as unknown as PromptPackBenchmarkDedupRow);
  }

  function getPromptPackBenchmarkDedupOrdinalForTest(row: Record<string, unknown>): number {
    return getPromptPackBenchmarkDedupOrdinal(row as unknown as PromptPackBenchmarkDedupRow);
  }

  return {
    createPromptPackReadinessSchema,
    createPromptPackBenchmarkSchema,
    createPromptPackScoringV2Schema,
    ensurePromptPackBenchmarkDedupAudit,
    ensurePromptPackBenchmarkDedupRepair,
    runPromptPackBenchmarkDedupPass,
    repairPromptPackBenchmarkDedupWinners,
    comparePromptPackBenchmarkDedupRowsForTest,
    getPromptPackBenchmarkDedupCompletenessRankForTest,
    getPromptPackBenchmarkDedupTimestampForTest,
    getPromptPackBenchmarkDedupOrdinalForTest,
  };
}
