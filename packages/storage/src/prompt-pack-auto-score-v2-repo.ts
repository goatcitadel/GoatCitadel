import type { DatabaseClient } from "./db.js";
import type { PromptPackAutoScoreRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";

interface PromptPackAutoScoreV2Row {
  auto_score_id: string;
  pack_id: string;
  test_id: string;
  run_id: string;
  scoring_schema_version: string;
  scorer_version: string;
  judge_rubric_version: string;
  policy_hash: string;
  policy_source: string;
  score_state: string;
  auto_verdict: string;
  weighted_score: number;
  judge_status: string;
  protocol_pass: number;
  record_json: string;
  created_at: string;
}

export class PromptPackAutoScoreV2Repository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly listByPackStmt;
  private readonly listByTestStmt;
  private readonly listByRunStmt;
  private readonly deleteByPackStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM prompt_pack_auto_scores_v2 WHERE auto_score_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO prompt_pack_auto_scores_v2 (
        auto_score_id, pack_id, test_id, run_id, scoring_schema_version,
        scorer_version, judge_rubric_version, policy_hash, policy_source,
        score_state, auto_verdict, weighted_score, judge_status, protocol_pass,
        record_json, created_at
      ) VALUES (
        @autoScoreId, @packId, @testId, @runId, @scoringSchemaVersion,
        @scorerVersion, @judgeRubricVersion, @policyHash, @policySource,
        @scoreState, @autoVerdict, @weightedScore, @judgeStatus, @protocolPass,
        @recordJson, @createdAt
      )
      ON CONFLICT(run_id, scoring_schema_version, scorer_version, policy_hash) DO UPDATE SET
        pack_id = excluded.pack_id,
        test_id = excluded.test_id,
        judge_rubric_version = excluded.judge_rubric_version,
        policy_source = excluded.policy_source,
        score_state = excluded.score_state,
        auto_verdict = excluded.auto_verdict,
        weighted_score = excluded.weighted_score,
        judge_status = excluded.judge_status,
        protocol_pass = excluded.protocol_pass,
        record_json = excluded.record_json,
        created_at = excluded.created_at
    `);
    this.listByPackStmt = db.prepare(`
      SELECT * FROM prompt_pack_auto_scores_v2
      WHERE pack_id = @packId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByTestStmt = db.prepare(`
      SELECT * FROM prompt_pack_auto_scores_v2
      WHERE test_id = @testId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByRunStmt = db.prepare(`
      SELECT * FROM prompt_pack_auto_scores_v2
      WHERE run_id = @runId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.deleteByPackStmt = db.prepare("DELETE FROM prompt_pack_auto_scores_v2 WHERE pack_id = ?");
  }

  public get(autoScoreId: string): PromptPackAutoScoreRecord {
    const row = toPromptPackAutoScoreV2Row(this.getStmt.get(autoScoreId));
    if (!row) {
      throw new NotFoundError({ entity: "Prompt pack auto score", id: autoScoreId });
    }
    return mapRow(row);
  }

  public create(input: PromptPackAutoScoreRecord): PromptPackAutoScoreRecord {
    this.insertStmt.run({
      autoScoreId: input.autoScoreId,
      packId: input.packId,
      testId: input.testId,
      runId: input.runId,
      scoringSchemaVersion: input.scoringSchemaVersion,
      scorerVersion: input.scorerVersion,
      judgeRubricVersion: input.judgeRubricVersion,
      policyHash: input.policyHash,
      policySource: input.policySource,
      scoreState: input.scoreState,
      autoVerdict: input.autoVerdict,
      weightedScore: input.weightedScore,
      judgeStatus: input.judgeStatus,
      protocolPass: input.protocol.protocolPass ? 1 : 0,
      recordJson: JSON.stringify(input),
      createdAt: input.createdAt,
    });
    return this.get(input.autoScoreId);
  }

  public listByPack(packId: string, limit = 1000): PromptPackAutoScoreRecord[] {
    return toPromptPackAutoScoreV2Rows(
      this.listByPackStmt.all({
        packId,
        limit: Math.max(1, Math.min(limit, 10_000)),
      }),
    ).map(mapRow);
  }

  public listByTest(testId: string, limit = 500): PromptPackAutoScoreRecord[] {
    return toPromptPackAutoScoreV2Rows(
      this.listByTestStmt.all({
        testId,
        limit: Math.max(1, Math.min(limit, 10_000)),
      }),
    ).map(mapRow);
  }

  public listByRun(runId: string, limit = 100): PromptPackAutoScoreRecord[] {
    return toPromptPackAutoScoreV2Rows(
      this.listByRunStmt.all({
        runId,
        limit: Math.max(1, Math.min(limit, 10_000)),
      }),
    ).map(mapRow);
  }

  public deleteByPack(packId: string): number {
    const result = this.deleteByPackStmt.run(packId);
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: PromptPackAutoScoreV2Row): PromptPackAutoScoreRecord {
  const parsed = safeJsonParse<PromptPackAutoScoreRecord | undefined>(row.record_json, undefined);
  if (parsed) {
    return parsed;
  }
  throw new Error(`Stored prompt pack auto score ${row.auto_score_id} is malformed.`);
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toPromptPackAutoScoreV2Row(value: unknown): PromptPackAutoScoreV2Row | undefined {
  return isPromptPackAutoScoreV2Row(value) ? value : undefined;
}

function toPromptPackAutoScoreV2Rows(value: unknown): PromptPackAutoScoreV2Row[] {
  return Array.isArray(value) ? value.filter(isPromptPackAutoScoreV2Row) : [];
}

function isPromptPackAutoScoreV2Row(value: unknown): value is PromptPackAutoScoreV2Row {
  return (
    isRecord(value) &&
    typeof value.auto_score_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.test_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.scoring_schema_version === "string" &&
    typeof value.scorer_version === "string" &&
    typeof value.judge_rubric_version === "string" &&
    typeof value.policy_hash === "string" &&
    typeof value.policy_source === "string" &&
    typeof value.score_state === "string" &&
    typeof value.auto_verdict === "string" &&
    typeof value.weighted_score === "number" &&
    typeof value.judge_status === "string" &&
    typeof value.protocol_pass === "number" &&
    typeof value.record_json === "string" &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
