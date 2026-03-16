import type { DatabaseSync } from "node:sqlite";
import type { PromptPackScoreRecord } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface PromptPackScoreRow {
  score_id: string;
  pack_id: string;
  test_id: string;
  run_id: string;
  routing_score: number;
  honesty_score: number;
  handoff_score: number;
  robustness_score: number;
  usability_score: number;
  total_score: number;
  notes: string | null;
  created_at: string;
}

export class PromptPackScoreRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly listByPackStmt;
  private readonly listByTestStmt;
  private readonly listByRunStmt;
  private readonly deleteByPackStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM prompt_pack_scores WHERE score_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO prompt_pack_scores (
        score_id, pack_id, test_id, run_id,
        routing_score, honesty_score, handoff_score, robustness_score, usability_score,
        total_score, notes, created_at
      ) VALUES (
        @scoreId, @packId, @testId, @runId,
        @routingScore, @honestyScore, @handoffScore, @robustnessScore, @usabilityScore,
        @totalScore, @notes, @createdAt
      )
    `);
    this.listByPackStmt = db.prepare(`
      SELECT * FROM prompt_pack_scores
      WHERE pack_id = @packId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByTestStmt = db.prepare(`
      SELECT * FROM prompt_pack_scores
      WHERE test_id = @testId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByRunStmt = db.prepare(`
      SELECT * FROM prompt_pack_scores
      WHERE run_id = @runId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.deleteByPackStmt = db.prepare("DELETE FROM prompt_pack_scores WHERE pack_id = ?");
  }

  public get(scoreId: string): PromptPackScoreRecord {
    const row = this.getStmt.get(scoreId) as PromptPackScoreRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Prompt pack score", id: scoreId });
    }
    return mapRow(row);
  }

  public create(input: Omit<PromptPackScoreRecord, "totalScore" | "createdAt"> & { createdAt?: string }): PromptPackScoreRecord {
    assertValidScore(input.routingScore, "routingScore");
    assertValidScore(input.honestyScore, "honestyScore");
    assertValidScore(input.handoffScore, "handoffScore");
    assertValidScore(input.robustnessScore, "robustnessScore");
    assertValidScore(input.usabilityScore, "usabilityScore");
    const totalScore = input.routingScore + input.honestyScore + input.handoffScore + input.robustnessScore + input.usabilityScore;
    this.insertStmt.run({
      scoreId: input.scoreId,
      packId: input.packId,
      testId: input.testId,
      runId: input.runId,
      routingScore: input.routingScore,
      honestyScore: input.honestyScore,
      handoffScore: input.handoffScore,
      robustnessScore: input.robustnessScore,
      usabilityScore: input.usabilityScore,
      totalScore,
      notes: input.notes ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    return this.get(input.scoreId);
  }

  public listByPack(packId: string, limit = 1000): PromptPackScoreRecord[] {
    const rows = this.listByPackStmt.all({
      packId,
      limit: Math.max(1, Math.min(limit, 5000)),
    }) as unknown as PromptPackScoreRow[];
    return rows.map(mapRow);
  }

  public listByTest(testId: string, limit = 200): PromptPackScoreRecord[] {
    const rows = this.listByTestStmt.all({
      testId,
      limit: Math.max(1, Math.min(limit, 5000)),
    }) as unknown as PromptPackScoreRow[];
    return rows.map(mapRow);
  }

  public listByRun(runId: string, limit = 50): PromptPackScoreRecord[] {
    const rows = this.listByRunStmt.all({
      runId,
      limit: Math.max(1, Math.min(limit, 5000)),
    }) as unknown as PromptPackScoreRow[];
    return rows.map(mapRow);
  }

  public deleteByPack(packId: string): number {
    const result = this.deleteByPackStmt.run(packId);
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: PromptPackScoreRow): PromptPackScoreRecord {
  return {
    scoreId: row.score_id,
    packId: row.pack_id,
    testId: row.test_id,
    runId: row.run_id,
    routingScore: clampScore(row.routing_score),
    honestyScore: clampScore(row.honesty_score),
    handoffScore: clampScore(row.handoff_score),
    robustnessScore: clampScore(row.robustness_score),
    usabilityScore: clampScore(row.usability_score),
    totalScore: row.total_score,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
  };
}

function clampScore(value: number): 0 | 1 | 2 {
  if (value <= 0) {
    return 0;
  }
  if (value >= 2) {
    return 2;
  }
  return 1;
}

function assertValidScore(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    throw new ValidationError({ code: "FIELD_INVALID", field, message: `${field} must be an integer between 0 and 2` });
  }
}
