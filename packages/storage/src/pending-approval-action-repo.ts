import type { PendingApprovalAction } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseSync } from "node:sqlite";
import { safeJsonParse } from "./safe-json.js";

interface PendingActionRow {
  approval_id: string;
  action_type: PendingApprovalAction["actionType"];
  request_json: string;
  created_at: string;
  resolved_at: string | null;
  resolution_status: NonNullable<PendingApprovalAction["resolutionStatus"]>;
  result_json: string | null;
}

export class PendingApprovalActionRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly resolveStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.upsertStmt = db.prepare(`
      INSERT INTO pending_approval_actions (
        approval_id, action_type, request_json, created_at, resolution_status
      ) VALUES (@approvalId, @actionType, @requestJson, @createdAt, 'pending')
      ON CONFLICT(approval_id) DO UPDATE SET
        action_type = excluded.action_type,
        request_json = excluded.request_json,
        created_at = excluded.created_at,
        resolved_at = NULL,
        resolution_status = 'pending',
        result_json = NULL
    `);

    this.getStmt = db.prepare("SELECT * FROM pending_approval_actions WHERE approval_id = ?");

    this.resolveStmt = db.prepare(`
      UPDATE pending_approval_actions
      SET resolved_at = @resolvedAt, resolution_status = @resolutionStatus, result_json = @resultJson
      WHERE approval_id = @approvalId
        AND resolution_status = 'pending'
    `);
  }

  public upsertPending(input: {
    approvalId: string;
    actionType: PendingApprovalAction["actionType"];
    request: Record<string, unknown>;
    createdAt?: string;
  }): PendingApprovalAction {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.upsertStmt.run({
      approvalId: input.approvalId,
      actionType: input.actionType,
      requestJson: JSON.stringify(input.request),
      createdAt,
    });
    return this.get(input.approvalId);
  }

  public get(approvalId: string): PendingApprovalAction {
    const row = this.getStmt.get(approvalId) as PendingActionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "pending approval action", id: approvalId });
    }
    return mapPendingRow(row);
  }

  public find(approvalId: string): PendingApprovalAction | undefined {
    const row = this.getStmt.get(approvalId) as PendingActionRow | undefined;
    if (!row) {
      return undefined;
    }
    return mapPendingRow(row);
  }

  public markResolved(
    approvalId: string,
    resolutionStatus: NonNullable<PendingApprovalAction["resolutionStatus"]>,
    result?: Record<string, unknown>,
  ): PendingApprovalAction {
    const update = this.resolveStmt.run({
      approvalId,
      resolvedAt: new Date().toISOString(),
      resolutionStatus,
      resultJson: result ? JSON.stringify(result) : null,
    });

    if (update.changes === 0) {
      const existing = this.find(approvalId);
      if (existing) {
        return existing;
      }
      throw new NotFoundError({ entity: "pending approval action", id: approvalId });
    }

    return this.get(approvalId);
  }
}

function mapPendingRow(row: PendingActionRow): PendingApprovalAction {
  return {
    approvalId: row.approval_id,
    actionType: row.action_type,
    request: safeJsonParse<Record<string, unknown>>(row.request_json, {}),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolutionStatus: row.resolution_status,
    result: row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined,
  };
}
