import type {
  ApprovalCreateInput,
  ApprovalExplanation,
  ApprovalExplanationStatus,
  ApprovalRequest,
  ApprovalResolveInput,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { safeJsonParse } from "./safe-json.js";

const APPROVAL_LINKAGE_KEY = "__gcApprovalLinkage";

interface ApprovalRow {
  approval_id: string;
  kind: string;
  risk_level: ApprovalRequest["riskLevel"];
  status: ApprovalRequest["status"];
  linkage_json: string | null;
  payload_json: string;
  preview_json: string;
  explanation_status: ApprovalExplanationStatus;
  explanation_json: string | null;
  explanation_error: string | null;
  explanation_updated_at: string | null;
  created_at: string;
  expires_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export class ApprovalRepository {
  private readonly createStmt;
  private readonly listStmt;
  private readonly getStmt;
  private readonly resolveStmt;
  private readonly updatePayloadStmt;
  private readonly markExplanationPendingStmt;
  private readonly setExplanationStmt;
  private readonly setExplanationFailedStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.createStmt = db.prepare(`
      INSERT INTO approvals (
        approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
        explanation_status, created_at, expires_at
      ) VALUES (
        @approvalId, @kind, @riskLevel, @status, @linkageJson, @payloadJson, @previewJson,
        @explanationStatus, @createdAt, @expiresAt
      )
    `);
    this.listStmt = db.prepare("SELECT * FROM approvals WHERE (@status IS NULL OR status = @status) ORDER BY created_at DESC LIMIT @limit");
    this.getStmt = db.prepare("SELECT * FROM approvals WHERE approval_id = ?");
    this.resolveStmt = db.prepare(`
      UPDATE approvals SET
        status = @status,
        linkage_json = @linkageJson,
        payload_json = @payloadJson,
        resolved_at = @resolvedAt,
        resolved_by = @resolvedBy,
        resolution_note = @resolutionNote
      WHERE approval_id = @approvalId
        AND status = 'pending'
    `);
    this.updatePayloadStmt = db.prepare(`
      UPDATE approvals SET
        linkage_json = @linkageJson,
        payload_json = @payloadJson
      WHERE approval_id = @approvalId
    `);
    this.markExplanationPendingStmt = db.prepare(`
      UPDATE approvals SET
        explanation_status = 'pending',
        explanation_error = NULL,
        explanation_updated_at = @updatedAt
      WHERE approval_id = @approvalId
        AND explanation_status = 'not_requested'
    `);
    this.setExplanationStmt = db.prepare(`
      UPDATE approvals SET
        explanation_status = 'completed',
        explanation_json = @explanationJson,
        explanation_error = NULL,
        explanation_updated_at = @updatedAt
      WHERE approval_id = @approvalId
    `);
    this.setExplanationFailedStmt = db.prepare(`
      UPDATE approvals SET
        explanation_status = 'failed',
        explanation_error = @explanationError,
        explanation_updated_at = @updatedAt
      WHERE approval_id = @approvalId
    `);
  }

  public create(input: ApprovalCreateInput): ApprovalRequest {
    const now = new Date().toISOString();
    const approvalId = randomUUID();
    this.createStmt.run({
      approvalId,
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      linkageJson: serializeApprovalLinkage(input.linkage),
      payloadJson: JSON.stringify(embedApprovalLinkage(input.payload, input.linkage)),
      previewJson: JSON.stringify(input.preview),
      explanationStatus: "not_requested",
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
    });

    return this.get(approvalId);
  }

  public get(approvalId: string): ApprovalRequest {
    const row = this.getStmt.get(approvalId) as ApprovalRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Approval", id: approvalId });
    }

    return mapRow(row);
  }

  public list(status?: ApprovalRequest["status"], limit = 100): ApprovalRequest[] {
    const rows = this.listStmt.all({ status: status ?? null, limit }) as unknown as ApprovalRow[];
    return rows.map(mapRow);
  }

  public resolve(approvalId: string, input: ApprovalResolveInput): ApprovalRequest {
    const current = this.get(approvalId);

    const status: ApprovalRequest["status"] =
      input.decision === "approve"
        ? "approved"
        : input.decision === "reject"
          ? "rejected"
          : "edited";

    const changed = this.resolveStmt.run({
      approvalId,
      status,
      linkageJson: serializeApprovalLinkage(current.linkage),
      payloadJson: JSON.stringify(embedApprovalLinkage(input.editedPayload ?? current.payload, current.linkage)),
      resolvedAt: new Date().toISOString(),
      resolvedBy: input.resolvedBy,
      resolutionNote: input.resolutionNote ?? null,
    }).changes;

    if (changed < 1) {
      throw new ConflictError({ code: "STATE_CONFLICT", message: `Approval ${approvalId} is already resolved` });
    }

    return this.get(approvalId);
  }

  public mergeLinkage(
    approvalId: string,
    linkagePatch: NonNullable<ApprovalRequest["linkage"]>,
  ): ApprovalRequest {
    const row = this.getStmt.get(approvalId) as ApprovalRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Approval", id: approvalId });
    }
    const payload = safeJsonParse<Record<string, unknown>>(row.payload_json, {});
    const currentLinkage = readApprovalLinkage(payload) ?? {};
    const nextLinkage = {
      ...currentLinkage,
      ...Object.fromEntries(
        Object.entries(linkagePatch).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
      ),
    };
    this.updatePayloadStmt.run({
      approvalId,
      linkageJson: serializeApprovalLinkage(nextLinkage),
      payloadJson: JSON.stringify(embedApprovalLinkage(payload, nextLinkage)),
    });
    return this.get(approvalId);
  }

  public markExplanationPending(approvalId: string): boolean {
    const changed = this.markExplanationPendingStmt.run({
      approvalId,
      updatedAt: new Date().toISOString(),
    }).changes;

    return changed > 0;
  }

  public setExplanation(approvalId: string, explanation: ApprovalExplanation): ApprovalRequest {
    this.setExplanationStmt.run({
      approvalId,
      explanationJson: JSON.stringify(explanation),
      updatedAt: new Date().toISOString(),
    });
    return this.get(approvalId);
  }

  public setExplanationFailed(approvalId: string, explanationError: string): ApprovalRequest {
    this.setExplanationFailedStmt.run({
      approvalId,
      explanationError,
      updatedAt: new Date().toISOString(),
    });
    return this.get(approvalId);
  }
}

