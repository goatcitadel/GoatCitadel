import type { LlmEvalProofRunRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface LlmEvalProofRunRow {
  run_id: string;
  prompt_hash: string;
  session_id: string | null;
  task_id: string | null;
  status: LlmEvalProofRunRecord["status"];
  candidates_json: string;
  results_json: string;
  warnings_json: string;
  created_at: string;
}

export class LlmEvalProofRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO llm_eval_proof_runs (
        run_id, prompt_hash, session_id, task_id, status,
        candidates_json, results_json, warnings_json, created_at
      ) VALUES (
        @runId, @promptHash, @sessionId, @taskId, @status,
        @candidatesJson, @resultsJson, @warningsJson, @createdAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM llm_eval_proof_runs WHERE run_id = ?");
    this.listStmt = db.prepare(`
      SELECT *
      FROM llm_eval_proof_runs
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
  }

  public insert(record: LlmEvalProofRunRecord): LlmEvalProofRunRecord {
    this.insertStmt.run({
      runId: record.runId,
      promptHash: record.promptHash,
      sessionId: record.sessionId ?? null,
      taskId: record.taskId ?? null,
      status: record.status,
      candidatesJson: JSON.stringify(record.candidates),
      resultsJson: JSON.stringify(record.results),
      warningsJson: JSON.stringify(record.warnings),
      createdAt: record.createdAt,
    });
    return record;
  }

  public get(runId: string): LlmEvalProofRunRecord | undefined {
    const row = this.getStmt.get(runId) as LlmEvalProofRunRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public list(limit = 50): LlmEvalProofRunRecord[] {
    const rows = this.listStmt.all({ limit: Math.max(1, Math.min(limit, 200)) }) as LlmEvalProofRunRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: LlmEvalProofRunRow): LlmEvalProofRunRecord {
  return {
    runId: row.run_id,
    promptHash: row.prompt_hash,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    candidates: safeJsonParse<LlmEvalProofRunRecord["candidates"]>(row.candidates_json, []),
    results: safeJsonParse<LlmEvalProofRunRecord["results"]>(row.results_json, []),
    warnings: safeJsonParse<string[]>(row.warnings_json, []),
  };
}
