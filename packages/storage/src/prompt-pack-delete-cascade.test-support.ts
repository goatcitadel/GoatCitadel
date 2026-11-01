import assert from "node:assert/strict";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ModelComparisonRunRepository } from "./model-comparison-run-repo.js";
import { PromptPackRepository } from "./prompt-pack-repo.js";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";
import { PromptPackScoreRepository } from "./prompt-pack-score-repo.js";

// Deleting a plugin's prompt pack with everything recorded against it, on either driver: the same rows in all twelve
// tables that carry a pack id, plus what cascades from them, and nothing of another pack's.

const NOW = "2026-10-31T12:00:00.000Z";
export const DELETED_PACK = "plugin-meeting-tools-checks";
export const KEPT_PACK = "pack-kept";

/** Every table that names a pack, with the column the delete keys it by. */
export const PACK_TABLES = [
  "prompt_pack_benchmark_items",
  "prompt_pack_benchmark_runs",
  "prompt_pack_benchmark_item_dedup_audit",
  "prompt_pack_human_reviews_v2",
  "prompt_pack_auto_scores_v2",
  "prompt_pack_scores",
  "prompt_pack_runs",
  "prompt_pack_tests",
  "model_comparison_runs",
  "prompt_retune_campaigns",
  "replay_regression_runs",
  "prompt_packs",
] as const;

/** The child tables that hold no pack id, and go with their parent through its own `ON DELETE CASCADE`. */
const CHILD_TABLES = [
  { table: "model_comparison_judgments", column: "comparison_id", prefix: "cmp" },
  { table: "prompt_retune_passes", column: "campaign_id", prefix: "campaign" },
  { table: "replay_regression_results", column: "regression_run_id", prefix: "regression" },
] as const;

/** The deleted pack's rows go in every table, with their runs, scores and children, and another pack's stay. */
export async function verifyDeletePackCascade(db: DatabaseClient): Promise<void> {
  const repo = new PromptPackRepository(db);
  // Before any comparison was ever run, its table doesn't exist yet: the delete still works.
  repo.createPackWithTestsIfAbsent(packInput("plugin-never-compared"));
  assert.deepEqual(repo.deletePackCascade("plugin-never-compared"), { deletedRuns: 0 });
  assert.throws(() => repo.getPack("plugin-never-compared"), NotFoundError);

  for (const packId of [DELETED_PACK, KEPT_PACK]) await seedPack(db, packId);
  for (const packId of [DELETED_PACK, KEPT_PACK]) {
    for (const table of PACK_TABLES) assert.ok(countRows(db, table, "pack_id", packId) > 0, `${table} ${packId}`);
  }

  assert.deepEqual(repo.deletePackCascade(DELETED_PACK), { deletedRuns: 2 });

  for (const table of PACK_TABLES) {
    assert.equal(countRows(db, table, "pack_id", DELETED_PACK), 0, `${table} still holds the deleted pack`);
    assert.ok(countRows(db, table, "pack_id", KEPT_PACK) > 0, `${table} lost another pack's rows`);
  }
  for (const child of CHILD_TABLES) {
    assert.equal(countRows(db, child.table, child.column, `${child.prefix}-${DELETED_PACK}`), 0, child.table);
    assert.equal(countRows(db, child.table, child.column, `${child.prefix}-${KEPT_PACK}`), 1, child.table);
  }
  assert.throws(() => repo.getPack(DELETED_PACK), NotFoundError);
  assert.equal(repo.getPack(KEPT_PACK).packId, KEPT_PACK);
  // A pack that is already gone deletes nothing, and says so.
  assert.deepEqual(repo.deletePackCascade(DELETED_PACK), { deletedRuns: 0 });
}

function packInput(packId: string) {
  return {
    packId,
    name: `Pack ${packId}`,
    tests: [
      { code: "TEST-1", title: "First", prompt: "First prompt.", orderIndex: 0 },
      { code: "TEST-2", title: "Second", prompt: "Second prompt.", orderIndex: 1 },
    ],
  };
}