function mapRow(row: ApprovalRow): ApprovalRequest {
  const explanation = safeJsonParse<ApprovalExplanation | undefined>(row.explanation_json, undefined);
  const rawPayload = safeJsonParse<Record<string, unknown>>(row.payload_json, {});
  const rawPreview = safeJsonParse<Record<string, unknown>>(row.preview_json, {});
  const linkage = deserializeApprovalLinkage(row.linkage_json)
    ?? readApprovalLinkage(rawPayload)
    ?? readApprovalLinkage(rawPreview);

  return {
    approvalId: row.approval_id,
    kind: row.kind,
    riskLevel: row.risk_level,
    status: row.status,
    payload: stripApprovalLinkage(rawPayload),
    preview: stripApprovalLinkage(rawPreview),
    linkage,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    resolutionNote: row.resolution_note ?? undefined,
    explanationStatus: row.explanation_status,
    explanation,
    explanationError: row.explanation_error ?? undefined,
  };
}

function embedApprovalLinkage(
  payload: Record<string, unknown>,
  linkage?: ApprovalRequest["linkage"],
): Record<string, unknown> {
  if (!linkage) {
    return stripApprovalLinkage(payload);
  }
  const normalizedLinkage = Object.fromEntries(
    Object.entries(linkage).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  );
  if (Object.keys(normalizedLinkage).length === 0) {
    return stripApprovalLinkage(payload);
  }
  return {
    ...stripApprovalLinkage(payload),
    [APPROVAL_LINKAGE_KEY]: normalizedLinkage,
  };
}

function readApprovalLinkage(payload: Record<string, unknown>): ApprovalRequest["linkage"] | undefined {
  const candidate = payload[APPROVAL_LINKAGE_KEY];
  return normalizeApprovalLinkage(candidate);
}

function stripApprovalLinkage(payload: Record<string, unknown>): Record<string, unknown> {
  if (!(APPROVAL_LINKAGE_KEY in payload)) {
    return payload;
  }
  const next = { ...payload };
  delete next[APPROVAL_LINKAGE_KEY];
  return next;
}

function serializeApprovalLinkage(linkage?: ApprovalRequest["linkage"]): string | null {
  const normalized = normalizeApprovalLinkage(linkage);
  return normalized ? JSON.stringify(normalized) : null;
}

function deserializeApprovalLinkage(raw: string | null): ApprovalRequest["linkage"] | undefined {
  if (!raw) {
    return undefined;
  }
  return normalizeApprovalLinkage(safeJsonParse<unknown>(raw, undefined));
}

function normalizeApprovalLinkage(candidate: unknown): ApprovalRequest["linkage"] | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
