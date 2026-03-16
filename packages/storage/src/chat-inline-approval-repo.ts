import type { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "@goatcitadel/contracts";

export interface ChatInlineApprovalRecord {
  approvalId: string;
  sessionId: string;
  turnId: string;
  toolName?: string;
  status: "pending" | "approved" | "denied";
  reason?: string;
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
}

interface ChatInlineApprovalRow {
  approval_id: string;
  session_id: string;
  turn_id: string;
  tool_name: string | null;
  status: "pending" | "approved" | "denied";
  reason: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export class ChatInlineApprovalRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly listByTurnStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM chat_inline_approvals WHERE approval_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_inline_approvals (
        approval_id, session_id, turn_id, tool_name, status, reason, resolved_by, created_at, resolved_at
      ) VALUES (
        @approvalId, @sessionId, @turnId, @toolName, @status, @reason, @resolvedBy, @createdAt, @resolvedAt
      )
      ON CONFLICT(approval_id) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        resolved_by = excluded.resolved_by,
        resolved_at = excluded.resolved_at
    `);
    this.listByTurnStmt = db.prepare(`
      SELECT * FROM chat_inline_approvals
      WHERE turn_id = @turnId
      ORDER BY created_at ASC
    `);
  }

  public get(approvalId: string): ChatInlineApprovalRecord | undefined {
    const row = this.getStmt.get(approvalId) as unknown as ChatInlineApprovalRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public upsert(input: {
    approvalId: string;
    sessionId: string;
    turnId: string;
    toolName?: string;
    status: "pending" | "approved" | "denied";
    reason?: string;
    resolvedBy?: string;
    createdAt?: string;
    resolvedAt?: string;
  }): ChatInlineApprovalRecord {
    const now = new Date().toISOString();
    const current = this.get(input.approvalId);
    this.upsertStmt.run({
      approvalId: input.approvalId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolName: input.toolName ?? null,
      status: input.status,
      reason: input.reason ?? null,
      resolvedBy: input.resolvedBy ?? null,
      createdAt: current?.createdAt ?? input.createdAt ?? now,
      resolvedAt: input.resolvedAt ?? (input.status === "pending" ? null : now),
    });
    return mapRow(this.requireRow(input.approvalId));
  }

  public listByTurn(turnId: string): ChatInlineApprovalRecord[] {
    const rows = this.listByTurnStmt.all({ turnId }) as unknown as ChatInlineApprovalRow[];
    return rows.map(mapRow);
  }

  private requireRow(approvalId: string): ChatInlineApprovalRow {
    const row = this.getStmt.get(approvalId) as unknown as ChatInlineApprovalRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "chat inline approval", id: approvalId });
    }
    return row;
  }
}

function mapRow(row: ChatInlineApprovalRow): ChatInlineApprovalRecord {
  return {
    approvalId: row.approval_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    toolName: row.tool_name ?? undefined,
    status: row.status,
    reason: row.reason ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}
