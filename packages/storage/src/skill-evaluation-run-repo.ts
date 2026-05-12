import type { SkillEvaluationRunRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface SkillEvaluationRunRow {
  run_id: string;
  skill_id: string;
  skill_name: string;
  status: SkillEvaluationRunRecord["status"];
  target_pass_rate: number;
  max_rounds: number;
  accepted: number;
  improvement_delta: number;
  proposal_id: string | null;
  improvement_candidate_id: string | null;
  ledger_signal_id: string | null;
  record_json: string;
  created_at: string;
  updated_at: string;
}

export class SkillEvaluationRunRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listBySkillStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO skill_evaluation_runs (
        run_id, skill_id, skill_name, status, target_pass_rate, max_rounds, accepted,
        improvement_delta, proposal_id, improvement_candidate_id, ledger_signal_id,
        record_json, created_at, updated_at
      ) VALUES (
        @runId, @skillId, @skillName, @status, @targetPassRate, @maxRounds, @accepted,
        @improvementDelta, @proposalId, @improvementCandidateId, @ledgerSignalId,
        @recordJson, @createdAt, @updatedAt
      )
      ON CONFLICT(run_id) DO UPDATE SET
        skill_id = excluded.skill_id,
        skill_name = excluded.skill_name,
        status = excluded.status,
        target_pass_rate = excluded.target_pass_rate,
        max_rounds = excluded.max_rounds,
        accepted = excluded.accepted,
        improvement_delta = excluded.improvement_delta,
        proposal_id = excluded.proposal_id,
        improvement_candidate_id = excluded.improvement_candidate_id,
        ledger_signal_id = excluded.ledger_signal_id,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare("SELECT * FROM skill_evaluation_runs WHERE run_id = ?");
    this.listBySkillStmt = db.prepare(`
      SELECT *
      FROM skill_evaluation_runs
      WHERE skill_id = @skillId
      ORDER BY updated_at DESC, run_id DESC
      LIMIT @limit
    `);
  }

  public upsert(input: SkillEvaluationRunRecord): SkillEvaluationRunRecord {
    this.upsertStmt.run({
      runId: input.runId,
      skillId: input.skillId,
      skillName: input.skillName,
      status: input.status,
      targetPassRate: input.targetPassRate,
      maxRounds: input.maxRounds,
      accepted: input.accepted ? 1 : 0,
      improvementDelta: input.improvementDelta,
      proposalId: input.proposalId ?? null,
      improvementCandidateId: input.improvementCandidateId ?? null,
      ledgerSignalId: input.ledgerSignalId ?? null,
      recordJson: JSON.stringify(input),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return this.get(input.runId);
  }

  public get(runId: string): SkillEvaluationRunRecord {
    const row = toSkillEvaluationRunRow(this.getStmt.get(runId));
    if (!row) {
      throw new NotFoundError({ entity: "skill evaluation run", id: runId });
    }
    return mapSkillEvaluationRunRow(row);
  }

  public find(runId: string): SkillEvaluationRunRecord | undefined {
    const row = toSkillEvaluationRunRow(this.getStmt.get(runId));
    return row ? mapSkillEvaluationRunRow(row) : undefined;
  }

  public listBySkill(skillId: string, limit = 100): SkillEvaluationRunRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 300));
    return toSkillEvaluationRunRows(this.listBySkillStmt.all({ skillId, limit: boundedLimit })).map(
      mapSkillEvaluationRunRow,
    );
  }
}

function mapSkillEvaluationRunRow(row: SkillEvaluationRunRow): SkillEvaluationRunRecord {
  const parsed = safeJsonParse<unknown>(row.record_json, undefined);
  if (isSkillEvaluationRunRecord(parsed)) {
    return parsed;
  }
  return {
    runId: row.run_id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scenarios: [],
    criteria: [],
    baselineResult: {
      instructionHash: "",
      score: { total: 0, passed: 0, passRate: 0 },
      scenarioResults: [],
    },
    accepted: Boolean(row.accepted),
    improvementDelta: row.improvement_delta,
    targetPassRate: row.target_pass_rate,
    maxRounds: row.max_rounds,
    proposalId: row.proposal_id ?? undefined,
    improvementCandidateId: row.improvement_candidate_id ?? undefined,
    ledgerSignalId: row.ledger_signal_id ?? undefined,
    warnings: [],
    operatorTruth: {
      executesScripts: false,
      writesSkillFile: false,
      proposalOnly: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillEvaluationRunRow(value: unknown): value is SkillEvaluationRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.run_id === "string" &&
    typeof value.skill_id === "string" &&
    typeof value.skill_name === "string" &&
    typeof value.status === "string" &&
    typeof value.target_pass_rate === "number" &&
    typeof value.max_rounds === "number" &&
    typeof value.accepted === "number" &&
    typeof value.improvement_delta === "number" &&
    (typeof value.proposal_id === "string" || value.proposal_id === null) &&
    (typeof value.improvement_candidate_id === "string" || value.improvement_candidate_id === null) &&
    (typeof value.ledger_signal_id === "string" || value.ledger_signal_id === null) &&
    typeof value.record_json === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function toSkillEvaluationRunRow(value: unknown): SkillEvaluationRunRow | undefined {
  return isSkillEvaluationRunRow(value) ? value : undefined;
}

function toSkillEvaluationRunRows(value: unknown): SkillEvaluationRunRow[] {
  return Array.isArray(value) ? value.filter(isSkillEvaluationRunRow) : [];
}

function isSkillEvaluationRunRecord(value: unknown): value is SkillEvaluationRunRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.runId === "string" &&
    typeof value.skillId === "string" &&
    typeof value.skillName === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.scenarios) &&
    Array.isArray(value.criteria) &&
    isRecord(value.baselineResult) &&
    (value.candidateResult === undefined || isRecord(value.candidateResult)) &&
    (value.mutation === undefined || isRecord(value.mutation)) &&
    typeof value.accepted === "boolean" &&
    typeof value.improvementDelta === "number" &&
    typeof value.targetPassRate === "number" &&
    typeof value.maxRounds === "number" &&
    (value.proposalId === undefined || typeof value.proposalId === "string") &&
    (value.improvementCandidateId === undefined || typeof value.improvementCandidateId === "string") &&
    (value.ledgerSignalId === undefined || typeof value.ledgerSignalId === "string") &&
    Array.isArray(value.warnings) &&
    isRecord(value.operatorTruth)
  );
}
