import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ApprovalInboxItemRecord, ApprovalInboxItemState, ApprovalRequest } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ApprovalInboxRow {
  inbox_item_id: string;
  approval_id: string;
  connector_id: string;
  receiver_kind: "mcp";
  receiver_id: string;
  token_id: string;
  token: string;
  action_type: "approval.resolve";
  state: ApprovalInboxItemState;
  approval_kind: string;
  risk_level: ApprovalRequest["riskLevel"];
  approval_status: ApprovalRequest["status"];
  preview_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  last_error: string | null;
  delivery_count: number;
  last_delivered_at: string;
}

export class ApprovalInboxRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByReceiverAndTokenStmt;
  private readonly listStmt;
  private readonly updateOnRedeliveryStmt;
  private readonly updateResolutionStmt;
  private readonly deleteByReceiverStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO approval_inbox_items (
        inbox_item_id, approval_id, connector_id, receiver_kind, receiver_id, token_id, token,
        action_type, state, approval_kind, risk_level, approval_status, preview_json,
        created_at, updated_at, expires_at, resolved_at, resolved_by, last_error,
        delivery_count, last_delivered_at
      ) VALUES (
        @inboxItemId, @approvalId, @connectorId, @receiverKind, @receiverId, @tokenId, @token,
        @actionType, @state, @approvalKind, @riskLevel, @approvalStatus, @previewJson,
        @createdAt, @updatedAt, @expiresAt, NULL, NULL, NULL, 1, @lastDeliveredAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM approval_inbox_items WHERE inbox_item_id = ?");
    this.getByReceiverAndTokenStmt = db.prepare(`
      SELECT * FROM approval_inbox_items
      WHERE receiver_kind = @receiverKind
        AND receiver_id = @receiverId
        AND token_id = @tokenId
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM approval_inbox_items
      WHERE receiver_kind = @receiverKind
        AND receiver_id = @receiverId
        AND (@state IS NULL OR state = @state)
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.updateOnRedeliveryStmt = db.prepare(`
      UPDATE approval_inbox_items
      SET approval_status = @approvalStatus,
          preview_json = @previewJson,
          expires_at = @expiresAt,
          updated_at = @updatedAt,
          last_error = NULL,
          delivery_count = delivery_count + 1,
          last_delivered_at = @lastDeliveredAt
      WHERE inbox_item_id = @inboxItemId
    `);
    this.updateResolutionStmt = db.prepare(`
      UPDATE approval_inbox_items
      SET state = @state,
          approval_status = @approvalStatus,
          updated_at = @updatedAt,
          resolved_at = @resolvedAt,
          resolved_by = @resolvedBy,
          last_error = @lastError
      WHERE inbox_item_id = @inboxItemId
    `);
    this.deleteByReceiverStmt = db.prepare(`
      DELETE FROM approval_inbox_items
      WHERE receiver_kind = @receiverKind
        AND receiver_id = @receiverId
    `);
  }

  public receiveMcpApprovalDelivery(input: {
    connectorId: string;
    receiverId: string;
    approvalId: string;
    tokenId: string;
    token: string;
    approvalKind: string;
    riskLevel: ApprovalRequest["riskLevel"];
    approvalStatus: ApprovalRequest["status"];
    preview: Record<string, unknown>;
    expiresAt: string;
    receivedAt?: string;
  }): ApprovalInboxItemRecord {
    const connectorId = input.connectorId.trim();
    const receiverId = input.receiverId.trim();
    const approvalId = input.approvalId.trim();
    const tokenId = input.tokenId.trim();
    const token = input.token.trim();
    const now = input.receivedAt ?? new Date().toISOString();
    if (!connectorId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "connectorId" });
    }
    if (!receiverId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "receiverId" });
    }
    if (!approvalId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "approvalId" });
    }
    if (!tokenId) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "tokenId" });
    }
    if (!token) {
      throw new ValidationError({ code: "FIELD_REQUIRED", field: "token" });
    }

    const current = this.getByReceiverAndToken("mcp", receiverId, tokenId);
    if (current) {
      this.updateOnRedeliveryStmt.run({
        inboxItemId: current.inboxItemId,
        approvalStatus: input.approvalStatus,
        previewJson: JSON.stringify(normalizeObject(input.preview)),
        expiresAt: input.expiresAt,
        updatedAt: now,
        lastDeliveredAt: now,
      });
      return this.get(current.inboxItemId);
    }

    const record: ApprovalInboxItemRecord = {
      inboxItemId: randomUUID(),
      approvalId,
      connectorId,
      receiverKind: "mcp",
      receiverId,
      tokenId,
      token,
      actionType: "approval.resolve",
      state: "pending",
      approvalKind: input.approvalKind,
      riskLevel: input.riskLevel,
      approvalStatus: input.approvalStatus,
      preview: normalizeObject(input.preview),
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      deliveryCount: 1,
      lastDeliveredAt: now,
    };

    this.insertStmt.run({
      inboxItemId: record.inboxItemId,
      approvalId: record.approvalId,
      connectorId: record.connectorId,
      receiverKind: record.receiverKind,
      receiverId: record.receiverId,
      tokenId: record.tokenId,
      token: record.token,
      actionType: record.actionType,
      state: record.state,
      approvalKind: record.approvalKind,
      riskLevel: record.riskLevel,
      approvalStatus: record.approvalStatus,
      previewJson: JSON.stringify(record.preview),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      lastDeliveredAt: record.lastDeliveredAt,
    });
    return this.get(record.inboxItemId);
  }

  public get(inboxItemId: string): ApprovalInboxItemRecord {
    const row = this.getStmt.get(inboxItemId) as ApprovalInboxRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Approval inbox item", id: inboxItemId });
    }
    return mapRow(row);
  }

  public getByReceiverAndToken(
    receiverKind: "mcp",
    receiverId: string,
    tokenId: string,
  ): ApprovalInboxItemRecord | undefined {
    const row = this.getByReceiverAndTokenStmt.get({
      receiverKind,
      receiverId,
      tokenId,
    }) as ApprovalInboxRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public listByReceiver(
    receiverKind: "mcp",
    receiverId: string,
    input?: {
      state?: ApprovalInboxItemState;
      limit?: number;
    },
  ): ApprovalInboxItemRecord[] {
    const rows = this.listStmt.all({
      receiverKind,
      receiverId,
      state: input?.state ?? null,
      limit: input?.limit ?? 100,
    }) as unknown as ApprovalInboxRow[];
    return rows.map(mapRow);
  }

  public markResolved(
    inboxItemId: string,
    input: {
      state: Extract<ApprovalInboxItemState, "approved" | "rejected" | "edited" | "expired" | "failed">;
      approvalStatus: ApprovalRequest["status"];
      resolvedAt?: string;
      resolvedBy?: string;
      lastError?: string;
    },
  ): ApprovalInboxItemRecord {
    const current = this.get(inboxItemId);
    this.updateResolutionStmt.run({
      inboxItemId,
      state: input.state,
      approvalStatus: input.approvalStatus,
      updatedAt: input.resolvedAt ?? new Date().toISOString(),
      resolvedAt: input.resolvedAt ?? current.resolvedAt ?? null,
      resolvedBy: input.resolvedBy ?? current.resolvedBy ?? null,
      lastError: input.lastError ?? null,
    });
    return this.get(inboxItemId);
  }

  public deleteByReceiver(receiverKind: "mcp", receiverId: string): number {
    const result = this.deleteByReceiverStmt.run({ receiverKind, receiverId });
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: ApprovalInboxRow): ApprovalInboxItemRecord {
  return {
    inboxItemId: row.inbox_item_id,
    approvalId: row.approval_id,
    connectorId: row.connector_id,
    receiverKind: row.receiver_kind,
    receiverId: row.receiver_id,
    tokenId: row.token_id,
    token: row.token,
    actionType: row.action_type,
    state: row.state,
    approvalKind: row.approval_kind,
    riskLevel: row.risk_level,
    approvalStatus: row.approval_status,
    preview: safeJsonParse<Record<string, unknown>>(row.preview_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    lastError: row.last_error ?? undefined,
    deliveryCount: row.delivery_count,
    lastDeliveredAt: row.last_delivered_at,
  };
}

function normalizeObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}
