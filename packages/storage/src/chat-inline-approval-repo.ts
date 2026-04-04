import type { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "@goatcitadel/contracts";

export interface ChatInlineApprovalRecord {
  approvalId: string;
  sessionId: string;
  turnId: string;
  toolName?: string;
  status: "pending" | "approved" | "denied";
  reason?: string;
  expiresAt?: string;
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
  expires_at: string | null;
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
        approval_id, session_id, turn_id, tool_name, status, reason, expires_at, resolved_by, created_at, resolved_at
      ) VALUES (
        @approvalId, @sessionId, @turnId, @toolName, @status, @reason, @expiresAt, @resolvedBy, @createdAt, @resolvedAt
      )
      ON CONFLICT(approval_id) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        expires_at = COALESCE(excluded.expires_at, chat_inline_approvals.expires_at),
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
    const row = this.getStmt.get(approvalId);
    if (!row) {
      return undefined;
    }
    assertChatInlineApprovalRow(row);
    return row ? mapRow(row) : undefined;
  }

  public upsert(input: {
    approvalId: string;
    sessionId: string;
    turnId: string;
    toolName?: string;
    status: "pending" | "approved" | "denied";
    reason?: string;
    expiresAt?: string;
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
      expiresAt: input.expiresAt ?? current?.expiresAt ?? null,
      resolvedBy: input.resolvedBy ?? null,
      createdAt: current?.createdAt ?? input.createdAt ?? now,
      resolvedAt: input.resolvedAt ?? (input.status === "pending" ? null : now),
    });
    return mapRow(this.requireRow(input.approvalId));
  }

  public listByTurn(turnId: string): ChatInlineApprovalRecord[] {
    const rows = this.listByTurnStmt.all({ turnId });
    assertChatInlineApprovalRows(rows);
    return rows.map(mapRow);
  }

  private requireRow(approvalId: string): ChatInlineApprovalRow {
    const row = this.getStmt.get(approvalId);
    if (!row) {
      throw new NotFoundError({ entity: "chat inline approval", id: approvalId });
    }
    assertChatInlineApprovalRow(row);
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
    expiresAt: row.expires_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function assertChatInlineApprovalRows(rows: unknown[]): asserts rows is ChatInlineApprovalRow[] {
  for (const row of rows) {
    assertChatInlineApprovalRow(row);
  }
}

function assertChatInlineApprovalRow(row: unknown): asserts row is ChatInlineApprovalRow {
  if (!isChatInlineApprovalRow(row)) {
    throw new TypeError("chat_inline_approvals query returned an unexpected row shape");
  }
}

function isChatInlineApprovalRow(row: unknown): row is ChatInlineApprovalRow {
  if (!isRecord(row)) {
    return false;
  }
  return typeof row.approval_id === "string"
    && typeof row.session_id === "string"
    && typeof row.turn_id === "string"
    && (typeof row.tool_name === "string" || row.tool_name === null)
    && (row.status === "pending" || row.status === "approved" || row.status === "denied")
    && (typeof row.reason === "string" || row.reason === null)
    && (typeof row.expires_at === "string" || row.expires_at === null)
    && (typeof row.resolved_by === "string" || row.resolved_by === null)
    && typeof row.created_at === "string"
    && (typeof row.resolved_at === "string" || row.resolved_at === null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
