import type { DatabaseSync } from "node:sqlite";
import type { ResearchRunRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";

interface ResearchRunRow {
  run_id: string;
  session_id: string;
  query: string;
  mode: "quick" | "deep";
  status: "running" | "completed" | "failed";
  summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export class ResearchRunRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly patchStmt;
  private readonly listBySessionStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM research_runs WHERE run_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO research_runs (
        run_id, session_id, query, mode, status, summary, error, started_at, finished_at
      ) VALUES (
        @runId, @sessionId, @query, @mode, @status, @summary, @error, @startedAt, @finishedAt
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE research_runs
      SET
        status = @status,
        summary = @summary,
        error = @error,
        finished_at = @finishedAt
      WHERE run_id = @runId
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM research_runs
      WHERE session_id = @sessionId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
  }

  public get(runId: string): ResearchRunRecord {
    const row = this.getStmt.get(runId) as ResearchRunRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Research run", id: runId });
    }
    return mapRow(row);
  }

  public create(input: {
    runId: string;
    sessionId: string;
    query: string;
    mode: "quick" | "deep";
    status?: "running" | "completed" | "failed";
    summary?: string;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
  }): ResearchRunRecord {
    this.insertStmt.run({
      runId: input.runId,
      sessionId: input.sessionId,
      query: input.query,
      mode: input.mode,
      status: input.status ?? "running",
      summary: input.summary ?? null,
      error: input.error ?? null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
    });
    return this.get(input.runId);
  }

  public patch(runId: string, input: {
    status?: "running" | "completed" | "failed";
    summary?: string;
    error?: string;
    finishedAt?: string;
  }): ResearchRunRecord {
    const current = this.get(runId);
    this.patchStmt.run({
      runId,
      status: input.status ?? current.status,
      summary: input.summary !== undefined ? input.summary : (current.summary ?? null),
      error: input.error !== undefined ? input.error : (current.error ?? null),
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
    });
    return this.get(runId);
  }

  public listBySession(sessionId: string, limit = 50): ResearchRunRecord[] {
    const rows = this.listBySessionStmt.all({
      sessionId,
      limit: Math.max(1, Math.min(limit, 500)),
    }) as unknown as ResearchRunRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: ResearchRunRow): ResearchRunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    query: row.query,
    mode: row.mode,
    status: row.status,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}
