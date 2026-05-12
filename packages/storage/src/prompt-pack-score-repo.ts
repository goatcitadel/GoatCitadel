import type { DatabaseClient } from "./db.js";
import type { PromptPackJudgeRecord, PromptPackScoreRecord } from "@goatcitadel/contracts";
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
  judge_json: string | null;
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

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM prompt_pack_scores WHERE score_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO prompt_pack_scores (
        score_id, pack_id, test_id, run_id,
        routing_score, honesty_score, handoff_score, robustness_score, usability_score,
        total_score, judge_json, notes, created_at
      ) VALUES (
        @scoreId, @packId, @testId, @runId,
        @routingScore, @honestyScore, @handoffScore, @robustnessScore, @usabilityScore,
        @totalScore, @judgeJson, @notes, @createdAt
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
    const row = toPromptPackScoreRow(this.getStmt.get(scoreId));
    if (!row) {
      throw new NotFoundError({ entity: "Prompt pack score", id: scoreId });
    }
    return mapRow(row);
  }

  public create(
    input: Omit<PromptPackScoreRecord, "totalScore" | "createdAt"> & { createdAt?: string },
  ): PromptPackScoreRecord {
    assertValidScore(input.routingScore, "routingScore");
    assertValidScore(input.honestyScore, "honestyScore");
    assertValidScore(input.handoffScore, "handoffScore");
    assertValidScore(input.robustnessScore, "robustnessScore");
    assertValidScore(input.usabilityScore, "usabilityScore");
    const totalScore =
      input.routingScore + input.honestyScore + input.handoffScore + input.robustnessScore + input.usabilityScore;
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
      judgeJson: input.judge ? JSON.stringify(input.judge) : null,
      notes: input.notes ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    return this.get(input.scoreId);
  }

  public listByPack(packId: string, limit = 1000): PromptPackScoreRecord[] {
    const rows = toPromptPackScoreRows(
      this.listByPackStmt.all({
        packId,
        limit: Math.max(1, Math.min(limit, 5000)),
      }),
    );
    return rows.map(mapRow);
  }

  public listByTest(testId: string, limit = 200): PromptPackScoreRecord[] {
    const rows = toPromptPackScoreRows(
      this.listByTestStmt.all({
        testId,
        limit: Math.max(1, Math.min(limit, 5000)),
      }),
    );
    return rows.map(mapRow);
  }

  public listByRun(runId: string, limit = 50): PromptPackScoreRecord[] {
    const rows = toPromptPackScoreRows(
      this.listByRunStmt.all({
        runId,
        limit: Math.max(1, Math.min(limit, 5000)),
      }),
    );
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
    judge: row.judge_json
      ? safeJsonParse<PromptPackJudgeRecord | undefined>(row.judge_json, undefined)
      : deriveJudgeFromNotes(row.notes ?? undefined),
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function deriveJudgeFromNotes(notes?: string): PromptPackJudgeRecord | undefined {
  const normalized = notes?.trim();
  if (!normalized) {
    return undefined;
  }

  const usedModelJudgeMatch = normalized.match(/Model judge used:\s*(yes|no)\./i);
  const ruleSignalsMatch = normalized.match(/Rule signals:\s*([^\n]+)\./i);
  const rationaleMatch = normalized.match(/Model rationale:\s*([^\n]+(?:\n(?!Model judge fallback reason:).+)*)/i);
  const errorMatch = normalized.match(/Model judge fallback reason:\s*([^\n]+(?:\n.+)*)/i);
  if (!usedModelJudgeMatch && !ruleSignalsMatch && !rationaleMatch && !errorMatch) {
    return undefined;
  }

  const modelJudgeError = errorMatch?.[1]?.trim();
  let status: PromptPackJudgeRecord["status"] = "ok";
  if (modelJudgeError) {
    status = /429|rate[_ -]?limit|too many requests/i.test(modelJudgeError) ? "rate_limited" : "fallback";
  } else if (usedModelJudgeMatch?.[1]?.toLowerCase() === "no") {
    status = "error";
  }

  return {
    usedModelJudge: usedModelJudgeMatch?.[1]?.toLowerCase() === "yes",
    status,
    attemptCount: 0,
    ruleSignals:
      ruleSignalsMatch?.[1]
        ?.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value !== "none") ?? [],
    modelJudgeError,
    modelJudgeRationale: rationaleMatch?.[1]?.trim(),
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

function toPromptPackScoreRow(value: unknown): PromptPackScoreRow | undefined {
  return isPromptPackScoreRow(value) ? value : undefined;
}

function toPromptPackScoreRows(value: unknown): PromptPackScoreRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackScoreRow) : [];
}

function isPromptPackScoreRow(value: unknown): value is PromptPackScoreRow {
  return (
    isRecord(value) &&
    typeof value.score_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.test_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.routing_score === "number" &&
    typeof value.honesty_score === "number" &&
    typeof value.handoff_score === "number" &&
    typeof value.robustness_score === "number" &&
    typeof value.usability_score === "number" &&
    typeof value.total_score === "number" &&
    (typeof value.judge_json === "string" || value.judge_json === null) &&
    (typeof value.notes === "string" || value.notes === null) &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
