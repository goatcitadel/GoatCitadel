import type { DatabaseClient } from "./db.js";
import type { PromptPackHumanReviewRecordV2 } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";

interface PromptPackHumanReviewV2Row {
  review_id: string;
  pack_id: string;
  test_id: string;
  run_id: string;
  auto_score_id: string | null;
  reviewer_id: string;
  override_verdict: string | null;
  record_json: string;
  created_at: string;
}

export class PromptPackHumanReviewV2Repository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly listByPackStmt;
  private readonly listByTestStmt;
  private readonly listByRunStmt;
  private readonly deleteByPackStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM prompt_pack_human_reviews_v2 WHERE review_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO prompt_pack_human_reviews_v2 (
        review_id, pack_id, test_id, run_id, auto_score_id, reviewer_id,
        override_verdict, record_json, created_at
      ) VALUES (
        @reviewId, @packId, @testId, @runId, @autoScoreId, @reviewerId,
        @overrideVerdict, @recordJson, @createdAt
      )
    `);
    this.listByPackStmt = db.prepare(`
      SELECT * FROM prompt_pack_human_reviews_v2
      WHERE pack_id = @packId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByTestStmt = db.prepare(`
      SELECT * FROM prompt_pack_human_reviews_v2
      WHERE test_id = @testId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByRunStmt = db.prepare(`
      SELECT * FROM prompt_pack_human_reviews_v2
      WHERE run_id = @runId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.deleteByPackStmt = db.prepare("DELETE FROM prompt_pack_human_reviews_v2 WHERE pack_id = ?");
  }

  public get(reviewId: string): PromptPackHumanReviewRecordV2 {
    const row = toPromptPackHumanReviewV2Row(this.getStmt.get(reviewId));
    if (!row) {
      throw new NotFoundError({ entity: "Prompt pack human review", id: reviewId });
    }
    return mapRow(row);
  }

  public create(input: PromptPackHumanReviewRecordV2): PromptPackHumanReviewRecordV2 {
    this.insertStmt.run({
      reviewId: input.reviewId,
      packId: input.packId,
      testId: input.testId,
      runId: input.runId,
      autoScoreId: input.autoScoreId ?? null,
      reviewerId: input.reviewerId,
      overrideVerdict: input.overrideVerdict ?? null,
      recordJson: JSON.stringify(input),
      createdAt: input.createdAt,
    });
    return this.get(input.reviewId);
  }

  public listByPack(packId: string, limit = 1000): PromptPackHumanReviewRecordV2[] {
    return toPromptPackHumanReviewV2Rows(
      this.listByPackStmt.all({
        packId,
        limit: Math.max(1, Math.min(limit, 10_000)),
      }),
    ).map(mapRow);
  }

  public listByTest(testId: string, limit = 500): PromptPackHumanReviewRecordV2[] {
    return toPromptPackHumanReviewV2Rows(
      this.listByTestStmt.all({
        testId,
        limit: Math.max(1, Math.min(limit, 10_000)),
      }),
    ).map(mapRow);
  }

  public listByRun(runId: string, limit = 100): PromptPackHumanReviewRecordV2[] {
    return toPromptPackHumanReviewV2Rows(
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

function mapRow(row: PromptPackHumanReviewV2Row): PromptPackHumanReviewRecordV2 {
  const parsed = safeJsonParse<PromptPackHumanReviewRecordV2 | undefined>(row.record_json, undefined);
  if (parsed) {
    return parsed;
  }
  throw new Error(`Stored prompt pack human review ${row.review_id} is malformed.`);
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toPromptPackHumanReviewV2Row(value: unknown): PromptPackHumanReviewV2Row | undefined {
  return isPromptPackHumanReviewV2Row(value) ? value : undefined;
}

function toPromptPackHumanReviewV2Rows(value: unknown): PromptPackHumanReviewV2Row[] {
  return Array.isArray(value) ? value.filter(isPromptPackHumanReviewV2Row) : [];
}

function isPromptPackHumanReviewV2Row(value: unknown): value is PromptPackHumanReviewV2Row {
  return (
    isRecord(value) &&
    typeof value.review_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.test_id === "string" &&
    typeof value.run_id === "string" &&
    (typeof value.auto_score_id === "string" || value.auto_score_id === null) &&
    typeof value.reviewer_id === "string" &&
    (typeof value.override_verdict === "string" || value.override_verdict === null) &&
    typeof value.record_json === "string" &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


