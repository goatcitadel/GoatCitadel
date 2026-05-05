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
    const row = this.getStmt.get(runId) as SkillEvaluationRunRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "skill evaluation run", id: runId });
    }
    return mapSkillEvaluationRunRow(row);
  }

  public find(runId: string): SkillEvaluationRunRecord | undefined {
    const row = this.getStmt.get(runId) as SkillEvaluationRunRow | undefined;
    return row ? mapSkillEvaluationRunRow(row) : undefined;
  }

  public listBySkill(skillId: string, limit = 100): SkillEvaluationRunRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 300));
    return (this.listBySkillStmt.all({ skillId, limit: boundedLimit }) as unknown as SkillEvaluationRunRow[]).map(
      mapSkillEvaluationRunRow,
    );
  }
}

function mapSkillEvaluationRunRow(row: SkillEvaluationRunRow): SkillEvaluationRunRecord {
  return safeJsonParse(row.record_json, {
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
  });
}
