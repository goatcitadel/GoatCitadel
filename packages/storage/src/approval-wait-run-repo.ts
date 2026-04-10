import type { DatabaseClient } from "./db.js";

interface ApprovalWaitRunRow {
  approval_id: string;
  run_id: string;
  created_at: string;
  resolved_at: string | null;
}

export interface ApprovalWaitRunRecord {
  approvalId: string;
  runId: string;
  createdAt: string;
  resolvedAt?: string;
}

export class ApprovalWaitRunRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly markResolvedStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM approval_wait_runs
      WHERE approval_id = ?
      LIMIT 1
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO approval_wait_runs (approval_id, run_id, created_at, resolved_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(approval_id) DO UPDATE SET
        run_id = excluded.run_id,
        created_at = excluded.created_at,
        resolved_at = excluded.resolved_at
    `);
    this.markResolvedStmt = db.prepare(`
      UPDATE approval_wait_runs
      SET resolved_at = ?
      WHERE approval_id = ?
    `);
  }

  public get(approvalId: string): ApprovalWaitRunRecord | undefined {
    const row = this.getStmt.get(approvalId) as ApprovalWaitRunRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public getRunId(approvalId: string): string | undefined {
    return this.get(approvalId)?.runId;
  }

  public upsert(input: {
    approvalId: string;
    runId: string;
    createdAt?: string;
    resolvedAt?: string | null;
  }): ApprovalWaitRunRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.upsertStmt.run(input.approvalId, input.runId, createdAt, input.resolvedAt ?? null);
    return this.get(input.approvalId) as ApprovalWaitRunRecord;
  }

  public markResolved(approvalId: string, resolvedAt?: string): ApprovalWaitRunRecord | undefined {
    this.markResolvedStmt.run(resolvedAt ?? new Date().toISOString(), approvalId);
    return this.get(approvalId);
  }
}

function mapRow(row: ApprovalWaitRunRow): ApprovalWaitRunRecord {
  return {
    approvalId: row.approval_id,
    runId: row.run_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}
