import type { DatabaseSync } from "node:sqlite";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";

interface ChatToolRunRow {
  tool_run_id: string;
  turn_id: string;
  session_id: string;
  tool_name: string;
  status: ChatToolRunRecord["status"];
  approval_id: string | null;
  args_json: string | null;
  result_json: string | null;
  error: string | null;
  failure_guidance: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ChatToolRunCreateInput {
  toolRunId: string;
  turnId: string;
  sessionId: string;
  toolName: string;
  status?: ChatToolRunRecord["status"];
  approvalId?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  failureGuidance?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ChatToolRunPatchInput {
  status?: ChatToolRunRecord["status"];
  approvalId?: string;
  result?: Record<string, unknown>;
  error?: string;
  failureGuidance?: string;
  finishedAt?: string;
}

export class ChatToolRunRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly listByTurnStmt;
  private readonly listBySessionStmt;
  private readonly listByTurnIdsStmtCache = new Map<number, ReturnType<DatabaseSync["prepare"]>>();
  private readonly patchStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM chat_tool_runs WHERE tool_run_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_tool_runs (
        tool_run_id, turn_id, session_id, tool_name, status, approval_id, args_json,
        result_json, error, failure_guidance, started_at, finished_at
      ) VALUES (
        @toolRunId, @turnId, @sessionId, @toolName, @status, @approvalId, @argsJson,
        @resultJson, @error, @failureGuidance, @startedAt, @finishedAt
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_tool_runs
      SET
        status = @status,
        approval_id = @approvalId,
        result_json = @resultJson,
        error = @error,
        failure_guidance = @failureGuidance,
        finished_at = @finishedAt
      WHERE tool_run_id = @toolRunId
    `);
    this.listByTurnStmt = db.prepare(`
      SELECT * FROM chat_tool_runs
      WHERE turn_id = @turnId
      ORDER BY started_at ASC
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_tool_runs
      WHERE session_id = @sessionId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
  }

  public get(toolRunId: string): ChatToolRunRecord {
    const row = this.getStmt.get(toolRunId) as ChatToolRunRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Chat tool run", id: toolRunId });
    }
    return mapRow(row);
  }

  public create(input: ChatToolRunCreateInput): ChatToolRunRecord {
    this.insertStmt.run({
      toolRunId: input.toolRunId,
      turnId: input.turnId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      status: input.status ?? "started",
      approvalId: input.approvalId ?? null,
      argsJson: input.args ? JSON.stringify(input.args) : null,
      resultJson: input.result ? JSON.stringify(input.result) : null,
      error: input.error ?? null,
      failureGuidance: input.failureGuidance ?? null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
    });
    return this.get(input.toolRunId);
  }

  public patch(toolRunId: string, input: ChatToolRunPatchInput): ChatToolRunRecord {
    const current = this.get(toolRunId);
    this.patchStmt.run({
      toolRunId,
      status: input.status ?? current.status,
      approvalId: input.approvalId !== undefined ? input.approvalId : (current.approvalId ?? null),
      resultJson: input.result !== undefined ? JSON.stringify(input.result) : (current.result ? JSON.stringify(current.result) : null),
      error: input.error !== undefined ? input.error : (current.error ?? null),
      failureGuidance: input.failureGuidance !== undefined ? input.failureGuidance : (current.failureGuidance ?? null),
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
    });
    return this.get(toolRunId);
  }

  public listByTurn(turnId: string): ChatToolRunRecord[] {
    const rows = this.listByTurnStmt.all({ turnId }) as unknown as ChatToolRunRow[];
    return rows.map(mapRow);
  }

  public listBySession(sessionId: string, limit = 200): ChatToolRunRecord[] {
    const rows = this.listBySessionStmt.all({
      sessionId,
      limit: Math.max(1, Math.min(limit, 2000)),
    }) as unknown as ChatToolRunRow[];
    return rows.map(mapRow);
  }

  public listByTurnIds(turnIds: string[]): Map<string, ChatToolRunRecord[]> {
    const uniqueTurnIds = [...new Set(turnIds.map((item) => item.trim()).filter(Boolean))];
    const grouped = new Map<string, ChatToolRunRecord[]>();
    if (uniqueTurnIds.length === 0) {
      return grouped;
    }

    for (let index = 0; index < uniqueTurnIds.length; index += 400) {
      const batch = uniqueTurnIds.slice(index, index + 400);
      const stmt = this.getListByTurnIdsStmt(batch.length);
      const rows = stmt.all(...batch) as unknown as ChatToolRunRow[];
      for (const row of rows) {
        const record = mapRow(row);
        const current = grouped.get(record.turnId) ?? [];
        current.push(record);
        grouped.set(record.turnId, current);
      }
    }

    for (const records of grouped.values()) {
      records.sort((left, right) => {
        const leftStarted = Date.parse(left.startedAt) || 0;
        const rightStarted = Date.parse(right.startedAt) || 0;
        if (leftStarted !== rightStarted) {
          return leftStarted - rightStarted;
        }
        return left.toolRunId.localeCompare(right.toolRunId);
      });
    }

    return grouped;
  }

  private getListByTurnIdsStmt(size: number) {
    const cached = this.listByTurnIdsStmtCache.get(size);
    if (cached) {
      return cached;
    }
    const placeholders = new Array(size).fill("?").join(", ");
    const stmt = this.db.prepare(`
      SELECT *
      FROM chat_tool_runs
      WHERE turn_id IN (${placeholders})
      ORDER BY started_at ASC, tool_run_id ASC
    `);
    this.listByTurnIdsStmtCache.set(size, stmt);
    return stmt;
  }
}

function mapRow(row: ChatToolRunRow): ChatToolRunRecord {
  return {
    toolRunId: row.tool_run_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    status: row.status,
    approvalId: row.approval_id ?? undefined,
    args: row.args_json ? safeJsonParse<Record<string, unknown>>(row.args_json, {}) : undefined,
    result: row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined,
    error: row.error ?? undefined,
    failureGuidance: row.failure_guidance ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
