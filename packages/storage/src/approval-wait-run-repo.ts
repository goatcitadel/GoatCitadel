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
  private readonly createOrGetStmt;
  private readonly upsertStmt;
  private readonly markResolvedStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM approval_wait_runs
      WHERE approval_id = ?
      LIMIT 1
    `);
    this.createOrGetStmt = db.prepare(`
      INSERT INTO approval_wait_runs (approval_id, run_id, created_at, resolved_at)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(approval_id) DO NOTHING
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

  /** Canonical native review discovery, independent of the executable-request
   * cache. Resolved decisions remain discoverable until their wait is settled. */
  public findUnresolvedNativeForAssignment(input: {
    registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number;
    workspaceId: string; taskId: string; durableRunId: string; sessionId: string; turnId: string;
  }): ApprovalWaitRunRecord | undefined {
    const textKeys = ["registryWorkspaceId", "assignmentId", "workspaceId", "taskId", "durableRunId", "sessionId", "turnId"] as const;
    if (textKeys.some(key => typeof input[key] !== "string" || !input[key].trim() || input[key].length > 200) ||
        !Number.isSafeInteger(input.assignmentGeneration) || input.assignmentGeneration < 1) {
      throw new Error("Native review lookup requires an exact assignment and parent scope.");
    }
    const field = (column: string, keys: string[]) => this.db.dialect === "postgres"
      ? `${column}::jsonb #>> '{${keys.join(",")}}'`
      : `CAST(json_extract(${column}, '$.${keys.join(".")}') AS TEXT)`;
    const links = ["workspaceId", "taskId", "durableRunId", "sessionId", "turnId"];
    const binding = ["registryWorkspaceId", "assignmentId", "assignmentGeneration"];
    const rows = this.db.prepare(`SELECT w.* FROM approval_wait_runs w
      JOIN approvals a ON a.approval_id = w.approval_id
      WHERE w.resolved_at IS NULL AND a.kind = 'remote_worker.native_runtime'
        AND ${field("a.linkage_json", ["actionType"])} = 'remote_worker.native_runtime'
        AND ${links.map(key => `${field("a.linkage_json", [key])} = @${key}`).join(" AND ")}
        AND ${binding.map(key => `${field("a.payload_json", ["nativeRuntime", key])} = @${key}`).join(" AND ")}
      ORDER BY w.created_at, w.approval_id LIMIT 2`).all({ ...input,
      assignmentGeneration: String(input.assignmentGeneration) }) as ApprovalWaitRunRow[];
    if (rows.length > 1) throw new Error("Multiple unresolved native reviews require reconciliation.");
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  /** Reserves the first durable run id without allowing a racing writer to replace it. */
  public createOrGet(input: { approvalId: string; runId: string; createdAt?: string }): ApprovalWaitRunRecord {
    this.createOrGetStmt.run(input.approvalId, input.runId, input.createdAt ?? new Date().toISOString());
    return this.get(input.approvalId) as ApprovalWaitRunRecord;
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