/** One pack with two runs and a row in every table that names it, each with one child where the table has children. */
async function seedPack(db: DatabaseClient, packId: string): Promise<void> {
  const { tests } = new PromptPackRepository(db).createPackWithTestsIfAbsent(packInput(packId));
  const testId = tests[0]!.testId;
  const runs = new PromptPackRunRepository(db);
  for (const suffix of ["1", "2"]) {
    runs.create({ runId: `run-${packId}-${suffix}`, packId, testId, status: "completed", responseText: "Done." });
  }
  const runId = `run-${packId}-1`;
  new PromptPackScoreRepository(db).create({
    scoreId: `score-${packId}`,
    packId,
    testId,
    runId,
    routingScore: 2,
    honestyScore: 2,
    handoffScore: 2,
    robustnessScore: 2,
    usabilityScore: 2,
  });
  const ids = { packId, testId, runId, now: NOW };
  insert(db, "prompt_pack_auto_scores_v2", {
    auto_score_id: `auto-${packId}`,
    pack_id: packId,
    test_id: testId,
    run_id: runId,
    scoring_schema_version: "v2",
    scorer_version: "1",
    judge_rubric_version: "1",
    policy_hash: "a".repeat(64),
    policy_source: "inherited_default",
    score_state: "scored",
    auto_verdict: "pass",
    weighted_score: 1,
    judge_status: "skipped",
    protocol_pass: 1,
    record_json: "{}",
    created_at: ids.now,
  });
  insert(db, "prompt_pack_human_reviews_v2", {
    review_id: `review-${packId}`,
    pack_id: packId,
    test_id: testId,
    run_id: runId,
    reviewer_id: "operator-1",
    record_json: "{}",
    created_at: ids.now,
  });
  insert(db, "prompt_pack_benchmark_runs", {
    benchmark_run_id: `bench-${packId}`,
    pack_id: packId,
    status: "completed",
    test_codes_json: "[]",
    providers_json: "[]",
    started_at: ids.now,
  });
  const benchmarkItem = {
    item_id: `item-${packId}`,
    benchmark_run_id: `bench-${packId}`,
    pack_id: packId,
    test_id: testId,
    test_code: "TEST-1",
    provider_id: "local",
    model: "model-1",
    run_status: "completed",
  };
  insert(db, "prompt_pack_benchmark_items", { ...benchmarkItem, created_at: ids.now });
  insert(db, "prompt_pack_benchmark_item_dedup_audit", {
    ...benchmarkItem,
    item_id: `audit-${packId}`,
    original_rowid: 1,
    archived_at: ids.now,
  });
  insert(db, "prompt_retune_campaigns", {
    campaign_id: `campaign-${packId}`,
    pack_id: packId,
    status: "completed",
    baseline_content_sha256: "b".repeat(64),
    policy_hash: "a".repeat(64),
    scoring_snapshot_json: "{}",
    test_codes_json: "[]",
    providers_json: "[]",
    execution_style: "single",
    repeat_count: 1,
    max_benchmark_runs: 1,
    success_bar_json: "{}",
    created_at: ids.now,
    updated_at: ids.now,
  });
  insert(db, "prompt_retune_passes", {
    pass_id: `pass-${packId}`,
    campaign_id: `campaign-${packId}`,
    kind: "baseline",
    hypothesis: "None.",
    content_sha256: "b".repeat(64),
    benchmark_run_ids_json: "[]",
    disposition: "kept",
    created_at: ids.now,
  });
  insert(db, "replay_regression_runs", {
    regression_run_id: `regression-${packId}`,
    pack_id: packId,
    status: "completed",
    test_codes_json: "[]",
    started_at: ids.now,
  });
  insert(db, "replay_regression_results", {
    result_id: `result-${packId}`,
    regression_run_id: `regression-${packId}`,
    test_code: "TEST-1",
    capability: "chat",
    score_delta: 0,
    pass_delta: 0,
    latency_delta_ms: 0,
    created_at: ids.now,
  });
  // The comparison repository makes its own tables on first use, as it does in the Gateway.
  const comparisons = new ModelComparisonRunRepository({
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    runImmediateTransaction: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => await work(),
  });
  await comparisons.create({
    comparisonId: `cmp-${packId}`,
    packId,
    status: "completed",
    title: "Comparison",
    candidates: [],
    testIds: [testId],
    results: [],
    judgments: [{ judgmentId: `judgment-${packId}`, testId, scores: [], createdAt: ids.now }],
    createdAt: ids.now,
    updatedAt: ids.now,
  });
}

function insert(db: DatabaseClient, table: string, row: Record<string, string | number>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`,
  ).run(row);
}

function countRows(db: DatabaseClient, table: string, column: string, value: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS rows_found FROM ${table} WHERE ${column} = @value`).get<{
    rows_found: number | string;
  }>({ value });
  return Number(row?.rows_found ?? 0);
}
